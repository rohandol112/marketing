/**
 * Data confidence: how much of this record is actually evidenced.
 *
 * This exists because a single number was doing two incompatible jobs. A lead
 * scoring 92 because we know it is excellent and a lead scoring 92 because we
 * are guessing generously look identical on a board, and only one of them
 * should ever reach a rep.
 *
 * Opportunity score answers "is this worth selling to".
 * Confidence answers "do we actually know that".
 *
 * They must never be averaged together. A high-opportunity, low-confidence lead
 * is not a medium lead - it is a research task.
 */

export const DEFAULT_CONFIDENCE_CONFIG = {
  weights: {
    identity: 25,         // an authoritative source says this exists (see below)
    operational: 10,      // and says it is still trading
    phone: 10,
    websiteResolves: 10,  // we fetched it ourselves and it answered
    address: 10,
    coordinates: 5,
    ratingAndReviews: 10,
    socialVerified: 10,
    secondSource: 10,     // human check, or grounded search citations
  },
  levels: { high: 80, medium: 60 },
  /** Below this, a lead cannot be handed to a rep. */
  assignFloor: 60,
};

function add(out, points, label, detail) {
  out.points += points;
  out.signals.push({ label, points, detail: detail || null });
}

function miss(out, label, worth) {
  out.missing.push({ label, worth });
}

