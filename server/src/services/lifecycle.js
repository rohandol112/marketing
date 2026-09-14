import { scoreLead } from '../lib/scoring.js';
import { computeConfidence, DEFAULT_CONFIDENCE_CONFIG } from '../lib/confidence.js';

/**
 * The discovery lifecycle. Deliberately separate from the sales pipeline.
 *
 *   discovered -> something thinks this business exists. Not shown to sales.
 *   verifying  -> a person has it open and is checking.
 *   verified   -> identity confirmed: an authoritative place id, or a human
 *                 who opened Maps and said yes.
 *   qualified  -> verified, confident enough, and worth someone's time.
 *                 Only now does it appear in the team lead's review queue.
 *   rejected   -> does not exist, or fails a hard disqualifier.
 *
 * A lead only gets a sales `stage` after a team lead approves it, and the
 * database enforces that with a CHECK constraint. These two state machines
 * never share a column again.
 */

export const DISCOVERY_STATUSES = ['discovered', 'verifying', 'verified', 'qualified', 'rejected'];

export const DISCOVERY_META = {
  discovered: { label: 'Candidate', note: 'Unverified. Not visible to sales.', sales: false },
  verifying:  { label: 'Being checked', note: 'Someone is confirming this exists.', sales: false },
  verified:   { label: 'Verified', note: 'Confirmed real, but not yet worth passing on.', sales: false },
  qualified:  { label: 'Qualified', note: 'Ready for the team lead to review and assign.', sales: true },
  rejected:   { label: 'Rejected', note: 'Not real, or fails a hard disqualifier.', sales: false },
};

/**
 * Identity: does something other than a language model say this business exists.
 *
 * A Google place id, an OpenStreetMap entry a contributor physically surveyed,
 * or a person who checked. All three are evidence of existence. Model recall is
 * not, which is the entire reason this function exists.
 *
 * Note this is only about existence. Whether we know enough to hand it to a rep
 * is the confidence floor's job, and an OSM lead usually still fails that until
 * someone adds a review count.
 */
/**
 * Sources that count as evidence a business exists.
 *
 * `gemini_grounded` is here and plain model recall is not, and the difference
 * is citations: a grounded result came back with the pages it was read from,
 * which a person can click. Recall came back with nothing to check.
 */
const DIRECTORY_SOURCES = new Set(['openstreetmap', 'google_places', 'gemini_grounded', 'google_maps']);

export function hasVerifiedIdentity(lead) {
  if (lead.google_place_id) return true;
  if (lead.external_source && DIRECTORY_SOURCES.has(lead.external_source)) return true;
  const prov = lead.field_provenance || lead.source_url || {};
  return Boolean(lead.verified_at || prov.verification);
}

/**
 * The single place that turns a lead row into its scores and its lifecycle
 * state. Every write path calls this so the three columns can never drift.
 */
export function evaluate(lead, scoringCfg, confidenceCfg = DEFAULT_CONFIDENCE_CONFIG) {
  const scored = scoreLead(lead, scoringCfg);
  const conf = computeConfidence(lead, confidenceCfg);

  const qualifyFloor = confidenceCfg.qualifyScoreFloor ?? 35;
  const identity = hasVerifiedIdentity(lead);

  let discovery_status;
  let reason = null;

  if (scored.disqualified) {
    discovery_status = 'rejected';
    reason = scored.disqualifyReason;
  } else if (!identity) {
    discovery_status = 'discovered';
    reason = 'Existence not confirmed. Check it on Maps and add a phone number.';
  } else if (!conf.assignable) {
    discovery_status = 'verified';
    reason =
      'Confidence is ' + conf.confidence + '%, below the ' + (confidenceCfg.assignFloor ?? 60) +
      '% floor. Missing: ' + conf.breakdown.missing.slice(0, 3).map((m) => m.label).join(', ') + '.';
  } else if (scored.score < qualifyFloor) {
    discovery_status = 'verified';
    reason = 'Real, but scores ' + scored.score + ' - below the ' + qualifyFloor + ' floor for taking up a rep\'s day.';
  } else {
    discovery_status = 'qualified';
  }

  // Preserve a manual "someone is on it" state rather than flipping it back.
  if (lead.discovery_status === 'verifying' && discovery_status === 'discovered') {
    discovery_status = 'verifying';
  }

  return {
    score: scored.score,
    tier: scored.tier,
    score_breakdown: scored.breakdown,
    disqualified: scored.disqualified,
    disqualify_reason: scored.disqualified ? scored.disqualifyReason : reason,
    confidence: conf.confidence,
    confidence_breakdown: conf.breakdown,
    discovery_status,
    assignable: conf.assignable && discovery_status === 'qualified',
  };
}

/** Column patch, JSON-encoded, ready for knex. */
export function evaluationPatch(lead, scoringCfg, confidenceCfg) {
  const e = evaluate(lead, scoringCfg, confidenceCfg);
  const patch = {
    score: e.score,
    tier: e.tier,
    score_breakdown: JSON.stringify(e.score_breakdown),
    disqualified: e.disqualified,
    disqualify_reason: e.disqualify_reason,
    confidence: e.confidence,
    confidence_breakdown: JSON.stringify(e.confidence_breakdown),
    discovery_status: e.discovery_status,
  };
  // The CHECK constraint will reject a stage on a lead that is no longer
  // qualified and approved, so clear it here rather than letting the write fail.
  if (e.discovery_status !== 'qualified' && lead.stage) patch.stage = null;
  return { patch, evaluation: e };
}

/**
 * Field-level provenance. An enterprise buyer will eventually ask where a phone
 * number came from, and "the AI said so" needs to be distinguishable from "a
 * person read it off Google Maps on this date".
 */
export function recordProvenance(existing, fields, { source, method, by, confidence }) {
  const prov = { ...(existing || {}) };
  const at = new Date().toISOString();
  for (const field of fields) {
    prov[field] = {
      source: source || 'unknown',
      method: method || null,
      by: by || null,
      confidence: confidence || null,
      verified_at: at,
    };
  }
  return prov;
}
