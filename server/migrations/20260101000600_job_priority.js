/**
 * Job priority.
 *
 * A bulk re-audit queues hundreds of jobs, each spending 10-30s in PageSpeed.
 * With one FIFO and a single worker, a sweep an operator just started sits
 * behind all of them and looks broken. Interactive work has to be able to jump
 * a background backlog.
 *
 * Lower number runs first.
 */

export async function up(knex) {
  await knex.schema.alterTable('jobs', (t) => {
    t.integer('priority').notNullable().defaultTo(100);
  });
  await knex.raw('DROP INDEX IF EXISTS jobs_status_created_at_index');
  await knex.raw('CREATE INDEX jobs_claim_idx ON jobs (status, priority, created_at)');

  // Discovery is something a person is watching; audits are housekeeping.
  await knex('jobs').where('kind', 'discovery').update({ priority: 10 });
  await knex('jobs').where('kind', 'rescore_tenant').update({ priority: 50 });
  await knex('jobs').where('kind', 'audit_lead').update({ priority: 200 });
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS jobs_claim_idx');
  await knex.schema.alterTable('jobs', (t) => t.dropColumn('priority'));
  await knex.raw('CREATE INDEX jobs_status_created_at_index ON jobs (status, created_at)');
}
