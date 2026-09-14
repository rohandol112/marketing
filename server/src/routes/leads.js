import { Hono } from 'hono';
import knex from '../db/knex.js';
import { HttpError, now } from '../lib/util.js';
import {
  moveStage, reviewLeads, autoAssign, assignOnly, logActivity, updateLeadFields, isSuppressed, STAGES,
} from '../services/leads.js';
import { auditLead, rescoreLead } from '../services/discovery.js';
import { enqueue } from '../lib/queue.js';
import { waLink, telLink, adLibraryLinks } from '../lib/wa.js';
import { gapsFrom } from '../lib/scoring.js';
import { CATEGORIES } from '../lib/categories.js';
import { recordProvenance, DISCOVERY_META } from '../services/lifecycle.js';

const app = new Hono();

/** category id -> affordability tier, known before a lead is ever scored */
const CATEGORY_TIER = new Map(CATEGORIES.map((c) => [c.id, c.tier]));
const CATEGORY_META = new Map(CATEGORIES.map((c) => [c.id, c]));

function baseQuery(c) {
  return knex('leads').where('leads.tenant_id', c.get('tenantId'));
}

/* ---------------------- listing ---------------------- */

/**
 * One endpoint drives both the review queue and the board. `status` separates
 * them: pending_review for the queue, approved for the board.
 */
/**
 * One place that turns query parameters into WHERE clauses, shared by the list
 * and the count. Two copies of this drifted apart once and the UI confidently
 * reported the wrong number of results.
 */
function applyLeadFilters(query, q) {
  if (q.status) query = query.whereIn('leads.status', q.status.split(','));
  if (q.discoveryStatus) query = query.whereIn('leads.discovery_status', q.discoveryStatus.split(','));
  if (q.minConfidence) query = query.where('leads.confidence', '>=', Number(q.minConfidence));
  if (q.stage) query = query.whereIn('leads.stage', q.stage.split(','));
  if (q.tier) query = query.whereIn('leads.tier', q.tier.split(','));
  if (q.assignedTo) query = query.where('leads.assigned_to', q.assignedTo);
  if (q.runId) query = query.where('leads.run_id', q.runId);
  if (q.category) query = query.whereIn('leads.normalized_category', q.category.split(','));
  if (q.minScore) query = query.where('leads.score', '>=', Number(q.minScore));
  if (q.maxConfidence) query = query.where('leads.confidence', '<=', Number(q.maxConfidence));

  // Locality is free text typed by whoever mapped the business, so "Pune",
  // "pune" and "PUNE" are three different strings for one place. Match on the
  // normalised form or the filter is useless.
  // Matched as one exact value, not a comma-separated list: real localities
  // contain commas ("Kothrud, Pune"), so splitting on them silently turned one
  // filter into two wrong ones.
  if (q.locality) {
    query = query.whereRaw('lower(trim(leads.locality)) = ?', [q.locality.trim().toLowerCase()]);
  }

  if (q.valueTier) {
    const wanted = q.valueTier.split(',');
    const ids = CATEGORIES.filter((cat) => wanted.includes(cat.tier)).map((cat) => cat.id);
    query = query.whereIn('leads.normalized_category', ids.length ? ids : ['__none__']);
  }

  // "What do we already have" - the fastest way to find the leads worth a rep's
  // fifteen seconds before anyone has enriched anything.
  if (q.hasPhone === 'true') query = query.whereNotNull('leads.phone');
  if (q.hasPhone === 'false') query = query.whereNull('leads.phone');
  if (q.hasWebsite === 'true') query = query.whereNotNull('leads.website');
  if (q.hasWebsite === 'false') query = query.whereNull('leads.website');
  if (q.hasReviews === 'true') query = query.whereNotNull('leads.review_count');
  if (q.hasReviews === 'false') query = query.whereNull('leads.review_count');
  if (q.assigned === 'false') query = query.whereNull('leads.assigned_to');
  if (q.includeDisqualified !== 'true') query = query.where('leads.disqualified', false);
  if (q.search) {
    query = query.where((qb) =>
      qb.whereILike('leads.name', '%' + q.search + '%').orWhereILike('leads.address', '%' + q.search + '%')
    );
  }
  if (q.dueBefore) query = query.where('leads.next_due_at', '<', q.dueBefore);
  // explicit selection, used by "Export N selected"
  if (q.ids) query = query.whereIn('leads.id', q.ids.split(',').filter(Boolean));

  return query;
}

