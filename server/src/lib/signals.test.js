import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, DEFAULT_SCORING_CONFIG, gapsFrom } from './scoring.js';
import { computeConfidence, DEFAULT_CONFIDENCE_CONFIG } from './confidence.js';
import { evaluate } from '../services/lifecycle.js';

/**
 * The signals the v2 auditor, Maps and Instagram feed into the score, and the
 * rules around them: a site audited before a signal existed earns nothing for
 * it, a chain never qualifies, a person's rejection survives a rescore.
 */

const cfg = DEFAULT_SCORING_CONFIG;
const ctx = { now: new Date('2026-10-01T00:00:00Z') };

const base = {
  name: 'Ranka Jewellers',
  normalized_category: 'jewellery_store',
  category: 'Jewellery store',
  review_count: 640,
  rating: 4.5,
  business_status: 'OPERATIONAL',
  website: 'https://ranka.in',
  website_status: 'ok',
  has_https: true,
  mobile_friendly: true,
};

const auditV2 = (over = {}) => ({
  v: 2,
  status: 200,
  metaDescription: 'Jewellery in Pune',
  socialLinkCount: 2,
  textLength: 4000,
  tracking: { any: true, analytics: true, adTracking: true, ga4: true, metaPixel: false, googleAds: false, universalAnalytics: false },
  conversion: { any: true, whatsapp: true },
  seo: { noindex: false, localSchema: true },
  tech: { outdated: [] },
  ...over,
});

const digitalLabels = (r) => r.breakdown.digital.signals.map((s) => s.label + ':' + s.points).join(' | ');

test('the v2 gaps are scored when the audit measured them', () => {
  const r = scoreLead({
    ...base,
    website_audit: auditV2({
      tracking: { any: false, analytics: false, adTracking: false },
      conversion: { any: false },
      seo: { noindex: true, localSchema: false },
      tech: { outdated: ['Flash'] },
    }),
  }, cfg, ctx);
  const labels = digitalLabels(r);
  assert.match(labels, /No analytics or ad tracking:5/);
  assert.match(labels, /No way to enquire on the site:4/);
  assert.match(labels, /Site is hidden from Google:8/);
  assert.match(labels, /Outdated technology:3/);
  assert.match(labels, /No local business schema:2/);
});

test('an audit from before v2 earns nothing for signals it never measured', () => {
  const old = scoreLead({ ...base, website_audit: { status: 200, metaDescription: 'x', socialLinkCount: 1, textLength: 5000 } }, cfg, ctx);
  assert.doesNotMatch(digitalLabels(old), /analytics|enquire|hidden|schema|Outdated/);
});

test('ad tracking already installed costs points, and never goes below zero', () => {
  const r = scoreLead({ ...base, website_audit: auditV2({ tracking: { any: true, analytics: true, adTracking: true, googleAds: true, metaPixel: true } }) }, cfg, ctx);
  const s = r.breakdown.digital.signals.find((x) => /Ad tracking already installed/.test(x.label));
  assert.equal(s.points, -4);
  assert.ok(r.breakdown.digital.points >= 0);
  assert.ok(!gapsFrom(r.breakdown).some((g) => /Ad tracking/.test(g)), 'a negative is not a sellable gap');
});

test('an invalid certificate is scored instead of "no HTTPS", not as well as', () => {
  const r = scoreLead({ ...base, has_https: false, website_audit: auditV2({ tls: { valid: false, customerVisible: true, error: 'CERT_HAS_EXPIRED' } }) }, cfg, ctx);
  const labels = digitalLabels(r);
  assert.match(labels, /SSL certificate is invalid:5/);
  assert.doesNotMatch(labels, /No HTTPS/);
});

test('a bad rating across many reviews is a reputation sale; a few reviews are not', () => {
  assert.match(digitalLabels(scoreLead({ ...base, rating: 3.6, review_count: 480 }, cfg, ctx)), /3\.6 stars across 480 reviews:5/);
  assert.doesNotMatch(digitalLabels(scoreLead({ ...base, rating: 3.6, review_count: 22 }, cfg, ctx)), /stars across/);
  assert.doesNotMatch(digitalLabels(scoreLead({ ...base, rating: 4.4 }, cfg, ctx)), /stars across/);
});

test('a dormant or empty Instagram account is a gap', () => {
  const dormant = scoreLead({ ...base, social_audit: { instagram: { found: true, mediaCount: 40, lastPostAt: '2026-05-01T00:00:00Z' } } }, cfg, ctx);
  assert.match(digitalLabels(dormant), /No Instagram post in 153 days:5/);
  const empty = scoreLead({ ...base, social_audit: { instagram: { found: true, mediaCount: 0, lastPostAt: null } } }, cfg, ctx);
  assert.match(digitalLabels(empty), /Instagram account with no posts:5/);
  const active = scoreLead({ ...base, social_audit: { instagram: { found: true, mediaCount: 300, lastPostAt: '2026-09-28T00:00:00Z' } } }, cfg, ctx);
  assert.doesNotMatch(digitalLabels(active), /Instagram/);
});

test('a site that blocks checks earns no gap points either way', () => {
  const r = scoreLead({ ...base, website_status: 'protected', website_audit: { v: 2, protected: 'bot_wall' } }, cfg, ctx);
  assert.equal(r.breakdown.digital.points, 0);
  assert.match(digitalLabels(r), /blocks automated checks:0/);
});

test('hiring for marketing and a new opening are triggers', () => {
  const r = scoreLead({ ...base, website_audit: auditV2({ hiringMarketing: true, newOpening: true }) }, cfg, ctx);
  const t = r.breakdown.trigger.signals.map((s) => s.label).join(' | ');
  assert.match(t, /Hiring for marketing/);
  assert.match(t, /new opening/);
});

