import { Hono } from 'hono';
import knex from '../db/knex.js';
import config, { discoverySource } from '../config.js';
import { CATEGORIES, PRESETS, GROUPS } from '../lib/categories.js';
import { STAGES, STAGE_META, LOSS_REASONS } from '../services/leads.js';
import { llmStatus, geminiKeyStatus, geminiSearchAvailable, modelsFor, activeProvider } from '../lib/llm.js';
import { queueStats, queueDepth } from '../lib/queue.js';
import { estimateSweep } from '../lib/places.js';
import { mapsLookupAvailable, thinkingFor } from '../lib/mapsDiscovery.js';
import { instagramAvailable } from '../lib/instagram.js';
import { EXCLUSION_LABELS } from '../lib/classify.js';

const app = new Hono();

/** Everything the frontend needs to render its dropdowns, in one call. */
app.get('/bootstrap', async (c) => {
  const tenantId = c.get('tenantId');
  const userId = c.get('userId');

  const [tenant, users, packages, catalog, areas, scoring] = await Promise.all([
    knex('tenants').where({ id: tenantId }).first(),
    knex('users').where({ tenant_id: tenantId, active: true }).orderBy('name'),
    knex('packages').where({ tenant_id: tenantId, active: true }).orderBy('sort_order'),
    knex('service_catalog').where({ tenant_id: tenantId, active: true }).orderBy('group_name'),
    knex('areas').where({ tenant_id: tenantId }).orderBy('created_at', 'desc'),
    knex('scoring_configs').where({ tenant_id: tenantId, active: true }).orderBy('version', 'desc').first(),
  ]);

  // Why a Gemini-backed source is off, in words a person can act on.
  const key = geminiKeyStatus();
  const geminiProblem = !config.gemini.apiKey ? 'No GEMINI_API_KEY set'
    : key.ok === false ? 'Google refused the key: ' + key.reason : null;
  const socialMethod = instagramAvailable() ? 'meta_graph_api' : geminiSearchAvailable() ? 'gemini_search_grounding' : 'none';

  return c.json({
    tenant,
    currentUser: users.find((u) => u.id === userId) || users[0] || null,
    users,
    packages,
    catalog,
    areas,
    scoringConfig: scoring?.config || null,
    categories: CATEGORIES,
    categoryGroups: GROUPS,
    presets: PRESETS,
    stages: STAGES.map((s) => ({ id: s, ...STAGE_META[s] })),
    lossReasons: LOSS_REASONS,
    // What the operator can actually pick, with the trade-off stated. Whether a
    // source is usable is a server fact, not something the UI should guess.
    discoverySources: [
      {
        id: 'maps',
        label: 'Google Maps (via Gemini)',
        available: mapsLookupAvailable(),
        recommended: mapsLookupAvailable() && config.places.mock,
        unavailableReason: mapsLookupAvailable() ? null : geminiProblem,
        note: 'Real Google Maps listings with rating, review count, phone and website - looked up, not recalled. The best source without a Places key.',
        caveat: 'Each category is ' + config.places.maxPages + ' grounded searches run side by side, about 20-30s a category. Names come back without coordinates; they are geocoded afterwards.',
      },
      {
        id: 'gemini',
        label: 'AI web search',
        available: !config.gemini.mock && key.ok !== false,
        recommended: !config.gemini.mock && key.ok !== false,
        unavailableReason: geminiProblem,
        note: 'Widest coverage by far, and it knows businesses no directory lists. Then run Research and verify to check each one against live web search.',
        caveat: 'Measured: the model does NOT search for open-ended "list businesses here" prompts - it answers from memory, so every lead arrives unverified. Verification is a second, grounded step.',
      },
      {
        id: 'osm',
        label: 'OpenStreetMap',
        available: true,
        recommended: config.gemini.mock,
        note: 'Every result is a business a human surveyed and mapped, with real coordinates. It cannot invent one. Free, no key, no quota.',
        caveat: mapsLookupAvailable()
          ? 'No ratings or review counts of its own - each new lead is looked up on Google Maps after the sweep to fill them in.'
          : 'Thin coverage: only about 8% carry a website and 20% a phone, and there are no ratings or review counts at all.',
      },
      {
        id: 'places',
        label: 'Google Places',
        available: !config.places.mock,
        recommended: !config.places.mock,
        unavailableReason: config.places.mock ? 'No GOOGLE_PLACES_API_KEY set' : null,
        note: 'Authoritative, with real ratings and review counts. The best data there is.',
        caveat: 'Needs an API key with billing. About $0.035 per call.',
      },
    ],
    modes: {
      discoverySource: discoverySource(),
      placesMock: config.places.mock,
      geminiMock: config.gemini.mock,
      pagespeedEnabled: config.pagespeed.enabled,
      fieldTier: config.places.fieldTier,
      maxPages: config.places.maxPages,
      mapsLookup: mapsLookupAvailable(),
      instagramLookup: instagramAvailable(),
      socialLookup: socialMethod !== 'none',
      socialMethod,
      geminiProblem,
      mapsEnrichOnDiscovery: config.enrich.mapsOnDiscovery,
      maintenanceAuto: config.maintenance.auto,
    },
    exclusionLabels: EXCLUSION_LABELS,
  });
});

