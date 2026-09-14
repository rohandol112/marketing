import Knex from 'knex';
import knexConfig from '../../knexfile.js';
import { uid, now } from '../lib/util.js';

const env = process.env.NODE_ENV === 'production' ? 'production' : 'development';

export const knex = Knex(knexConfig[env]);

/**
 * Run a callback inside a transaction scoped to one tenant. Sets the GUC that
 * the RLS policies read, so a query that forgets its tenant_id filter still
 * cannot cross tenants.
 */
export async function withTenant(tenantId, fn) {
  return knex.transaction(async (trx) => {
    await trx.raw("SELECT set_config('app.tenant_id', ?, true)", [String(tenantId)]);
    return fn(trx);
  });
}

export async function logUsage({ tenantId, provider, operation, units = 1, costUsd = 0, meta }) {
  try {
    await knex('api_usage').insert({
      id: uid('u_'),
      tenant_id: tenantId || null,
      provider,
      operation,
      units,
      cost_usd: costUsd,
      meta: meta ? JSON.stringify(meta) : '{}',
      created_at: now(),
    });
  } catch (e) {
    // usage logging must never take a request down
    console.warn('[usage] failed to log', provider, operation, e.message);
  }
}

export async function ping() {
  await knex.raw('select 1');
}

export default knex;
