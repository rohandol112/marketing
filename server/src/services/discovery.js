import knex, { logUsage } from '../db/knex.js';
import config, { discoverySource } from '../config.js';
import { searchCategory, costPerCall } from '../lib/places.js';
import { discoverCategory } from '../lib/geminiDiscovery.js';
import { discoverCategory as discoverViaOsm } from '../lib/osm.js';
import { discoverCategory as discoverViaMaps, mapsLookupAvailable } from '../lib/mapsDiscovery.js';
import { searchAreas, locateBusiness } from '../lib/geo.js';
import { auditWebsite, pageSpeedReport } from '../lib/websiteAudit.js';
import { DEFAULT_SCORING_CONFIG } from '../lib/scoring.js';
import { detectExclusion } from '../lib/classify.js';
import { instagramAvailable } from '../lib/instagram.js';
import { ensureGeminiKey, geminiSearchAvailable } from '../lib/llm.js';
import { CATEGORIES } from '../lib/categories.js';
import { evaluationPatch, recordProvenance } from './lifecycle.js';
import {
  uid, now, normalizeName, normalizeHost, normalizeUrl, normalizeLocality, cleanEmail, cleanInstagramHandle,
  nameSimilarity, haversineMeters, addDays, asObject, daysSince, phoneInfo, phoneFields, countryFor, addressKey,
} from '../lib/util.js';
import { enqueue, registerHandler } from '../lib/queue.js';

/**
 * Discovery: turn an area plus a category list into scored, deduplicated leads
 * sitting in a review queue. No LLM touches any of this. Finding businesses,
 * reading phone numbers, scoring and deduping are all deterministic on purpose -
 * one hallucinated phone number and the sales team never trusts the tool again.
 */

export async function getScoringConfig(tenantId) {
  const row = await knex('scoring_configs')
    .where({ tenant_id: tenantId, active: true })
    .orderBy('version', 'desc')
    .first();
  return row?.config || DEFAULT_SCORING_CONFIG;
}

/** The tenant's calling code, for numbers a directory wrote in national format. */
export async function tenantCountry(tenantId) {
  const t = await knex('tenants').where({ id: tenantId }).first('country_code');
  return t?.country_code || '';
}

/**
 * Two businesses are the same when the phone matches, or when a normalised name
 * matches inside the same postcode. Two reps calling the same shop is the
 * fastest way to look amateur in front of a customer.
 */
export function buildDedupeKey(lead) {
  if (lead.phone_normalized) return 'p:' + lead.phone_normalized;
  const name = normalizeName(lead.name);
  const place =
    lead.postal_code ||
    lead.locality ||
    (lead.lat != null ? Number(lead.lat).toFixed(2) + ',' + Number(lead.lng).toFixed(2) : 'unknown');
  return 'n:' + name + '|' + String(place).toLowerCase();
}

function applyScore(row, cfg) {
  const { patch } = evaluationPatch(row, cfg);
  return { ...row, ...patch };
}

async function updateRun(runId, patch) {
  await knex('discovery_runs').where({ id: runId }).update(patch);
}

const T1 = CATEGORIES.filter((c) => c.tier === 'T1').map((c) => c.id);
const T2 = CATEGORIES.filter((c) => c.tier === 'T2').map((c) => c.id);

/* ------------------------------------------------------------------ */
/* Dedupe                                                             */
/* ------------------------------------------------------------------ */

/**
 * Everything already known near the sweep, loaded once.
 *
 * Exact keys - place id, external id, phone - are checked in the database.
 * What they miss is the same business found twice under different tags: a
 * clinic swept as both "dental" and "polyclinic", or a node and its building
 * outline. Same name, same spot: one business.
 */
class NearbyIndex {
  constructor(rows) {
    this.rows = rows.filter((r) => r.lat != null && r.lng != null)
      .map((r) => ({ id: r.id, name: r.name, lat: Number(r.lat), lng: Number(r.lng) }));
  }

  find(lead) {
    if (lead.lat == null || lead.lng == null) return null;
    for (const r of this.rows) {
      if (Math.abs(r.lat - lead.lat) > 0.0015 || Math.abs(r.lng - lead.lng) > 0.0015) continue;
      if (haversineMeters(r, lead) <= 150 && nameSimilarity(r.name, lead.name) >= 0.85) return r;
    }
    return null;
  }

  add(lead) {
    if (lead.lat != null && lead.lng != null) this.rows.push({ id: lead.id, name: lead.name, lat: Number(lead.lat), lng: Number(lead.lng) });
  }
}

