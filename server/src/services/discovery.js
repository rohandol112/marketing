import knex, { logUsage } from '../db/knex.js';
import config, { discoverySource } from '../config.js';
import { searchCategory, costPerCall } from '../lib/places.js';
import { discoverCategory } from '../lib/geminiDiscovery.js';
import { discoverCategory as discoverViaOsm } from '../lib/osm.js';
import { discoverCategory as discoverViaMaps } from '../lib/mapsDiscovery.js';
import { searchAreas } from '../lib/geo.js';
import { auditWebsite, pageSpeedMobile } from '../lib/websiteAudit.js';
import { scoreLead, DEFAULT_SCORING_CONFIG } from '../lib/scoring.js';
import { evaluationPatch, recordProvenance } from './lifecycle.js';
import { uid, now, normalizePhone, normalizeName, normalizeHost, addDays } from '../lib/util.js';
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
    (lead.lat != null ? lead.lat.toFixed(2) + ',' + lead.lng.toFixed(2) : 'unknown');
  return 'n:' + name + '|' + String(place).toLowerCase();
}

function applyScore(row, cfg) {
  const { patch } = evaluationPatch(row, cfg);
  return { ...row, ...patch };
}

async function updateRun(runId, patch) {
  await knex('discovery_runs').where({ id: runId }).update(patch);
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
  const params = run.params || {};
  const center = { lat: Number(run.lat), lng: Number(run.lng) };
  const radiusM = Number(run.radius_m);
  const tier = params.fieldTier || config.places.fieldTier;
  const maxPages = params.maxPages || config.places.maxPages;

  await updateRun(runId, {
    status: 'running',
    progress: JSON.stringify({ done: 0, total: categories.length, currentCategory: null }),
  });

  const source = params.source || discoverySource();

  let apiCalls = 0;
  let found = 0;
  let created = 0;
  let dupes = 0;
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
      if (source === 'gemini' && grounded === false) {
        // proven not to ground on this run - stop paying for the attempt
      }
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
        });
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
        await updateRun(runId, {
          status: 'failed',
          error: 'Places API rejected the key: ' + e.message,
          api_calls: apiCalls,
          cost_usd: apiCalls * costPerCall(tier),
          finished_at: now(),
        });
        return;
      }
      continue;
    }

    apiCalls += result.calls;
    found += result.leads.length;

    for (const raw of result.leads) {
      const minReviews = params.minReviews ?? 0;
      if (minReviews && (raw.review_count ?? 0) < minReviews) continue;

      const dedupeKey = buildDedupeKey(raw);

      // Only match on the fields this lead actually has. A null place_id must
      // never be treated as a match, or every AI-sourced lead collides with the
      // first one.
      const existing = await knex('leads')
        .where({ tenant_id: tenantId })
        .andWhere((qb) => {
          let any = false;
          if (raw.google_place_id) { qb.orWhere('google_place_id', raw.google_place_id); any = true; }
          if (raw.external_id && raw.external_source) {
            qb.orWhere((sub) =>
              sub.where('external_id', raw.external_id).andWhere('external_source', raw.external_source)
            );
            any = true;
          }
          if (dedupeKey) { qb.orWhere('dedupe_key', dedupeKey); any = true; }
          if (!any) qb.whereRaw('false');
        })
        .first('id');

      if (existing) {
        dupes++;
        continue;
      }

      const row = applyScore(
        {
          ...raw,
          id: uid('ld_'),
          tenant_id: tenantId,
          run_id: runId,
          dedupe_key: dedupeKey,
          phone_normalized: raw.phone_normalized || normalizePhone(raw.phone),
          website_host: raw.website_host || normalizeHost(raw.website),
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
        // Only audit sites worth auditing. A site check on a lead nobody will
        // ever call is a free request that still costs a second of wall clock.
        // AI-sourced leads are the exception: fetching the site is how we find
        // out whether the business is real at all.
        // Maps leads arrive with reviews already, so the audit is the only
        // thing standing between them and a real digital-gap score. Audit all
        // of them rather than gating on a score the audit itself would raise.
        if (row.website && (source !== 'places' || row.score >= (params.auditThreshold ?? cfg.tiers.B - 10))) {
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
    params: JSON.stringify({ ...params, source, grounded, warnings: [...warnings] }),
    finished_at: now(),
  });
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

  const result = await auditWebsite(lead.website);

  let psi = lead.psi_mobile;
  if (withPageSpeed && result.website_status === 'ok' && config.pagespeed.enabled) {
    psi = await pageSpeedMobile(lead.website);
    if (psi != null) {
      await logUsage({ tenantId: lead.tenant_id, provider: 'pagespeed', operation: 'runPagespeed', units: 1 });
    }
  }

  const cfg = await getScoringConfig(lead.tenant_id);
  const merged = {
    ...lead,
    website_status: result.website_status,
    has_https: result.has_https,
    mobile_friendly: result.mobile_friendly,
    psi_mobile: psi,
    // never overwrite a value a human entered
    email: lead.email || result.email || null,
    ig_handle: lead.ig_handle || result.ig_handle || null,
    website_audit: result.website_audit,
  };

  const { patch, evaluation } = evaluationPatch(merged, cfg);

  await knex('leads').where({ id: leadId }).update({
    website_status: merged.website_status,
    has_https: merged.has_https,
    mobile_friendly: merged.mobile_friendly,
    psi_mobile: merged.psi_mobile,
    email: merged.email,
    ig_handle: merged.ig_handle,
    website_audit: JSON.stringify(result.website_audit),
    field_provenance: JSON.stringify(
      recordProvenance(lead.field_provenance, ['website_status', 'has_https', 'mobile_friendly', 'psi_mobile'], {
        source: 'website_audit',
        method: 'http_fetch',
      })
    ),
    ...patch,
    updated_at: now(),
  });

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
  const leads = await knex('leads').where({ tenant_id: tenantId });
  let n = 0;
  for (const lead of leads) {
    const { patch } = evaluationPatch(lead, cfg);
    await knex('leads').where({ id: lead.id }).update({ ...patch, updated_at: now() });
    n++;
  }
  return n;
}

/**
 * Google's terms allow caching place_id indefinitely but require every other
 * field to be refreshed within 30 days. This is a compliance obligation, not a
 * data-freshness nicety.
 */
export async function refreshStaleLeads({ tenantId, limit = 200 }) {
  const stale = await knex('leads')
    .where({ tenant_id: tenantId })
    .whereNotNull('google_place_id')
    .andWhereRaw('(stale_after IS NULL OR stale_after < now())')
    .limit(limit);
  return { staleCount: stale.length, ids: stale.map((l) => l.id) };
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
    const { haversineMeters } = await import('../lib/util.js');
    patch.distance_m = Math.round(haversineMeters(
      { lat: Number(run.lat), lng: Number(run.lng) }, { lat: hit.lat, lng: hit.lng }
    ));
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
