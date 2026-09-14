import knex from '../db/knex.js';
import { uid, now, addDays, HttpError, normalizePhone } from '../lib/util.js';
import { rescoreLead } from './discovery.js';
import { recordProvenance } from './lifecycle.js';

/**
 * The stage machine.
 *
 * The guards below exist because without them reps park every lead in a
 * "Follow Up" column forever, the funnel data turns to noise, and the whole
 * scoring feedback loop dies with it. Being slightly annoying here is what
 * makes the analytics in four weeks worth reading.
 */

export const STAGES = ['todo', 'in_discussion', 'follow_up_1', 'follow_up_2', 'follow_up_3', 'success', 'failed'];

export const STAGE_META = {
  todo:          { label: 'To Do',        dueInDays: null, terminal: false },
  in_discussion: { label: 'In Discussion', dueInDays: 2,   terminal: false },
  follow_up_1:   { label: 'Follow Up 1',   dueInDays: 3,   terminal: false },
  follow_up_2:   { label: 'Follow Up 2',   dueInDays: 7,   terminal: false },
  follow_up_3:   { label: 'Follow Up 3',   dueInDays: 14,  terminal: false },
  success:       { label: 'Success Deal',  dueInDays: null, terminal: true },
  failed:        { label: 'Failed Deal',   dueInDays: null, terminal: true },
};

export const LOSS_REASONS = [
  { id: 'price_too_high',      label: 'Price too high',              recycle: false },
  { id: 'no_budget',           label: 'No budget right now',         recycle: true, recycleDays: 120 },
  { id: 'timing_not_right',    label: 'Timing not right',            recycle: true, recycleDays: 90 },
  { id: 'went_with_competitor', label: 'Went with a competitor',     recycle: true, recycleDays: 180 },
  { id: 'already_has_agency',  label: 'Already has an agency',       recycle: true, recycleDays: 180 },
  { id: 'no_response',         label: 'Never responded',             recycle: true, recycleDays: 90 },
  { id: 'not_decision_maker',  label: 'Could not reach the decision maker', recycle: true, recycleDays: 60 },
  { id: 'not_interested',      label: 'Genuinely not interested',    recycle: false },
  { id: 'out_of_scope',        label: 'Wanted something we do not do', recycle: false },
  { id: 'business_closed',     label: 'Business closed or unreachable', recycle: false },
  { id: 'bad_data',            label: 'Bad data - wrong business',   recycle: false },
];

const LOSS_BY_ID = new Map(LOSS_REASONS.map((r) => [r.id, r]));

const FORWARD = ['todo', 'in_discussion', 'follow_up_1', 'follow_up_2', 'follow_up_3'];

/**
 * Legal moves:
 *   - one step forward along the funnel
 *   - anywhere backwards (a rep correcting themselves)
 *   - straight to success or failed from any non-terminal stage that has
 *     at least one logged activity
 */
export async function assertStageMove(lead, toStage, { activityCount, proposal, lossReason }) {
  if (!STAGES.includes(toStage)) {
    throw new HttpError(400, 'Unknown stage: ' + toStage);
  }
  const from = lead.stage;
  if (from === toStage) return;

  if (!from) {
    throw new HttpError(
      409,
      lead.name + ' is not in the sales pipeline yet. It has to be approved in the review queue before it can move between stages.'
    );
  }

  if (STAGE_META[from].terminal && !STAGE_META[toStage].terminal) {
    // reopening a closed lead is fine, but it goes back to discussion
    if (toStage !== 'in_discussion' && toStage !== 'todo') {
      throw new HttpError(409, 'A closed lead can only be reopened into To Do or In Discussion.');
    }
    return;
  }

  if (toStage === 'success') {
    if (!activityCount) {
      throw new HttpError(409, 'Cannot mark a deal won with no logged activity. Log the call that closed it first.');
    }
    if (!proposal || !proposal.amount) {
      throw new HttpError(409, 'Success needs a proposal with an amount. Add the package and value you actually sold.');
    }
    return;
  }

  if (toStage === 'failed') {
    if (!lossReason) {
      throw new HttpError(409, 'Every lost deal needs a reason. Pick one - free text here is how loss analytics dies.');
    }
    if (!LOSS_BY_ID.has(lossReason)) {
      throw new HttpError(400, 'Unknown loss reason: ' + lossReason);
    }
    return;
  }

  const fromIdx = FORWARD.indexOf(from);
  const toIdx = FORWARD.indexOf(toStage);

  if (fromIdx === -1 || toIdx === -1) return; // to/from a terminal stage, handled above

  if (toIdx < fromIdx) return; // moving backwards is always allowed

  if (!activityCount) {
    throw new HttpError(
      409,
      'Log an activity before moving this lead forward. A lead that moved without a call did not actually move.'
    );
  }

  if (toIdx - fromIdx > 1) {
    throw new HttpError(
      409,
      'Cannot skip from ' + STAGE_META[from].label + ' to ' + STAGE_META[toStage].label +
      '. Move one stage at a time so the funnel numbers mean something.'
    );
  }
}

