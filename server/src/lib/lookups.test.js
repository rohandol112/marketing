import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';
import { lookupBusiness, placeIdFor, parseRating, parseCount } from './mapsDiscovery.js';
import { lookupInstagram } from './instagram.js';

/**
 * The two outside lookups, against canned responses. What matters is what they
 * refuse to believe: another business's place id, a rating of 45, a follower
 * count for an account that might not be theirs.
 */

function geminiResponse(obj, chunks = []) {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [{
        content: { parts: [{ text: '```json\n' + JSON.stringify(obj) + '\n```' }] },
        groundingMetadata: { groundingChunks: chunks.map((c) => ({ maps: c })) },
      }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 80 },
    }),
  });
}

test('ratings and counts are parsed strictly', () => {
  assert.equal(parseRating('4.6'), 4.6);
  assert.equal(parseRating('4,6'), 4.6);
  assert.equal(parseRating(45), null, 'a 45-star rating is a parsing accident');
  assert.equal(parseRating(0), null);
  assert.equal(parseCount('1,234 reviews'), 1234);
  assert.equal(parseCount('1.2k'), 1200);
  assert.equal(parseCount(0), 0, 'zero reviews is a real answer');
  assert.equal(parseCount('lots'), null);
});

test('a place id is matched to its business by name, never by position', () => {
  const chunks = [
    { placeId: 'ChIJ_neighbour_aaaaaaaaaaaaaa', title: 'Kumar Sweets' },
    { placeId: 'ChIJ_ranka_bbbbbbbbbbbbbbbbbb', title: 'Ranka Jewellers' },
  ];
  // The model put Ranka first and gave no id: positional pairing used to hand
  // it Kumar Sweets' place.
  assert.equal(placeIdFor('Ranka Jewellers', chunks, ''), 'ChIJ_ranka_bbbbbbbbbbbbbbbbbb');
  assert.equal(placeIdFor('Unrelated Name', chunks, null), null);
  assert.equal(placeIdFor('Ranka Jewellers', chunks, 'ChIJ_declared_cccccccccccccccc'), 'ChIJ_declared_cccccccccccccccc');
});

const lead = {
  name: 'Ranka Jewellers',
  address: 'Laxmi Road, Pune',
  locality: 'Pune',
  category: 'Jewellery store',
  phone_normalized: null,
  website_host: 'ranka.in',
};

test('a strong match: same name, values copied as Maps holds them', async () => {
  const r = await lookupBusiness(lead, {
    fetchImpl: geminiResponse(
      { found: true, name: 'Ranka Jewellers', address: 'Laxmi Rd, Pune', category: 'Jewelry store', rating: '4.6', review_count: '1,284', phone: '020 2445 1234', website: 'https://ranka.in', business_status: 'OPERATIONAL' },
      [{ placeId: 'ChIJ_ranka_bbbbbbbbbbbbbbbbbb', title: 'Ranka Jewellers' }]
    ),
  });
  assert.equal(r.match, 'strong');
  assert.equal(r.result.rating, 4.6);
  assert.equal(r.result.review_count, 1284);
  assert.equal(r.result.place_id, 'ChIJ_ranka_bbbbbbbbbbbbbbbbbb');
  assert.equal(r.result.business_status, 'OPERATIONAL');
  assert.equal(r.grounded, true);
  assert.equal(r.hostMatch, true);
});

test('a different business with a similar name is not written', async () => {
  const r = await lookupBusiness(lead, {
    fetchImpl: geminiResponse({ found: true, name: 'Rathi Jewels & Watches', rating: 4.1, review_count: 300 }),
  });
  assert.equal(r.match, 'none');
});

test('not found is not a match, and a closed business says so', async () => {
  assert.equal((await lookupBusiness(lead, { fetchImpl: geminiResponse({ found: false }) })).match, 'none');
  const closed = await lookupBusiness(lead, {
    fetchImpl: geminiResponse({ found: true, name: 'Ranka Jewellers', business_status: 'CLOSED_PERMANENTLY' }),
  });
  assert.equal(closed.result.business_status, 'CLOSED_PERMANENTLY');
});

test('a matching phone turns a weak name match into a candidate - and only the phone does', async () => {
  const listing = { found: true, name: 'Ranka Diamonds', phone: '+91 20 2445 1234' };
  const goldHouse = { ...lead, name: 'Ranka Gold House', website_host: null };

  const withoutPhone = await lookupBusiness({ ...goldHouse, phone_normalized: null }, { fetchImpl: geminiResponse(listing) });
  assert.ok(withoutPhone.similarity < 0.5, 'names alone are too far apart: ' + withoutPhone.similarity);
  assert.equal(withoutPhone.match, 'none');

  const withPhone = await lookupBusiness({ ...goldHouse, phone_normalized: '+912024451234' }, { fetchImpl: geminiResponse(listing) });
  assert.equal(withPhone.phoneMatch, true);
  assert.equal(withPhone.match, 'medium', 'offered to a person, not written');
});

/* ---------------- Instagram ---------------- */

function graph(body, status = 200) {
  return async () => ({ ok: status < 400, status, json: async () => body });
}

test('Instagram: followers, recency and engagement from Business Discovery', async () => {
  config.instagram.token = 'test-token';
  config.instagram.businessId = '17841400000000000';
  const now = new Date('2026-10-01T00:00:00Z');
  const r = await lookupInstagram('@RankaJewellers', {
    now,
    fetchImpl: graph({
      business_discovery: {
        username: 'rankajewellers', name: 'Ranka Jewellers', followers_count: 2400, follows_count: 80, media_count: 210,
        website: 'https://ranka.in',
        media: { data: [
          { timestamp: '2026-09-25T10:00:00+0000', like_count: 40, comments_count: 4 },
          { timestamp: '2026-06-01T10:00:00+0000', like_count: 20, comments_count: 0 },
        ] },
      },
    }),
  });
  assert.equal(r.found, true);
  assert.equal(r.handle, 'rankajewellers');
  assert.equal(r.followers, 2400);
  assert.equal(r.mediaCount, 210);
  assert.equal(r.lastPostAt, '2026-09-25T10:00:00.000Z');
  assert.equal(r.postsLast30d, 1);
  assert.equal(r.engagementRate, 0.0133);
});

test('Instagram: a personal account is not found, throttling retries, a dead token stops', async () => {
  config.instagram.token = 'test-token';
  config.instagram.businessId = '17841400000000000';
  const missing = await lookupInstagram('someperson', { fetchImpl: graph({ error: { code: 110, message: 'Invalid user id' } }, 400) });
  assert.equal(missing.found, false);

  await assert.rejects(
    lookupInstagram('x_y', { fetchImpl: graph({ error: { code: 4, message: 'Application request limit reached' } }, 400) }),
    (e) => e.retryable === true
  );
  await assert.rejects(
    lookupInstagram('x_y', { fetchImpl: graph({ error: { code: 190, message: 'Error validating access token' } }, 400) }),
    (e) => e.retryable === false && /META_GRAPH_TOKEN/.test(e.message)
  );
  assert.equal((await lookupInstagram('reel', { fetchImpl: graph({}) })).found, false, 'a reserved path is not a handle');
});
