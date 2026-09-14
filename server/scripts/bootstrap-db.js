/**
 * Get the database ready, then get out of the way.
 *
 * Runs once per container start, before the API listens. Migrations are
 * idempotent so they run every time; the seed is not - it inserts fixed ids -
 * so it only runs when there is no tenant yet. A redeploy must never overwrite
 * a salesperson's pipeline.
 */
import knex from '../src/db/knex.js';

const RETRIES = Number(process.env.DB_WAIT_RETRIES || 30);
const force = /^(1|true|yes|on)$/i.test(process.env.FORCE_SEED || '');

async function waitForDb() {
  for (let attempt = 1; ; attempt++) {
    try {
      await knex.raw('select 1');
      return;
    } catch (e) {
      if (attempt >= RETRIES) throw e;
      console.log(`[db] waiting for postgres (${e.code || e.message}) ${attempt}/${RETRIES}`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  await waitForDb();

  const [batch, applied] = await knex.migrate.latest();
  console.log(
    applied.length
      ? `[db] applied ${applied.length} migration(s) as batch ${batch}`
      : '[db] schema already up to date'
  );

  const [{ count }] = await knex('tenants').count('* as count');
  if (Number(count) > 0 && !force) {
    console.log(`[db] ${count} tenant(s) already here, skipping the seed`);
    return;
  }
  await knex.seed.run();
  console.log('[db] seeded');
}

main()
  .then(() => knex.destroy())
  .catch(async (e) => {
    console.error('[db] bootstrap failed:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  });
