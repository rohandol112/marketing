import { Hono } from 'hono';
import knex from '../db/knex.js';
import { STAGES, STAGE_META, LOSS_REASONS } from '../services/leads.js';

const app = new Hono();

const BANDS = [
  { id: '80-100', min: 80, max: 101 },
  { id: '70-79', min: 70, max: 80 },
  { id: '60-69', min: 60, max: 70 },
  { id: '50-59', min: 50, max: 60 },
  { id: '0-49', min: 0, max: 50 },
];

app.get('/funnel', async (c) => {
  const tenantId = c.get('tenantId');
  const rows = await knex('leads')
    .where({ tenant_id: tenantId, status: 'approved', disqualified: false })
    .select('stage')
    .count('* as n')
    .groupBy('stage');

  const byStage = Object.fromEntries(rows.map((r) => [r.stage, Number(r.n)]));
  const total = Object.values(byStage).reduce((a, b) => a + b, 0);

  const queue = await knex('leads')
    .where({ tenant_id: tenantId })
    .select('status')
    .count('* as n')
    .groupBy('status');

  return c.json({
    stages: STAGES.map((s) => ({
      stage: s,
      label: STAGE_META[s].label,
      count: byStage[s] || 0,
      pct: total ? Math.round(((byStage[s] || 0) / total) * 100) : 0,
    })),
    total,
    byStatus: Object.fromEntries(queue.map((r) => [r.status, Number(r.n)])),
  });
});

/**
 * Conversion rate by score band. This is the number the whole product is for.
 * If the top band does not close better than the bottom band, the score is
 * decoration and the weights need retuning.
 */
app.get('/score-bands', async (c) => {
  const tenantId = c.get('tenantId');
  const leads = await knex('leads')
    .where({ tenant_id: tenantId, status: 'approved' })
    .select('score', 'stage', 'won_amount', 'tier');

  const out = BANDS.map((band) => {
    const inBand = leads.filter((l) => l.score >= band.min && l.score < band.max);
    const closed = inBand.filter((l) => l.stage === 'success' || l.stage === 'failed');
    const won = inBand.filter((l) => l.stage === 'success');
    const amounts = won.map((w) => Number(w.won_amount || 0)).filter(Boolean);

    return {
      band: band.id,
      leads: inBand.length,
      closed: closed.length,
      won: won.length,
      winRate: closed.length ? Math.round((won.length / closed.length) * 100) : null,
      avgDealSize: amounts.length ? Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length) : null,
      revenue: amounts.reduce((a, b) => a + b, 0),
    };
  });

  const withData = out.filter((b) => b.closed >= 3);
  let verdict = 'Not enough closed deals yet. Come back after about 30 closes.';
  if (withData.length >= 2) {
    const top = withData[0];
    const bottom = withData[withData.length - 1];
    if (top.winRate != null && bottom.winRate != null) {
      verdict = top.winRate > bottom.winRate + 10
        ? 'The score is predictive: ' + top.band + ' converts at ' + top.winRate + '% versus ' + bottom.winRate + '% for ' + bottom.band + '.'
        : 'The score is NOT separating winners from losers (' + top.winRate + '% vs ' + bottom.winRate + '%). Retune the weights.';
    }
  }

  return c.json({ bands: out, verdict });
});

/**
 * Which score component actually predicts a close. Compare the average points a
 * component contributed on won deals against lost ones - a component that
 * scores the same either way is carrying no information and its weight should
 * come down.
 */
app.get('/weight-signal', async (c) => {
  const tenantId = c.get('tenantId');
  const closed = await knex('leads')
    .where({ tenant_id: tenantId })
    .whereIn('stage', ['success', 'failed'])
    .select('stage', 'score_breakdown');

  const components = ['demand', 'digital', 'affordability', 'trigger'];
  const acc = {};
  for (const comp of components) acc[comp] = { won: [], lost: [] };

  for (const row of closed) {
    const b = row.score_breakdown;
    if (!b || !b.demand) continue;
    for (const comp of components) {
      const pts = b[comp]?.points;
      if (typeof pts === 'number') acc[comp][row.stage === 'success' ? 'won' : 'lost'].push(pts);
    }
  }

  const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

  const results = components.map((comp) => {
    const w = avg(acc[comp].won);
    const l = avg(acc[comp].lost);
    const lift = w != null && l != null ? Math.round((w - l) * 100) / 100 : null;
    return {
      component: comp,
      wonSample: acc[comp].won.length,
      lostSample: acc[comp].lost.length,
      avgWon: w == null ? null : Math.round(w * 100) / 100,
      avgLost: l == null ? null : Math.round(l * 100) / 100,
      lift,
      recommendation:
        acc[comp].won.length < 10
          ? 'Not enough data'
          : lift > 2
            ? 'Predictive - consider increasing this weight'
            : lift < -2
              ? 'Inverted - this component is pointing the wrong way, investigate'
              : 'Carrying little signal - consider reducing this weight',
    };
  });

  return c.json({
    components: results,
    totalClosed: closed.length,
    note: 'This is a difference of means, not a regression. Treat it as a direction to look in, not a coefficient.',
  });
});

