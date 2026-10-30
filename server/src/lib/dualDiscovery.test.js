import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, normalizeCandidates, mergeCandidates, discoverCombined, failureReason, lunaOutputBudget, readResponse } from './dualDiscovery.js';
import config from '../config.js';
import { callMaps } from './mapsDiscovery.js';

test('503 retries exponentially, honors Retry-After, and never retries auth', async () => {
  const waits = []; let calls = 0;
  const result = await withRetry(async () => { if (++calls < 3) throw Object.assign(new Error('busy'), { status: 503, retryAfterMs: 2500 }); return 7; },
    { sleepImpl: async ms => waits.push(ms), random: () => 0 });
  assert.equal(result, 7); assert.deepEqual(waits, [2500, 2500]);
  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('auth'), { status: 401 }); }, { sleepImpl: async () => {} }));
  assert.equal(calls, 1);
});

const args = { categoryId: 'dental', areaLabel: 'Kothrud', center: { lat: 18.5, lng: 73.8 }, radiusM: 5000 };
test('a Luna timeout is not retried through three full waiting periods', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); },
    { retryTimeout: false, sleepImpl: async () => assert.fail('timeout must not retry') }));
  assert.equal(calls, 1);
});
const citation = 'https://clinic.example/contact';
test('uncited phones, third-party ratings and invented coordinates are not accepted', () => {
  const rows = normalizeCandidates([{ name: 'Clinic A', phone: '1234567890', lat: 18.5, lng: 73.8,
    review_count: 104, rating: 4.9, evidence: [{ field: 'review_count', url: citation }] }],
    { ...args, provider: 'luna', model: 'test', sources: [citation] });
  assert.equal(rows.length, 1); assert.equal(rows[0].phone, null);
  assert.equal(rows[0].review_count, null); assert.equal(rows[0].lat, null);
  assert.equal(rows[0].external_source, 'openai_web');
  assert.equal(normalizeCandidates([{ name: 'Invented', evidence: [] }], { ...args, provider: 'luna', sources: [] }).length, 0);
});

test('merge combines matching phones with provenance, without merging a shared-domain branch', () => {
  const a = { name: 'Clinic A', phone: '+91 9876543210', website: 'https://clinic.example', address: '1 Main St', source_url: { provider: 'luna', evidence: [] } };
  const b = { name: 'Clinic A Dental', phone: '09876543210', google_place_id: 'ChIJ_verified', source_url: { provider: 'gemini', evidence: [] } };
  const c = { name: 'Clinic A', phone: '09876543211', website: a.website, address: '2 Main St', source_url: { provider: 'luna' } };
  const result = mergeCandidates([a], [b, c]);
  assert.equal(result.leads.length, 2); assert.equal(result.overlap, 1);
  assert.equal(result.leads[0].google_place_id, b.google_place_id);
  assert.deepEqual(result.leads[0].source_url.providers.sort(), ['gemini', 'luna']);
});

test('same-name branches never inherit the first ambiguous Maps identity', () => {
  const chunks = ['A', 'B'].map(id => ({ placeId: 'ChIJ_' + id, title: 'ABC Dental', uri: 'https://maps.google.com/' + id }));
  const r = normalizeCandidates([{ name: 'ABC Dental', address: '1 A St' }, { name: 'ABC Dental', address: '99 B St' }],
    { ...args, provider: 'gemini', chunks });
  assert.equal(r.length, 0, 'ambiguous uncited branches need verification, not an invented identity');
});

test('a Maps identity cannot launder web-directory counts or uncited phones', () => {
  const r = normalizeCandidates([{ name: 'Clinic A', phone: '9876543210', rating: 4.9, review_count: 104,
    evidence: [{ field: 'review_count', url: citation }, { field: 'rating', url: citation }] }],
    { ...args, provider: 'luna', sources: [citation], chunks: [{ title: 'Clinic A', placeId: 'ChIJ_A', uri: 'https://maps.google.com/A' }] });
  assert.equal(r[0].phone, null); assert.equal(r[0].review_count, null); assert.equal(r[0].rating, null);
});