export async function moveStage({ tenantId, leadId, toStage, userId, reason, lossReason, proposal }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new HttpError(404, 'Lead not found');

  const [{ count }] = await knex('activities').where({ lead_id: leadId }).count('* as count');
  const activityCount = Number(count);

  await assertStageMove(lead, toStage, { activityCount, proposal, lossReason });

  const patch = {
    stage: toStage,
    updated_at: now(),
    loss_reason: toStage === 'failed' ? lossReason : null,
  };

  const meta = STAGE_META[toStage];
  patch.next_due_at = meta.dueInDays ? addDays(now(), meta.dueInDays) : null;

  if (toStage === 'success' && proposal) {
    patch.won_amount = proposal.amount;
    await knex('proposals').insert({
      id: uid('pr_'),
      tenant_id: tenantId,
      lead_id: leadId,
      package_id: proposal.packageId || null,
      amount: proposal.amount,
      currency: proposal.currency || null,
      status: 'accepted',
      sent_at: now(),
      created_at: now(),
    });
  }

  // A "timing" loss is not a loss, it is a date. Recycle it automatically or it
  // will be forgotten forever.
  if (toStage === 'failed') {
    const rule = LOSS_BY_ID.get(lossReason);
    if (rule?.recycle) {
      patch.next_due_at = addDays(now(), rule.recycleDays);
    }
  }

  await knex.transaction(async (trx) => {
    await trx('leads').where({ id: leadId }).update(patch);
    await trx('lead_stage_history').insert({
      id: uid('sh_'),
      tenant_id: tenantId,
      lead_id: leadId,
      from_stage: lead.stage,
      to_stage: toStage,
      by_user: userId || null,
      reason: reason || null,
      at: now(),
    });
  });

  return knex('leads').where({ id: leadId }).first();
}

/* ------------------------------------------------------------------ */
/* Review queue                                                       */
/* ------------------------------------------------------------------ */

export async function reviewLeads({ tenantId, ids, decision, userId, assignTo }) {
  if (!['approved', 'rejected', 'hold'].includes(decision)) {
    throw new HttpError(400, 'decision must be approved, rejected or hold');
  }

  if (decision === 'approved') {
    // Approval is the moment a lead crosses from the discovery pipeline into
    // the sales pipeline. Both gates are checked here rather than trusting the
    // caller, because everything downstream assumes they held.
    const blocked = await knex('leads')
      .whereIn('id', ids)
      .andWhere({ tenant_id: tenantId })
      .andWhere((qb) => qb.whereNot('discovery_status', 'qualified').orWhere('disqualified', true))
      .select('id', 'name', 'discovery_status', 'confidence', 'disqualify_reason');

    if (blocked.length) {
      throw new HttpError(
        409,
        blocked.length + ' of these are not ready for a rep yet: ' +
        blocked.slice(0, 3).map((b) => b.name + ' (' + b.discovery_status + ', ' + b.confidence + '% confidence)').join(', ') +
        (blocked.length > 3 ? ' and ' + (blocked.length - 3) + ' more' : '') +
        '. Verify them first.',
        { blocked }
      );
    }
    if (assignTo) await assertCapacity(tenantId, assignTo, ids.length);
  }

  const patch = { status: decision, updated_at: now() };
  if (decision === 'approved') {
    patch.stage = 'todo';          // enters the sales pipeline here, and only here
    if (assignTo) patch.assigned_to = assignTo;
  } else {
    patch.stage = null;            // leaves it, if it was ever in it
    patch.assigned_to = null;
    if (decision === 'rejected') patch.discovery_status = 'rejected';
  }

  const n = await knex('leads').whereIn('id', ids).andWhere({ tenant_id: tenantId }).update(patch);
  return { updated: n };
}