app.get('/loss-reasons', async (c) => {
  const rows = await knex('leads')
    .where({ tenant_id: c.get('tenantId'), stage: 'failed' })
    .whereNotNull('loss_reason')
    .select('loss_reason')
    .count('* as n')
    .groupBy('loss_reason')
    .orderBy('n', 'desc');

  const labels = Object.fromEntries(LOSS_REASONS.map((r) => [r.id, r.label]));
  const total = rows.reduce((a, r) => a + Number(r.n), 0);

  return c.json({
    total,
    reasons: rows.map((r) => ({
      id: r.loss_reason,
      label: labels[r.loss_reason] || r.loss_reason,
      count: Number(r.n),
      pct: total ? Math.round((Number(r.n) / total) * 100) : 0,
      recyclable: LOSS_REASONS.find((x) => x.id === r.loss_reason)?.recycle || false,
    })),
  });
});

app.get('/reps', async (c) => {
  const tenantId = c.get('tenantId');
  const rows = await knex('leads')
    .leftJoin('users', 'leads.assigned_to', 'users.id')
    .where('leads.tenant_id', tenantId)
    .andWhere('leads.status', 'approved')
    .whereNotNull('leads.assigned_to')
    .select('users.id', 'users.name', 'users.open_lead_cap', 'leads.stage', 'leads.won_amount')
    .limit(5000);

  const by = {};
  for (const r of rows) {
    by[r.id] ||= { id: r.id, name: r.name, cap: r.open_lead_cap, open: 0, won: 0, lost: 0, revenue: 0 };
    if (r.stage === 'success') { by[r.id].won++; by[r.id].revenue += Number(r.won_amount || 0); }
    else if (r.stage === 'failed') by[r.id].lost++;
    else by[r.id].open++;
  }

  return c.json(
    Object.values(by).map((r) => ({
      ...r,
      closed: r.won + r.lost,
      winRate: r.won + r.lost ? Math.round((r.won / (r.won + r.lost)) * 100) : null,
      atCapacity: r.open >= (r.cap || 25),
    })).sort((a, b) => b.revenue - a.revenue)
  );
});

app.get('/categories', async (c) => {
  const rows = await knex('leads')
    .where({ tenant_id: c.get('tenantId'), status: 'approved' })
    .select('normalized_category', 'tier', 'stage', 'won_amount', 'score')
    .limit(5000);

  const by = {};
  for (const r of rows) {
    const k = r.normalized_category || 'unclassified';
    by[k] ||= { category: k, leads: 0, won: 0, lost: 0, revenue: 0, scoreSum: 0 };
    by[k].leads++;
    by[k].scoreSum += Number(r.score || 0);
    if (r.stage === 'success') { by[k].won++; by[k].revenue += Number(r.won_amount || 0); }
    if (r.stage === 'failed') by[k].lost++;
  }

  return c.json(
    Object.values(by)
      .map((x) => ({
        ...x,
        avgScore: Math.round(x.scoreSum / x.leads),
        winRate: x.won + x.lost ? Math.round((x.won / (x.won + x.lost)) * 100) : null,
      }))
      .sort((a, b) => b.revenue - a.revenue || b.leads - a.leads)
  );
});

/** Anything overdue, which is the only list a rep should look at first. */
app.get('/due', async (c) => {
  const rows = await knex('leads')
    .leftJoin('users', 'leads.assigned_to', 'users.id')
    .where('leads.tenant_id', c.get('tenantId'))
    .andWhere('leads.status', 'approved')
    .whereNotIn('leads.stage', ['success', 'failed'])
    .whereNotNull('leads.next_due_at')
    .andWhere('leads.next_due_at', '<', new Date().toISOString())
    .select('leads.id', 'leads.name', 'leads.stage', 'leads.score', 'leads.next_due_at', 'users.name as assignee')
    .orderBy('leads.next_due_at')
    .limit(100);
  return c.json(rows);
});

export default app;