app.get('/', async (c) => {
  const q = c.req.query();
  let query = applyLeadFilters(
    baseQuery(c).leftJoin('users', 'leads.assigned_to', 'users.id').select('leads.*', 'users.name as assignee_name'),
    q
  );

  const limit = Math.min(Number(q.limit || 200), 500);

  if (q.sort === 'priority') {
    /**
     * Verification order.
     *
     * Sorting the verification queue by opportunity is useless: without review
     * counts every lead scores identically, so the list is arbitrary and a rep
     * has no reason to start anywhere. Order by what is actually known before
     * anyone does the work - what the category is worth, and whether we already
     * have a number to ring.
     */
     const t1 = CATEGORIES.filter((c) => c.tier === 'T1').map((c) => c.id);
     const t2 = CATEGORIES.filter((c) => c.tier === 'T2').map((c) => c.id);
     query = query
       .orderByRaw(
         'case when leads.normalized_category = any(?) then 0 ' +
         'when leads.normalized_category = any(?) then 1 else 2 end',
         [t1, t2]
       )
       .orderByRaw('case when leads.phone is not null then 0 else 1 end')
       .orderByRaw('case when leads.website is not null then 0 else 1 end')
       .orderBy('leads.confidence', 'desc')
       .orderBy('leads.name', 'asc');
  } else {
    const sort = q.sort === 'recent' ? 'leads.updated_at' : q.sort === 'due' ? 'leads.next_due_at' : 'leads.score';
    const dir = q.sort === 'due' ? 'asc' : 'desc';
    query = query.orderBy(sort, dir);
  }

  const rows = await query.limit(limit).offset(Number(q.offset || 0));

  return c.json(rows.map(summarize));
});

function summarize(lead) {
  const conf = lead.confidence_breakdown || {};
  return {
    ...lead,
    gaps: gapsFrom(lead.score_breakdown).slice(0, 3),
    discoveryMeta: DISCOVERY_META[lead.discovery_status] || null,
    valueTier: CATEGORY_TIER.get(lead.normalized_category) || null,
    confidenceLevel: conf.level || null,
    missingData: (conf.missing || []).slice(0, 4).map((m) => m.label),
    candidates: lead.candidates || {},
    links: {
      whatsapp: waLink(lead.phone),
      tel: telLink(lead.phone),
      ...adLibraryLinks(lead),
    },
  };
}

/** Board payload: leads grouped by stage, plus per-column counts. */
app.get('/board', async (c) => {
  const q = c.req.query();
  let query = baseQuery(c)
    .leftJoin('users', 'leads.assigned_to', 'users.id')
    .select('leads.*', 'users.name as assignee_name')
    .where('leads.status', 'approved')
    .where('leads.discovery_status', 'qualified')
    .whereNotNull('leads.stage')
    .where('leads.disqualified', false);

  if (q.assignedTo === 'none') query = query.whereNull('leads.assigned_to');
  else if (q.assignedTo) query = query.where('leads.assigned_to', q.assignedTo);
  if (q.tier) query = query.whereIn('leads.tier', q.tier.split(','));
  if (q.search) query = query.whereILike('leads.name', '%' + q.search + '%');

  const rows = await query.orderBy('leads.score', 'desc').limit(1000);

  const columns = {};
  for (const s of STAGES) columns[s] = [];
  for (const row of rows) {
    if (!row.stage) continue;   // belt and braces: the CHECK constraint already forbids this
    (columns[row.stage] ||= []).push(summarize(row));
  }

  return c.json({
    columns,
    counts: Object.fromEntries(Object.entries(columns).map(([k, v]) => [k, v.length])),
    total: rows.length,
  });
});

