import { tierOf, isInSeason } from './categories.js';
import { asObject, daysSince } from './util.js';
import { EXCLUSION_LABELS } from './classify.js';

/**
 * Deterministic lead scoring. No LLM anywhere in this file, on purpose.
 *
 * The whole thesis is one ratio: offline strength divided by online presence.
 * A jeweller with 80,000 customers and 24 LinkedIn followers is not a weak
 * business, it is a business with an unclaimed digital asset. That gap is the
 * product. Everything below is a way of putting a number on it.
 *
 * Weights are data, not code, so they can be retuned from closed-won data
 * without a deploy. See POST /api/settings/scoring and the retune script.
 */

export const DEFAULT_SCORING_CONFIG = {
  version: 1,

  demand: {
    max: 40,
    reviewLogCoef: 12,        // 12 * log10(reviews + 1): 100 -> 24, 1000 -> 36
    // Unknown demand is worth nothing. Paying points for a missing review count
    // made every unverified lead cluster at the same fake score, which is worse
    // than useless - it looks like a ranking. Missing data costs confidence
    // instead, which is a number that says what it means.
    unknownReviewsPoints: 0,
    ratingBonus: { min: 4.3, points: 4 },
    tenureBonus: { minYears: 5, points: 4 },
    multiLocation: { min: 2, points: 6 },
  },

  digital: {
    max: 30,
    noWebsite: 12,
    placeholderSite: 10,
    brokenSite: 10,
    noHttps: 4,
    notMobileFriendly: 4,
    slowMobile: { maxPsi: 50, points: 3 },
    reviewToFollowerRatio: { min: 1.0, points: 8 },  // the killer signal
    lowInstagram: { max: 1000, points: 6 },
    lowLinkedin: { max: 500, points: 3 },
    staleGbp: { days: 90, points: 4 },
    notRunningAds: 4,

    // Signals the auditor already collects for free. Leaving these unscored is
    // why 1,600 leads all sat on exactly 12 points - "has a website or not" was
    // doing the entire job of a 30-point bucket.
    socialAsWebsite: 10,        // their "website" is a Facebook page
    noSocialLinks: 6,           // live site that links to no social at all
    noMetaDescription: 3,
    staleContent: { years: 2, points: 4 },
    thinContent: 3,

    // Read off the page by the v2 auditor. A site audited before these existed
    // has no evidence either way, and unknown scores nothing.
    noTracking: 5,              // no analytics, tag manager or pixel at all
    noRetargeting: 2,           // measures visits, cannot retarget them
    noConversionPath: 4,        // no form, WhatsApp, click-to-call, booking or chat
    noindex: 8,                 // the site tells Google not to list it
    sslInvalid: 5,              // expired or wrong certificate: a full-page browser warning
    outdatedTech: 3,            // Flash, 1990s markup, jQuery 1.x, WordPress 5
    noLocalSchema: 2,
    lowSeoScore: { max: 70, points: 3 },                  // Google's own PageSpeed SEO audit
    lowRating: { max: 3.9, minReviews: 30, points: 5 },   // reputation management is the sale
    dormantInstagram: { days: 60, points: 5 },
    adsAlreadyRunning: -4,      // ads tag or pixel: someone is probably already doing this
  },

  affordability: {
    max: 20,
    tierPoints: { T1: 20, T2: 13, T3: 6 },
    unknownPoints: 8,
  },

  trigger: {
    max: 10,
    newOutlet: { days: 90, points: 10 },
    hiringMarketing: 6,
    newOpening: 5,
    inSeason: 4,
  },

  tiers: { A: 70, B: 50 },

  disqualify: {
    minReviews: 20,
    requireOperational: true,
    excludeAgencyManaged: true,
    excludeFranchiseHq: true,   // chain and franchise outlets: marketing is bought centrally
    excludeGovernment: true,    // government and non-commercial bodies are not buyers
  },
};

