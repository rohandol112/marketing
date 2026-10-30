import { tierOf, appGapOf } from './categories.js';
import { asObject, daysSince } from './util.js';

/**
 * "Can we close a big deal here this week?"
 *
 * Opportunity says the gap is real. Confidence says we know it. Neither says
 * whether a rep can get the owner on the phone tomorrow and leave with a signed
 * retainer, which is the only question that matters when the pipeline is empty.
 * This answers it, from three things:
 *
 *   size   - how big the deal can be: category value, scale, branches
 *   pain   - how visible and urgent the problem is. "Your site is down right
 *            now" closes faster than "your meta description is missing"
 *   reach  - whether a decision maker can be reached today: a mobile number
 *            that takes WhatsApp, facts verified enough to quote, an owner-run
 *            business rather than a branch office
 *
 * It ranks the hot list and nothing else. It never feeds back into opportunity
 * or confidence, and it never qualifies a lead - those gates stay where they are.
 */
export const DEFAULT_DEAL_CONFIG = {
  size: {
    max: 40,
    tier: { T1: 20, T2: 12, T3: 4 },
    reviewSteps: [[1000, 14], [300, 10], [100, 6], [30, 3]],
    multiLocation: 6,
  },
  pain: { max: 35, fromDigitalGap: 25, urgent: 10 },
  reach: { max: 25, mobile: 16, landline: 11, tollfree: 4, emailOnly: 4, verified: 5, ownerRun: 4 },
  bands: { hot: 70, warm: 50 },
};

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Appended to an urgent issue that rests on a search result rather than a source a person can trust. */
export const UNCONFIRMED = ' (going by search - open the profile before you say it)';

/** The one thing to open the call with, if there is something urgent. */
export function urgentIssue(lead) {
  const audit = asObject(lead.website_audit);
  const ws = lead.website_status;
  const reviews = num(lead.review_count);
  const rating = num(lead.rating);

  if (ws === 'broken') {
    return audit.error ? 'Their website is down right now: ' + lowerFirst(audit.error) : 'Their website is down right now';
  }
  if (ws === 'parked') return 'Their domain is parked, for sale or suspended - the site is gone';
  if (audit.tls && audit.tls.valid === false && audit.tls.customerVisible) return 'Visitors get a browser security warning on their site';
  if (audit.seo && audit.seo.noindex) return 'Their site is hidden from Google search';
  if (ws === 'placeholder') return 'Their site is an unfinished template';
  if ((ws === 'none' || ws === 'social_only') && reviews !== null && reviews >= 100) {
    return reviews.toLocaleString() + ' Google reviews and no website of their own';
  }
  if (rating !== null && reviews !== null && reviews >= 30 && rating <= 3.9) {
    return 'A ' + rating.toFixed(1) + '-star rating is costing them customers';
  }
  const ig = asObject(lead.social_audit).instagram;
  if (ig && ig.found) {
    const quiet = daysSince(ig.lastPostAt);
    if (quiet !== null && quiet > 90) {
      // A date read off a search result can be a pinned post or an old
      // snippet; the rep looks before saying it to the owner.
      return 'Their Instagram has been silent for ' + quiet + ' days'
        + (['gemini_search_grounding', 'openai_web_search'].includes(ig.source) ? UNCONFIRMED : '');
    }
  }
  return null;
}

function lowerFirst(s) {
  return String(s).charAt(0).toLowerCase() + String(s).slice(1);
}

/**
 * @param lead    the lead row
 * @param scored  scoreLead() output
 * @param conf    computeConfidence() output
 */
export function dealScore(lead, scored, conf, cfg = DEFAULT_DEAL_CONFIG) {
  const blockers = [];
  const reasons = [];

  if (scored.disqualified || lead.status === 'rejected') {
    return {
      score: 0, band: 'cold', size: 0, pain: 0, reach: 0, reasons: [],
      blockers: [scored.disqualifyReason || 'Rejected'],
    };
  }

  const audit = asObject(lead.website_audit);

  /* ---- size ---- */
  let size = 0;
  const tier = tierOf(lead.normalized_category);
  if (tier) {
    size += cfg.size.tier[tier] || 0;
    if (tier === 'T1') reasons.push('High-ticket category');
  }
  const reviews = num(lead.review_count);
  if (reviews !== null) {
    for (const [min, pts] of cfg.size.reviewSteps) {
      if (reviews >= min) {
        size += pts;
        if (min >= 300) reasons.push(reviews.toLocaleString() + ' reviews - an established, busy business');
        break;
      }
    }
  }
  const locations = num(lead.locations_count);
  if ((locations !== null && locations >= 2) || audit.multiLocation === true) {
    size += cfg.size.multiLocation;
    reasons.push('Several locations - a real marketing budget line');
  }
  size = Math.min(size, cfg.size.max);

  /* ---- pain ---- */
  const digital = scored.breakdown && scored.breakdown.digital ? scored.breakdown.digital : { points: 0, max: 30 };
  let pain = Math.round((digital.points / (digital.max || 30)) * cfg.pain.fromDigitalGap);
  const urgent = urgentIssue(lead);
  if (urgent) {
    pain += cfg.pain.urgent;
    reasons.unshift(urgent);
  }
  pain = Math.min(pain, cfg.pain.max);

  /* ---- reach ---- */
  let reach = 0;
  const whatsapp = audit.contact && audit.contact.whatsapp;
  if (lead.phone_normalized && lead.phone_type === 'mobile') {
    reach += cfg.reach.mobile;
    reasons.push('Mobile number on file - call or WhatsApp today');
  } else if (whatsapp) {
    reach += cfg.reach.mobile;
    reasons.push('WhatsApp number on their own website');
  } else if (lead.phone_normalized && lead.phone_type === 'tollfree') {
    reach += cfg.reach.tollfree;
    blockers.push('Only a toll-free number - hard to reach the owner');
  } else if (lead.phone_normalized) {
    reach += cfg.reach.landline;
  } else if (lead.email) {
    reach += cfg.reach.emailOnly;
    blockers.push('No phone number - email only');
  } else {
    blockers.push('No way to contact them yet');
  }
  if (conf && conf.confidence >= 80) reach += cfg.reach.verified;
  const bigOperation = (locations !== null && locations > 5) || audit.franchise === true;
  if (!bigOperation && lead.agency_managed !== true) reach += cfg.reach.ownerRun;
  reach = Math.min(reach, cfg.reach.max);

  /* ---- what holds it back ---- */
  let score = size + pain + reach;
  if (conf && conf.confidence < 60) {
    score *= 0.6;
    blockers.push('Facts not verified yet (' + conf.confidence + '% confidence)');
  }
  if (lead.agency_managed === true) {
    score *= 0.5;
    blockers.push('Already has an agency');
  }
  if (audit.tracking && audit.tracking.googleAds) {
    score *= 0.85;
    blockers.push('Already running Google Ads');
  }
  score = Math.max(0, Math.min(100, Math.round(score)));

  return {
    score,
    band: score >= cfg.bands.hot ? 'hot' : score >= cfg.bands.warm ? 'warm' : 'cold',
    size,
    pain,
    reach,
    reasons: reasons.slice(0, 4),
    blockers,
  };
}