test('a cited domain does not authorize unobserved pages on that domain', () => {
  const r = normalizeCandidates([{ name: 'Invented Clinic', phone: '9876543210', evidence: [{ field: 'phone', url: 'https://clinic.example/invented' }] }],
    { ...args, provider: 'gemini', sources: [citation], sourceHosts: ['clinic.example'] });
  assert.equal(r.length, 0);
});

test('combined discovery preserves the other provider when one fails and exposes costs', async () => {
  const r = await discoverCombined(args, {
    luna: async () => ({ leads: [{ name: 'A', phone: '9876543210', source_url: { provider: 'luna' } }], calls: 2, costUsd: .02, tokensIn: 10, tokensOut: 5 }),
    gemini: async () => { throw new Error('temporary unavailable'); },
  });
  assert.equal(r.leads.length, 1); assert.equal(r.report.providers.luna.withPhone, 1);
  assert.equal(r.costUsd, .02); assert.match(r.warnings.join(' '), /gemini/i);
  assert.equal(r.report.partial, true);
});

test('real adapters reject incomplete Luna output, cascade a missing Gemini model, and count calls', async () => {
  const saved = { fetch: globalThis.fetch, combined: { ...config.combined }, key: config.gemini.apiKey };
  config.combined.retries = 0;
  config.combined.geminiModels = ['missing-model', 'gemini-3.6-flash'];
  config.combined.openaiKey = 'test-openai'; config.combined.mapsMcp = false;
  config.gemini.apiKey = 'test-google';
  const urls = []; let attempts = 0;
  globalThis.fetch = async (target, options) => {
    urls.push(String(target));
    if (String(target).includes('api.openai.com')) {
      assert.equal(JSON.parse(options.body).store, false);
      return { ok: true, json: async () => ({ status: 'incomplete', usage: { input_tokens: 10, output_tokens: 20 }, output: [] }) };
    }
    if (String(target).includes('missing-model')) return { ok: false, status: 404, text: async () => '{"error":{"message":"model not found"}}' };
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ businesses: [{ name: 'Clinic A', phone: '9876543210', address: '1 Main St', evidence: [{ field: 'phone', url: 'https://maps.google.com/place/A' }] }] }) }] },
      groundingMetadata: { groundingChunks: [{ maps: { title: 'Clinic A', placeId: 'places/ChIJ_abc12345678901234567890', uri: 'https://maps.google.com/place/A' } }] } }],
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, thoughtsTokenCount: 20 } }) };
  };
  try {
    const r = await discoverCombined({ ...args, onAttempt: () => attempts++ });
    assert.equal(attempts, 3); assert.equal(r.calls, 3);
    assert.equal(r.leads.length, 1); assert.equal(r.leads[0].phone, '9876543210');
    assert.equal(r.report.partial, true); assert.ok(r.report.providers.gemini.estimatedCostUsd > 0);
    assert.equal(urls.filter(u => u.includes('missing-model')).length, 1);
  } finally { globalThis.fetch = saved.fetch; Object.assign(config.combined, saved.combined); config.gemini.apiKey = saved.key; }
});

test('request limit blocks additional provider calls, and auth is never cascaded', async () => {
  const saved = { fetch: globalThis.fetch, combined: { ...config.combined }, key: config.gemini.apiKey };
  config.combined.retries = 0; config.gemini.apiKey = 'test'; config.combined.mapsMcp = false;
  let calls = 0, claims = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401, headers: new Headers(), text: async () => 'unauthenticated' }; };
  try {
    const r = await discoverCombined({ ...args, passes: 2, onAttempt: () => { if (++claims > 1) throw new Error('request_limit'); } });
    assert.equal(calls, 1); assert.equal(r.leads.length, 0); assert.equal(r.report.partial, true);
  } finally { globalThis.fetch = saved.fetch; Object.assign(config.combined, saved.combined); config.gemini.apiKey = saved.key; }
});

