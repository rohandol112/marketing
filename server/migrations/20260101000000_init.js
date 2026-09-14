/**
 * Initial schema. Multi-tenant from commit one: every business table carries
 * tenant_id, and every repository query filters on it. Retrofitting this later
 * is a rewrite, so it goes in now even though there is only one tenant today.
 */

export async function up(knex) {
  await knex.raw('CREATE EXTENSION IF NOT EXISTS pg_trgm');

  await knex.schema.createTable('tenants', (t) => {
    t.text('id').primary();
    t.text('name').notNullable();
    t.text('country_code');            // default dial code for phone normalisation
    t.text('currency').defaultTo('INR');
    t.text('timezone').defaultTo('Asia/Kolkata');
    t.text('brand_voice');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('users', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('email');
    t.text('role').notNullable();
    t.integer('open_lead_cap').defaultTo(25);
    t.boolean('active').defaultTo(true);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['tenant_id']);
  });
  await knex.raw("ALTER TABLE users ADD CONSTRAINT users_role_chk CHECK (role IN ('admin','team_lead','rep'))");

  await knex.schema.createTable('service_catalog', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('group_name').notNullable();
    t.text('sub_group');
    t.text('name').notNullable();
    t.jsonb('gap_tags').defaultTo('[]');   // which detected gaps this service answers
    t.boolean('active').defaultTo(true);
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('packages', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('name').notNullable();
    t.text('tagline');
    t.integer('price_min');
    t.integer('price_max');
    t.text('currency').defaultTo('INR');
    t.text('billing').defaultTo('one_time');
    t.jsonb('includes').defaultTo('[]');
    t.text('best_for');
    t.integer('sort_order').defaultTo(0);
    t.boolean('active').defaultTo(true);
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('scoring_configs', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.integer('version').notNullable().defaultTo(1);
    t.jsonb('config').notNullable();
    t.boolean('active').defaultTo(true);
    t.text('note');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['tenant_id', 'active']);
  });

  // A saved search area. Works anywhere on earth: centre point + radius.
  await knex.schema.createTable('areas', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('label').notNullable();
    t.text('country_code');
    t.text('region_code');
    t.text('language_code').defaultTo('en');
    t.double('lat').notNullable();
    t.double('lng').notNullable();
    t.integer('radius_m').notNullable().defaultTo(5000);
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['tenant_id']);
  });

  await knex.schema.createTable('discovery_runs', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('area_label');
    t.double('lat');
    t.double('lng');
    t.integer('radius_m');
    t.text('region_code');
    t.text('language_code');
    t.jsonb('categories').defaultTo('[]');
    t.jsonb('params').defaultTo('{}');
    t.text('status').notNullable().defaultTo('queued');
    t.jsonb('progress').defaultTo('{}');
    t.text('source').defaultTo('places');
    t.integer('api_calls').defaultTo(0);
    t.decimal('cost_usd', 10, 4).defaultTo(0);
    t.integer('found_count').defaultTo(0);
    t.integer('new_count').defaultTo(0);
    t.integer('dupe_count').defaultTo(0);
    t.text('error');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('finished_at', { useTz: true });
    t.index(['tenant_id', 'created_at']);
  });

  await knex.schema.createTable('leads', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable().references('id').inTable('tenants').onDelete('CASCADE');
    t.text('run_id');
    t.text('google_place_id');
    t.text('dedupe_key');

    t.text('name').notNullable();
    t.text('category');                 // raw Google primary type display name
    t.text('normalized_category');      // our catalogue id
    t.text('address');
    t.text('locality');
    t.text('region');
    t.text('country_code');
    t.text('postal_code');
    t.double('lat');
    t.double('lng');
    t.integer('distance_m');

    t.text('phone');
    t.text('phone_normalized');
    t.text('email');
    t.text('website');
    t.text('website_host');
    t.text('maps_url');

    t.double('rating');
    t.integer('review_count');
    t.text('business_status');

    // rep-verified fields: no legal API exists for these, so they are audit inputs
    t.text('ig_handle');
    t.integer('ig_followers');
    t.integer('li_followers');
    t.integer('fb_followers');
    t.integer('years_in_business');
    t.integer('locations_count');
    t.boolean('runs_ads');
    t.boolean('agency_managed');

    t.text('website_status');           // none|ok|placeholder|broken|parked
    t.jsonb('website_audit');
    t.integer('psi_mobile');
    t.boolean('has_https');
    t.boolean('mobile_friendly');

    t.integer('score').defaultTo(0);
    t.jsonb('score_breakdown').defaultTo('{}');
    t.text('tier');
    t.boolean('disqualified').defaultTo(false);
    t.text('disqualify_reason');

    t.text('status').notNullable().defaultTo('pending_review');
    t.text('stage').notNullable().defaultTo('todo');
    t.text('assigned_to').references('id').inTable('users').onDelete('SET NULL');

    t.timestamp('next_due_at', { useTz: true });
    t.timestamp('last_activity_at', { useTz: true });
    t.integer('activity_count').defaultTo(0);
    t.text('loss_reason');
    t.integer('won_amount');

    t.jsonb('source_url').defaultTo('{}');   // provenance per field: the DPDP paper trail
    t.timestamp('fields_refreshed_at', { useTz: true });
    t.timestamp('stale_after', { useTz: true });  // Google ToS: refresh non-id fields within 30d
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());

    t.index(['tenant_id', 'dedupe_key']);
    t.index(['tenant_id', 'status', 'stage']);
    t.index(['tenant_id', 'assigned_to']);
    t.index(['tenant_id', 'score']);
  });
  await knex.raw(
    'CREATE UNIQUE INDEX leads_tenant_place_uq ON leads (tenant_id, google_place_id) WHERE google_place_id IS NOT NULL'
  );
  await knex.raw('CREATE INDEX leads_name_trgm ON leads USING gin (name gin_trgm_ops)');

  await knex.schema.createTable('lead_stage_history', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable();
    t.text('lead_id').notNullable().references('id').inTable('leads').onDelete('CASCADE');
    t.text('from_stage');
    t.text('to_stage').notNullable();
    t.text('by_user');
    t.text('reason');
    t.timestamp('at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['lead_id', 'at']);
  });

  await knex.schema.createTable('activities', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable();
    t.text('lead_id').notNullable().references('id').inTable('leads').onDelete('CASCADE');
    t.text('user_id');
    t.text('type').notNullable();      // call|whatsapp|email|meeting|visit|note|proposal_sent
    t.text('channel');
    t.text('body');
    t.text('outcome');
    t.jsonb('extracted');              // structured output of the call-note extractor
    t.timestamp('occurred_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('next_due_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['lead_id', 'occurred_at']);
  });

  // Every suggestion is logged with what the rep did to it. That is both the
  // eval dataset and the number you show another agency when you sell this.
  await knex.schema.createTable('ai_suggestions', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable();
    t.text('lead_id').references('id').inTable('leads').onDelete('CASCADE');
    t.text('kind').notNullable();
    t.text('stage');
    t.text('input_hash').notNullable();
    t.jsonb('output').notNullable();
    t.text('model');
    t.integer('latency_ms');
    t.integer('tokens_in');
    t.integer('tokens_out');
    t.boolean('fallback').defaultTo(false);
    t.text('action');                  // accepted|edited|rejected
    t.text('edited_text');
    t.timestamp('acted_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['tenant_id', 'kind', 'input_hash']);
    t.index(['lead_id', 'created_at']);
  });

  await knex.schema.createTable('proposals', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable();
    t.text('lead_id').notNullable().references('id').inTable('leads').onDelete('CASCADE');
    t.text('package_id');
    t.integer('amount');
    t.text('currency');
    t.text('status').defaultTo('draft');
    t.timestamp('sent_at', { useTz: true });
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['lead_id']);
  });

  await knex.schema.createTable('dnc', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable();
    t.text('phone_normalized');
    t.text('email');
    t.text('reason');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['tenant_id', 'phone_normalized']);
  });

  await knex.schema.createTable('jobs', (t) => {
    t.text('id').primary();
    t.text('tenant_id').notNullable();
    t.text('kind').notNullable();
    t.jsonb('payload').defaultTo('{}');
    t.text('status').notNullable().defaultTo('queued');
    t.integer('attempts').defaultTo(0);
    t.text('error');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.timestamp('started_at', { useTz: true });
    t.timestamp('finished_at', { useTz: true });
    t.index(['status', 'created_at']);
  });

  await knex.schema.createTable('api_usage', (t) => {
    t.text('id').primary();
    t.text('tenant_id');
    t.text('provider').notNullable();   // places|gemini|pagespeed
    t.text('operation');
    t.integer('units').defaultTo(1);
    t.decimal('cost_usd', 10, 6).defaultTo(0);
    t.jsonb('meta').defaultTo('{}');
    t.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
    t.index(['provider', 'created_at']);
  });
}

export async function down(knex) {
  for (const table of [
    'api_usage', 'jobs', 'dnc', 'proposals', 'ai_suggestions', 'activities',
    'lead_stage_history', 'leads', 'discovery_runs', 'areas', 'scoring_configs',
    'packages', 'service_catalog', 'users', 'tenants',
  ]) {
    await knex.schema.dropTableIfExists(table);
  }
}
