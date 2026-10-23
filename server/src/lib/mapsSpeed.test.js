import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';
import {
  discoverCategory, mapsIdentity, mapsUrlFor, placeIdFor, thinkingFor, mapsError, mapsLimiter, callMaps,
} from './mapsDiscovery.js';
import { isKeyRefusal, googleErrorSummary, noteGeminiKey, geminiKeyStatus, probeGeminiKey, geminiUsable } from './llm.js';

/**
 * Maps discovery against canned Google responses: how fast a category runs,
 * what stops a sweep, and which listing ids are believed.
 */

mapsLimiter.rpm = 1000;

const area = { categoryId: 'jewellery_store', areaLabel: 'Baner, Pune', center: { lat: 18.559, lng: 73.7868 }, radiusM: 3000, regionCode: 'IN' };

function reply(businesses, { delayMs = 0, status = 200, body } = {}) {
  return async (url, init) => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const json = body || {
      candidates: [{ content: { parts: [{ text: JSON.stringify({ businesses }) }] }, groundingMetadata: {} }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 },
    };
    return {
      ok: status < 400,
      status,
      json: async () => json,
      text: async () => JSON.stringify(json),
      init,
    };
  };
}

const shop = (name, extra = {}) => ({
  name, locality: 'Baner', address: name + ', Baner Road, Pune', rating: '4.7', review_count: '1,204',
  phone: '+91 98220 12345', website: null, business_status: 'OPERATIONAL', ...extra,
});

test('a category runs its searches side by side, not one after another', async () => {
  const started = Date.now();
  const r = await discoverCategory({ ...area, passes: 3, fetchImpl: reply([shop('Kothari Jewellers')], { delayMs: 300 }) });
  const ms = Date.now() - started;
  assert.equal(r.calls, 3);
  assert.ok(ms < 800, 'three 300ms searches should take about 300ms together, took ' + ms + 'ms');
  assert.equal(r.leads.length, 1, 'the same business found by three searches is one lead');
});