/**
 * Assignment gives an already-approved lead to a person. It must never approve
 * one as a side effect.
 *
 * Approval is a judgement a team lead makes in the review queue - "this is worth
 * one of my reps' days". Letting an assign call imply it meant the review step
 * could be skipped entirely, which quietly defeats the point of having a queue.
 */
async function assertApproved(tenantId, ids) {
  const notReady = await knex('leads')
    .whereIn('id', ids)
    .andWhere({ tenant_id: tenantId })
    .andWhereNot('status', 'approved')
    .select('id', 'name', 'status', 'discovery_status');

  if (notReady.length) {
    throw new HttpError(
      409,
      notReady.length + ' of these have not been approved yet: ' +
      notReady.slice(0, 3).map((l) => l.name + ' (' + l.status + ')').join(', ') +
      (notReady.length > 3 ? ' and ' + (notReady.length - 3) + ' more' : '') +
      '. Approve them in the review queue first - assigning does not approve.',
      { notReady }
    );
  }
}

async function assertCapacity(tenantId, userId, adding) {
  const user = await knex('users').where({ id: userId, tenant_id: tenantId }).first();
  if (!user) throw new HttpError(404, 'User not found');

  const [{ count }] = await knex('leads')
    .where({ tenant_id: tenantId, assigned_to: userId, status: 'approved' })
    .whereNotIn('stage', ['success', 'failed'])
    .count('* as count');

  const open = Number(count);
  const cap = user.open_lead_cap || 25;
  if (open + adding > cap) {
    throw new HttpError(
      409,
      user.name + ' already has ' + open + ' open leads (cap ' + cap + '). Assigning ' + adding +
      ' more would bury them. Raise the cap in Settings or spread these across the team.'
    );
  }
}

/**
 * Give already-approved leads to a specific rep. Does not approve anything -
 * see assertApproved above for why that separation matters.
 */
export async function assignOnly({ tenantId, ids, userId }) {
  await assertApproved(tenantId, ids);
  await assertCapacity(tenantId, userId, ids.length);

  const updated = await knex('leads')
    .whereIn('id', ids)
    .andWhere({ tenant_id: tenantId })
    .update({ assigned_to: userId, updated_at: now() });

  return { updated };
}

/**
 * Round-robin across active reps, respecting each rep's cap. Returns which
 * leads could not be placed rather than silently overloading someone.
 */
export async function autoAssign({ tenantId, ids }) {
  await assertApproved(tenantId, ids);

  const reps = await knex('users')
    .where({ tenant_id: tenantId, role: 'rep', active: true })
    .orderBy('name');
  if (!reps.length) throw new HttpError(409, 'No active reps to assign to.');

  const loads = await knex('leads')
    .where({ tenant_id: tenantId, status: 'approved' })
    .whereNotIn('stage', ['success', 'failed'])
    .whereNotNull('assigned_to')
    .select('assigned_to')
    .count('* as n')
    .groupBy('assigned_to');

  const loadBy = new Map(loads.map((l) => [l.assigned_to, Number(l.n)]));
  const assigned = [];
  const skipped = [];

  const leads = await knex('leads')
    .whereIn('id', ids)
    .andWhere({ tenant_id: tenantId })
    .orderBy('score', 'desc');

  for (const lead of leads) {
    if (lead.discovery_status !== 'qualified' || lead.disqualified) {
      skipped.push({
        id: lead.id,
        name: lead.name,
        reason: 'not qualified yet (' + lead.discovery_status + ', ' + lead.confidence + '% confidence)',
      });
      continue;
    }
    // always give the next lead to whoever is least loaded and still under cap
    const candidates = reps
      .map((r) => ({ r, load: loadBy.get(r.id) || 0 }))
      .filter((c) => c.load < (c.r.open_lead_cap || 25))
      .sort((a, b) => a.load - b.load);

    if (!candidates.length) {
      skipped.push({ id: lead.id, name: lead.name, reason: 'every rep is at their cap' });
      continue;
    }

    const target = candidates[0];
    // Already approved - assertApproved above guarantees it - so this only
    // changes who owns it.
    await knex('leads').where({ id: lead.id }).update({
      assigned_to: target.r.id,
      updated_at: now(),
    });
    loadBy.set(target.r.id, target.load + 1);
    assigned.push({ id: lead.id, name: lead.name, to: target.r.name });
  }

  return { assigned, skipped };
}

