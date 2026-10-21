/**
 * Lead quality and data hygiene.
 *
 * New columns, each answering a question the pipeline kept getting wrong:
 *
 *   phone_type        mobile, landline, toll-free or invalid. A wa.me link to a
 *                     landline is a dead end, and an invalid number is not
 *                     evidence of anything.
 *   exclusion         why a lead is not a prospect whatever it scores: a chain
 *                     outlet, a government body, a placeholder listing, a
 *                     duplicate. 'none' means a person cleared it, for good.
 *   social_audit      what Instagram's own API says about their account.
 *   deal_score        "can we close a big deal here this week" - ranks the hot
 *                     list, never qualifies anything.
 *
 * Two tables:
 *
 *   lead_suppressions keys of leads that were merged away or purged, so the
 *                     next sweep does not quietly bring them back.
 *   maintenance_runs  what every cleanup did, row by row, so a merge or a purge
 *                     can always be explained afterwards.
 *
 * The data fixes here are the ones the constraints depend on and that SQL can
 * do safely. Anything that needs the application's rules - phone parsing,
 * dedupe keys, chain detection, merges - is the maintenance job's, which runs
 * on its own shortly after boot and can be previewed first.
 */

const WEBSITE_STATUSES = ['none', 'unknown', 'ok', 'placeholder', 'parked', 'broken', 'social_only', 'protected'];
const EXCLUSIONS = ['chain', 'government', 'non_commercial', 'junk', 'out_of_area', 'duplicate', 'none'];
const PHONE_TYPES = ['mobile', 'landline', 'tollfree', 'unknown', 'invalid'];
const COUNTS = ['review_count', 'ig_followers', 'li_followers', 'fb_followers', 'years_in_business', 'locations_count'];
const TEXTS = ['phone', 'email', 'website', 'website_host', 'ig_handle', 'locality', 'postal_code', 'address'];

const list = (values) => values.map((v) => "'" + v + "'").join(',');

export async function up(knex) {
  await knex.schema.alterTable('leads', (t) => {
    t.text('phone_type');
    t.text('exclusion');
    t.text('exclusion_reason');
    t.jsonb('social_audit').defaultTo('{}');
    t.integer('deal_score').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('lead_suppressions', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('kind').notNullable();        // external | place | dedupe
    t.text('value').notNullable();
    t.text('reason');
    t.text('lead_name');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.unique(['tenant_id', 'kind', 'value']);
  });

  await knex.schema.createTable('maintenance_runs', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('status').notNullable().defaultTo('running');   // running | done | failed
    t.boolean('dry_run').notNullable().defaultTo(false);
    t.text('trigger');                                      // schedule | manual | cli
    t.jsonb('report').defaultTo('{}');
    t.text('error');
    t.timestamp('started_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true });
    t.index(['tenant_id', 'started_at']);
  });

  for (const table of ['lead_suppressions', 'maintenance_runs']) {
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

  // ---- values that cannot be true are unknown, and unknown is NULL ----
  await knex.raw('UPDATE leads SET rating = NULL WHERE rating IS NOT NULL AND (rating < 0 OR rating > 5)');
  for (const col of COUNTS) {
    await knex.raw('UPDATE leads SET ?? = NULL WHERE ?? < 0', [col, col]);
  }
  for (const col of TEXTS) {
    await knex.raw(
      "UPDATE leads SET ?? = NULLIF(btrim(??), '') WHERE ?? IS NOT NULL AND (?? <> btrim(??) OR btrim(??) = '')",
      [col, col, col, col, col, col]
    );
  }
  await knex.raw(`
    UPDATE leads SET name = btrim(regexp_replace(name, '\\s+', ' ', 'g'))
    WHERE name <> btrim(regexp_replace(name, '\\s+', ' ', 'g'))
  `);
  // A status nothing in the code writes is a status nobody can act on.
  await knex.raw(
    'UPDATE leads SET website_status = NULL WHERE website_status IS NOT NULL AND website_status NOT IN (' + list(WEBSITE_STATUSES) + ')'
  );

  await knex.raw('ALTER TABLE leads ADD CONSTRAINT leads_rating_chk CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5))');
  await knex.raw(
    'ALTER TABLE leads ADD CONSTRAINT leads_counts_chk CHECK (' +
    COUNTS.map((c) => '(' + c + ' IS NULL OR ' + c + ' >= 0)').join(' AND ') + ')'
  );
  await knex.raw(
    'ALTER TABLE leads ADD CONSTRAINT leads_website_status_chk CHECK (website_status IS NULL OR website_status IN (' + list(WEBSITE_STATUSES) + '))'
  );
  await knex.raw(
    'ALTER TABLE leads ADD CONSTRAINT leads_exclusion_chk CHECK (exclusion IS NULL OR exclusion IN (' + list(EXCLUSIONS) + '))'
  );
  await knex.raw(
    'ALTER TABLE leads ADD CONSTRAINT leads_phone_type_chk CHECK (phone_type IS NULL OR phone_type IN (' + list(PHONE_TYPES) + '))'
  );

  // ---- the queries dedupe, the filters and the cleanup actually run ----
  await knex.raw('CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads (tenant_id, phone_normalized) WHERE phone_normalized IS NOT NULL');
  await knex.raw('CREATE INDEX IF NOT EXISTS leads_host_idx ON leads (tenant_id, website_host) WHERE website_host IS NOT NULL');
  await knex.raw('CREATE INDEX IF NOT EXISTS leads_category_idx ON leads (tenant_id, normalized_category)');
  await knex.raw('CREATE INDEX IF NOT EXISTS leads_run_idx ON leads (tenant_id, run_id)');
  await knex.raw('CREATE INDEX IF NOT EXISTS leads_geo_idx ON leads (tenant_id, lat, lng) WHERE lat IS NOT NULL');
  await knex.raw('CREATE INDEX IF NOT EXISTS leads_deal_idx ON leads (tenant_id, deal_score DESC)');
  await knex.raw('CREATE INDEX IF NOT EXISTS leads_locality_idx ON leads (tenant_id, lower(btrim(locality)))');
  await knex.raw('CREATE INDEX IF NOT EXISTS jobs_finished_idx ON jobs (status, finished_at)');
  await knex.raw('CREATE INDEX IF NOT EXISTS api_usage_tenant_created_idx ON api_usage (tenant_id, created_at)');
  await knex.raw('CREATE INDEX IF NOT EXISTS ai_suggestions_unacted_idx ON ai_suggestions (tenant_id, created_at) WHERE action IS NULL');
}

export async function down(knex) {
  for (const idx of [
    'leads_phone_idx', 'leads_host_idx', 'leads_category_idx', 'leads_run_idx', 'leads_geo_idx', 'leads_deal_idx',
    'leads_locality_idx', 'jobs_finished_idx', 'api_usage_tenant_created_idx', 'ai_suggestions_unacted_idx',
  ]) {
    await knex.raw('DROP INDEX IF EXISTS ' + idx);
  }
  for (const c of ['leads_rating_chk', 'leads_counts_chk', 'leads_website_status_chk', 'leads_exclusion_chk', 'leads_phone_type_chk']) {
    await knex.raw('ALTER TABLE leads DROP CONSTRAINT IF EXISTS ' + c);
  }
  await knex.schema.dropTableIfExists('maintenance_runs');
  await knex.schema.dropTableIfExists('lead_suppressions');
  await knex.schema.alterTable('leads', (t) => {
    t.dropColumn('phone_type');
    t.dropColumn('exclusion');
    t.dropColumn('exclusion_reason');
    t.dropColumn('social_audit');
    t.dropColumn('deal_score');
  });
}
