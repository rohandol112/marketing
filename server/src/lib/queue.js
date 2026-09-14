import knex from '../db/knex.js';
import { uid, now, sleep } from './util.js';

/**
 * Identifies this process to the jobs table. A job carrying someone else's
 * worker id with a cold heartbeat is orphaned and safe to requeue.
 */
const WORKER_ID = uid('w_');
const HEARTBEAT_MS = 10000;
const ORPHAN_AFTER_MS = 60000;

/**
 * Postgres-backed job queue.
 *
 * A 90-call Places sweep must never run inside a request handler - it takes
 * minutes and the browser will give up long before it finishes. This is the
 * smallest thing that keeps that promise without adding Redis: jobs live in a
 * table, one worker loop claims them with SKIP LOCKED, and the HTTP layer only
 * ever enqueues and polls.
 *
 * The claim is already safe for multiple worker processes, so when a single
 * loop stops keeping up, scale by running `node src/worker.js` a second time
 * rather than rewriting this.
 */

const handlers = new Map();
let running = false;
let stopping = false;
let activeJobs = 0;

export function registerHandler(kind, fn) {
  handlers.set(kind, fn);
}

/**
 * Lower runs first. Anything a person is watching outranks housekeeping, or a
 * bulk re-audit of 300 sites starves the sweep they just started.
 */
export const PRIORITY = {
  discovery: 10,
  rescore_tenant: 50,
  audit_lead: 200,
};

export async function enqueue({ tenantId, kind, payload, priority }) {
  const id = uid('job_');
  await knex('jobs').insert({
    id,
    tenant_id: tenantId,
    kind,
    payload: JSON.stringify(payload || {}),
    status: 'queued',
    priority: priority ?? PRIORITY[kind] ?? 100,
    created_at: now(),
  });
  return id;
}

async function claimNext() {
  const rows = await knex.raw(
    `UPDATE jobs
        SET status = 'running',
            started_at = now(),
            heartbeat_at = now(),
            worker_id = ?,
            attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE status = 'queued'
         ORDER BY priority, created_at
           FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING *`,
    [WORKER_ID]
  );
  return rows.rows?.[0] || null;
}

/**
 * Requeue jobs whose worker stopped beating.
 *
 * This is what makes a killed worker recoverable. Runs continuously rather than
 * only at boot, because the process that orphaned a job is often not the one
 * that starts next - and a stuck job that looks busy is worse than one that
 * looks failed.
 */
export async function reapOrphans(orphanAfterMs = ORPHAN_AFTER_MS) {
  const r = await knex('jobs')
    .where('status', 'running')
    .andWhere((qb) =>
      qb.whereNull('heartbeat_at').orWhereRaw('heartbeat_at < now() - (? || ' + "' milliseconds'" + ')::interval', [orphanAfterMs])
    )
    .update({
      status: 'queued',
      started_at: null,
      heartbeat_at: null,
      error: 'Requeued: worker stopped responding',
    });
  if (r) console.log('[queue] reaped ' + r + ' orphaned job(s)');
  return r;
}

async function runOne(job) {
  const handler = handlers.get(job.kind);
  if (!handler) {
    await knex('jobs').where({ id: job.id }).update({
      status: 'failed',
      error: 'No handler registered for kind: ' + job.kind,
      finished_at: now(),
    });
    return;
  }

  // Beat while the handler runs, so a long job is distinguishable from a dead
  // one. A discovery sweep of 62 categories legitimately takes many minutes.
  const beat = setInterval(() => {
    knex('jobs').where({ id: job.id }).update({ heartbeat_at: now() })
      .catch((e) => console.warn('[queue] heartbeat failed for ' + job.id + ':', e.message));
  }, HEARTBEAT_MS);

  try {
    await handler(job.payload || {}, job);
    await knex('jobs').where({ id: job.id }).update({ status: 'done', finished_at: now() });
  } catch (e) {
    console.error('[queue] job ' + job.id + ' (' + job.kind + ') failed:', e.message);
    const retryable = job.attempts < 3 && e.retryable !== false;
    await knex('jobs').where({ id: job.id }).update({
      status: retryable ? 'queued' : 'failed',
      error: String(e.message).slice(0, 2000),
      finished_at: retryable ? null : now(),
      heartbeat_at: null,
    });
  } finally {
    clearInterval(beat);
  }
}

export async function startWorker({ pollMs = 1000, concurrency = 1 } = {}) {
  if (running) return;
  running = true;
  stopping = false;
  console.log('[queue] worker started (concurrency ' + concurrency + ')');

  let sinceReap = 0;

  while (!stopping) {
    try {
      // Sweep for jobs a dead worker left behind. Continuous, not boot-only.
      sinceReap += pollMs;
      if (sinceReap >= 30000) {
        sinceReap = 0;
        await reapOrphans().catch((e) => console.warn('[queue] reap failed:', e.message));
      }

      if (activeJobs >= concurrency) {
        await sleep(pollMs);
        continue;
      }
      const job = await claimNext();
      if (!job) {
        await sleep(pollMs);
        continue;
      }
      activeJobs++;
      runOne(job).finally(() => { activeJobs--; });
    } catch (e) {
      console.error('[queue] loop error:', e.message);
      await sleep(3000);
    }
  }

  running = false;
  console.log('[queue] worker stopped');
}

export function stopWorker() {
  stopping = true;
}

/** Anything left `running` when the process died is stuck. Reclaim on boot. */
export async function requeueStale(olderThanMinutes = 15) {
  const r = await knex('jobs')
    .where('status', 'running')
    .andWhereRaw("started_at < now() - (? || ' minutes')::interval", [olderThanMinutes])
    .update({ status: 'queued', error: 'Requeued after worker restart' });
  if (r) console.log('[queue] requeued ' + r + ' stale job(s)');
  return r;
}

export function queueStats() {
  return { registered: [...handlers.keys()], running, activeJobs };
}

/** What the worker is actually chewing through, for the status screen. */
export async function queueDepth() {
  const rows = await knex('jobs')
    .whereIn('status', ['queued', 'running'])
    .select('kind', 'status')
    .count('* as n')
    .groupBy('kind', 'status');
  return rows.map((r) => ({ kind: r.kind, status: r.status, count: Number(r.n) }));
}
