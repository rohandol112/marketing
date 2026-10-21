import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, DEFAULT_SCORING_CONFIG, gapsFrom } from './scoring.js';
import { computeConfidence, DEFAULT_CONFIDENCE_CONFIG } from './confidence.js';
import { dealScore } from './deal.js';
import { enrichSocial } from './prompts.js';

const cfg = DEFAULT_SCORING_CONFIG;
const ctx = { now: new Date('2026-10-01T00:00:00Z') };

const baseLead = {
  id: 'lead_test_123',
  name: 'Kothari Jewellers',
  locality: 'Kothrud',
  region: 'Pune',
  category: 'Jewellery store',
  review_count: 550,
  rating: 4.6,
  business_status: 'OPERATIONAL',
  website: 'https://kotharijewellers.com',
  website_status: 'ok',
  has_https: true,
  mobile_friendly: true,
};

test('social presence: low follower count with high reviews awards review-to-follower ratio and lowInstagram', () => {
  const scored = scoreLead({
    ...baseLead,
    ig_followers: 120,
    social_audit: {
      instagram: {
        found: true,
        handle: 'kotharijewellers',
        followers: 120,
        mediaCount: 45,
        lastPostAt: '2026-09-20T00:00:00Z',
        source: 'gemini_search_grounding',
      },
    },
  }, cfg, ctx);

  const digital = scored.breakdown.digital.signals.map((s) => s.label);
  assert.ok(digital.some((l) => l.includes('Review to follower ratio')), 'should award review-to-follower ratio');
  assert.ok(digital.some((l) => l.includes('Instagram under 1000')), 'should award lowInstagram');

  // Gaps should name social media management
  const gaps = gapsFrom(scored.breakdown);
  assert.ok(gaps.some((g) => /instagram|follower|social/i.test(g)), 'gaps should highlight social presence');
});

test('social presence: dormant Instagram account awards dormantInstagram and triggers deal opportunity', () => {
  const scored = scoreLead({
    ...baseLead,
    ig_followers: 800,
    social_audit: {
      instagram: {
        found: true,
        handle: 'kotharijewellers',
        followers: 800,
        mediaCount: 30,
        lastPostAt: '2026-05-01T00:00:00Z', // 153 days quiet (> 90 days)
        source: 'gemini_search_grounding',
      },
    },
  }, cfg, ctx);

  const digital = scored.breakdown.digital.signals.map((s) => s.label);
  assert.ok(digital.some((l) => l.includes('No Instagram post in')), 'should award dormantInstagram points');

  const conf = computeConfidence({
    ...baseLead,
    social_audit: { instagram: { found: true } },
    field_provenance: { groundingSources: ['https://instagram.com/kotharijewellers'] },
  }, DEFAULT_CONFIDENCE_CONFIG);

  assert.ok(conf.breakdown.signals.some((s) => s.label === 'Social presence checked'), 'confidence awards socialVerified');

  const deal = dealScore({
    ...baseLead,
    social_audit: {
      instagram: {
        found: true,
        mediaCount: 30,
        lastPostAt: '2026-05-01T00:00:00Z',
      },
    },
  }, scored, conf);

  assert.ok(deal.reasons.some((r) => r.includes('Instagram has been silent')), 'deal reasons should highlight Instagram dormancy');
});

test('social presence: empty Instagram account with 0 posts is flagged as gap', () => {
  const scored = scoreLead({
    ...baseLead,
    ig_followers: 50,
    social_audit: {
      instagram: {
        found: true,
        handle: 'kothari_pune',
        followers: 50,
        mediaCount: 0,
        lastPostAt: null,
        source: 'gemini_search_grounding',
      },
    },
  }, cfg, ctx);

  const digital = scored.breakdown.digital.signals.map((s) => s.label);
  assert.ok(digital.some((l) => l === 'Instagram account with no posts'), 'should flag 0 posts account');
});

test('social presence: Facebook and LinkedIn presence tracked in social_audit', () => {
  const leadWithSocial = {
    ...baseLead,
    ig_followers: 400,
    fb_followers: 1200,
    li_followers: 25,
    social_audit: {
      instagram: { found: true, followers: 400, handle: 'kothari_jewellers', source: 'gemini_search_grounding' },
      facebook: { found: true, followers: 1200, url: 'https://facebook.com/kotharijewellers', source: 'gemini_search_grounding' },
      linkedin: { found: true, followers: 25, url: 'https://linkedin.com/company/kothari-jewellers', source: 'gemini_search_grounding' },
    },
  };

  const scored = scoreLead(leadWithSocial, cfg, ctx);
  const digital = scored.breakdown.digital.signals.map((s) => s.label);

  assert.ok(digital.some((l) => l === 'LinkedIn barely used'), 'should award lowLinkedin for 25 followers');
});