/**
 * CSV export of whatever the current filters select.
 *
 * Shares applyLeadFilters with the list and the count, so what you export is
 * exactly what you were looking at. Streams the whole match, not a page - the
 * point of an export is to get everything.
 */
const CSV_COLUMNS = [
  'id', 'name', 'category', 'normalized_category', 'value_tier',
  'discovery_status', 'status', 'stage', 'assignee',
  'score', 'tier', 'confidence', 'confidence_level',
  'review_count', 'rating', 'phone', 'email', 'website', 'website_status',
  'ig_handle', 'ig_followers', 'li_followers', 'years_in_business', 'locations_count',
  'address', 'locality', 'region', 'postal_code', 'country_code', 'lat', 'lng',
  'external_source', 'external_id', 'google_place_id', 'maps_url',
  'disqualified', 'disqualify_reason', 'loss_reason', 'won_amount',
  'activity_count', 'next_due_at', 'last_activity_at',
  'verified_at', 'verified_by', 'run_id', 'created_at', 'updated_at',
  'gaps', 'missing_data',
];

/** RFC 4180: quote everything that could break a cell, double internal quotes. */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  // A leading =, +, - or @ is executed as a formula by Excel and Sheets.
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/["\r\n,]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function leadsToCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const l of rows) {
    const conf = l.confidence_breakdown || {};
    const flat = {
      ...l,
      value_tier: CATEGORY_TIER.get(l.normalized_category) || '',
      confidence_level: conf.level || '',
      assignee: l.assignee_name || '',
      gaps: gapsFrom(l.score_breakdown).slice(0, 3).join(' | '),
      missing_data: (conf.missing || []).slice(0, 4).map((m) => m.label).join(' | '),
    };
    lines.push(CSV_COLUMNS.map((c) => csvCell(flat[c])).join(','));
  }
  return lines.join('\r\n');
}

app.get('/export.csv', async (c) => {
  const q = c.req.query();
  const rows = await applyLeadFilters(
    baseQuery(c).leftJoin('users', 'leads.assigned_to', 'users.id')
      .select('leads.*', 'users.name as assignee_name'),
    q
  ).orderBy('leads.score', 'desc').limit(Number(q.limit || 50000));

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const name = 'leads-' + (q.discoveryStatus || 'all') + '-' + stamp + '.csv';

  // BOM so Excel opens UTF-8 business names correctly instead of mojibake.
  return new Response('﻿' + leadsToCsv(rows), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + name + '"',
      'X-Row-Count': String(rows.length),
    },
  });
});

/** How many leads match the current filters, ignoring the page limit. */
app.get('/count', async (c) => {
  const row = await applyLeadFilters(baseQuery(c), c.req.query()).count('* as count').first();
  return c.json({ count: Number(row.count) });
});

/**
 * Every filter value that would actually return something, with counts.
 *
 * Built from the same filters the caller already has applied, minus the one
 * being counted, so the numbers stay honest as you narrow down rather than
 * offering options that lead to an empty table.
 */