test('malformed second-stage Gemini extraction warns and continues the cascade', async () => {
  const saved = { fetch: globalThis.fetch, combined: { ...config.combined }, key: config.gemini.apiKey };
  config.combined.retries = 0; config.combined.mapsMcp = false; config.gemini.apiKey = 'test';
  config.combined.geminiModels = ['model-a', 'model-b'];
  let attempts = 0;
  globalThis.fetch = async (target, options) => {
    if (String(target).includes('api.openai.com')) return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ text: '{"businesses":[]}' }] }] }) };
    const body = JSON.parse(options.body);
    const text = !body.tools ? 'invalid JSON' : String(target).includes('model-a') ? 'Research about Clinic A.'
      : JSON.stringify({ businesses: [{ name: 'Clinic B', phone: '9876543210', evidence: [{ field: 'phone', url: citation }] }] });
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] },
      groundingMetadata: body.tools ? { groundingChunks: [{ web: { uri: citation, title: 'Clinic' } }] } : undefined }] }) };
  };
  try {
    const r = await discoverCombined({ ...args, onAttempt: () => attempts++ });
    assert.equal(attempts, 4); // Luna + research A + extraction A + research B
    assert.equal(r.leads.length, 1); assert.equal(r.leads[0].name, 'Clinic B');
    assert.match(r.warnings.join(' '), /invalid extraction/);
  } finally { globalThis.fetch = saved.fetch; Object.assign(config.combined, saved.combined); config.gemini.apiKey = saved.key; }
});

test('Gemini 503 fails over once per model and cooldown skips it on the next category', async () => {
  const saved = { fetch: globalThis.fetch, combined: { ...config.combined }, key: config.gemini.apiKey };
  config.combined.retries = 2; config.combined.mapsMcp = false; config.gemini.apiKey = 'test';
  config.combined.geminiModels = ['overloaded-test-model', 'gemini-3.7-flash', 'unused-test-model'];
  config.combined.thinking = 'medium';
  const models = [];
  globalThis.fetch = async (target, options) => {
    if (String(target).includes('api.openai.com')) return { ok: true, json: async () => ({ status: 'completed', output: [{ type: 'message', content: [{ text: '{"businesses":[]}' }] }] }) };
    const model = String(target).match(/models\/(.*):generateContent/)[1];
    models.push(model);
    if (model === 'overloaded-test-model') return { ok: false, status: 503, headers: new Headers(), text: async () => 'unavailable' };
    assert.equal(JSON.parse(options.body).generationConfig.thinkingConfig.thinkingLevel, 'medium');
    return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ businesses: [{ name: 'Clinic A', phone: '9876543210', evidence: [{ field: 'phone', url: citation }] }] }) }] },
      groundingMetadata: { groundingChunks: [{ web: { uri: citation } }] } }] }) };
  };
  try {
    const first = await discoverCombined(args);
    const second = await discoverCombined(args);
    assert.deepEqual(models, ['overloaded-test-model', 'gemini-3.7-flash', 'gemini-3.7-flash']);
    assert.equal(first.leads.length, 1); assert.equal(second.leads.length, 1);
    assert.equal(first.calls, 3); assert.equal(second.calls, 2);
    assert.match(second.warnings.join(' '), /cooldown/);
  } finally { globalThis.fetch = saved.fetch; Object.assign(config.combined, saved.combined); config.gemini.apiKey = saved.key; }
});

test('Gemini transport preserves Retry-After for cascade scheduling', async () => {
  await assert.rejects(callMaps({ model: 'test', system: 'test', user: 'test',
    fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '90' }), text: async () => 'temporary rate limit' }),
  }), e => e.status === 429 && e.retryAfterMs === 90000);
});

