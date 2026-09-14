import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, DEFAULT_SCORING_CONFIG, gapsFrom } from './scoring.js';

/**
 * Hand-labelled fixtures. These are the leads a rep looked at and said "yes,
 * obviously call that one first". If a weight change stops ranking them top,
 * the weight change is wrong until proven otherwise by closed-won data.
 */

const narenkumar = {
  name: 'Narenkumar Jewellers',
  normalized_category: 'jewellery_store',
  category: 'Jewelry store',
  review_count: 1240,
  rating: 4.6,
  website: null,
  website_status: 'none',
  li_followers: 24,
  ig_followers: 310,
  years_in_business: 22,
  locations_count: 2,
  business_status: 'OPERATIONAL',
};

const mauliGarden = {
  name: 'Mauli Garden Lawns',
  normalized_category: 'banquet_hall',
  category: 'Banquet hall',
  review_count: 820,
  rating: 4.4,
  website: null,
  website_status: 'none',
  ig_followers: 420,
  years_in_business: 11,
  locations_count: 1,
  business_status: 'OPERATIONAL',
};

const tangent = {
  name: 'Tangent Interiors',
  normalized_category: 'interior_designer',
  category: 'Interior designer',
  review_count: 186,
  rating: 4.8,
  website: 'http://tangentinteriors.example',
  website_status: 'placeholder',
  has_https: false,
  mobile_friendly: false,
  ig_followers: 740,
  years_in_business: 7,
  locations_count: 1,
  business_status: 'OPERATIONAL',
};

const cornerCafe = {
  name: 'Corner Street Cafe',
  normalized_category: 'cafe',
  category: 'Cafe',
  review_count: 260,
  rating: 4.2,
  website: 'https://cornercafe.example',
  website_status: 'ok',
  has_https: true,
  mobile_friendly: true,
  psi_mobile: 88,
  ig_followers: 14000,
  years_in_business: 3,
  locations_count: 1,
  business_status: 'OPERATIONAL',
};

const tinyShop = {
  name: 'New Tailor Shop',
  normalized_category: 'boutique',
  review_count: 6,
  rating: 4.9,
  website_status: 'none',
  business_status: 'OPERATIONAL',
};

const closedDown = {
  name: 'Old Salon',
  normalized_category: 'salon',
  review_count: 400,
  rating: 4.5,
  website_status: 'none',
  business_status: 'CLOSED_PERMANENTLY',
};

const cfg = DEFAULT_SCORING_CONFIG;
// Fixed date so the seasonality bonus cannot make these tests flaky.
const ctx = { now: new Date('2026-06-15T00:00:00Z') };

test('the three hand-labelled leads all land in tier A', () => {
  for (const lead of [narenkumar, mauliGarden, tangent]) {
    const r = scoreLead(lead, cfg, ctx);
    assert.equal(r.tier, 'A', lead.name + ' scored ' + r.score + ', expected tier A');
    assert.equal(r.disqualified, false, lead.name + ' should not be disqualified');
  }
});

test('a healthy cafe with a real digital presence ranks below all of them', () => {
  const cafe = scoreLead(cornerCafe, cfg, ctx);
  for (const lead of [narenkumar, mauliGarden, tangent]) {
    const r = scoreLead(lead, cfg, ctx);
    assert.ok(
      r.score > cafe.score,
      lead.name + ' (' + r.score + ') should outrank the cafe (' + cafe.score + ')'
    );
  }
  assert.notEqual(cafe.tier, 'A');
});

test('the review floor disqualifies businesses with no proven demand', () => {
  const r = scoreLead(tinyShop, cfg, ctx);
  assert.equal(r.disqualified, true);
  assert.match(r.disqualifyReason, /reviews/);
});

test('permanently closed businesses are disqualified regardless of score', () => {
  const r = scoreLead(closedDown, cfg, ctx);
  assert.equal(r.disqualified, true);
  assert.match(r.disqualifyReason, /operational/i);
});

test('the review-to-follower ratio fires on the jeweller', () => {
  const r = scoreLead(narenkumar, cfg, ctx);
  const labels = r.breakdown.digital.signals.map((s) => s.label).join(' | ');
  assert.match(labels, /Review to follower ratio/);
});

test('no bucket can exceed its own cap', () => {
  const maxed = {
    ...narenkumar,
    review_count: 50000,
    ig_followers: 1,
    li_followers: 1,
    runs_ads: false,
    locations_count: 12,
    new_outlet_days: 10,
    hiring_marketing: true,
  };
  const r = scoreLead(maxed, cfg, ctx);
  assert.ok(r.breakdown.demand.points <= cfg.demand.max);
  assert.ok(r.breakdown.digital.points <= cfg.digital.max);
  assert.ok(r.breakdown.affordability.points <= cfg.affordability.max);
  assert.ok(r.breakdown.trigger.points <= cfg.trigger.max);
  assert.ok(r.score <= 100);
});

test('an unknown review count scores zero rather than a flattering placeholder', () => {
  const unknown = { ...mauliGarden, review_count: null, rating: null };
  const r = scoreLead(unknown, cfg, ctx);

  // Not disqualified - we do not know it is bad, we just do not know.
  assert.equal(r.disqualified, false);

  // The review signal itself must contribute nothing. Paying points for missing
  // data made every unverified lead cluster at the same fake score. Other
  // demand signals we genuinely know, like tenure, still count.
  const reviewSignal = r.breakdown.demand.signals.find((x) => /review count/i.test(x.label));
  assert.equal(reviewSignal.points, 0);

  // With nothing else known either, demand is worth exactly nothing.
  const blank = scoreLead(
    { ...unknown, years_in_business: null, locations_count: null },
    cfg, ctx
  );
  assert.equal(blank.breakdown.demand.points, 0);

  const known = scoreLead(mauliGarden, cfg, ctx);
  assert.ok(
    known.score > r.score,
    'a lead with a known review count must outscore the same lead without one'
  );
});

test('gapsFrom returns something a rep can actually say out loud', () => {
  const r = scoreLead(narenkumar, cfg, ctx);
  const gaps = gapsFrom(r.breakdown);
  assert.ok(gaps.length >= 2);
  assert.ok(gaps.some((g) => /website/i.test(g)));
});

test('scoring is pure - same input, same output', () => {
  const a = scoreLead(narenkumar, cfg, ctx);
  const b = scoreLead(narenkumar, cfg, ctx);
  assert.deepEqual(a.score, b.score);
  assert.deepEqual(a.breakdown.digital.points, b.breakdown.digital.points);
});