app.get('/facets', async (c) => {
  const tenantId = c.get('tenantId');
  const q = c.req.query();

  const base = () => {
    let b = knex('leads').where('leads.tenant_id', tenantId);
    if (q.discoveryStatus) b = b.whereIn('leads.discovery_status', q.discoveryStatus.split(','));
    if (q.status) b = b.whereIn('leads.status', q.status.split(','));
    if (q.includeDisqualified !== 'true') b = b.where('leads.disqualified', false);
    return b;
  };

  const [localities, categories, runs, totals] = await Promise.all([
    base()
      .whereNotNull('leads.locality')
      // most common spelling wins the label, so "Pune" beats "PUNE" and "pune"
      .select(
        knex.raw('lower(trim(leads.locality)) as value'),
        knex.raw('mode() within group (order by leads.locality) as label')
      )
      .count('* as count')
      .groupBy('value')
      .orderBy('count', 'desc')
      .limit(60),

    base()
      .whereNotNull('leads.normalized_category')
      .select('leads.normalized_category as value')
      .count('* as count')
      .groupBy('value')
      .orderBy('count', 'desc'),

    base()
      .leftJoin('discovery_runs', 'leads.run_id', 'discovery_runs.id')
      .whereNotNull('leads.run_id')
      .select('leads.run_id as value', 'discovery_runs.area_label as label', 'discovery_runs.created_at')
      .count('* as count')
      .groupBy('leads.run_id', 'discovery_runs.area_label', 'discovery_runs.created_at')
      .orderBy('discovery_runs.created_at', 'desc'),

    base()
      .select(
        knex.raw('count(*) as total'),
        knex.raw('count(leads.phone) as with_phone'),
        knex.raw('count(leads.website) as with_website'),
        knex.raw('count(leads.review_count) as with_reviews'),
        knex.raw('count(*) filter (where leads.assigned_to is null) as unassigned')
      )
      .first(),
  ]);

  const tierCount = { T1: 0, T2: 0, T3: 0 };
  const cats = categories.map((r) => {
    const meta = CATEGORY_META.get(r.value);
    if (meta && tierCount[meta.tier] != null) tierCount[meta.tier] += Number(r.count);
    return {
      value: r.value,
      label: meta ? meta.label : r.value.replace(/_/g, ' '),
      tier: meta ? meta.tier : null,
      group: meta ? meta.group : null,
      count: Number(r.count),
    };
  });

  return c.json({
    localities: localities.map((r) => ({ value: r.value, label: r.label, count: Number(r.count) })),
    categories: cats,
    areas: runs.map((r) => ({ value: r.value, label: r.label || 'Untitled sweep', count: Number(r.count) })),
    tiers: Object.entries(tierCount).map(([value, count]) => ({ value, count })),
    completeness: {
      total: Number(totals.total),
      withPhone: Number(totals.with_phone),
      withWebsite: Number(totals.with_website),
      withReviews: Number(totals.with_reviews),
      unassigned: Number(totals.unassigned),
    },
  });
});

/* ---------------------- single lead ---------------------- */

app.get('/:id', async (c) => {
  const tenantId = c.get('tenantId');
  // Join users here too, or the drawer shows a blank owner on every lead.
  const lead = await knex('leads')
    .leftJoin('users', 'leads.assigned_to', 'users.id')
    .where('leads.id', c.req.param('id'))
    .andWhere('leads.tenant_id', tenantId)
    .select('leads.*', 'users.name as assignee_name')
    .first();
  if (!lead) throw new HttpError(404, 'Lead not found');

  const [activities, history, suggestions, proposals, suppressed] = await Promise.all([
    knex('activities').where({ lead_id: lead.id }).orderBy('occurred_at', 'desc').limit(50),
    knex('lead_stage_history').where({ lead_id: lead.id }).orderBy('at', 'desc').limit(50),
    knex('ai_suggestions').where({ lead_id: lead.id }).orderBy('created_at', 'desc').limit(20),
    knex('proposals').where({ lead_id: lead.id }).orderBy('created_at', 'desc'),
    isSuppressed(tenantId, lead),
  ]);

  return c.json({
    ...summarize(lead),
    activities,
    history,
    proposals,
    suppressed,
    suggestions: suggestions.map((s) => ({
      id: s.id, kind: s.kind, action: s.action, fallback: s.fallback,
      model: s.model, createdAt: s.created_at,
    })),
  });
});

app.patch('/:id', async (c) => {
  const lead = await updateLeadFields({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
    patch: await c.req.json(),
    userId: c.get('userId'),
  });
  return c.json(summarize(lead));
});

app.post('/:id/rescore', async (c) => {
  const r = await rescoreLead(c.req.param('id'));
  if (!r) throw new HttpError(404, 'Lead not found');
  return c.json(r);
});

app.post('/:id/audit', async (c) => {
  const lead = await knex('leads').where({ id: c.req.param('id'), tenant_id: c.get('tenantId') }).first();
  if (!lead) throw new HttpError(404, 'Lead not found');
  if (!lead.website) throw new HttpError(409, 'No website on this lead to audit.');
  const r = await auditLead({ leadId: lead.id, withPageSpeed: c.req.query('pagespeed') === 'true' });
  return c.json(r);
});