/* ------------------------------------------------------------------ */
/* Activities                                                         */
/* ------------------------------------------------------------------ */

export async function logActivity({ tenantId, leadId, userId, type, channel, body, outcome, extracted, nextDueAt }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new HttpError(404, 'Lead not found');

  const id = uid('ac_');
  const at = now();

  await knex.transaction(async (trx) => {
    await trx('activities').insert({
      id,
      tenant_id: tenantId,
      lead_id: leadId,
      user_id: userId || null,
      type,
      channel: channel || null,
      body: body || null,
      outcome: outcome || null,
      extracted: extracted ? JSON.stringify(extracted) : null,
      occurred_at: at,
      next_due_at: nextDueAt || null,
      created_at: at,
    });
    await trx('leads').where({ id: leadId }).update({
      last_activity_at: at,
      activity_count: Number(lead.activity_count || 0) + 1,
      next_due_at: nextDueAt || lead.next_due_at,
      updated_at: at,
    });
  });

  return knex('activities').where({ id }).first();
}

/* ------------------------------------------------------------------ */
/* Manual enrichment                                                  */
/* ------------------------------------------------------------------ */

export const MANUAL_FIELDS = [
  // the two that decide the demand score - omitting these silently threw away
  // the whole point of the verification step
  'review_count', 'rating',
  'ig_handle', 'ig_followers', 'li_followers', 'fb_followers',
  'years_in_business', 'locations_count', 'runs_ads', 'agency_managed',
  'phone', 'email', 'website', 'name', 'category', 'normalized_category',
  'address', 'locality', 'postal_code', 'business_status',
  // a rep confirming "I looked, there is none" is real evidence
  'website_status',
  'assigned_to',
];

const NUMERIC_FIELDS = new Set([
  'review_count', 'ig_followers', 'li_followers', 'fb_followers',
  'years_in_business', 'locations_count',
]);

/**
 * The ten-minute audit a rep does before calling. Instagram follower counts and
 * "are they running ads" have no legal API, so they are inputs here rather than
 * a blocker in the pipeline. Anything entered by a human always beats anything
 * fetched.
 */
export async function updateLeadFields({ tenantId, leadId, patch, userId }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new HttpError(404, 'Lead not found');

  const clean = {};
  const ignored = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!MANUAL_FIELDS.includes(k)) { ignored.push(k); continue; }
    if (v === '' || v === null || v === undefined) { clean[k] = null; continue; }
    if (NUMERIC_FIELDS.has(k)) {
      const n = Math.round(Number(v));
      if (!Number.isFinite(n) || n < 0) throw new HttpError(400, k + ' must be a whole number, got: ' + v);
      clean[k] = n;
    } else if (k === 'rating') {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 5) throw new HttpError(400, 'rating must be between 0 and 5, got: ' + v);
      clean[k] = n;
    } else {
      clean[k] = v;
    }
  }
  // Silently dropping an unknown field is how review_count went missing for a
  // whole release. Say so instead.
  if (ignored.length) {
    throw new HttpError(
      400,
      'These fields are not editable: ' + ignored.join(', ') + '. Editable: ' + MANUAL_FIELDS.join(', ')
    );
  }
  if (!Object.keys(clean).length) {
    throw new HttpError(400, 'Nothing to update.');
  }

  if (clean.phone !== undefined) clean.phone_normalized = normalizePhone(clean.phone);

  clean.field_provenance = JSON.stringify(
    recordProvenance(lead.field_provenance, Object.keys(clean), {
      source: 'human',
      method: 'manual_audit',
      by: userId || 'unknown',
      confidence: 'high',
    })
  );
  clean.updated_at = now();

  await knex('leads').where({ id: leadId }).update(clean);
  await rescoreLead(leadId);

  return knex('leads').where({ id: leadId }).first();
}

/* ------------------------------------------------------------------ */
/* Do not contact                                                     */
/* ------------------------------------------------------------------ */

export async function isSuppressed(tenantId, lead) {
  if (!lead.phone_normalized && !lead.email) return null;
  const hit = await knex('dnc')
    .where({ tenant_id: tenantId })
    .andWhere((qb) => {
      if (lead.phone_normalized) qb.orWhere('phone_normalized', lead.phone_normalized);
      if (lead.email) qb.orWhere('email', lead.email);
    })
    .first();
  return hit || null;
}
