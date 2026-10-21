import test from 'node:test';
import assert from 'node:assert/strict';
import { dealScore, urgentIssue, recommendPackage, gapTagsFor } from './deal.js';
import { evaluate } from '../services/lifecycle.js';
import { DEFAULT_SCORING_CONFIG } from './scoring.js';

/**
 * The hot list's ordering. The test that matters: a big, owner-run business
 * with an urgent visible problem and a mobile number outranks everything that
 * lacks any of the three.
 */

const verified = {
  google_place_id: 'ChIJ',
  business_status: 'OPERATIONAL',
  address: 'FC Road, Pune',
  lat: 18.52,
  lng: 73.84,
};

const bigBroken = {
  ...verified,
  name: 'Shree Multispeciality Hospital',
  normalized_category: 'private_hospital',
  review_count: 1850,
  rating: 4.4,
  phone_normalized: '+919822012345',
  phone_type: 'mobile',
  website: 'https://shreehospital.in',
  website_status: 'broken',
  website_audit: { v: 2, error: 'The domain does not resolve - expired or never set up' },
};

const smallFine = {
  ...verified,
  name: 'Corner Cafe',
  normalized_category: 'cafe',
  review_count: 60,
  rating: 4.1,
  phone_normalized: '+912025531234',
  phone_type: 'landline',
  website: 'https://cornercafe.in',
  website_status: 'ok',
  has_https: true,
  mobile_friendly: true,
  website_audit: { v: 2, status: 200, metaDescription: 'x', socialLinkCount: 2, textLength: 4000, tracking: { any: true, analytics: true, adTracking: true }, conversion: { any: true, whatsapp: true }, seo: { localSchema: true }, tech: { outdated: [] } },
};

const deal = (lead) => evaluate(lead, DEFAULT_SCORING_CONFIG).deal;

test('a big owner-run business with a dead site and a mobile number is hot', () => {
  const d = deal(bigBroken);
  assert.equal(d.band, 'hot');
  assert.ok(d.score >= 70, 'scored ' + d.score);
  assert.match(d.reasons[0], /website is down right now/, 'the urgent hook leads');
  assert.ok(d.reasons.some((r) => /Mobile number/.test(r)));
});

test('it outranks a small healthy business, and a landline outranks no phone', () => {
  assert.ok(deal(bigBroken).score > deal(smallFine).score + 30);
  const noPhone = deal({ ...bigBroken, phone_normalized: null, phone_type: null });
  assert.ok(deal(bigBroken).score > noPhone.score);
  assert.ok(noPhone.blockers.some((b) => /No way to contact/.test(b)));
});

test('a WhatsApp number on their own site counts as reachable', () => {
  const viaSite = deal({ ...bigBroken, phone_normalized: '+912025531234', phone_type: 'landline', website_status: 'ok', website_audit: { v: 2, contact: { whatsapp: '+919822099999' } } });
  assert.ok(viaSite.reasons.some((r) => /WhatsApp number on their own website/.test(r)));
});

test('unverified facts and an existing agency hold a deal back', () => {
  const unverified = { ...bigBroken, google_place_id: null, business_status: null, address: null, lat: null, lng: null };
  const d = deal(unverified);
  assert.ok(d.blockers.some((b) => /not verified/.test(b)));
  assert.ok(d.score < deal(bigBroken).score);

  const agency = deal({ ...bigBroken, agency_managed: true });
  assert.equal(agency.score, 0, 'an agency-managed lead is disqualified outright');
});

test('excluded and rejected leads are never hot', () => {
  assert.equal(deal({ ...bigBroken, exclusion: 'chain', exclusion_reason: 'Chain outlet' }).score, 0);
  assert.equal(deal({ ...bigBroken, status: 'rejected' }).score, 0);
});

test('urgent issues, most visible first', () => {
  assert.match(urgentIssue({ website_status: 'parked' }), /parked/);
  assert.match(urgentIssue({ website_status: 'ok', website_audit: { tls: { valid: false, customerVisible: true } } }), /security warning/);
  assert.match(urgentIssue({ website_status: 'ok', website_audit: { seo: { noindex: true } } }), /hidden from Google/);
  assert.match(urgentIssue({ website_status: 'none', review_count: 1240 }), /1,240 Google reviews and no website/);
  assert.match(urgentIssue({ website_status: 'ok', review_count: 300, rating: 3.5 }), /3\.5-star rating/);
  assert.equal(urgentIssue({ website_status: 'none', review_count: 40 }), null, 'too small to lead with');
  assert.equal(urgentIssue({ website_status: 'ok', review_count: 300, rating: 4.6 }), null);
});

/* ---------------- packages ---------------- */

const catalog = [
  { name: 'Custom Website Development', gap_tags: ['no_website', 'placeholder_site', 'broken_site'] },
  { name: 'Increase site index', gap_tags: ['no_seo', 'no_website'] },
  { name: 'UI/UX Design', gap_tags: ['placeholder_site', 'not_mobile'] },
  { name: 'Social Media Management', gap_tags: ['low_instagram', 'high_review_ratio', 'stale_gbp'] },
  { name: 'Reel Contents', gap_tags: ['no_video', 'low_instagram'] },
  { name: 'Sponsored Ads', gap_tags: ['no_ads'] },
];
const packages = [
  { id: 'pk_starter', name: 'Starter Site', price_min: 15000, price_max: 25000, includes: ['Custom Website Development', 'Increase site index'], active: true },
  { id: 'pk_social', name: 'Social Growth', price_min: 18000, price_max: 35000, includes: ['Social Media Management', 'Reel Contents'], active: true },
  { id: 'pk_full', name: 'Full Stack Brand', price_min: 75000, price_max: 150000, includes: ['Custom Website Development', 'UI/UX Design', 'Increase site index'], active: true },
];

test('the package follows the gaps, and its size follows the business', () => {
  const noSiteBig = { normalized_category: 'jewellery_store', review_count: 1240, website_status: 'none' };
  assert.equal(recommendPackage(noSiteBig, packages, catalog).name, 'Full Stack Brand');

  const noSiteSmall = { normalized_category: 'cafe', review_count: 80, website_status: 'none' };
  assert.equal(recommendPackage(noSiteSmall, packages, catalog).name, 'Starter Site');

  const socialGap = { normalized_category: 'salon', review_count: 400, ig_followers: 120, website_status: 'ok' };
  assert.deepEqual(gapTagsFor(socialGap).sort(), ['high_review_ratio', 'low_instagram']);
  assert.equal(recommendPackage(socialGap, packages, catalog).name, 'Social Growth');

  assert.equal(recommendPackage({ website_status: 'unknown' }, packages, catalog), null, 'no known gap, no recommendation');
});

test('an incidental match does not win on price', () => {
  // The seeded PRO Retainer includes an AI chatbot tagged no_website, one
  // service in eight. It used to be recommended for every big site-less lead.
  const withRetainer = [
    ...packages,
    { id: 'pk_pro', name: 'PRO Retainer', price_min: 100000, price_max: null, billing: 'monthly', active: true,
      includes: ['Ai Chatbot Agent', 'Influencer Marketing', 'Sponsored Ads', 'Lead Generation', 'Public Relation', 'Professional Advertisement', 'Ai Process Automation', 'Social Media Management'] },
  ];
  const cat = [...catalog, { name: 'Ai Chatbot Agent', gap_tags: ['no_website'] }];
  const noSiteBig = { normalized_category: 'jewellery_store', review_count: 1240, website_status: 'none' };
  assert.equal(recommendPackage(noSiteBig, withRetainer, cat).name, 'Full Stack Brand');
});