async function loadNearby(tenantId, center, radiusM) {
  const pad = (radiusM + 2000) / 111320;
  const padLng = pad / Math.max(0.2, Math.cos((center.lat * Math.PI) / 180));
  const rows = await knex('leads')
    .where({ tenant_id: tenantId })
    .whereBetween('lat', [center.lat - pad, center.lat + pad])
    .whereBetween('lng', [center.lng - padLng, center.lng + padLng])
    .select('id', 'name', 'lat', 'lng');
  return new NearbyIndex(rows);
}

/** Keys a merged or purged lead leaves behind, so the next sweep does not bring it back. */
export function suppressionKeys(lead) {
  const keys = [];
  if (lead.external_source && lead.external_id) keys.push({ kind: 'external', value: lead.external_source + ':' + lead.external_id });
  if (lead.google_place_id) keys.push({ kind: 'place', value: lead.google_place_id });
  if (lead.dedupe_key) keys.push({ kind: 'dedupe', value: lead.dedupe_key });
  return keys;
}

async function isSuppressed(tenantId, lead) {
  const keys = suppressionKeys(lead);
  if (!keys.length) return false;
  const hit = await knex('lead_suppressions')
    .where({ tenant_id: tenantId })
    .andWhere((qb) => { for (const k of keys) qb.orWhere(k); })
    .first('id');
  return Boolean(hit);
}

/* ------------------------------------------------------------------ */
/* The sweep                                                          */
/* ------------------------------------------------------------------ */

