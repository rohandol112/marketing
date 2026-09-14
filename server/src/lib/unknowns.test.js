import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, DEFAULT_SCORING_CONFIG } from './scoring.js';
import { computeConfidence, DEFAULT_CONFIDENCE_CONFIG } from './confidence.js';

/**
 * The rule this file defends, learned the hard way twice:
 *
 *   a field nobody has looked at must never score the same as a field
 *   someone looked at and found empty.
 *
 * It happened with review_count (every unverified lead clustered on one fake
 * number) and again with website_status, where 'none' was written for 1,600
 * OpenStreetMap businesses that mostly do have websites. Both looked like
 * working rankings and were noise.
 */

const cfg = DEFAULT_SCORING_CONFIG;
const ctx = { now: new Date('2026-06-15T00:00:00Z') };

const base = {
  name: 'Test Jewellers',
  normalized_category: 'jewellery_store',
  review_count: 400,
  rating: 4.5,
  business_status: 'OPERATIONAL',
};

test('an unchecked website scores nothing, a confirmed missing one scores full', () => {
  const unchecked = scoreLead({ ...base, website: null, website_status: 'unknown' }, cfg, ctx);
  const confirmed = scoreLead({ ...base, website: null, website_status: 'none' }, cfg, ctx);

  const pts = (r) => r.breakdown.digital.signals
    .filter((s) => /website/i.test(s.label))
    .reduce((a, s) => a + s.points, 0);

  assert.equal(pts(unchecked), 0, 'unknown must earn nothing');
  assert.equal(pts(confirmed), cfg.digital.noWebsite, 'a confirmed absence is a real gap');
  assert.ok(confirmed.score > unchecked.score);
});

test('an unchecked website says so rather than claiming there is none', () => {
  const r = scoreLead({ ...base, website: null, website_status: 'unknown' }, cfg, ctx);
  const labels = r.breakdown.digital.signals.map((s) => s.label).join(' | ');
  assert.match(labels, /not checked/i);
  assert.doesNotMatch(labels, /No website at all/);
});

test('not knowing costs confidence; knowing they have none earns it', () => {
  const unchecked = computeConfidence(
    { ...base, website: null, website_status: 'unknown' }, DEFAULT_CONFIDENCE_CONFIG
  );
  const confirmed = computeConfidence(
    { ...base, website: null, website_status: 'none' }, DEFAULT_CONFIDENCE_CONFIG
  );
  assert.ok(
    confirmed.confidence > unchecked.confidence,
    'confirming an absence is evidence and should raise confidence'
  );
  assert.match(unchecked.breakdown.missing.map((m) => m.label).join(' | '), /website/i);
});

test('a business listing a Facebook page as its website is a real gap', () => {
  const social = scoreLead(
    { ...base, website: 'https://facebook.com/testjewellers', website_status: 'social_only',
      website_audit: { socialOnlyHost: 'facebook.com' } },
    cfg, ctx
  );
  const labels = social.breakdown.digital.signals.map((s) => s.label).join(' | ');
  assert.match(labels, /facebook page/i);
  assert.ok(social.breakdown.digital.points >= cfg.digital.socialAsWebsite);
});

test('a live site linking to no social account is scored', () => {
  const r = scoreLead(
    { ...base, website: 'https://x.example', website_status: 'ok', has_https: true, mobile_friendly: true,
      website_audit: { status: 200, socialLinkCount: 0, metaDescription: 'x', textLength: 5000 } },
    cfg, ctx
  );
  const labels = r.breakdown.digital.signals.map((s) => s.label).join(' | ');
  assert.match(labels, /no social accounts/i);
});

test('a config saved before a weight existed does not crash the scorer', () => {
  // Exactly what was stored in the database: a complete-looking config from an
  // earlier release, missing every weight added since.
  const oldConfig = {
    version: 4,
    demand: { max: 40, reviewLogCoef: 12, ratingBonus: { min: 4.3, points: 4 } },
    digital: { max: 30, noWebsite: 12, placeholderSite: 10 },   // no staleContent, no socialAsWebsite
    affordability: { max: 20, tierPoints: { T1: 20, T2: 13, T3: 6 } },
    trigger: { max: 10 },
    tiers: { A: 70, B: 50 },
    disqualify: { minReviews: 20, requireOperational: true },
  };

  const lead = {
    ...base,
    website: 'https://x.example',
    website_status: 'ok',
    has_https: true,
    mobile_friendly: true,
    website_audit: { status: 200, copyrightYear: 2019, socialLinkCount: 0, metaDescription: null, textLength: 200 },
  };

  assert.doesNotThrow(() => scoreLead(lead, oldConfig, ctx));
  const r = scoreLead(lead, oldConfig, ctx);
  assert.ok(r.score > 0);
  // the operator's saved weight is respected, the missing ones fall back
  assert.equal(r.breakdown.digital.max, 30);
});
