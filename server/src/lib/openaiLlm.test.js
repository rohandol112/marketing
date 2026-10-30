import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';
import { activeProvider, generateJson, generateGrounded, modelsFor, llmStatus, geminiUsable, noteGeminiKey, limiter } from './llm.js';
import { lookupBusiness } from './mapsDiscovery.js';
import { generateOutreach } from './prompts.js';

const vars = ['LLM_PROVIDER', 'OPENAI_API_KEY', 'LLM_MODEL_MAIN', 'LLM_MODEL_FAST', 'LLM_MODEL_SEARCH', 'LLM_REASONING_EFFORT', 'LLM_RESEARCH_EFFORT'];
async function withOpenAI(fn) {
  const saved = Object.fromEntries(vars.map(k => [k, process.env[k]]));
  const oldFetch = globalThis.fetch;
  for (const k of vars) delete process.env[k];
  process.env.LLM_PROVIDER = 'openai'; process.env.OPENAI_API_KEY = 'test-openai';
  limiter.rpm = 1000;
  try { await fn(); } finally {
    globalThis.fetch = oldFetch;
    for (const k of vars) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
  }
}
const response = (text, extra = {}) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 30, output_tokens: 40 }, ...extra });
const shape = { type: 'OBJECT', properties: { message: { type: 'STRING' }, optional: { type: 'STRING' } }, required: ['message'] };

test('OpenAI routes JSON drafting to GPT-6.1 Terra Low with a strict schema and no tools', () => withOpenAI(async () => {
  assert.equal(activeProvider(), 'openai');
  assert.equal(modelsFor('openai').main, 'gpt-6.1-terra');
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++; assert.equal(url, 'https://api.openai.com/v1/responses');
    const b = JSON.parse(init.body);
    assert.equal(b.model, 'gpt-6.1-terra'); assert.equal(b.reasoning.effort, 'low');
    assert.equal(b.store, false); assert.equal(b.tools, undefined); assert.equal(b.temperature, undefined);
    assert.equal(b.text.format.strict, true);
    assert.deepEqual(b.text.format.schema.required.sort(), ['message', 'optional']);
    assert.deepEqual(b.text.format.schema.properties.optional.anyOf, [{ type: 'string' }, { type: 'null' }]);
    return { ok: true, json: async () => response('{"message":"Call +91 9876543210 or https://example.com","optional":null}') };
  };
  const r = await generateJson({ system: 'system', user: 'user', schema: shape });
  assert.equal(r.fallback, false); assert.equal(r.provider, 'openai'); assert.equal(calls, 1);
  assert.match(r.data.message, /\{\{phone\}\}/); assert.doesNotMatch(r.data.message, /example\.com/);
  assert.equal(llmStatus().reasoningEffort, 'low'); assert.equal(llmStatus().researchEffort, 'medium');
}));

test('Terra Medium research requires executed web search and preserves cited raw contacts', () => withOpenAI(async () => {
  globalThis.fetch = async (_url, init) => {
    const b = JSON.parse(init.body);
    assert.equal(b.reasoning.effort, 'medium'); assert.equal(b.model, 'gpt-6.1-terra');
    assert.equal(b.tool_choice, 'required'); assert.equal(b.tools[0].type, 'web_search');
    assert.equal(b.text, undefined, 'web search cannot be combined with JSON mode');
    assert.ok(b.include.includes('web_search_call.action.sources'));
    return { ok: true, json: async () => response('{"phone":"+91 9876543210"}', { output: [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'Clinic contact', sources: [{ title: 'Contact', url: 'https://clinic.example/contact' }] } },
      { type: 'message', content: [{ type: 'output_text', text: '{"phone":"+91 9876543210"}' }] },
    ] }) };
  };
  const r = await generateGrounded({ system: 's', user: 'u', shape: { phone: 'number or null' }, raw: true });
  assert.equal(r.fallback, false); assert.equal(r.grounded, true); assert.equal(r.provider, 'openai');
  assert.equal(r.data.phone, '+91 9876543210'); assert.equal(r.sources[0].uri, 'https://clinic.example/contact');
  assert.deepEqual(r.queries, ['Clinic contact']);
}));

test('unsearched, incomplete and refused OpenAI output never becomes successful research or a draft', () => withOpenAI(async () => {
  globalThis.fetch = async () => ({ ok: true, json: async () => response('{"phone":"invented"}') });
  const unsearched = await generateGrounded({ system: 's', user: 'u', shape: {}, fallback: () => ({ unknown: true }) });
  assert.equal(unsearched.fallback, true); assert.equal(unsearched.grounded, false);
  for (const data of [response('{"message":"partial"}', { status: 'incomplete' }), response('', { output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'no' }] }] })]) {
    globalThis.fetch = async () => ({ ok: true, json: async () => data });
    const r = await generateJson({ system: 's', user: 'u', schema: shape, fallback: () => ({ message: 'fallback' }), maxRetries: 0 });
    assert.equal(r.fallback, true); assert.equal(r.data.message, 'fallback');
  }
}));

test('OpenAI auth errors do not retry or leak response bodies into fallback reasons', () => withOpenAI(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return { ok: false, status: 401, headers: new Headers(), text: async () => 'secret credential from provider' }; };
  const r = await generateJson({ system: 's', user: 'u', schema: shape, fallback: () => ({ message: 'fallback' }) });
  assert.equal(calls, 1); assert.equal(r.fallback, true); assert.doesNotMatch(r.reason, /secret credential/);
}));

test('Terra drafting does not disable Gemini Maps or send a Terra model to Google', () => withOpenAI(async () => {
  const key = config.gemini.apiKey; config.gemini.apiKey = 'test-google'; noteGeminiKey(true);
  process.env.LLM_MODEL_MAIN = 'gpt-6.1-terra';
  try {
    assert.equal(geminiUsable(), true);
    await lookupBusiness({ name: 'Clinic A', locality: 'Bandra' }, { fetchImpl: async url => {
      assert.match(String(url), /models\/gemini-/); assert.doesNotMatch(String(url), /gpt-6/);
      return { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: '{"found":false}' }] } }] }) };
    } });
  } finally { config.gemini.apiKey = key; }
}));

test('thin-evidence outreach accepts zero gaps and no package without inventing facts or retrying', () => withOpenAI(async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: true, json: async () => response(JSON.stringify({ brief: {
      headline: 'Research is inconclusive', gaps: [], decision_maker: 'Unknown; ask on the call', best_channel: 'phone', best_time: 'Ask what suits them',
      opener: 'Could I ask how you currently get enquiries?', recommended_package_id: null, price_band: 'No package configured',
      objection_to_expect: 'Unknown', objection_response: 'Ask what would be useful', do_not_say: 'Do not claim a broken site',
    }, whatsapp: { message: 'Could I ask how you currently get enquiries?', follow_up_if_no_reply: 'Would a short conversation help?', why_this_angle: 'Evidence is thin' } })) };
  };
  const r = await generateOutreach({ tenant: { name: 'Agency', currency: 'INR' }, catalog: [], packages: [], lead: { name: 'Clinic A', score_breakdown: {}, website_status: 'protected' } });
  assert.equal(r.fallback, false); assert.equal(calls, 1);
  assert.deepEqual(r.data.brief.gaps, []); assert.equal(r.data.brief.recommended_package_id, null);
}));