export function computeConfidence(lead, cfg = DEFAULT_CONFIDENCE_CONFIG) {
  // Same trap as the scoring config: a stored weights object must not erase
  // weights added in a later release.
  const w = { ...DEFAULT_CONFIDENCE_CONFIG.weights, ...(cfg.weights || {}) };
  const levels = { ...DEFAULT_CONFIDENCE_CONFIG.levels, ...(cfg.levels || {}) };
  const prov = lead.field_provenance || {};

  const out = { points: 0, signals: [], missing: [] };

  /**
   * Identity: does an authoritative source say this business exists.
   *
   * A Google Place ID is the cheapest way to satisfy this, but it is not the
   * only one, and treating it as the only one is a trap: with no Places API key
   * this single check is worth 25 points that can never be earned, so no lead
   * could ever clear the assignment floor and the whole pipeline dead-ends.
   *
   * A person who opened Maps, confirmed the business and copied its phone
   * number across has established identity at least as well as an API lookup.
   * That is the point of the verification step.
   */
  if (lead.google_place_id) {
    add(out, w.identity, 'Google Place ID', 'An authoritative directory lists this business');
  } else if (lead.external_source === 'google_maps') {
    // A Maps place id is the same identity evidence a Places lookup gives; it
    // simply arrives through Gemini's grounding tool instead of the REST API.
    add(out, w.identity, 'Google Maps place', 'Looked up in Maps, not recalled');
  } else if (lead.external_source === 'gemini_grounded') {
    const n = (prov.groundingSources || []).length;
    add(out, Math.round(w.identity * 0.7), 'Found in web search with ' + n + ' cited sources',
        'Retrieved and cited, not recalled - but weaker than a directory listing');
    miss(out, 'Not confirmed against a business directory', Math.round(w.identity * 0.3));
  } else if (lead.external_source === 'openstreetmap') {
    // Somebody physically surveyed this and put it on a map with coordinates.
    // Weaker than Google - no trading status, and it can go stale - but it is a
    // real public directory listing, not a generated name.
    add(out, Math.round(w.identity * 0.8), 'Mapped in OpenStreetMap', 'Surveyed by a contributor, with coordinates');
    miss(out, 'Not confirmed against Google', Math.round(w.identity * 0.2));
  } else if (prov.verification || lead.verified_at) {
    add(out, w.identity, 'Confirmed by a person on Maps', prov.verification?.method || 'manual check');
  } else if (lead.website && lead.website_status === 'ok') {
    // Their own working website naming the business is weaker, but it is
    // first-party evidence that something real is trading under this name.
    add(out, Math.round(w.identity * 0.6), 'Own website resolves', 'First-party evidence, weaker than a directory listing');
    miss(out, 'No directory listing or human check', Math.round(w.identity * 0.4));
  } else {
    miss(out, 'Existence not confirmed by any authoritative source', w.identity);
  }

  if (lead.business_status === 'OPERATIONAL') {
    add(out, w.operational, 'Confirmed operational');
  } else if (lead.business_status) {
    miss(out, 'Business status is ' + lead.business_status, w.operational);
  } else {
    miss(out, 'Trading status unknown', w.operational);
  }

  if (lead.phone_normalized) {
    const src = prov.phone?.method || prov.phone?.source;
    add(out, w.phone, 'Phone on record', src ? 'via ' + src : null);
  } else {
    miss(out, 'No phone number', w.phone);
  }

  // Only counts if the auditor actually reached it. A URL nobody has fetched is
  // a claim, not evidence.
  const siteResolved = lead.website && ['ok', 'placeholder', 'parked'].includes(lead.website_status);
  if (siteResolved) {
    add(out, w.websiteResolves, 'Website responds', 'We fetched it, it is real');
  } else if (lead.website && lead.website_status === 'broken') {
    miss(out, 'Website on record does not respond', w.websiteResolves);
  } else if (lead.website) {
    miss(out, 'Website not yet checked', w.websiteResolves);
  } else if (lead.website_status === 'unknown') {
    miss(out, 'Nobody has checked whether they have a website', w.websiteResolves);
  } else {
    // Confirmed to have none - that is knowledge, not a gap in our knowledge.
    add(out, w.websiteResolves, 'Confirmed to have no website', 'An authoritative source says so');
  }

  if (lead.address) add(out, w.address, 'Street address');
  else miss(out, 'No address', w.address);

  if (lead.lat != null && lead.lng != null) add(out, w.coordinates, 'Coordinates');
  else miss(out, 'No coordinates', w.coordinates);

  if (lead.review_count != null && lead.rating != null) {
    add(out, w.ratingAndReviews, 'Rating and review count', 'Demand can actually be scored');
  } else {
    miss(out, 'No rating or review count', w.ratingAndReviews);
  }

  const social = lead.ig_handle || lead.ig_followers != null || lead.li_followers != null;
  if (social) add(out, w.socialVerified, 'Social presence checked');
  else miss(out, 'Social accounts not checked', w.socialVerified);

  // A second, independent source. The human check already paid for identity
  // above, so it only counts again here when a directory listing was the thing
  // that established identity - otherwise it would be the same evidence twice.
  const humanVerified = Boolean(prov.verification || lead.verified_at);
  const grounded = Array.isArray(prov.groundingSources) && prov.groundingSources.length > 0;
  if (lead.google_place_id && humanVerified) {
    add(out, w.secondSource, 'Directory listing plus a human check', 'Two independent sources agree');
  } else if (grounded) {
    add(out, w.secondSource, 'Grounded in search results', prov.groundingSources.length + ' sources');
  } else if (humanVerified && lead.website && lead.website_status !== 'broken') {
    add(out, w.secondSource, 'Human check plus a working website');
  } else {
    miss(out, 'Only one source of evidence', w.secondSource);
  }

  const score = Math.max(0, Math.min(100, Math.round(out.points)));
  const level = score >= levels.high ? 'high' : score >= levels.medium ? 'medium' : 'low';

  return {
    confidence: score,
    level,
    assignable: score >= (cfg.assignFloor ?? DEFAULT_CONFIDENCE_CONFIG.assignFloor),
    breakdown: {
      points: score,
      level,
      signals: out.signals,
      missing: out.missing.sort((a, b) => b.worth - a.worth),
      computedAt: new Date().toISOString(),
    },
  };
}

/** The shortest path to a usable lead: what to fill in first. */
export function nextBestVerification(lead, cfg) {
  const { breakdown } = computeConfidence(lead, cfg);
  return breakdown.missing.slice(0, 3).map((m) => m.label);
}
