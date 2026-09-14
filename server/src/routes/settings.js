import { Hono } from 'hono';
import knex from '../db/knex.js';
import { uid, now, HttpError } from '../lib/util.js';
import { DEFAULT_SCORING_CONFIG } from '../lib/scoring.js';
import { enqueue } from '../lib/queue.js';

const app = new Hono();

/* ---------------------- tenant ---------------------- */

app.get('/tenant', async (c) => {
  const t = await knex('tenants').where({ id: c.get('tenantId') }).first();
  return c.json(t);
});

app.patch('/tenant', async (c) => {
  const b = await c.req.json();
  const patch = {};
  for (const k of ['name', 'country_code', 'currency', 'timezone', 'brand_voice']) {
    if (b[k] !== undefined) patch[k] = b[k];
  }
  await knex('tenants').where({ id: c.get('tenantId') }).update(patch);
  return c.json(await knex('tenants').where({ id: c.get('tenantId') }).first());
});

/* ---------------------- users ---------------------- */

app.get('/users', async (c) => {
  const users = await knex('users').where({ tenant_id: c.get('tenantId') }).orderBy('name');
  const loads = await knex('leads')
    .where({ tenant_id: c.get('tenantId'), status: 'approved' })
    .whereNotIn('stage', ['success', 'failed'])
    .select('assigned_to')
    .count('* as n')
    .groupBy('assigned_to');
  const loadBy = Object.fromEntries(loads.map((l) => [l.assigned_to, Number(l.n)]));
  return c.json(users.map((u) => ({ ...u, openLeads: loadBy[u.id] || 0 })));
});

app.post('/users', async (c) => {
  const b = await c.req.json();
  if (!b.name) throw new HttpError(400, 'name is required');
  if (!['admin', 'team_lead', 'rep'].includes(b.role)) {
    throw new HttpError(400, 'role must be admin, team_lead or rep');
  }
  const user = {
    id: uid('us_'),
    tenant_id: c.get('tenantId'),
    name: b.name,
    email: b.email || null,
    role: b.role,
    open_lead_cap: b.openLeadCap || 25,
    active: true,
    created_at: now(),
  };
  await knex('users').insert(user);
  return c.json(user, 201);
});

app.patch('/users/:id', async (c) => {
  const b = await c.req.json();
  const patch = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.email !== undefined) patch.email = b.email;
  if (b.role !== undefined) patch.role = b.role;
  if (b.openLeadCap !== undefined) patch.open_lead_cap = Number(b.openLeadCap);
  if (b.active !== undefined) patch.active = !!b.active;
  await knex('users').where({ id: c.req.param('id'), tenant_id: c.get('tenantId') }).update(patch);
  return c.json(await knex('users').where({ id: c.req.param('id') }).first());
});

/* ---------------------- packages ---------------------- */

app.get('/packages', async (c) => {
  return c.json(await knex('packages').where({ tenant_id: c.get('tenantId') }).orderBy('sort_order'));
});

app.post('/packages', async (c) => {
  const b = await c.req.json();
  if (!b.name) throw new HttpError(400, 'name is required');
  const tenant = await knex('tenants').where({ id: c.get('tenantId') }).first();
  const pkg = {
    id: uid('pk_'),
    tenant_id: c.get('tenantId'),
    name: b.name,
    tagline: b.tagline || null,
    price_min: b.priceMin ?? null,
    price_max: b.priceMax ?? null,
    currency: b.currency || tenant.currency,
    billing: b.billing || 'one_time',
    includes: JSON.stringify(b.includes || []),
    best_for: b.bestFor || null,
    sort_order: b.sortOrder ?? 0,
    active: true,
  };
  await knex('packages').insert(pkg);
  return c.json(pkg, 201);
});