test('a chain or government body is disqualified with its reason; a cleared one is not', () => {
  const chain = scoreLead({ ...base, exclusion: 'chain', exclusion_reason: 'Chain outlet (tanishq)' }, cfg, ctx);
  assert.equal(chain.disqualified, true);
  assert.match(chain.disqualifyReason, /tanishq/);

  const cleared = scoreLead({ ...base, exclusion: 'none' }, cfg, ctx);
  assert.equal(cleared.disqualified, false);

  const optedIn = scoreLead({ ...base, exclusion: 'chain' }, { ...cfg, disqualify: { ...cfg.disqualify, excludeFranchiseHq: false } }, ctx);
  assert.equal(optedIn.disqualified, false, 'the weight is a switch the team can turn off');
});

test('a social page listed as the website is scored, and a dead Google profile link says so', () => {
  const r = scoreLead({ ...base, website: 'https://x.business.site', website_status: 'social_only', website_audit: { socialOnlyHost: 'business.site', platformKind: 'google' } }, cfg, ctx);
  assert.match(digitalLabels(r), /dead Google Business Profile link:10/);
});

/* ---------------- confidence ---------------- */

test('an invalid phone number is not evidence', () => {
  const lead = { ...base, phone: '24441454', phone_normalized: null, phone_type: 'invalid' };
  const r = computeConfidence(lead, DEFAULT_CONFIDENCE_CONFIG);
  assert.match(r.breakdown.missing.map((m) => m.label).join(' | '), /looks invalid/);
  const ok = computeConfidence({ ...lead, phone: '98220 12345', phone_normalized: '+919822012345', phone_type: 'mobile' }, DEFAULT_CONFIDENCE_CONFIG);
  assert.ok(ok.confidence > r.confidence);
  assert.match(ok.breakdown.signals.map((s) => s.label).join(' | '), /Mobile number on record/);
});

test('a social page or a protected site counts as checked', () => {
  for (const website_status of ['social_only', 'protected']) {
    const r = computeConfidence({ ...base, website_status }, DEFAULT_CONFIDENCE_CONFIG);
    assert.doesNotMatch(r.breakdown.missing.map((m) => m.label).join(' | '), /[Ww]ebsite/, website_status);
  }
});

test('recent activity earns part of the trading-status evidence', () => {
  const thisYear = new Date().getFullYear();
  const noStatus = { ...base, business_status: null };
  const silent = computeConfidence({ ...noStatus, website_audit: { copyrightYear: 2015 } }, DEFAULT_CONFIDENCE_CONFIG);
  const active = computeConfidence({ ...noStatus, website_audit: { copyrightYear: thisYear } }, DEFAULT_CONFIDENCE_CONFIG);
  assert.equal(active.confidence - silent.confidence, 6);
  assert.match(active.breakdown.signals.map((s) => s.detail || '').join(' | '), /current to/);

  const surveyed = computeConfidence({ ...noStatus, website_status: 'unknown', website: null, source_url: { osm: { checkDate: new Date(Date.now() - 100 * 86400000).toISOString().slice(0, 10) } } }, DEFAULT_CONFIDENCE_CONFIG);
  assert.match(surveyed.breakdown.signals.map((s) => s.detail || '').join(' | '), /OpenStreetMap/);
});

/* ---------------- lifecycle ---------------- */

test('a deal a rep is working stays on the board when its data gets worse', () => {
  // Confidence dips below the floor after a re-audit: before, the stage was
  // cleared and the lead vanished from the rep's board mid-follow-up.
  const working = {
    ...base, status: 'approved', stage: 'follow_up_3', verified_at: '2026-09-01T00:00:00Z',
    business_status: null, review_count: null, website_status: 'broken', phone_normalized: '+912025884455', phone: '+91 20 2588 4455',
  };
  const e = evaluate(working, cfg);
  assert.equal(e.discovery_status, 'qualified');
  assert.equal(e.disqualified, false);
  assert.match(e.disqualify_reason, /^In the pipeline, but: Confidence is/);

  // Even a new exclusion only warns; a rep already in conversation decides.
  const chain = evaluate({ ...working, exclusion: 'chain', exclusion_reason: 'Chain outlet (x)' }, cfg);
  assert.equal(chain.discovery_status, 'qualified');
  assert.match(chain.disqualify_reason, /Chain outlet/);

  // Out of the pipeline, the same lead is not qualified.
  assert.notEqual(evaluate({ ...working, stage: null }, cfg).discovery_status, 'qualified');
});

test("a person's rejection survives a rescore", () => {
  // Rescoring used to recompute these from the data alone and resurrect them.
  const rejected = { ...base, google_place_id: 'ChIJx', phone_normalized: '+912025531234', address: 'x', lat: 1, lng: 1, status: 'rejected', disqualify_reason: 'A person checked and this business does not exist' };
  const e = evaluate(rejected, cfg);
  assert.equal(e.discovery_status, 'rejected');
  assert.equal(e.disqualified, true);
  assert.equal(e.deal_score, 0);
  assert.match(e.disqualify_reason, /does not exist/);

  const fromReview = evaluate({ ...rejected, disqualify_reason: 'Confidence is 30%, below the floor' }, cfg);
  assert.equal(fromReview.disqualify_reason, 'Rejected in review');

  const held = evaluate({ ...rejected, status: 'hold' }, cfg);
  assert.notEqual(held.discovery_status, 'rejected', 'holding it brings it back');
});