/* ------------------------------------------------------------------ */
/* What to sell them                                                  */
/* ------------------------------------------------------------------ */

const asArray = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  return [];
};

/** The catalogue's gap tags this lead actually shows. */
export function gapTagsFor(lead) {
  const tags = new Set();
  const ws = lead.website_status;
  const audit = asObject(lead.website_audit);
  const reviews = num(lead.review_count);

  if (ws === 'none' || ws === 'social_only') tags.add('no_website');
  if (ws === 'placeholder' || ws === 'parked') tags.add('placeholder_site');
  if (ws === 'broken') tags.add('broken_site');
  if (num(lead.psi_mobile) !== null && lead.psi_mobile < 50) tags.add('slow_site');
  if (lead.mobile_friendly === false) tags.add('not_mobile');
  if (audit.seo && (audit.seo.noindex || !audit.seo.localSchema)) tags.add('no_seo');
  if (ws === 'ok' && audit.status && audit.metaDescription === null) tags.add('no_seo');

  const followers = Math.max(num(lead.ig_followers) ?? -1, num(lead.li_followers) ?? -1, num(lead.fb_followers) ?? -1);
  if (num(lead.ig_followers) !== null && lead.ig_followers < 1000) tags.add('low_instagram');
  if (audit.socialLinkCount === 0) tags.add('low_instagram');
  const ig = asObject(lead.social_audit).instagram;
  const noPosts = ig && ig.mediaCount !== null && ig.mediaCount !== undefined && ig.mediaCount !== '' && Number(ig.mediaCount) === 0;
  if (ig && ig.found && (noPosts || (daysSince(ig.lastPostAt) ?? 0) > 60)) tags.add('low_instagram');
  if (reviews !== null && followers >= 0 && reviews / Math.max(followers, 1) > 1) tags.add('high_review_ratio');

  if (lead.runs_ads === false || (audit.tracking && !audit.tracking.adTracking)) tags.add('no_ads');
  // A news house without an app is pitched the newsroom product, a school the institute app.
  if (lead.app_status === 'no_app') tags.add(appGapOf(lead.normalized_category));
  return [...tags];
}

/**
 * The package that answers the most of this lead's gaps, sized to the
 * business: a big T1 gets the bigger package among equals, a small shop the
 * cheaper one. Built from the tenant's own packages and service catalogue, so
 * renaming a package in Settings changes nothing here.
 *
 * `only` narrows it to the gaps being pitched - the app list asks for the
 * package that answers "no app", not the one that answers most gaps.
 */
export function recommendPackage(lead, packages = [], catalog = [], { only = null } = {}) {
  const gaps = new Set(gapTagsFor(lead).filter((t) => !only || only.includes(t)));
  if (!gaps.size || !packages.length) return null;

  const serviceTags = new Map(catalog.map((s) => [String(s.name).toLowerCase(), asArray(s.gap_tags)]));
  const reviews = num(lead.review_count) ?? 0;
  const big = tierOf(lead.normalized_category) === 'T1' && (reviews >= 300 || (num(lead.locations_count) ?? 0) >= 2);

  let best = null;
  for (const p of packages) {
    if (p.active === false) continue;
    const services = asArray(p.includes);
    const covers = new Set();
    let relevant = 0;
    for (const svc of services) {
      const hits = (serviceTags.get(String(svc).toLowerCase()) || []).filter((t) => gaps.has(t));
      if (hits.length) relevant++;
      hits.forEach((t) => covers.add(t));
    }
    // A package that answers the gap with one incidental service out of eight
    // is not the answer: a full retainer won "no website" on price because it
    // happens to include a website chatbot.
    if (!covers.size || relevant / Math.max(services.length, 1) < 0.15) continue;
    const price = Number(p.price_min) || 0;
    const rank = covers.size * 1000 + (big ? price : -price) / 1000;
    if (!best || rank > best.rank) best = { rank, p, covers: [...covers] };
  }
  if (!best) return null;

  const { p } = best;
  return {
    id: p.id,
    name: p.name,
    priceMin: p.price_min,
    priceMax: p.price_max,
    currency: p.currency,
    billing: p.billing,
    covers: best.covers,
  };
}
