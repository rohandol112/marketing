/**
 * Token accounting per discovery run.
 *
 * `api_calls` and `cost_usd` only ever described the Places path. When
 * discovery runs through a model, calls are a poor proxy for what it actually
 * consumed - one sweep of 30 categories is 30 calls but tens of thousands of
 * tokens, and tokens are what a paid tier bills for.
 *
 * OSM and Places runs leave these null, which is correct: neither spends a
 * token.
 */

export async function up(knex) {
  await knex.schema.alterTable('discovery_runs', (t) => {
    t.integer('tokens_in');
    t.integer('tokens_out');
    t.text('llm_model');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('discovery_runs', (t) => {
    t.dropColumn('tokens_in');
    t.dropColumn('tokens_out');
    t.dropColumn('llm_model');
  });
}