export async function runDiscovery({ runId }) {
  const run = await knex('discovery_runs').where({ id: runId }).first();
  if (!run) {
    // The run was deleted while its job was queued. Nothing to do and nothing
    // to retry - throwing here just burned three attempts before giving up.
    console.log('[discovery] run ' + runId + ' no longer exists, skipping job');
    return;
  }
  if (run.status === 'cancelled') return;

  const tenantId = run.tenant_id;
  const cfg = await getScoringConfig(tenantId);
  const categories = run.categories || [];
  const allowed = new Set(categories);
  const params = run.params || {};
  const center = { lat: Number(run.lat), lng: Number(run.lng) };
  const radiusM = Number(run.radius_m);
  const tier = params.fieldTier || config.places.fieldTier;
  const maxPages = params.maxPages || config.places.maxPages;
  const defaultCountry = run.region_code || (await tenantCountry(tenantId));

  const source = params.source || discoverySource();
  const tag = '[discovery] ' + runId;
  const startedAt = Date.now();

  // A refused key fails every Maps and Gemini call the same way. Find out
  // before sweeping, and say so in the run, the server log and the UI - not
  // sixty categories later as an empty result.
  if (source === 'maps' || source === 'gemini') {
    const key = config.gemini.apiKey ? await ensureGeminiKey() : null;
    if (!key || key.ok === false) {
      const error = !key
        ? 'GEMINI_API_KEY is not set, so ' + (source === 'maps' ? 'Google Maps' : 'Gemini') + ' discovery cannot run.'
        : 'Google refused GEMINI_API_KEY - ' + key.reason + '. Put a working key from aistudio.google.com/apikey in GEMINI_API_KEY and restart the server.';
      console.error(tag + ' not started: ' + error);
      await updateRun(runId, { status: 'failed', error, finished_at: now() });
      return;
    }
  }

  await updateRun(runId, {
    status: 'running',
    progress: JSON.stringify({ done: 0, total: categories.length, currentCategory: null }),
  });

  const nearby = await loadNearby(tenantId, center, radiusM);

  let apiCalls = 0;
  let found = 0;
  let created = 0;
  let dupes = 0;
  let suppressed = 0;
  let excluded = 0;
  let reclassifiedAway = 0;
  let grounded = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let llmModel = null;
  const auditQueue = [];
  const errors = [];
  const warnings = new Set();

  // Existence is decided by the lifecycle, not the scorer. A model-recalled
  // business has no verified identity, so evaluate() lands it in
  // 'discovered' and the CHECK constraint keeps it out of any sales stage.
  const provenanceSource =
    source === 'places' ? 'google_places'
    : source === 'maps' ? 'gemini_maps_grounding'
    : source === 'osm' ? 'openstreetmap'
    : source === 'gemini' ? 'gemini_recall'
    : 'mock';

  /** One category, from whichever source this sweep uses. */
  async function fetchCategory(categoryId) {
    if (source === 'maps') {
      const result = await discoverViaMaps({
        categoryId,
        areaLabel: run.area_label,
        center,
        radiusM,
        regionCode: run.region_code || undefined,
        limit: 15,
        passes: maxPages,
      });
      tokensIn += result.tokensIn || 0;
      tokensOut += result.tokensOut || 0;
      llmModel = result.model || llmModel;
      if (result.grounded) grounded = true;
      for (const w of result.warnings || []) warnings.add(w);
      return result;
    }
    if (source === 'osm') {
      const result = await discoverViaOsm({
        categoryId,
        center,
        radiusM,
        regionCode: run.region_code || undefined,
        areaLabel: run.area_label,
        allowed,
      });
      reclassifiedAway += result.skipped || 0;
      for (const w of result.warnings || []) warnings.add(w);
      return result;
    }
    if (source === 'gemini') {
      const result = await discoverCategory({
        categoryId,
        areaLabel: run.area_label,
        center,
        radiusM,
        regionCode: run.region_code || undefined,
        limit: maxPages * 10,
        tryGrounding: grounded !== false,
      });
      if (result.grounded != null) grounded = grounded === false ? false : result.grounded;
      // Tokens are what a paid tier actually bills for, so accumulate them
      // rather than inferring spend from the call count.
      tokensIn += result.tokensIn || 0;
      tokensOut += result.tokensOut || 0;
      llmModel = result.model || llmModel;
      for (const w of result.warnings || []) warnings.add(w);
      return result;
    }
    return searchCategory({
      categoryId,
      center,
      radiusM,
      regionCode: run.region_code || undefined,
      languageCode: run.language_code || 'en',
      maxPages,
      tier,
    });
  }

  /**
   * Write one category's leads. Only ever one category at a time: the
   * duplicate check reads before it writes, and two categories finding the
   * same clinic at once would otherwise both insert it.
   */
  async function ingest(rawLeads) {
    const n = { created: 0, dupes: 0, suppressed: 0, excluded: 0 };
    for (const raw of rawLeads) {
      // Unknown is not zero. Filtering on (review_count ?? 0) threw away every
      // directory lead the moment anyone set a minimum.
      const minReviews = params.minReviews ?? 0;
      if (minReviews && raw.review_count != null && raw.review_count < minReviews) continue;

      const country = countryFor(raw, defaultCountry);
      const website = normalizeUrl(raw.website);
      const phones = phoneFields(raw.phone, country);
      const lead = {
        ...raw,
        ...phones,
        website,
        website_host: normalizeHost(website),
        website_status: website ? raw.website_status ?? null : raw.website_status === 'none' ? 'none' : 'unknown',
        email: cleanEmail(raw.email),
        ig_handle: cleanInstagramHandle(raw.ig_handle),
        locality: normalizeLocality(raw.locality),
      };
      const dedupeKey = buildDedupeKey(lead);

      // Only match on the fields this lead actually has. A null place_id must
      // never be treated as a match, or every AI-sourced lead collides with the
      // first one.
      const existing = await knex('leads')
        .where({ tenant_id: tenantId })
        .andWhere((qb) => {
          let any = false;
          if (lead.google_place_id) { qb.orWhere('google_place_id', lead.google_place_id); any = true; }
          if (lead.external_id && lead.external_source) {
            qb.orWhere((sub) =>
              sub.where('external_id', lead.external_id).andWhere('external_source', lead.external_source)
            );
            any = true;
          }
          if (dedupeKey) { qb.orWhere('dedupe_key', dedupeKey); any = true; }
          if (lead.phone_normalized) { qb.orWhere('phone_normalized', lead.phone_normalized); any = true; }
          if (!any) qb.whereRaw('false');
        })
        .first('id');

      // The same name at the same street address, under another id or another
      // spelling of the locality, is the same shop.
      let sameAddress = null;
      const at = existing ? null : addressKey(lead.address);
      if (at) {
        const named = await knex('leads')
          .where({ tenant_id: tenantId })
          .whereRaw('lower(name) = lower(?)', [lead.name])
          .whereNotNull('address')
          .limit(20)
          .select('id', 'address');
        sameAddress = named.find((r) => addressKey(r.address) === at) || null;
      }

      if (existing || sameAddress || nearby.find(lead)) {
        n.dupes++;
        continue;
      }
      if (await isSuppressed(tenantId, { ...lead, dedupe_key: dedupeKey })) {
        n.suppressed++;
        continue;
      }

      const exclusion = detectExclusion(lead);
      if (exclusion) n.excluded++;

      const row = applyScore(
        {
          ...lead,
          id: uid('ld_'),
          tenant_id: tenantId,
          run_id: runId,
          dedupe_key: dedupeKey,
          exclusion: exclusion ? exclusion.kind : null,
          exclusion_reason: exclusion ? exclusion.reason : null,
          status: 'pending_review',
          stage: null,   // no sales stage until a team lead approves it
          fields_refreshed_at: now(),
          stale_after: addDays(now(), 30),
          created_at: now(),
          updated_at: now(),
        },
        cfg
      );

      const knownFields = Object.entries(raw)
        .filter(([k, v]) => v !== null && v !== undefined && !['source_url', 'disqualified', 'disqualify_reason'].includes(k))
        .map(([k]) => k);

      row.field_provenance = JSON.stringify(
        recordProvenance(raw.source_url || {}, knownFields, {
          source: provenanceSource,
          method: source === 'gemini' ? 'model_recall'
          : source === 'maps' ? 'maps_grounded_lookup'
          : source === 'osm' ? 'community_survey' : 'api',
          confidence: raw.source_url?.confidence || null,
        })
      );
      row.source_url = JSON.stringify(row.source_url || {});
      if (row.website_audit) row.website_audit = JSON.stringify(row.website_audit);

      try {
        await knex('leads').insert(row);
        n.created++;
        nearby.add(row);
        // Only audit sites worth auditing. A site check on a lead nobody will
        // ever call is a free request that still costs a second of wall clock.
        // AI-sourced leads are the exception: fetching the site is how we find
        // out whether the business is real at all.
        // Maps leads arrive with reviews already, so the audit is the only
        // thing standing between them and a real digital-gap score. Audit all
        // of them rather than gating on a score the audit itself would raise.
        if (row.website && !row.exclusion && (source !== 'places' || row.score >= (params.auditThreshold ?? cfg.tiers.B - 10))) {
          auditQueue.push(row.id);
        }
      } catch (e) {
        if (/duplicate key|unique/i.test(e.message)) n.dupes++;
        else errors.push(raw.name + ': ' + e.message);
      }
    }
    created += n.created;
    dupes += n.dupes;
    suppressed += n.suppressed;
    excluded += n.excluded;
    return n;
  }

  const secs = (t) => ((Date.now() - t) / 1000).toFixed(1) + 's';
  const who = source === 'places' ? 'Places API' : source === 'osm' ? 'OpenStreetMap'
    : source === 'maps' ? 'Google Maps grounding' : 'Gemini';
  const fatalMessage = (e) => {
    const detail = String(e.message || '').replace(/^Maps grounding /, '');
    if (e.keyRefused) return 'Google refused GEMINI_API_KEY - ' + detail + '. Put a working key in GEMINI_API_KEY and restart the server.';
    if (e.dailyQuota) return 'The Gemini key has used up its quota for today - ' + detail + '. Leads found before it ran out are kept.';
    return who + ' rejected the request: ' + e.message;
  };

  let stop = null;            // set once the rest of the sweep would fail the same way
  let writes = Promise.resolve();

  async function sweepOne(categoryId) {
    const t0 = Date.now();
    let result;
    try {
      result = await fetchCategory(categoryId);
    } catch (e) {
      apiCalls += e.calls || 0;
      errors.push(categoryId + ': ' + e.message);
      console.warn(tag + ' ' + categoryId + ' failed after ' + secs(t0) + ': ' + e.message);
      // An auth or quota failure will hit every remaining category too.
      if ((e.fatal || e.status === 401 || e.status === 403) && !stop) stop = { error: fatalMessage(e) };
      return;
    }

    apiCalls += result.calls || 0;
    found += result.leads.length;

    const write = writes.then(() => ingest(result.leads));
    writes = write.catch(() => {});
    let n;
    try {
      n = await write;
    } catch (e) {
      errors.push(categoryId + ': ' + e.message);
      console.error(tag + ' ' + categoryId + ' could not be saved: ' + e.message);
      return;
    }
    console.log(
      tag + ' ' + categoryId + ': ' + result.leads.length + ' found, ' + n.created + ' new, ' + n.dupes + ' already known'
      + (n.suppressed ? ', ' + n.suppressed + ' suppressed' : '')
      + (n.excluded ? ', ' + n.excluded + ' excluded' : '')
      + (result.failed ? ', ' + result.failed + ' of ' + result.calls + ' searches failed' : '')
      + ' (' + secs(t0) + ')'
    );
  }

  /**
   * Maps sweeps run a few categories side by side - each one is several
   * grounded calls that mostly wait on Google, and the Maps limiter caps the
   * total in flight. Other sources keep their one-at-a-time pace: Overpass
   * throttles per IP, and recall carries state from one category to the next.
   */
  const total = categories.length;
  const concurrency = source === 'maps' ? Math.max(1, Math.min(config.maps.categoryConcurrency, total)) : 1;
  const inFlight = new Set();
  let next = 0;
  let done = 0;
  let cancelled = false;

  const progress = () => updateRun(runId, {
    progress: JSON.stringify({ done, total, currentCategory: [...inFlight].join(', ') || null }),
  }).catch(() => {});

  console.log(
    tag + ' started: ' + source + ' sweep of ' + total + ' categor' + (total === 1 ? 'y' : 'ies') + ' within '
    + (radiusM / 1000) + ' km of ' + run.area_label
    + (source === 'maps' ? ' (' + maxPages + ' searches per category, ' + concurrency + ' categories at a time)' : '')
  );

  async function worker() {
    while (!stop && !cancelled && next < total) {
      // Claim the category before awaiting anything: two workers that both
      // passed the check above must not both take the last one.
      const categoryId = categories[next++];
      const fresh = await knex('discovery_runs').where({ id: runId }).first('status');
      if (fresh?.status === 'cancelled') { cancelled = true; break; }
      if (stop) break;
      inFlight.add(categoryId);
      await progress();
      try {
        await sweepOne(categoryId);
      } finally {
        inFlight.delete(categoryId);
        done++;
        await progress();
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  await writes;

  const costUsd = source === 'places' ? apiCalls * costPerCall(tier) : 0;
  if (apiCalls > 0) {
    await logUsage({
      tenantId,
      provider: source === 'places' ? 'places' : source,
      operation: source === 'places' ? 'searchText' : 'discovery',
      units: apiCalls,
      costUsd,
      meta: {
        runId, tier, categories: categories.length, grounded,
        model: llmModel || undefined,
        tokensIn: tokensIn || undefined,
        tokensOut: tokensOut || undefined,
      },
    });
  }

  /**
   * Enrichment is part of discovery, not a chore afterwards.
   *
   * Geocoding and the website audit were separate manual endpoints, so a fresh
   * sweep landed with 0% coordinates and an unaudited site on every lead until
   * somebody remembered to trigger them. A sweep should produce finished leads -
   * including the ones a stopped or cancelled sweep had already saved.
   */
  for (const leadId of auditQueue) {
    await enqueue({ tenantId, kind: 'audit_lead', payload: { leadId } });
  }

  const needGeo = await knex('leads')
    .where({ tenant_id: tenantId, run_id: runId })
    .whereNull('lat')
    .whereNotNull('address')
    .select('id');

  for (const l of needGeo) {
    await enqueue({ tenantId, kind: 'geocode_lead', payload: { leadId: l.id }, priority: 180 });
  }

  // Directory leads have no review count, which is the whole demand score.
  // Look them up on Google Maps now rather than leaving every one at zero.
  let enrichQueued = 0;
  const enrichMaps = params.enrichMaps ?? (config.enrich.mapsOnDiscovery && (source === 'osm' || source === 'gemini'));
  if (enrichMaps && mapsLookupAvailable()) {
    const q = await queueMapsEnrichment({ tenantId, runId, limit: config.enrich.mapsMaxPerRun });
    enrichQueued = q.queued;
  }

  if (reclassifiedAway) {
    warnings.add(reclassifiedAway + ' places matched a broad map tag but belong to categories you did not pick, so they were left out.');
  }

  // Someone may have pressed cancel during the last category.
  if (!cancelled) cancelled = (await knex('discovery_runs').where({ id: runId }).first('status'))?.status === 'cancelled';

  const patch = {
    progress: JSON.stringify({ done, total, currentCategory: null }),
    api_calls: apiCalls,
    cost_usd: costUsd,
    found_count: found,
    new_count: created,
    dupe_count: dupes,
    source: source === 'gemini' ? (grounded ? 'gemini_grounded' : 'gemini_recall') : source,
    tokens_in: tokensIn || null,
    tokens_out: tokensOut || null,
    llm_model: llmModel,
    error: stop ? stop.error : errors.length ? errors.slice(0, 10).join(' | ') : null,
    params: JSON.stringify({
      ...params, source, grounded, warnings: [...warnings],
      excluded, suppressed, reclassifiedAway, enrichQueued,
      durationMs: Date.now() - startedAt,
    }),
    finished_at: now(),
  };
  // A cancelled run stays cancelled; its counts are still worth keeping.
  if (!cancelled) patch.status = stop ? 'failed' : 'done';
  await updateRun(runId, patch);

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const summary = (cancelled ? 'cancelled' : stop ? 'stopped' : 'done') + ' in '
    + (elapsed >= 60 ? Math.floor(elapsed / 60) + 'm' + String(elapsed % 60).padStart(2, '0') + 's' : elapsed + 's')
    + ': ' + done + '/' + total + ' categories, ' + found + ' found, ' + created + ' new, ' + dupes + ' already known'
    + (suppressed ? ', ' + suppressed + ' suppressed' : '') + (excluded ? ', ' + excluded + ' excluded' : '')
    + (errors.length ? ', ' + errors.length + ' error' + (errors.length === 1 ? '' : 's') : '')
    + '; queued ' + auditQueue.length + ' site audits, ' + needGeo.length + ' geocodes, ' + enrichQueued + ' Maps lookups';
  if (stop) console.error(tag + ' ' + summary + '. ' + stop.error);
  else console.log(tag + ' ' + summary);
}

/* ------------------------------------------------------------------ */
/* Google Maps lookups                                                */
/* ------------------------------------------------------------------ */

/**
 * Queue Maps lookups, most valuable first: high-ticket categories, then leads
 * that already have a number to ring. Anything looked up in the last 30 days,
 * already queued, excluded or disqualified is skipped.
 */
export async function queueMapsEnrichment({ tenantId, ids = null, runId = null, limit = 100, onlyMissing = true, refresh = false }) {
  if (!mapsLookupAvailable()) return { queued: 0, available: false };
  const cutoff = addDays(now(), -30);

  let q = knex('leads')
    .where({ tenant_id: tenantId, disqualified: false })
    .andWhere((qb) => qb.whereNull('exclusion').orWhere('exclusion', 'none'))
    .whereNotExists(
      knex('jobs')
        .whereIn('jobs.status', ['queued', 'running'])
        .andWhere('jobs.kind', 'enrich_maps')
        .andWhereRaw("jobs.payload->>'leadId' = leads.id")
    );
  if (Array.isArray(ids) && ids.length) q = q.whereIn('id', ids);
  if (runId) q = q.where('run_id', runId);
  if (onlyMissing) q = q.whereNull('review_count');
  if (!refresh) {
    q = q.andWhere((qb) =>
      qb.whereRaw("field_provenance->'maps_lookup' IS NULL").orWhereRaw("(field_provenance->'maps_lookup'->>'at') < ?", [cutoff])
    );
  }

  const rows = await q
    .orderByRaw('case when normalized_category = any(?) then 0 when normalized_category = any(?) then 1 else 2 end', [T1, T2])
    .orderByRaw('case when phone_normalized is not null then 0 else 1 end')
    .orderBy('confidence', 'desc')
    .limit(Math.min(Number(limit) || 100, 1000))
    .select('id');

  for (const r of rows) {
    await enqueue({ tenantId, kind: 'enrich_maps', payload: { leadId: r.id, refresh }, priority: 160 });
  }
  return { queued: rows.length, available: true };
}

/* ------------------------------------------------------------------ */
/* Website audit                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param withPageSpeed  defaults on whenever a key is configured. It was
 *   defaulting to false, so PageSpeed never ran once despite a working key and
 *   the slow-mobile signal never fired for a single lead.
 */
export async function auditLead({ leadId, withPageSpeed = config.pagespeed.enabled }) {
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!lead) return;

  const country = countryFor(lead, await tenantCountry(lead.tenant_id));
  const result = await auditWebsite(lead.website, { country });
  const audit = result.website_audit;
  const previous = asObject(lead.website_audit);

  let psi = lead.psi_mobile;
  if (result.website_status === 'ok') {
    if (withPageSpeed && config.pagespeed.enabled) {
      const report = await pageSpeedReport(audit.finalUrl || lead.website);
      if (report) {
        psi = report.performance;
        audit.psi = report;
        // Google's own number, which an owner can check on their own phone.
        if (report.lcpMs != null && report.lcpMs > 4000) {
          audit.signals = [
            'Google measures the homepage at ' + (report.lcpMs / 1000).toFixed(1) + 's to load on a phone (performance ' + report.performance + '/100)',
            ...(audit.signals || []),
          ];
        }
        await logUsage({ tenantId: lead.tenant_id, provider: 'pagespeed', operation: 'runPagespeed', units: 1 });
      }
    } else if (previous.psi) {
      // A plain re-audit keeps the last PageSpeed report rather than losing it.
      audit.psi = previous.psi;
    }
  }

  const prov = asObject(lead.field_provenance);
  const patch = {
    website_status: result.website_status,
    has_https: result.has_https,
    mobile_friendly: result.mobile_friendly,
    psi_mobile: psi,
  };
  const audited = ['website_status', 'has_https', 'mobile_friendly', 'psi_mobile'];
  const fromSite = [];

  // Never overwrite a value a person entered or a directory supplied - only
  // fill gaps, from the business's own site.
  if (!lead.email && result.email) { patch.email = result.email; fromSite.push('email'); }
  if (!lead.ig_handle && result.ig_handle) { patch.ig_handle = result.ig_handle; fromSite.push('ig_handle'); }
  if (!lead.phone && result.phone) {
    const info = phoneInfo(result.phone, country);
    if (info.valid) {
      patch.phone = info.e164;
      patch.phone_normalized = info.e164;
      patch.phone_type = info.type;
      fromSite.push('phone');
    }
  }

  let nextProv = recordProvenance(prov, audited, { source: 'website_audit', method: 'http_fetch' });
  if (fromSite.length) {
    nextProv = recordProvenance(nextProv, fromSite, {
      source: 'website_audit', method: 'own_website', confidence: 'high', by: audit.finalUrl || lead.website,
    });
  }

  const merged = { ...lead, ...patch, website_audit: audit, field_provenance: nextProv };
  if (!lead.exclusion) {
    const exclusion = detectExclusion(merged);
    if (exclusion) {
      patch.exclusion = exclusion.kind;
      patch.exclusion_reason = exclusion.reason;
      merged.exclusion = exclusion.kind;
      merged.exclusion_reason = exclusion.reason;
    }
  }
  if (patch.phone) patch.dedupe_key = buildDedupeKey(merged);

  const cfg = await getScoringConfig(lead.tenant_id);
  const { patch: scored, evaluation } = evaluationPatch(merged, cfg);

  await knex('leads').where({ id: leadId }).update({
    ...patch,
    website_audit: JSON.stringify(audit),
    field_provenance: JSON.stringify(nextProv),
    ...scored,
    updated_at: now(),
  });

  await maybeQueueSocial({ ...merged, ...scored });

  return evaluation;
}

/** When social presence was last looked at, by any route. */
export function socialCheckedAt(lead) {
  const ig = asObject(lead.social_audit).instagram;
  const lookup = asObject(lead.field_provenance).social_lookup;
  const times = [ig && ig.checkedAt, lookup && lookup.at].filter(Boolean).map((t) => Date.parse(t)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/**
 * An audit is the cue to look at social presence - but not for every lead.
 *
 * Every audit used to queue a search, with no check for one already queued, so
 * a re-audit of 300 sites queued 300 more. Meta's API is exact and free, so any
 * lead with a handle gets it. A search is billed, takes ~15s and rarely comes
 * back with follower counts, so it is spent on the leads a rep will actually
 * call: tier A and B, not excluded, not disqualified.
 */
async function maybeQueueSocial(lead) {
  if ((lead.exclusion && lead.exclusion !== 'none') || lead.disqualified) return;
  const viaMeta = instagramAvailable() && Boolean(lead.ig_handle);
  const viaSearch = !viaMeta && geminiSearchAvailable() && ['A', 'B'].includes(lead.tier);
  if (!viaMeta && !viaSearch) return;
  const age = daysSince(socialCheckedAt(lead));
  if (age !== null && age < 14) return;
  await queueSocialEnrichment({ tenantId: lead.tenant_id, ids: [lead.id], limit: 1, onlyMissing: false });
}

/** Recompute one lead from whatever is currently on the row. */
export async function rescoreLead(leadId) {
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!lead) return null;
  const cfg = await getScoringConfig(lead.tenant_id);
  const { patch, evaluation } = evaluationPatch(lead, cfg);
  await knex('leads').where({ id: leadId }).update({ ...patch, updated_at: now() });
  return evaluation;
}

/** Rescore an entire tenant. Run after changing weights. */
export async function rescoreTenant({ tenantId }) {
  const cfg = await getScoringConfig(tenantId);
  let n = 0;
  let lastId = '';
  // In pages, so a large tenant does not load every row and audit at once.
  for (;;) {
    const leads = await knex('leads').where({ tenant_id: tenantId }).where('id', '>', lastId).orderBy('id').limit(500);
    if (!leads.length) break;
    for (const lead of leads) {
      const { patch } = evaluationPatch(lead, cfg);
      await knex('leads').where({ id: lead.id }).update({ ...patch, updated_at: now() });
      n++;
    }
    lastId = leads[leads.length - 1].id;
  }
  return n;
}

/**
 * Google's terms allow caching place_id indefinitely but require every other
 * field to be refreshed within 30 days. This is a compliance obligation, not a
 * data-freshness nicety - so stale Google-sourced leads are looked up again,
 * not just counted.
 */
export async function refreshStaleLeads({ tenantId, limit = 200 }) {
  const stale = await knex('leads')
    .where({ tenant_id: tenantId })
    .andWhere((qb) => qb.whereNotNull('google_place_id').orWhere('external_source', 'google_maps').orWhereNotNull('review_count'))
    .andWhereRaw('(stale_after IS NULL OR stale_after < now())')
    .andWhere((qb) => qb.whereNull('exclusion').orWhere('exclusion', 'none'))
    .orderBy('stale_after', 'asc')
    .limit(limit)
    .select('id');

  let queued = 0;
  if (stale.length && mapsLookupAvailable()) {
    const r = await queueMapsEnrichment({ tenantId, ids: stale.map((l) => l.id), limit, onlyMissing: false, refresh: true });
    queued = r.queued;
  }
  return { staleCount: stale.length, queued, ids: stale.map((l) => l.id) };
}

registerHandler('discovery', runDiscovery);
registerHandler('audit_lead', auditLead);

/**
 * Maps grounding returns an address but no latitude or longitude, which leaves
 * radius filtering approximate and the distance column empty. Every lead has a
 * full street address though, so geocoding it closes the gap with the same free
 * service the area picker already uses.
 *
 * Rate limited to one request a second by Nominatim's policy, so this runs as a
 * background job rather than inline.
 */
export async function geocodeLead({ leadId }) {
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!lead || lead.lat != null || !lead.address) return;

  // Places, when there is a key, answers an address with the place itself.
  // Otherwise OpenStreetMap, and only a point it is sure of - never the area
  // picker's offline list, which is how real clinics once landed in Aundh.
  let hit = null;
  if (!config.places.mock) {
    const r = await searchAreas([lead.address, lead.locality, lead.region].filter(Boolean).join(', '), { limit: 1, regionCode: lead.country_code || undefined });
    if (r.source === 'places' && r.results?.[0]) hit = { ...r.results[0], kind: 'place', query: 'places' };
  }
  if (!hit) {
    hit = await locateBusiness({
      name: lead.name, address: lead.address, locality: lead.locality, region: lead.region, countryCode: lead.country_code || undefined,
    });
  }

  const prov = asObject(lead.field_provenance);
  prov.geocode = hit
    ? { at: now(), source: hit.source || 'openstreetmap', kind: hit.kind || null, byName: Boolean(hit.byName) }
    : { at: now(), found: false };
  if (!hit) {
    await knex('leads').where({ id: leadId }).update({ field_provenance: JSON.stringify(prov) });
    return null;
  }

  const patch = { lat: hit.lat, lng: hit.lng, field_provenance: JSON.stringify(prov), updated_at: now() };

  // Distance from the sweep centre, now that we finally have a point.
  const run = lead.run_id ? await knex('discovery_runs').where({ id: lead.run_id }).first() : null;
  if (run?.lat != null) {
    patch.distance_m = Math.round(haversineMeters(
      { lat: Number(run.lat), lng: Number(run.lng) }, { lat: hit.lat, lng: hit.lng }
    ));
    // Maps answers "near" generously. Well outside the circle is not this area.
    const radius = Number(run.radius_m) || 0;
    if (radius && patch.distance_m > radius * 1.5 + 1000 && !lead.exclusion) {
      patch.exclusion = 'out_of_area';
      patch.exclusion_reason = 'About ' + (patch.distance_m / 1000).toFixed(1) + ' km from the centre of the ' +
        (radius / 1000).toFixed(1) + ' km sweep around ' + (run.area_label || 'the area');
    }
  }

  await knex('leads').where({ id: leadId }).update(patch);
  await rescoreLead(leadId);
  return patch;
}

registerHandler('geocode_lead', geocodeLead);

registerHandler('rescore_tenant', rescoreTenant);

/**
 * Queue social presence lookups across a filtered set, best prospects first.
 * Skips anything excluded, disqualified, already queued, or looked at in the
 * last 14 days - by Meta's API, by search, or by a person.
 */
export async function queueSocialEnrichment({ tenantId, ids = null, runId = null, limit = 100, onlyMissing = true, refresh = false }) {
  const canSocial = instagramAvailable() || geminiSearchAvailable();
  if (!canSocial) return { queued: 0, available: false };
  const cutoff = addDays(now(), -14);

  let q = knex('leads')
    .where({ tenant_id: tenantId, disqualified: false })
    .andWhere((qb) => qb.whereNull('exclusion').orWhere('exclusion', 'none'))
    .whereNotExists(
      knex('jobs')
        .whereIn('jobs.status', ['queued', 'running'])
        .whereIn('jobs.kind', ['enrich_social', 'enrich_instagram'])
        .andWhereRaw("jobs.payload->>'leadId' = leads.id")
    );
  if (Array.isArray(ids) && ids.length) q = q.whereIn('id', ids);
  if (runId) q = q.where('run_id', runId);
  if (onlyMissing) q = q.whereNull('ig_followers');
  if (!refresh) {
    q = q
      .andWhere((qb) =>
        qb.whereRaw("social_audit->'instagram'->>'checkedAt' IS NULL").orWhereRaw("(social_audit->'instagram'->>'checkedAt') < ?", [cutoff])
      )
      .andWhere((qb) =>
        qb.whereRaw("field_provenance->'social_lookup'->>'at' IS NULL").orWhereRaw("(field_provenance->'social_lookup'->>'at') < ?", [cutoff])
      );
  }

  const rows = await q
    .orderByRaw("case tier when 'A' then 0 when 'B' then 1 when 'C' then 2 else 3 end")
    .orderByRaw('deal_score desc nulls last, confidence desc nulls last')
    .limit(Math.min(Number(limit) || 100, 500))
    .select('id');

  for (const r of rows) {
    await enqueue({ tenantId, kind: 'enrich_social', payload: { leadId: r.id }, priority: 175 });
  }
  return { queued: rows.length, available: true };
}
