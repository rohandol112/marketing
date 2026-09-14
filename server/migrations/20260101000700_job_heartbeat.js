/**
 * Job heartbeats.
 *
 * A worker that is killed mid-job leaves the row saying `running` forever.
 * Nothing ever picks it up again, and from the outside a dead job is
 * indistinguishable from a slow one - a discovery run sat at "24 of 62
 * categories" for a quarter of an hour looking busy while nothing owned it.
 *
 * `requeueStale` at boot was not enough: it only ran at startup, and only for
 * jobs older than a fixed window, so anything orphaned shortly before a restart
 * stayed stuck.
 *
 * With a heartbeat the distinction is explicit. A live worker touches its jobs
 * every few seconds; a job whose heartbeat has gone cold is orphaned regardless
 * of how recently it started, and the reaper can requeue it safely.
 */

export async function up(knex) {
  await knex.schema.alterTable('jobs', (t) => {
    t.timestamp('heartbeat_at', { useTz: true });
    t.text('worker_id');
  });
  await knex.raw('CREATE INDEX jobs_heartbeat_idx ON jobs (status, heartbeat_at)');

  // Anything already stuck is by definition orphaned - nothing is beating for it.
  await knex.raw(`
    UPDATE jobs
    SET status = 'queued', started_at = NULL, error = 'Requeued: orphaned before heartbeats existed'
    WHERE status = 'running'
  `);
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS jobs_heartbeat_idx');
  await knex.schema.alterTable('jobs', (t) => {
    t.dropColumn('heartbeat_at');
    t.dropColumn('worker_id');
  });
}