test('a refused key stops the sweep instead of becoming a warning', async () => {
  const refused = {
    error: { code: 401, status: 'UNAUTHENTICATED', message: 'API keys are not supported by this API.', details: [{ reason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED' }] },
  };
  await assert.rejects(
    discoverCategory({ ...area, passes: 3, fetchImpl: reply([], { status: 401, body: refused }) }),
    (e) => e.fatal === true && e.keyRefused === true && /ACCESS_TOKEN_TYPE_UNSUPPORTED/.test(e.message)
  );
  assert.equal(geminiKeyStatus().ok, false, 'the refusal is remembered');
  assert.equal(geminiUsable(), false, 'and every Gemini feature reports itself off');
  noteGeminiKey(true);
});

test('the day\'s quota running out stops the sweep; a per-minute limit is retried', async () => {
  const daily = { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for GenerateRequestsPerDayPerProjectPerModel' } };
  await assert.rejects(
    discoverCategory({ ...area, passes: 1, fetchImpl: reply([], { status: 429, body: daily }) }),
    (e) => e.fatal === true && e.dailyQuota === true
  );

  let calls = 0;
  const flaky = async (...args) => {
    calls++;
    if (calls === 1) return reply([], { status: 429, body: { error: { code: 429, message: 'per minute' } } })(...args);
    return reply([shop('Ranka Jewellers')])(...args);
  };
  const r = await discoverCategory({ ...area, passes: 1, fetchImpl: flaky });
  assert.equal(calls, 2, 'retried once');
  assert.equal(r.leads.length, 1);
});

test('one search failing even after its retry is a warning; the other two still count', async () => {
  let n = 0;
  const mixed = async (url, init) => {
    n++;
    // The "independent or family-run" search keeps failing; the others answer.
    if (/independent or family-run/.test(init.body)) return reply([], { status: 500, body: { error: { code: 500, message: 'internal' } } })(url, init);
    return reply([shop('Business ' + n)])(url, init);
  };
  const r = await discoverCategory({ ...area, passes: 3, fetchImpl: mixed });
  assert.equal(n, 4, 'three searches and one retry');
  assert.equal(r.failed, 1);
  assert.equal(r.leads.length, 2);
  assert.ok(r.warnings.some((w) => /internal/.test(w)));
});

test('listing ids: place ids are kept, feature ids and CIDs become direct links, nothing else is believed', () => {
  assert.deepEqual(mapsIdentity('ChIJ2bsUIGy_wjsRtg8bTe2dN3c'), { placeId: 'ChIJ2bsUIGy_wjsRtg8bTe2dN3c', cid: null });
  assert.deepEqual(mapsIdentity('places/ChIJ2bsUIGy_wjsRtg8bTe2dN3c'), { placeId: 'ChIJ2bsUIGy_wjsRtg8bTe2dN3c', cid: null });
  assert.deepEqual(mapsIdentity('0x3bc2bf2e4e2c7b4b:0x2b8f1b7f0e4b6e01'), { placeId: null, cid: BigInt('0x2b8f1b7f0e4b6e01').toString() });
  // An all-digit id is a CID, not a place id - "place_id:<cid>" opens nothing.
  assert.deepEqual(mapsIdentity('10111481897763520146'), { placeId: null, cid: '10111481897763520146' });
  assert.equal(mapsIdentity(10111481897763520146).cid, null, 'a 20-digit number has already lost digits');
  assert.deepEqual(mapsIdentity('not-a-real-id'), { placeId: null, cid: null });
  assert.deepEqual(mapsIdentity(''), { placeId: null, cid: null });
  assert.equal(placeIdFor('Kothari Jewellers', [], '10111481897763520146'), null);

  assert.equal(mapsUrlFor({ placeId: 'ChIJabc' }), 'https://www.google.com/maps/place/?q=place_id:ChIJabc');
  assert.equal(mapsUrlFor({ cid: '123' }), 'https://maps.google.com/?cid=123');
  assert.match(mapsUrlFor({ name: 'Kothari Jewellers', place: 'Baner' }), /maps\/search\/Kothari%20Jewellers%20Baner/);
});

test('a lead found by its CID gets a direct Maps link and an exact dedupe key', async () => {
  const r = await discoverCategory({
    ...area, passes: 1,
    fetchImpl: reply([shop('PNG Jewellers', { maps_place_id: '0x3bc2bf2e4e2c7b4b:0x00000000000004d2' })]),
  });
  const lead = r.leads[0];
  assert.equal(lead.google_place_id, null);
  assert.equal(lead.external_id, 'cid:1234');
  assert.equal(lead.maps_url, 'https://maps.google.com/?cid=1234');
});

test('thinking is turned down for Maps calls only where it was measured to be safe', () => {
  assert.deepEqual(thinkingFor('gemini-3.6-flash', 'minimal', false), { thinkingLevel: 'minimal' });
  assert.deepEqual(thinkingFor('gemini-3-flash', 'minimal', false), { thinkingLevel: 'minimal' });
  assert.equal(thinkingFor('gemini-2.5-flash', 'minimal', false), null, 'with thinking off, 2.5 flash returned no businesses');
  assert.equal(thinkingFor('gemini-3.5-flash-lite', 'minimal', false), null, 'never measured');
  assert.equal(thinkingFor('gemini-3-pro', 'minimal', false), null, 'never measured');
  assert.deepEqual(thinkingFor('gemini-3-pro', 'low', true), { thinkingLevel: 'low' }, 'unless someone sets it on purpose');
  assert.equal(thinkingFor('gemini-3.6-flash', 'default', false), null);
});

test('a model that refuses the thinking setting is asked again at its default, once', async () => {
  const bodies = [];
  let call = 0;
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    call++;
    if (call === 1) {
      const body = { error: { code: 400, message: 'thinking_level is not supported by this model.' } };
      return { ok: false, status: 400, json: async () => body, text: async () => JSON.stringify(body) };
    }
    return reply([shop('Kothari Jewellers')])(url, init);
  };
  const r = await callMaps({ model: 'gemini-3.9-flash-test', user: 'x', fetchImpl });
  assert.equal(r.businesses.length, 1);
  assert.ok(bodies[0].generationConfig.thinkingConfig, 'first call carries the setting');
  assert.equal(bodies[1].generationConfig.thinkingConfig, undefined, 'the retry does not');
  assert.equal(thinkingFor('gemini-3.9-flash-test', 'minimal', false), null, 'and it is remembered');
});

test('Google errors are read for what they say about the key', () => {
  const t = JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad', details: [{ reason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED' }] } });
  assert.equal(googleErrorSummary(401, t), '401 UNAUTHENTICATED (ACCESS_TOKEN_TYPE_UNSUPPORTED): bad');
  assert.equal(isKeyRefusal(401, t), true);
  assert.equal(isKeyRefusal(400, 'API key not valid. Please pass a valid API key.'), true);
  assert.equal(isKeyRefusal(400, 'Invalid JSON payload'), false, 'a malformed request says nothing about the key');
  assert.equal(isKeyRefusal(403, 'Grounding with Google Maps is not enabled for this model'), false, 'one tool refused is not the key');
  assert.equal(isKeyRefusal(429, 'quota'), false);

  const e = mapsError(404, JSON.stringify({ error: { code: 404, message: 'models/gemini-9 is not found' } }));
  assert.equal(e.fatal, true, 'a missing model fails every category the same way');
  assert.equal(e.keyRefused, false);
});

test('the boot check marks a refused key, and ignores a network failure', async () => {
  const saved = config.gemini.apiKey;
  const savedProvider = process.env.LLM_PROVIDER;
  config.gemini.apiKey = 'test-key';
  process.env.LLM_PROVIDER = 'gemini';
  try {
    noteGeminiKey(true);
    await probeGeminiKey({ fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
    assert.equal(geminiKeyStatus().ok, true, 'offline is not refused');

    await probeGeminiKey({
      fetchImpl: async () => ({ ok: false, status: 403, text: async () => JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'Generative Language API has not been used in project 123', details: [{ reason: 'SERVICE_DISABLED' }] } }) }),
    });
    assert.equal(geminiKeyStatus().ok, false);
    assert.match(geminiKeyStatus().reason, /SERVICE_DISABLED/);

    await probeGeminiKey({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{}' }) });
    assert.equal(geminiKeyStatus().ok, true, 'a working key clears it');
  } finally {
    config.gemini.apiKey = saved;
    if (savedProvider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = savedProvider;
  }
});

test('one shop returned by two searches under two ids is one lead', async () => {
  const address = 'Vijayashree Society, Chaitanya Nagar, Kothrud, Pune, Maharashtra 411038, India';
  let n = 0;
  const twoIds = async (url, init) => {
    n++;
    const id = n === 1 ? 'ChIJIyN40_b_wjsRfZS93m-4SeA' : 'ChIJv18214C_wh0RXfL0q8A9PeA';
    return reply([shop('Shri Kulswamini Saraf', { address, maps_place_id: id, locality: n === 1 ? 'Chaitanya Nagar, Kothrud' : 'Kothrud' })])(url, init);
  };
  const r = await discoverCategory({ ...area, passes: 2, fetchImpl: twoIds });
  assert.equal(r.leads.length, 1);
});