test('Luna at max effort is streamed with room to answer, and its answer is used', async () => {
  // Measured on production's request: max needs ~25k output tokens and 4-6
  // minutes. At 16k it answered nothing; past 300s Node's fetch gave up on
  // headers. Streaming sends headers at once.
  const saved = { fetch: globalThis.fetch, combined: { ...config.combined }, key: config.gemini.apiKey };
  config.combined.retries = 0; config.combined.mapsMcp = false; config.combined.lunaEffort = 'max';
  config.combined.maxOutput = 16000; config.combined.geminiModels = []; config.gemini.apiKey = 'test';
  const bodies = [];
  const final = { status: 'completed', usage: { input_tokens: 21248, output_tokens: 24504 },
    output: [{ type: 'reasoning' }, { type: 'message', content: [{ text: JSON.stringify({ businesses: [{ name: 'Clinic A', phone: '9876543210',
      evidence: [{ field: 'phone', url: citation }] }] }), annotations: [{ url: citation }] }] }] };
  globalThis.fetch = async (target, options) => {
    bodies.push(JSON.parse(options.body));
    const sse = [
      { type: 'response.created', response: { status: 'in_progress' } },
      { type: 'response.output_item.added', item: { type: 'reasoning' } },
      { type: 'response.completed', response: final },
    ].map((e) => 'event: ' + e.type + '\r\ndata: ' + JSON.stringify(e) + '\r\n\r\n').join('');
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const r = await discoverCombined(args);
    assert.equal(bodies.length, 1, 'one call, never a second at a lower effort');
    assert.equal(bodies[0].reasoning.effort, 'max');
    assert.equal(bodies[0].stream, true);
    assert.equal(bodies[0].max_output_tokens, lunaOutputBudget('max'));
    assert.ok(lunaOutputBudget('max') >= 32000, 'max gets more than the 24,504 tokens it was measured to need');
    assert.equal(lunaOutputBudget('high'), 16000, 'other efforts keep the configured budget');
    assert.equal(r.leads.length, 1); assert.equal(r.leads[0].name, 'Clinic A');
    assert.equal(r.report.providers.luna.tokensOut, 24504);
  } finally {
    globalThis.fetch = saved.fetch; Object.assign(config.combined, saved.combined); config.gemini.apiKey = saved.key;
  }
});

test('Luna that still runs out of budget says how to fix it and never drops below the configured effort', async () => {
  const saved = { fetch: globalThis.fetch, combined: { ...config.combined }, key: config.gemini.apiKey };
  config.combined.retries = 0; config.combined.mapsMcp = false; config.combined.lunaEffort = 'max';
  config.combined.geminiModels = []; config.gemini.apiKey = 'test';
  const efforts = [];
  globalThis.fetch = async (target, options) => {
    efforts.push(JSON.parse(options.body).reasoning.effort);
    return { ok: true, json: async () => ({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' },
      usage: { input_tokens: 27402, output_tokens: 64000 }, output: [{ type: 'reasoning' }] }) };
  };
  try {
    const r = await discoverCombined(args);
    assert.deepEqual(efforts, ['max']);
    assert.equal(r.leads.length, 0);
    assert.match(r.warnings.join(' '), /used all \d+ output tokens at max effort; raise DISCOVERY_MAX_OUTPUT_TOKENS/);
    assert.equal(r.report.providers.luna.tokensOut, 64000, 'the call is still counted');
  } finally {
    globalThis.fetch = saved.fetch; Object.assign(config.combined, saved.combined); config.gemini.apiKey = saved.key;
  }
});

test('a stream that ends without a final response is an error, not an empty answer', async () => {
  const res = new Response('event: response.created\ndata: {"type":"response.created","response":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(readResponse(res), /ended without a final response/);
  const err = new Response('data: {"type":"error","status":429}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(readResponse(err), (e) => e.status === 429);
});

test('failure reasons name the cause, not "network/request failure" for everything', () => {
  assert.equal(failureReason(new Error('request_limit')), 'request limit reached');
  assert.equal(failureReason(Object.assign(new Error('x'), { status: 429 })), 'HTTP 429');
  assert.match(failureReason(Object.assign(new Error('x'), { name: 'TimeoutError' })), /^provider timeout after \d+s/);
  assert.equal(failureReason(new SyntaxError('bad')), 'invalid JSON output');
  assert.equal(failureReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } })), 'network/request failure (UND_ERR_HEADERS_TIMEOUT)');
  assert.equal(failureReason(Object.assign(new TypeError('fetch failed'), { cause: { code: 'https://x?key=secret' } })), 'network/request failure');
});