app.patch('/packages/:id', async (c) => {
  const b = await c.req.json();
  const patch = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.tagline !== undefined) patch.tagline = b.tagline;
  if (b.priceMin !== undefined) patch.price_min = b.priceMin;
  if (b.priceMax !== undefined) patch.price_max = b.priceMax;
  if (b.billing !== undefined) patch.billing = b.billing;
  if (b.includes !== undefined) patch.includes = JSON.stringify(b.includes);
  if (b.bestFor !== undefined) patch.best_for = b.bestFor;
  if (b.sortOrder !== undefined) patch.sort_order = b.sortOrder;
  if (b.active !== undefined) patch.active = !!b.active;
  await knex('packages').where({ id: c.req.param('id'), tenant_id: c.get('tenantId') }).update(patch);
  return c.json(await knex('packages').where({ id: c.req.param('id') }).first());
});

app.delete('/packages/:id', async (c) => {
  await knex('packages').where({ id: c.req.param('id'), tenant_id: c.get('tenantId') }).update({ active: false });
  return c.json({ ok: true });
});

/* ---------------------- service catalogue ---------------------- */

app.get('/catalog', async (c) => {
  const rows = await knex('service_catalog')
    .where({ tenant_id: c.get('tenantId') })
    .orderBy(['group_name', 'sub_group', 'name']);
  const grouped = {};
  for (const r of rows) (grouped[r.group_name] ||= []).push(r);
  return c.json({ rows, grouped });
});

app.patch('/catalog/:id', async (c) => {
  const b = await c.req.json();
  const patch = {};
  if (b.name !== undefined) patch.name = b.name;
  if (b.active !== undefined) patch.active = !!b.active;
  if (b.gapTags !== undefined) patch.gap_tags = JSON.stringify(b.gapTags);
  await knex('service_catalog').where({ id: c.req.param('id'), tenant_id: c.get('tenantId') }).update(patch);
  return c.json(await knex('service_catalog').where({ id: c.req.param('id') }).first());
});

/* ---------------------- scoring weights ---------------------- */

app.get('/scoring', async (c) => {
  const row = await knex('scoring_configs')
    .where({ tenant_id: c.get('tenantId'), active: true })
    .orderBy('version', 'desc')
    .first();
  return c.json({
    config: row?.config || DEFAULT_SCORING_CONFIG,
    version: row?.version || 0,
    defaults: DEFAULT_SCORING_CONFIG,
  });
});

/**
 * Saving weights creates a new version rather than mutating the old one, so a
 * retune that makes things worse can be rolled back and, more importantly, so
 * an old score can still be explained by the config that produced it.
 */
app.post('/scoring', async (c) => {
  const tenantId = c.get('tenantId');
  const b = await c.req.json();
  if (!b.config || typeof b.config !== 'object') throw new HttpError(400, 'config object is required');

  const current = await knex('scoring_configs')
    .where({ tenant_id: tenantId })
    .orderBy('version', 'desc')
    .first();

  const version = (current?.version || 0) + 1;
  const config = { ...b.config, version };

  await knex.transaction(async (trx) => {
    await trx('scoring_configs').where({ tenant_id: tenantId }).update({ active: false });
    await trx('scoring_configs').insert({
      id: uid('sc_'),
      tenant_id: tenantId,
      version,
      config: JSON.stringify(config),
      active: true,
      note: b.note || null,
      created_at: now(),
    });
  });

  if (b.rescore !== false) {
    await enqueue({ tenantId, kind: 'rescore_tenant', payload: { tenantId } });
  }

  return c.json({ version, config, rescoreQueued: b.rescore !== false });
});

app.get('/scoring/history', async (c) => {
  const rows = await knex('scoring_configs')
    .where({ tenant_id: c.get('tenantId') })
    .orderBy('version', 'desc')
    .limit(20);
  return c.json(rows);
});

/* ---------------------- do not contact ---------------------- */

app.get('/dnc', async (c) => {
  return c.json(await knex('dnc').where({ tenant_id: c.get('tenantId') }).orderBy('created_at', 'desc').limit(500));
});

app.post('/dnc', async (c) => {
  const b = await c.req.json();
  if (!b.phone && !b.email) throw new HttpError(400, 'phone or email is required');
  const row = {
    id: uid('dnc_'),
    tenant_id: c.get('tenantId'),
    phone_normalized: b.phone || null,
    email: b.email || null,
    reason: b.reason || null,
    created_at: now(),
  };
  await knex('dnc').insert(row);
  return c.json(row, 201);
});

export default app;
