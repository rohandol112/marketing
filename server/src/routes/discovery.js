import { Hono } from 'hono';
import knex from '../db/knex.js';
import config, { discoverySource } from '../config.js';
import { uid, now, HttpError } from '../lib/util.js';
import { searchAreas } from '../lib/geo.js';
import { estimateSweep } from '../lib/places.js';
import { enqueue } from '../lib/queue.js';
import { PRESETS, CATEGORY_BY_ID } from '../lib/categories.js';

const app = new Hono();

/* ---------------------- area search ---------------------- */

/** Type any place name on earth, get a centre point. No pincode tables. */
app.get('/areas/search', async (c) => {
  const q = c.req.query('q');
  if (!q || q.length < 2) return c.json({ results: [], source: 'none' });
  const res = await searchAreas(q, {
    limit: Number(c.req.query('limit') || 8),
    regionCode: c.req.query('region') || undefined,
  });
  return c.json(res);
});

app.get('/areas', async (c) => {
  const areas = await knex('areas').where({ tenant_id: c.get('tenantId') }).orderBy('created_at', 'desc');
  return c.json(areas);
});

app.post('/areas', async (c) => {
  const tenantId = c.get('tenantId');
  const b = await c.req.json();
  if (b.lat == null || b.lng == null) throw new HttpError(400, 'lat and lng are required');

  const area = {
    id: uid('ar_'),
    tenant_id: tenantId,
    label: b.label || 'Untitled area',
    country_code: b.countryCode || null,
    region_code: b.regionCode || null,
    language_code: b.languageCode || 'en',
    lat: Number(b.lat),
    lng: Number(b.lng),
    radius_m: Number(b.radiusM || 5000),
    created_at: now(),
  };
  await knex('areas').insert(area);
  return c.json(area, 201);
});

app.delete('/areas/:id', async (c) => {
  await knex('areas').where({ id: c.req.param('id'), tenant_id: c.get('tenantId') }).del();
  return c.json({ ok: true });
});

/* ---------------------- runs ---------------------- */

function resolveCategories(body) {
  let ids = [];
  if (body.preset && PRESETS[body.preset]) ids = PRESETS[body.preset].ids;
  if (Array.isArray(body.categories) && body.categories.length) ids = body.categories;

  const unknown = ids.filter((id) => !CATEGORY_BY_ID.has(id));
  if (unknown.length) throw new HttpError(400, 'Unknown categories: ' + unknown.join(', '));
  if (!ids.length) throw new HttpError(400, 'Pick at least one category, or a preset.');
  return [...new Set(ids)];
}

app.post('/runs', async (c) => {
  const tenantId = c.get('tenantId');
  const b = await c.req.json();

  if (b.lat == null || b.lng == null) {
    throw new HttpError(400, 'An area is required. Search for a place first, then pick a radius.');
  }

  const categories = resolveCategories(b);
  const radiusM = Math.min(Math.max(Number(b.radiusM || 5000), 200), 50000);
  const maxPages = Math.min(Math.max(Number(b.maxPages || config.places.maxPages), 1), 3);

  const source = b.source || discoverySource();
  const estimate = estimateSweep({
    categoryCount: categories.length,
    maxPages,
    tier: b.fieldTier || config.places.fieldTier,
  });
  if (source !== 'places') {
    estimate.costUsd = 0;
    estimate.note = source === 'gemini'
      ? 'Gemini discovery: no per-call charge, but every lead arrives unverified and must be confirmed before a rep can call it.'
      : estimate.note;
  }

  // A guard against a fat-fingered "everything, 50km" run.
  const cap = Number(b.costCapUsd ?? 25);
  if (source === 'places' && estimate.costUsd > cap) {
    throw new HttpError(
      409,
      'That sweep would cost about $' + estimate.costUsd + ' (' + estimate.calls + ' calls), over the $' + cap +
      ' cap. Narrow the categories, or raise costCapUsd if you mean it.'
    );
  }

  const run = {
    id: uid('run_'),
    tenant_id: tenantId,
    area_label: b.areaLabel || 'Untitled area',
    lat: Number(b.lat),
    lng: Number(b.lng),
    radius_m: radiusM,
    region_code: b.regionCode || null,
    language_code: b.languageCode || 'en',
    categories: JSON.stringify(categories),
    params: JSON.stringify({
      maxPages,
      source,
      fieldTier: b.fieldTier || config.places.fieldTier,
      minReviews: b.minReviews ?? 0,
      auditThreshold: b.auditThreshold,
    }),
    status: 'queued',
    progress: JSON.stringify({ done: 0, total: categories.length, currentCategory: null }),
    source,
    created_at: now(),
  };

  await knex('discovery_runs').insert(run);
  await enqueue({ tenantId, kind: 'discovery', payload: { runId: run.id } });

  return c.json({ run: { ...run, categories, params: JSON.parse(run.params) }, estimate }, 201);
});

app.get('/runs', async (c) => {
  const runs = await knex('discovery_runs')
    .where({ tenant_id: c.get('tenantId') })
    .orderBy('created_at', 'desc')
    .limit(Number(c.req.query('limit') || 25));
  return c.json(runs);
});

app.get('/runs/:id', async (c) => {
  const run = await knex('discovery_runs')
    .where({ id: c.req.param('id'), tenant_id: c.get('tenantId') })
    .first();
  if (!run) throw new HttpError(404, 'Run not found');

  const [{ count }] = await knex('leads').where({ run_id: run.id }).count('* as count');
  return c.json({ ...run, leadCount: Number(count) });
});

app.post('/runs/:id/cancel', async (c) => {
  const n = await knex('discovery_runs')
    .where({ id: c.req.param('id'), tenant_id: c.get('tenantId') })
    .whereIn('status', ['queued', 'running'])
    .update({ status: 'cancelled', finished_at: now() });
  if (!n) throw new HttpError(409, 'That run is not cancellable.');
  return c.json({ ok: true });
});

export default app;