app.get('/health', async (c) => {
  let dbOk = true;
  let dbError = null;
  try {
    await knex.raw('select 1');
  } catch (e) {
    dbOk = false;
    dbError = e.message;
  }

  return c.json({
    ok: dbOk,
    db: { ok: dbOk, error: dbError },
    discoverySource: discoverySource(),
    places: {
      configured: !config.places.mock,
      mode: config.places.mock ? 'mock' : 'live',
      fieldTier: config.places.fieldTier,
    },
    gemini: llmStatus(),
    pagespeed: { configured: config.pagespeed.enabled },
    mapsLookup: {
      configured: mapsLookupAvailable(),
      // What the configured model is actually sent, not just the setting.
      thinkingLevel: thinkingFor(modelsFor(activeProvider()).main)?.thinkingLevel || 'model default',
      concurrency: config.maps.concurrency,
      categoryConcurrency: config.maps.categoryConcurrency,
    },
    instagram: { configured: instagramAvailable(), apiVersion: config.instagram.version },
    socialLookup: {
      configured: instagramAvailable() || geminiSearchAvailable(),
      method: instagramAvailable() ? 'meta_graph_api' : geminiSearchAvailable() ? 'gemini_search_grounding' : 'none',
    },
    maintenance: { auto: config.maintenance.auto, intervalHours: config.maintenance.intervalHours },
    queue: { ...queueStats(), depth: await queueDepth() },
  });
});

/** What a sweep will cost before anyone spends anything. */
app.post('/estimate', async (c) => {
  const body = await c.req.json();
  const categories = body.categories || [];
  return c.json(
    estimateSweep({
      categoryCount: categories.length,
      maxPages: body.maxPages,
      tier: body.fieldTier,
    })
  );
});

/** Rolling spend, so nobody discovers the bill at the end of the month. */
app.get('/usage', async (c) => {
  const tenantId = c.get('tenantId');
  const rows = await knex('api_usage')
    .where({ tenant_id: tenantId })
    .andWhereRaw("created_at > now() - interval '30 days'")
    .select('provider')
    .sum('units as units')
    .sum('cost_usd as cost_usd')
    .groupBy('provider');

  const byDay = await knex('api_usage')
    .where({ tenant_id: tenantId })
    .andWhereRaw("created_at > now() - interval '30 days'")
    .select(knex.raw("to_char(created_at, 'YYYY-MM-DD') as day"), 'provider')
    .sum('units as units')
    .sum('cost_usd as cost_usd')
    .groupBy('day', 'provider')
    .orderBy('day');

  return c.json({
    last30Days: rows.map((r) => ({
      provider: r.provider,
      units: Number(r.units),
      costUsd: Number(r.cost_usd),
    })),
    byDay: byDay.map((r) => ({
      day: r.day,
      provider: r.provider,
      units: Number(r.units),
      costUsd: Number(r.cost_usd),
    })),
  });
});

export default app;
