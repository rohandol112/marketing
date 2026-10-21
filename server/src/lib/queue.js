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

/**
 * What the worker got through since the last report. Hundreds of audits and
 * lookups follow a sweep; a line each is noise, silence looks like a hang. One
 * line every half minute while there is work says it is alive and how far along.
 */
const REPORT_MS = 30000;
let tally = { done: {}, failed: 0, retried: 0, ms: 0 };

function count(kind, ok, ms, retrying) {
  if (ok) tally.done[kind] = (tally.done[kind] || 0) + 1;
  else if (retrying) tally.retried++;
  else tally.failed++;
  tally.ms += ms;
}

async function report() {
  const kinds = Object.entries(tally.done);
  const done = kinds.reduce((n, [, v]) => n + v, 0);
  if (!done && !tally.failed && !tally.retried) return;
  const t = tally;
  tally = { done: {}, failed: 0, retried: 0, ms: 0 };
  const waiting = await knex('jobs').where('status', 'queued').count('* as n').first().catch(() => null);
  console.log(
    '[queue] last ' + REPORT_MS / 1000 + 's: ' + done + ' done'
    + (kinds.length ? ' (' + kinds.map(([k, v]) => k + ' ' + v).join(', ') + ')' : '')
    + (t.retried ? ', ' + t.retried + ' to retry' : '') + (t.failed ? ', ' + t.failed + ' failed' : '')
    + (done ? ', avg ' + (t.ms / (done + t.failed + t.retried) / 1000).toFixed(1) + 's' : '')
    + (waiting ? '; ' + Number(waiting.n) + ' waiting' : '')
  );
}

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
  enrich_maps: 160,
  enrich_instagram: 170,
  enrich_social: 175,
  geocode_lead: 180,
  audit_lead: 200,
  maintenance: 250,
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

  const started = Date.now();
  try {
    await handler(job.payload || {}, job);
    await knex('jobs').where({ id: job.id }).update({ status: 'done', finished_at: now() });
    count(job.kind, true, Date.now() - started);
  } catch (e) {
    const retryable = job.attempts < 3 && e.retryable !== false;
    console.error('[queue] ' + job.kind + ' ' + job.id + ' failed (attempt ' + job.attempts + (retryable ? ', will retry' : ', giving up') + '): ' + e.message);
    count(job.kind, false, Date.now() - started, retryable);
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
  let lastReport = Date.now();

  while (!stopping) {
    try {
      // Sweep for jobs a dead worker left behind. Continuous, not boot-only.
      sinceReap += pollMs;
      if (sinceReap >= 30000) {
        sinceReap = 0;
        await reapOrphans().catch((e) => console.warn('[queue] reap failed:', e.message));
      }
      if (Date.now() - lastReport >= REPORT_MS) {
        lastReport = Date.now();
        await report().catch(() => {});
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