/**
 * Human verification of an AI-suggested lead.
 *
 * Leads discovered by the model arrive disqualified on purpose. This is the
 * gate: a person opened Google Maps, confirmed the business is real, and typed
 * in the phone number. Only then can it reach a board and be called.
 */
app.post('/:id/verify', async (c) => {
  const tenantId = c.get('tenantId');
  const leadId = c.req.param('id');
  const b = await c.req.json().catch(() => ({}));

  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new HttpError(404, 'Lead not found');

  if (b.exists === false) {
    await knex('leads').where({ id: leadId }).update({
      status: 'rejected',
      stage: null,
      discovery_status: 'rejected',
      disqualified: true,
      disqualify_reason: 'A person checked and this business does not exist',
      verified_at: now(),
      verified_by: c.get('userId'),
      updated_at: now(),
    });
    return c.json({ ok: true, verified: false, message: 'Marked as not real. It will not come back in future sweeps.' });
  }

  if (!b.phone) {
    throw new HttpError(
      409,
      'Add the phone number you found on Maps. Verifying without one leaves the rep nothing to call.'
    );
  }

  const patch = {};
  for (const k of ['name', 'phone', 'website', 'address', 'locality', 'rating', 'review_count', 'ig_followers', 'years_in_business']) {
    if (b[k] !== undefined && b[k] !== '') patch[k] = b[k];
  }

  await updateLeadFields({ tenantId, leadId, patch, userId: c.get('userId') });

  // Mark identity as human-confirmed, then let the lifecycle decide whether
  // that is now enough to qualify. Verification establishes existence; it does
  // not on its own make a lead worth calling.
  const fresh = await knex('leads').where({ id: leadId }).first();
  const prov = recordProvenance(fresh.field_provenance, Object.keys(patch), {
    source: 'human',
    method: 'human_maps_check',
    by: c.get('userId'),
    confidence: 'high',
  });
  prov.verification = { by: c.get('userId'), at: now(), method: 'human_maps_check' };

  await knex('leads').where({ id: leadId }).update({
    field_provenance: JSON.stringify(prov),
    // Someone looked at the listing and it was trading. That is the same fact
    // the Places API reports as businessStatus.
    business_status: fresh.business_status || 'OPERATIONAL',
    verified_at: now(),
    verified_by: c.get('userId'),
    fields_refreshed_at: now(),
    updated_at: now(),
  });

  // Audit any website they supplied straight away - it is the difference
  // between "they told us a URL" and "we fetched it and it answered".
  const withSite = await knex('leads').where({ id: leadId }).first('website', 'website_status');
  if (withSite.website && !['ok', 'placeholder', 'parked', 'broken'].includes(withSite.website_status)) {
    await auditLead({ leadId });
  }

  const evaluation = await rescoreLead(leadId);
  const updated = await knex('leads').where({ id: leadId }).first();

  return c.json({
    ok: true,
    verified: true,
    lead: summarize(updated),
    score: evaluation,
    message:
      evaluation.discovery_status === 'qualified'
        ? 'Verified and qualified. It is now in the review queue.'
        : 'Verified, but ' + (evaluation.disqualify_reason || 'not qualified yet') +
          ' Fill in what is missing to push it through.',
  });
});

/* ---------------------- stage + review ---------------------- */

app.post('/:id/stage', async (c) => {
  const b = await c.req.json();
  const lead = await moveStage({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
    toStage: b.stage,
    userId: c.get('userId'),
    reason: b.reason,
    lossReason: b.lossReason,
    proposal: b.proposal,
  });
  return c.json(summarize(lead));
});

app.post('/review', async (c) => {
  const b = await c.req.json();
  if (!Array.isArray(b.ids) || !b.ids.length) throw new HttpError(400, 'ids is required');
  const r = await reviewLeads({
    tenantId: c.get('tenantId'),
    ids: b.ids,
    decision: b.decision,
    userId: c.get('userId'),
    assignTo: b.assignTo,
  });
  return c.json(r);
});

