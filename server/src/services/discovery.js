import knex, { logUsage } from '../db/knex.js';
import config, { discoverySource } from '../config.js';
import { searchCategory, costPerCall } from '../lib/places.js';
import { discoverCategory } from '../lib/geminiDiscovery.js';
import { discoverCategory as discoverViaOsm } from '../lib/osm.js';
import { discoverCategory as discoverViaMaps, mapsLookupAvailable } from '../lib/mapsDiscovery.js';
import { searchAreas } from '../lib/geo.js';
import { auditWebsite, pageSpeedReport } from '../lib/websiteAudit.js';
import { DEFAULT_SCORING_CONFIG } from '../lib/scoring.js';
import { detectExclusion } from '../lib/classify.js';
import { instagramAvailable } from '../lib/instagram.js';
import { CATEGORIES } from '../lib/categories.js';
import { evaluationPatch, recordProvenance } from './lifecycle.js';
import {
  uid, now, normalizeName, normalizeHost, normalizeUrl, normalizeLocality, cleanEmail, cleanInstagramHandle,
  nameSimilarity, haversineMeters, addDays, asObject, daysSince, phoneInfo, phoneFields, countryFor,
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

  await updateRun(runId, {
    status: 'running',
    progress: JSON.stringify({ done: 0, total: categories.length, currentCategory: null }),
  });

  const source = params.source || discoverySource();
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

  for (let i = 0; i < categories.length; i++) {
    const categoryId = categories[i];

    const fresh = await knex('discovery_runs').where({ id: runId }).first('status');
    if (fresh?.status === 'cancelled') {
      await updateRun(runId, { finished_at: now() });
      return;
    }

    await updateRun(runId, {
      progress: JSON.stringify({ done: i, total: categories.length, currentCategory: categoryId }),
    });

    let result;
    try {
      if (source === 'maps') {
        result = await discoverViaMaps({
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
      } else if (source === 'osm') {
        result = await discoverViaOsm({
          categoryId,
          center,
          radiusM,
          regionCode: run.region_code || undefined,
          areaLabel: run.area_label,
          allowed,
        });
        reclassifiedAway += result.skipped || 0;
        for (const w of result.warnings || []) warnings.add(w);
      } else if (source === 'gemini') {
        result = await discoverCategory({
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
      } else {
        result = await searchCategory({
          categoryId,
          center,
          radiusM,
          regionCode: run.region_code || undefined,
          languageCode: run.language_code || 'en',
          maxPages,
          tier,
        });
      }
    } catch (e) {
      errors.push(categoryId + ': ' + e.message);
      apiCalls += e.calls || 0;
      // An auth or quota failure will hit every remaining category too.
      if (e.status === 401 || e.status === 403) {
        const who = source === 'places' ? 'Places API' : source === 'osm' ? 'OpenStreetMap' : 'Gemini';
        await updateRun(runId, {
          status: 'failed',
          error: who + ' rejected the request: ' + e.message,
          api_calls: apiCalls,
          cost_usd: source === 'places' ? apiCalls * costPerCall(tier) : 0,
          finished_at: now(),
        });
        return;
      }
      continue;
    }

    apiCalls += result.calls;
    found += result.leads.length;

    for (const raw of result.leads) {
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

      if (existing || nearby.find(lead)) {
        dupes++;
        continue;
      }
      if (await isSuppressed(tenantId, { ...lead, dedupe_key: dedupeKey })) {
        suppressed++;
        continue;
      }

      const exclusion = detectExclusion(lead);
      if (exclusion) excluded++;

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

      // Existence is decided by the lifecycle, not the scorer. A model-recalled
      // business has no verified identity, so evaluate() lands it in
      // 'discovered' and the CHECK constraint keeps it out of any sales stage.
      const provenanceSource =
        source === 'places' ? 'google_places'
        : source === 'maps' ? 'gemini_maps_grounding'
        : source === 'osm' ? 'openstreetmap'
        : source === 'gemini' ? 'gemini_recall'
        : 'mock';
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
        created++;
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
        if (/duplicate key|unique/i.test(e.message)) dupes++;
        else errors.push(raw.name + ': ' + e.message);
      }
    }
  }

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
   * somebody remembered to trigger them. A sweep should produce finished leads.
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

  await updateRun(runId, {
    status: 'done',
    progress: JSON.stringify({ done: categories.length, total: categories.length, currentCategory: null }),
    api_calls: apiCalls,
    cost_usd: costUsd,
    found_count: found,
    new_count: created,
    dupe_count: dupes,
    source: source === 'gemini' ? (grounded ? 'gemini_grounded' : 'gemini_recall') : source,
    tokens_in: tokensIn || null,
    tokens_out: tokensOut || null,
    llm_model: llmModel,
    error: errors.length ? errors.slice(0, 10).join(' | ') : null,
    params: JSON.stringify({
      ...params, source, grounded, warnings: [...warnings],
      excluded, suppressed, reclassifiedAway, enrichQueued,
    }),
    finished_at: now(),
  });
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

  // A handle on their own site is the cue to read the account's real numbers.
  const handle = patch.ig_handle || lead.ig_handle;
  const igChecked = asObject(lead.social_audit).instagram;
  if (handle && instagramAvailable() && !merged.exclusion && (!igChecked || (daysSince(igChecked.checkedAt) ?? 99) > 14)) {
    await enqueue({ tenantId: lead.tenant_id, kind: 'enrich_instagram', payload: { leadId } });
  }

  return evaluation;
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

  const query = [lead.address, lead.locality, lead.region].filter(Boolean).join(', ');
  const r = await searchAreas(query, { limit: 1, regionCode: lead.country_code || undefined });
  const hit = (r.results || [])[0];
  if (!hit) return;

  const patch = { lat: hit.lat, lng: hit.lng, updated_at: now() };

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

// Bulk social enrichment, queued one lead at a time so progress is visible and
// a single failure does not take a batch down.
registerHandler('enrich_social', async ({ leadId, tenantId }) => {
  const { enrichLeadSocial } = await import('./ai.js');
  await enrichLeadSocial({ tenantId, leadId });
});
