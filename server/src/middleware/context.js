import knex from '../db/knex.js';
import { HttpError } from '../lib/util.js';

/**
 * Request context.
 *
 * Auth is deliberately a stub: a header picks the acting user. That is fine for
 * an internal tool behind a VPN and honest about what it is. Swap this one
 * function for real sessions before this is exposed to the internet - every
 * route already reads tenant and user from here, so nothing downstream changes.
 */

let defaults = null;

async function loadDefaults() {
  if (defaults) return defaults;
  const tenant = await knex('tenants').orderBy('created_at').first();
  if (!tenant) return null;
  const user = await knex('users')
    .where({ tenant_id: tenant.id })
    .orderByRaw("case role when 'admin' then 0 when 'team_lead' then 1 else 2 end")
    .first();
  defaults = { tenantId: tenant.id, userId: user?.id || null };
  return defaults;
}

export async function contextMiddleware(c, next) {
  let tenantId = c.req.header('x-tenant-id');
  let userId = c.req.header('x-user-id');

  if (!tenantId || !userId) {
    const d = await loadDefaults();
    if (!d) throw new HttpError(503, 'No tenant seeded yet. Run: npm run setup');
    tenantId = tenantId || d.tenantId;
    userId = userId || d.userId;
  }

  c.set('tenantId', tenantId);
  c.set('userId', userId);
  await next();
}

export async function requireRole(c, roles) {
  const userId = c.get('userId');
  const user = await knex('users').where({ id: userId }).first();
  if (!user) throw new HttpError(401, 'Unknown user');
  if (!roles.includes(user.role)) {
    throw new HttpError(403, 'This needs one of: ' + roles.join(', ') + '. You are a ' + user.role + '.');
  }
  return user;
}

export function resetContextCache() {
  defaults = null;
}
