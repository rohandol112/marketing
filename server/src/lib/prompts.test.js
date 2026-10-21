import test from 'node:test';
import assert from 'node:assert/strict';
import { briefFallback, waFallback, leadContext } from './prompts.js';
import { scoreLead, DEFAULT_SCORING_CONFIG } from './scoring.js';

/**
 * The templates a rep reads whenever the model is unavailable - with no working
 * key, every brief. They have to read like a person wrote them.
 */

const catalog = [
  { name: 'Custom Website Development', gap_tags: ['no_website', 'placeholder_site', 'broken_site'], active: true },
  { name: 'Increase site index', gap_tags: ['no_seo', 'no_website'], active: true },
  { name: 'SEO Audit', gap_tags: ['no_seo', 'slow_site'], active: true },
  { name: 'Social Media Management', gap_tags: ['low_instagram', 'high_review_ratio'], active: true },
  { name: 'Pay-Per-Click Ads', gap_tags: ['no_ads'], active: true },
];
const packages = [
  { id: 'pk_starter', name: 'Starter Site', price_min: 15000, price_max: 25000, currency: 'INR', billing: 'one_time', sort_order: 1, includes: ['Custom Website Development', 'Increase site index'], active: true },
  { id: 'pk_social', name: 'Social Growth', price_min: 18000, price_max: 35000, currency: 'INR', billing: 'monthly', sort_order: 3, includes: ['Social Media Management'], active: true },
];

const withScore = (lead) => ({ ...lead, score_breakdown: scoreLead(lead, DEFAULT_SCORING_CONFIG).breakdown });

test('an unchecked website reads as a sentence, not "a unknown website"', () => {
  const b = briefFallback(withScore({ name: 'P N Gadgil', normalized_category: 'jewellery_store', website_status: 'unknown' }), packages, catalog);
  assert.equal(b.headline, 'P N Gadgil has a website nobody has checked yet.');
  assert.match(b.opener, /^Hi, I was looking at P N Gadgil online and noticed/);
});

test('an urgent, verified problem leads the brief', () => {
  const lead = withScore({
    name: 'Shree Hospital', normalized_category: 'private_hospital', review_count: 1850, rating: 4.4,
    website: 'https://shreehospital.in', website_status: 'broken',
    website_audit: { error: 'The domain does not resolve - expired or never set up' },
  });
  const b = briefFallback(lead, packages, catalog);
  assert.match(b.headline, /^Shree Hospital: their website is down right now/);
  assert.match(b.opener, /1,850 reviews is a lot of happy customers\. I noticed your site is broken or unreachable\./);
});

test('each gap gets a service that answers it, from the catalogue', () => {
  const lead = withScore({
    name: 'Ranka Jewellers', normalized_category: 'jewellery_store', review_count: 640, rating: 4.5,
    website: 'https://ranka.in', website_status: 'ok', has_https: true, mobile_friendly: true, ig_followers: 120,
    website_audit: { v: 2, status: 200, metaDescription: 'x', socialLinkCount: 2, textLength: 4000,
      tracking: { any: false, analytics: false, adTracking: false }, conversion: { any: true }, seo: { localSchema: true }, tech: { outdated: [] } },
  });
  const b = briefFallback(lead, packages, catalog);
  const byGap = Object.fromEntries(b.gaps.map((g) => [g.gap, g.service]));
  assert.equal(byGap['No analytics or ad tracking'], 'Pay-Per-Click Ads');
  assert.equal(byGap['Instagram under 1000'], 'Social Media Management');
  assert.ok(b.gaps.every((g) => g.why_it_matters && !/^Customers looking for them online/.test(g.why_it_matters)));
});

test('the brief recommends the same package as the lead card', () => {
  const b = briefFallback(withScore({ name: 'Mauli Lawns', normalized_category: 'banquet_hall', review_count: 820, website_status: 'none' }), packages, catalog);
  assert.equal(b.recommended_package_id, 'pk_starter');
  assert.equal(b.price_band, 'INR 15,000 to 25,000');
});

test('the WhatsApp template reads mid-sentence correctly', () => {
  const m = waFallback(withScore({ name: 'Mauli Lawns', normalized_category: 'banquet_hall', review_count: 820, website_status: 'none' }), { name: 'Tanz Corp' });
  assert.match(m.message, /One thing stood out: no website at all\./);
});

test('the model is told what kind of number is on file, never the number', () => {
  const ctx = leadContext(withScore({ name: 'Ranka', normalized_category: 'jewellery_store', phone: '+91 98220 12345', phone_normalized: '+919822012345', phone_type: 'mobile', website_status: 'none' }));
  assert.match(ctx, /Best contact: a mobile number \(WhatsApp works\)/);
  assert.doesNotMatch(ctx, /98220/);
  assert.match(ctx, /Area: unknown/, 'the old precedence bug printed "Area: " with nothing after it');
});
