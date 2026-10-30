import test from 'node:test';
import assert from 'node:assert/strict';
import knex from '../db/knex.js';
import { getPrecallBrief, getWhatsappOpener } from './ai.js';

test('brief and message share one generation, research cache and independent feedback records', async () => {
  const keys = ['LLM_PROVIDER', 'OPENAI_API_KEY', 'LLM_MODEL_MAIN', 'LLM_MODEL_FAST', 'LLM_MODEL_SEARCH', 'LLM_REASONING_EFFORT', 'LLM_RESEARCH_EFFORT'];
  const env = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  process.env.LLM_PROVIDER = 'openai'; process.env.OPENAI_API_KEY = 'test';
  const client = knex.client;
  const saved = { fetch: globalThis.fetch, acquire: client.acquireConnection, release: client.releaseConnection, query: client._query };
  const lead = { id: 'lead-a', tenant_id: 'tenant-a', name: 'Clinic A', category: 'Dental clinic', normalized_category: 'dental_clinic', locality: 'Bandra',
    country_code: 'IN', stage: 'todo', score: 60, score_breakdown: {}, website_status: 'protected', review_count: 120, phone_normalized: '+919876543210', phone_type: 'mobile' };
  const tenant = { id: 'tenant-a', name: 'Agency', country_code: 'IN', currency: 'INR', brand_voice: 'plain' };
  const suggestions = [], usage = [], requests = [];
  const fromSchema = s => {
    if (s.anyOf) return s.anyOf.some(x => x.type === 'null') ? null : fromSchema(s.anyOf[0]);
    if (s.type === 'object') return Object.fromEntries(Object.entries(s.properties).map(([k,v]) => [k, fromSchema(v)]));
    if (s.type === 'array') return Array.from({ length: s.minItems || 0 }, () => fromSchema(s.items));
    if (s.type === 'number' || s.type === 'integer') return 1;
    if (s.type === 'boolean') return false;
    return s.enum?.[0] || 'A specific, factual draft';
  };
  client.acquireConnection = async () => ({}); client.releaseConnection = async () => {};
  client._query = async (_connection, q) => {
    let rows = [], command = 'SELECT';
    const insert = q.sql.match(/insert into "([^"]+)" \(([^)]+)\)/);
    if (insert) {
      command = 'INSERT';
      const row = Object.fromEntries(insert[2].split(', ').map((name, i) => [name.replaceAll('"', ''), q.bindings[i]]));
      if (insert[1] === 'ai_suggestions') suggestions.push(row);
      if (insert[1] === 'api_usage') usage.push(row);
    } else if (q.sql.includes('from "ai_suggestions"')) {
      rows = suggestions.filter(r => r.tenant_id === q.bindings[0] && r.kind === q.bindings[1] && r.input_hash === q.bindings[2]).slice().reverse().slice(0, 1);
    } else if (q.sql.includes('from "leads"')) rows = [lead];
    else if (q.sql.includes('from "tenants"')) rows = [tenant];
    else if (q.sql.includes('from "users"')) rows = [{ id: 'rep-a', name: 'Rep' }];
    q.response = { rows, rowCount: rows.length || (command === 'INSERT' ? 1 : 0), command };
    return q;
  };
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const b = JSON.parse(init.body); requests.push(b);
    const output = b.tools ? [
      { type: 'web_search_call', status: 'completed', action: { type: 'search', query: 'Clinic A Bandra', sources: [{ url: 'https://clinic.example/contact', title: 'Clinic A' }] } },
      { type: 'message', content: [{ type: 'output_text', text: '{"summary":"Clinic A is a dental clinic.","confidence":"medium"}' }] },
    ] : [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(fromSchema(b.text.format.schema)) }] }];
    return { ok: true, json: async () => ({ status: 'completed', output, usage: { input_tokens: 50, output_tokens: 100 } }) };
  };
  const args = { tenantId: tenant.id, leadId: lead.id, userId: 'rep-a' };
  try {
    const [brief, message] = await Promise.all([getPrecallBrief(args), getWhatsappOpener(args)]);
    assert.equal(requests.length, 2, 'one research call and one combined drafting call, even concurrently');
    assert.equal(requests.filter(r => r.tools).length, 1);
    assert.equal(requests.find(r => r.tools).reasoning.effort, 'medium');
    assert.equal(requests.find(r => !r.tools).reasoning.effort, 'low');
    assert.equal(requests.every(r => r.model === 'gpt-6.1-terra'), true);
    assert.equal(brief.kind, 'precall_brief'); assert.equal(message.kind, 'whatsapp_opener');
    assert.notEqual(brief.id, message.id, 'accept/edit feedback stays independent');
    assert.ok(brief.output.headline); assert.ok(message.output.message);
    assert.equal(usage.length, 2, 'research and combined outreach count as two calls, not three');
    assert.equal(usage.every(r => r.provider === 'openai'), true);
    assert.equal(usage.filter(r => r.operation === 'outreach_bundle').length, 1);
    assert.equal((await getWhatsappOpener(args)).cached, true);
    assert.equal(requests.length, 2);
    await getPrecallBrief({ ...args, force: true });
    assert.equal(requests.length, 3, 'regenerate reuses cached research');
    process.env.LLM_REASONING_EFFORT = 'high';
    await getWhatsappOpener(args);
    assert.equal(requests.length, 4, 'changed model profile invalidates drafts without deleting old rows');
    assert.equal(requests.filter(r => r.tools).length, 1, 'research has its own model profile');
    assert.equal(suggestions.filter(r => r.kind === 'precall_brief').length, 3);
  } finally {
    globalThis.fetch = saved.fetch; client.acquireConnection = saved.acquire; client.releaseConnection = saved.release; client._query = saved.query;
    for (const k of keys) { if (env[k] == null) delete process.env[k]; else process.env[k] = env[k]; }
    await knex.destroy();
  }
});
