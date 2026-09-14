/**
 * Row level security, opt-in.
 *
 * Honest caveat: this is defence in depth, not the primary boundary. The policy
 * allows access when `app.tenant_id` is unset, so migrations, the worker and
 * local dev keep working. It only bites once every request path runs inside a
 * transaction that does `SET LOCAL app.tenant_id = '<id>'` (see withTenant() in
 * src/db/knex.js). The real guarantee today is that every repository query
 * filters on tenant_id - this catches the query someone forgets.
 *
 * Turn it into a hard boundary before onboarding a second paying tenant:
 *   1. connect the app as a non-superuser, non-owner role
 *   2. route every request through withTenant()
 *   3. drop the `IS NULL` escape from the policies below
 */

const TENANT_TABLES = [
  'users', 'service_catalog', 'packages', 'scoring_configs', 'areas',
  'discovery_runs', 'leads', 'lead_stage_history', 'activities',
  'ai_suggestions', 'proposals', 'dnc', 'jobs',
];

export async function up(knex) {
  for (const table of TENANT_TABLES) {
    await knex.raw('ALTER TABLE ?? ENABLE ROW LEVEL SECURITY', [table]);
    await knex.raw(
      `CREATE POLICY tenant_isolation ON ?? USING (
         current_setting('app.tenant_id', true) IS NULL
         OR current_setting('app.tenant_id', true) = ''
         OR tenant_id = current_setting('app.tenant_id', true)
       )`,
      [table]
    );
  }
}

export async function down(knex) {
  for (const table of TENANT_TABLES) {
    await knex.raw('DROP POLICY IF EXISTS tenant_isolation ON ??', [table]);
    await knex.raw('ALTER TABLE ?? DISABLE ROW LEVEL SECURITY', [table]);
  }
}
