import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, normalizeCandidates, mergeCandidates, discoverCombined } from './dualDiscovery.js';
import config from '../config.js';

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