const round = (n) => Math.round(n * 100) / 100;

/**
 * Merge a stored config over the defaults, one level deep into each bucket.
 *
 * A shallow spread looks right and is a trap: `{...DEFAULTS, ...cfg}` replaces
 * the whole `digital` object with the stored one, so every weight added in a
 * later release is undefined for any tenant who had already saved their
 * weights. That crashed the scorer with "cannot read properties of undefined"
 * on a config saved two commits earlier.
 */
export function mergeConfig(defaults, cfg) {
  if (!cfg || typeof cfg !== 'object') return defaults;
  const out = { ...defaults };
  for (const [k, v] of Object.entries(cfg)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && defaults[k] && typeof defaults[k] === 'object') {
      out[k] = mergeConfig(defaults[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

function bucket(label, max) {
  return { label, points: 0, max, signals: [] };
}

function award(b, points, label, detail) {
  if (!points) return;
  b.points += points;
  b.signals.push({ label, points: round(points), detail: detail || null });
}

function note(b, label, detail) {
  b.signals.push({ label, points: 0, detail: detail || null });
}

function capBucket(b) {
  if (b.points > b.max) {
    b.signals.push({ label: 'Capped at ' + b.max, points: round(b.max - b.points), detail: null });
    b.points = b.max;
  }
  b.points = Math.max(0, round(b.points));
  return b;
}

/**
 * @param {object} lead   raw lead row (snake_case, as stored)
 * @param {object} cfg    scoring config
 * @param {object} ctx    { now?: Date }
 */
export function scoreLead(lead, cfg = DEFAULT_SCORING_CONFIG, ctx = {}) {
  const c = mergeConfig(DEFAULT_SCORING_CONFIG, cfg);
  const at = ctx.now || new Date();

  const reviews = numOrNull(lead.review_count);
  const rating = numOrNull(lead.rating);
  const igF = numOrNull(lead.ig_followers);
  const liF = numOrNull(lead.li_followers);
  const catId = lead.normalized_category;
  const audit = asObject(lead.website_audit);
  const v2 = Number(audit.v) >= 2;

  // ---------------- disqualifiers ----------------
  const dq = [];
  if (c.disqualify.requireOperational && lead.business_status && lead.business_status !== 'OPERATIONAL') {
    dq.push('Not operational (' + lead.business_status + ')');
  }
  if (reviews !== null && reviews < c.disqualify.minReviews) {
    dq.push('Only ' + reviews + ' reviews (floor is ' + c.disqualify.minReviews + ')');
  }
  if (c.disqualify.excludeAgencyManaged && lead.agency_managed === true) {
    dq.push('Already has an agency');
  }
  // A person can clear an exclusion by setting it to 'none'. The detectors
  // never overwrite that, so the same false positive cannot come back.
  const exclusion = lead.exclusion && lead.exclusion !== 'none' ? lead.exclusion : null;
  if (exclusion) {
    const switchedOff =
      (exclusion === 'chain' && !c.disqualify.excludeFranchiseHq) ||
      ((exclusion === 'government' || exclusion === 'non_commercial') && !c.disqualify.excludeGovernment);
    if (!switchedOff) dq.push(lead.exclusion_reason || EXCLUSION_LABELS[exclusion] || exclusion);
  }

  // ---------------- DEMAND ----------------
  const demand = bucket('Demand', c.demand.max);
  if (reviews === null) {
    demand.signals.push({
      label: 'Review count unknown',
      points: 0,
      detail: 'Scores nothing. Demand cannot be measured without it - fill it in during verification.',
    });
  } else {
    const pts = c.demand.reviewLogCoef * Math.log10(reviews + 1);
    award(demand, pts, reviews.toLocaleString() + ' reviews', 'log-scaled so 1,000 reviews is not 10x 100 reviews');
  }
  if (rating !== null && rating >= c.demand.ratingBonus.min) {
    award(demand, c.demand.ratingBonus.points, rating.toFixed(1) + ' star rating', 'People already like them - the product is not the problem');
  }
  if (numOrNull(lead.years_in_business) !== null && lead.years_in_business >= c.demand.tenureBonus.minYears) {
    award(demand, c.demand.tenureBonus.points, lead.years_in_business + ' years in business', 'Survived long enough to have budget');
  }
  if (numOrNull(lead.locations_count) !== null && lead.locations_count >= c.demand.multiLocation.min) {
    award(demand, c.demand.multiLocation.points, lead.locations_count + ' locations', 'Multi-outlet means a real marketing budget line');
  }
  capBucket(demand);

  // ---------------- DIGITAL GAP ----------------
  const digital = bucket('Digital gap', c.digital.max);
  const ws = lead.website_status;

  if (ws === 'unknown') {
    // Not "they have no website" - "nobody has checked". Scoring these the same
    // was the single biggest source of false positives in the whole product.
    note(digital, 'Website not checked yet', 'The directory does not record one. Confirm on Maps or search before assuming there is none.');
  } else if (ws === 'protected') {
    note(digital, 'Site blocks automated checks', 'It is up, but nothing about its content can be claimed until someone opens it.');
  } else if (!lead.website || ws === 'none') {
    award(digital, c.digital.noWebsite, 'No website at all', 'The single easiest thing to sell');
  } else if (ws === 'social_only') {
    const host = String(audit.socialOnlyHost || 'social');
    award(
      digital,
      c.digital.socialAsWebsite,
      audit.platformKind === 'google'
        ? 'Their website is a dead Google Business Profile link'
        : 'Their website is a ' + host.split('.')[0] + ' page',
      'They have an audience somewhere and own nothing - the clearest possible pitch'
    );
  } else if (ws === 'placeholder' || ws === 'parked') {
    award(
      digital,
      c.digital.placeholderSite,
      ws === 'parked' ? 'Domain parked, for sale or suspended' : 'Placeholder or unfinished site',
      audit.placeholderReason || (audit.signals && audit.signals[0]) || 'Template defaults still on the page'
    );
  } else if (ws === 'broken') {
    award(digital, c.digital.brokenSite, 'Site is broken or unreachable', audit.error || 'Paying for a domain that does nothing');
  } else {
    const tlsBad = audit.tls && audit.tls.valid === false && audit.tls.customerVisible;
    if (tlsBad) {
      award(digital, c.digital.sslInvalid, 'SSL certificate is invalid', 'Browsers show a full-page security warning before the site loads');
    } else if (lead.has_https === false) {
      award(digital, c.digital.noHttps, 'No HTTPS', 'Browsers now flag this to their customers');
    }
    if (lead.mobile_friendly === false) award(digital, c.digital.notMobileFriendly, 'Not mobile responsive', 'Most of their traffic is a phone');
    const psi = numOrNull(lead.psi_mobile);
    if (psi !== null && psi < c.digital.slowMobile.maxPsi) {
      award(digital, c.digital.slowMobile.points, 'Mobile PageSpeed ' + psi, 'Slow enough to lose the visit');
    }
    const seoScore = numOrNull(audit.psi && audit.psi.seo);
    if (seoScore !== null && seoScore < c.digital.lowSeoScore.max) {
      award(digital, c.digital.lowSeoScore.points, 'Google scores their SEO ' + seoScore + '/100', "Google's own audit, a number they can check themselves");
    }

    // A live site that links to no social account anywhere is the same story as
    // a low follower count, and unlike follower counts we can actually see it.
    if (audit.socialLinkCount === 0) {
      award(digital, c.digital.noSocialLinks, 'Site links to no social accounts', 'No audience being built anywhere they own');
    }
    if (audit.metaDescription === null && audit.status) {
      award(digital, c.digital.noMetaDescription, 'No meta description', 'Google has nothing to show under their name');
    }
    if (audit.copyrightYear && at.getFullYear() - audit.copyrightYear >= c.digital.staleContent.years) {
      award(digital, c.digital.staleContent.points, 'Site untouched since ' + audit.copyrightYear, 'Nobody has looked at it in years');
    }
    if (!audit.spa && audit.textLength != null && audit.textLength < 400) {
      award(digital, c.digital.thinContent, 'Almost no content on the page', 'Nothing for search or a customer to read');
    }

    if (v2) {
      const t = audit.tracking || null;
      if (audit.seo && audit.seo.noindex) {
        award(digital, c.digital.noindex, 'Site is hidden from Google', 'A robots noindex tag tells Google not to list it - it cannot rank for anything');
      }
      if (t && !t.any) {
        award(digital, c.digital.noTracking, 'No analytics or ad tracking', 'They cannot see where a single customer comes from');
      } else if (t && t.universalAnalytics && !t.analytics && !t.adTracking) {
        award(digital, c.digital.noTracking, 'Only dead Universal Analytics', 'Google switched it off - nothing has been measured since');
      } else if (t && t.analytics && !t.adTracking) {
        award(digital, c.digital.noRetargeting, 'No retargeting pixel', 'Every visitor who leaves is gone for good');
      }
      if (audit.conversion && !audit.conversion.any) {
        award(digital, c.digital.noConversionPath, 'No way to enquire on the site', 'No form, WhatsApp button, click-to-call or booking');
      }
      if (audit.tech && Array.isArray(audit.tech.outdated) && audit.tech.outdated.length) {
        award(digital, c.digital.outdatedTech, 'Outdated technology', audit.tech.outdated.join(', '));
      }
      if (audit.seo && !audit.seo.localSchema) {
        award(digital, c.digital.noLocalSchema, 'No local business schema', 'Google cannot read their address, hours or category from the site');
      }
      if (t && (t.googleAds || t.metaPixel)) {
        award(
          digital,
          c.digital.adsAlreadyRunning,
          'Ad tracking already installed',
          [t.googleAds && 'Google Ads tag', t.metaPixel && 'Meta pixel'].filter(Boolean).join(' and ') + ' found - someone may already run their ads'
        );
      }
    }
  }

  // Reputation is a digital sale in its own right, whatever the website.
  if (rating !== null && reviews !== null && reviews >= c.digital.lowRating.minReviews && rating <= c.digital.lowRating.max) {
    award(
      digital,
      c.digital.lowRating.points,
      rating.toFixed(1) + ' stars across ' + reviews.toLocaleString() + ' reviews',
      'The rating is costing them customers - reputation management is the pitch'
    );
  }

  // The ratio that matters most: lots of real customers, almost no followers.
  const followers = maxOrNull([igF, liF, numOrNull(lead.fb_followers)]);
  if (reviews !== null && followers !== null && followers >= 0) {
    const ratio = reviews / Math.max(followers, 1);
    if (ratio > c.digital.reviewToFollowerRatio.min) {
      award(
        digital,
        c.digital.reviewToFollowerRatio.points,
        'Review to follower ratio ' + ratio.toFixed(1) + ':1',
        reviews.toLocaleString() + ' customers bothered to review, only ' + followers.toLocaleString() + ' follow them'
      );
    }
  }
  if (igF !== null && igF < c.digital.lowInstagram.max) {
    award(digital, c.digital.lowInstagram.points, 'Instagram under ' + c.digital.lowInstagram.max, igF.toLocaleString() + ' followers');
  }
  const ig = asObject(lead.social_audit).instagram;
  if (ig && ig.found) {
    const quiet = daysSince(ig.lastPostAt, at.getTime());
    if (Number(ig.mediaCount) === 0) {
      award(digital, c.digital.dormantInstagram.points, 'Instagram account with no posts', 'They claimed the handle and never used it');
    } else if (quiet !== null && quiet > c.digital.dormantInstagram.days) {
      award(digital, c.digital.dormantInstagram.points, 'No Instagram post in ' + quiet + ' days', 'They have the account and stopped feeding it');
    }
  }
  if (liF !== null && liF < c.digital.lowLinkedin.max) {
    award(digital, c.digital.lowLinkedin.points, 'LinkedIn barely used', liF.toLocaleString() + ' followers');
  }
  if (lead.gbp_days_since_post != null && lead.gbp_days_since_post > c.digital.staleGbp.days) {
    award(digital, c.digital.staleGbp.points, 'No Google post in ' + lead.gbp_days_since_post + ' days', 'Free channel sitting idle');
  }
  if (lead.runs_ads === false) {
    award(digital, c.digital.notRunningAds, 'Not running ads', 'Rep-verified - no paid acquisition at all');
  }
  capBucket(digital);

  // ---------------- AFFORDABILITY ----------------
  const afford = bucket('Affordability', c.affordability.max);
  const tier = tierOf(catId);
  if (tier && c.affordability.tierPoints[tier] != null) {
    award(afford, c.affordability.tierPoints[tier], tier + ' category: ' + (lead.category || catId), tierNote(tier));
  } else {
    award(afford, c.affordability.unknownPoints, 'Category not classified', 'Defaulted - map it in the catalogue to sharpen this');
  }
  capBucket(afford);

  // ---------------- TRIGGER ----------------
  const trigger = bucket('Trigger', c.trigger.max);
  if (lead.new_outlet_days != null && lead.new_outlet_days <= c.trigger.newOutlet.days) {
    award(trigger, c.trigger.newOutlet.points, 'Opened a new outlet ' + lead.new_outlet_days + ' days ago', 'Best possible moment to call');
  } else if (audit.newOpening === true) {
    award(trigger, c.trigger.newOpening, 'Their site announces a new opening', 'New premises need customers fast');
  }
  if (lead.hiring_marketing === true || audit.hiringMarketing === true) {
    award(trigger, c.trigger.hiringMarketing, 'Hiring for marketing', 'They already decided they have a problem');
  }
  if (catId && isInSeason(catId, at)) {
    award(trigger, c.trigger.inSeason, 'Category is in season', 'Budget is open right now');
  }
  capBucket(trigger);

  const total = Math.round(demand.points + digital.points + afford.points + trigger.points);
  const leadTier = total >= c.tiers.A ? 'A' : total >= c.tiers.B ? 'B' : 'C';

  return {
    score: total,
    tier: leadTier,
    disqualified: dq.length > 0,
    disqualifyReason: dq.length ? dq.join('; ') : null,
    breakdown: {
      demand,
      digital,
      affordability: afford,
      trigger,
      total,
      tier: leadTier,
      scoredAt: at.toISOString(),
      configVersion: c.version,
    },
  };
}

function tierNote(tier) {
  if (tier === 'T1') return 'High ticket - a single close pays for the month';
  if (tier === 'T2') return 'Mid ticket - retainer territory';
  return 'Low ticket - only worth it in volume';
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function maxOrNull(arr) {
  const vals = arr.filter((v) => v !== null && v !== undefined);
  return vals.length ? Math.max(...vals) : null;
}

/** Short human lines. Feeds both the UI tooltip and the Gemini prompt. */
export function explainScore(breakdown) {
  if (!breakdown || !breakdown.demand) return [];
  const out = [];
  for (const key of ['demand', 'digital', 'affordability', 'trigger']) {
    const b = breakdown[key];
    if (!b) continue;
    for (const s of b.signals) {
      if (s.points > 0) out.push(s.label + (s.detail ? ' - ' + s.detail : ''));
    }
  }
  return out;
}

/** Just the sellable gaps, for the pitch. */
export function gapsFrom(breakdown) {
  if (!breakdown || !breakdown.digital) return [];
  return breakdown.digital.signals.filter((s) => s.points > 0).map((s) => s.label);
}
