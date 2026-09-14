import { Hono } from 'hono';
import knex from '../db/knex.js';
import config, { discoverySource } from '../config.js';
import { CATEGORIES, PRESETS, GROUPS } from '../lib/categories.js';
import { STAGES, STAGE_META, LOSS_REASONS } from '../services/leads.js';
import { llmStatus } from '../lib/llm.js';
import { queueStats, queueDepth } from '../lib/queue.js';
import { estimateSweep } from '../lib/places.js';

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
        id: 'gemini',
        label: 'AI web search',
        available: !config.gemini.mock,
        recommended: !config.gemini.mock,
        note: 'Widest coverage by far, and it knows businesses no directory lists. Then run Research and verify to check each one against live web search.',
        caveat: 'Measured: the model does NOT search for open-ended "list businesses here" prompts - it answers from memory, so every lead arrives unverified. Verification is a second, grounded step.',
      },
      {
        id: 'osm',
        label: 'OpenStreetMap',
        available: true,
        recommended: config.gemini.mock,
        note: 'Every result is a business a human surveyed and mapped, with real coordinates. It cannot invent one. Free, no key, no quota.',
        caveat: 'Thin coverage: only about 8% carry a website and 20% a phone, and there are no ratings or review counts at all.',
      },
      {
        id: 'places',
        label: 'Google Places',
        available: !config.places.mock,
        recommended: !config.places.mock,
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
    },
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
