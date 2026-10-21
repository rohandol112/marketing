/**
 * Data cleanup from the command line.
 *
 *   npm run cleanup                 preview: the full report, nothing written
 *   npm run cleanup -- --apply      do it
 *   npm run cleanup -- --tenant=X   one workspace (default: all of them)
 *   npm run cleanup -- --json       the raw report, for piping somewhere
 *
 * The same job runs on its own every MAINTENANCE_INTERVAL_HOURS when
 * MAINTENANCE_AUTO is on; this is for running it now, or seeing what it would do.
 */
import knex from '../src/db/knex.js';
import { runMaintenance } from '../src/services/maintenance.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const asJson = args.includes('--json');
const tenantArg = (args.find((a) => a.startsWith('--tenant=')) || '').split('=')[1];

function line(label, value) {
  console.log('  ' + label.padEnd(34) + value);
}

function print(report) {
  const s = report.steps || {};
  console.log('\n' + (report.dryRun ? 'PREVIEW' : 'APPLIED') + ' - workspace ' + report.tenantId + (report.skipped ? ' - ' + report.skipped : ''));
  if (report.skipped) return;

  console.log('\nNormalised');
  line('leads scanned', s.normalise.scanned);
  line('leads with a field fixed', s.normalise.changed);
  for (const [f, n] of Object.entries(s.normalise.fields)) line('  ' + f, n);

  console.log('\nRe-categorised');
  line('leads moved', s.reclassify.changed);
  for (const [k, n] of Object.entries(s.reclassify.moves)) line('  ' + k, n);

  console.log('\nExcluded (not prospects)');
  line('newly flagged', s.exclude.flagged);
  for (const [k, n] of Object.entries(s.exclude.byKind)) line('  ' + k, n);
  for (const x of s.exclude.samples.slice(0, 8)) console.log('    - ' + x.name + ': ' + x.reason);

  console.log('\nDuplicates');
  line('clusters found', s.merge.clusters);
  line('duplicate leads merged away', s.merge.merged);
  line('left for a person (both in pipeline)', s.merge.needsReview);
  for (const x of s.merge.samples.slice(0, 8)) {
    console.log('    - kept "' + x.kept.name + '", merged ' + x.removed.map((r) => '"' + r.name + '"').join(', ') + ' (' + x.why.join(', ') + ')');
  }

  console.log('\nHousekeeping');
  for (const [k, n] of Object.entries(s.housekeep)) line(k, n);

  console.log('\nAfter rescoring');
  line('leads whose score or state changed', s.rescore.changed);
  line('qualified for review', s.rescore.qualified);
  line('hot (close this week, has phone)', s.rescore.hot);
  line('warm', s.rescore.warm);
  for (const [k, n] of Object.entries(s.rescore.statusMoves)) line('  ' + k, n);

  if (s.refresh) {
    console.log('\nGoogle data refresh');
    line('stale Google-sourced leads', s.refresh.staleGoogleData);
    line('Maps lookups queued', s.refresh.queuedLookups);
  }
  if (s.vacuum) line('\nvacuum', s.vacuum.ran ? 'done' : s.vacuum.error ? 'failed: ' + s.vacuum.error : 'not needed');

  console.log('\nLeads ' + report.totals.leadsBefore + ' -> ' + report.totals.leadsAfter + ' in ' + ((report.durationMs || 0) / 1000).toFixed(1) + 's');
  if (report.dryRun) console.log('\nNothing was written. Run with --apply to do it.\n');
}

async function main() {
  const tenants = tenantArg ? [{ id: tenantArg }] : await knex('tenants').select('id');
  if (!tenants.length) {
    console.log('No workspaces yet. Run: npm run setup');
    return;
  }
  for (const t of tenants) {
    const report = await runMaintenance({ tenantId: t.id, dryRun: !apply, trigger: 'cli' });
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else print(report);
  }
}

main()
  .then(() => knex.destroy())
  .catch(async (e) => {
    console.error('cleanup failed:', e.message);
    await knex.destroy().catch(() => {});
    process.exit(1);
  });