app.post('/assign', async (c) => {
  const b = await c.req.json();
  if (!Array.isArray(b.ids) || !b.ids.length) throw new HttpError(400, 'ids is required');

  if (b.auto) {
    return c.json(await autoAssign({ tenantId: c.get('tenantId'), ids: b.ids }));
  }
  if (!b.userId) throw new HttpError(400, 'userId is required unless auto is true');

  // Assigning is not approving. A lead reaches the board through the review
  // queue and nowhere else.
  const r = await assignOnly({
    tenantId: c.get('tenantId'),
    ids: b.ids,
    userId: b.userId,
  });
  return c.json(r);
});

/* ---------------------- activities ---------------------- */

app.post('/:id/activities', async (c) => {
  const b = await c.req.json();
  if (!b.type) throw new HttpError(400, 'type is required');
  const activity = await logActivity({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
    userId: c.get('userId'),
    type: b.type,
    channel: b.channel,
    body: b.body,
    outcome: b.outcome,
    extracted: b.extracted,
    nextDueAt: b.nextDueAt,
  });
  return c.json(activity, 201);
});

/* ---------------------- do not contact ---------------------- */

app.post('/:id/dnc', async (c) => {
  const tenantId = c.get('tenantId');
  const lead = await knex('leads').where({ id: c.req.param('id'), tenant_id: tenantId }).first();
  if (!lead) throw new HttpError(404, 'Lead not found');
  const b = await c.req.json().catch(() => ({}));

  await knex('dnc').insert({
    id: 'dnc_' + lead.id,
    tenant_id: tenantId,
    phone_normalized: lead.phone_normalized,
    email: lead.email,
    reason: b.reason || 'Requested by the business',
    created_at: now(),
  }).onConflict('id').merge();

  await knex('leads').where({ id: lead.id }).update({
    status: 'rejected',
    stage: 'failed',
    loss_reason: 'not_interested',
    updated_at: now(),
  });

  return c.json({ ok: true, message: lead.name + ' will not be contacted again.' });
});

/* ---------------------- bulk refresh ---------------------- */

/**
 * Re-run the auditor over every lead with a website. Needed after the auditor
 * learns a new signal - existing audit blobs are snapshots and do not
 * retroactively grow new fields.
 */
app.post('/reaudit', async (c) => {
  const tenantId = c.get('tenantId');
  const q = c.req.query();

  let sel = knex('leads').where({ tenant_id: tenantId }).whereNotNull('website');
  if (q.status) sel = sel.whereIn('website_status', q.status.split(','));

  const rows = await sel.limit(Number(q.limit || 500)).select('id');
  for (const r of rows) {
    await enqueue({ tenantId, kind: 'audit_lead', payload: { leadId: r.id } });
  }
  return c.json({
    queued: rows.length,
    note: 'Running in the background. PageSpeed makes each one take a few seconds.',
  });
});

/** Turn the addresses Maps gave us into coordinates. */
app.post('/geocode', async (c) => {
  const tenantId = c.get('tenantId');
  const rows = await knex('leads')
    .where({ tenant_id: tenantId })
    .whereNull('lat')
    .whereNotNull('address')
    .limit(Number(c.req.query('limit') || 200))
    .select('id');

  for (const r of rows) {
    await enqueue({ tenantId, kind: 'geocode_lead', payload: { leadId: r.id }, priority: 180 });
  }
  return c.json({
    queued: rows.length,
    note: 'One per second - Nominatim policy. Roughly ' + Math.ceil(rows.length * 1.2) + 's.',
  });
});

/** Google's 30-day cache limit is a term, not a suggestion. */
app.post('/refresh-stale', async (c) => {
  const tenantId = c.get('tenantId');
  const stale = await knex('leads')
    .where({ tenant_id: tenantId })
    .whereNotNull('website')
    .andWhereRaw('(stale_after IS NULL OR stale_after < now())')
    .limit(200)
    .select('id');

  for (const l of stale) {
    await enqueue({ tenantId, kind: 'audit_lead', payload: { leadId: l.id } });
  }
  return c.json({ queued: stale.length });
});

export default app;
