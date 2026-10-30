import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import knex from '../db/knex.js';
import config from '../config.js';
import discoveryRoutes from '../routes/discovery.js';
import { runDiscovery } from './discovery.js';

test('combined run queues through the route, saves merged leads and report without touching old records', async () => {
  // Exercise real route, orchestration, lifecycle, usage and enqueue code with
  // an isolated SQL transport. Never connects to a configured database.
  const client = knex.client;
  const saved = { acquire: client.acquireConnection, release: client.releaseConnection, query: client._query,
    fetch: globalThis.fetch, combined: { ...config.combined }, key: config.gemini.apiKey };
  let run, finalPatch; const inserted = { leads: [], jobs: [], api_usage: [] };
  const parseInsert = q => {
    const m = q.sql.match(/insert into "([^"]+)" \(([^)]+)\)/);
    if (!m) return null;
    return { table: m[1], row: Object.fromEntries(m[2].split(', ').map((c,i) => [c.replaceAll('"',''), q.bindings[i]])) };
  };
  client.acquireConnection = async () => ({}); client.releaseConnection = async () => {};
  client._query = async (_conn, q) => {
    let rows = []; let command = 'SELECT';
    const insert = parseInsert(q);
    if (insert) {
      command = 'INSERT';
      if (insert.table === 'discovery_runs') {
        run = { ...insert.row, categories: JSON.parse(insert.row.categories), params: JSON.parse(insert.row.params) };
      } else inserted[insert.table]?.push(insert.row);
    } else if (q.sql.startsWith('update "discovery_runs"')) {
      command = 'UPDATE';
      const assignments = q.sql.match(/set (.+) where/)[1].split(', ');
      const patch = Object.fromEntries(assignments.map((a,i) => [a.match(/"([^"]+)"/)[1], q.bindings[i]]));
      Object.assign(run, patch); if (patch.finished_at) finalPatch = patch;
    } else if (q.sql.includes('from "discovery_runs"')) rows = run ? [run] : [];
    else if (q.sql.includes('from "tenants"')) rows = [{ country_code: 'IN' }];
    q.response = { rows, rowCount: command === 'SELECT' ? rows.length : 1, command };
    return q;
  };
  config.combined.openaiKey = 'test-openai'; config.gemini.apiKey = 'test-google';
  config.combined.geminiModels = ['gemini-3.6-flash']; config.combined.retries = 0; config.combined.mapsMcp = false;
  globalThis.fetch = async target => ({ ok: true, json: async () => String(target).includes('api.openai.com') ? {
    status: 'completed', usage: { input_tokens: 100, output_tokens: 100 }, tool_usage: { web_search: { num_requests: 1 } },
    output: [{ type: 'message', content: [{ text: JSON.stringify({ businesses: [{ name: 'Test Dental', phone: '+91 9876543210',
      evidence: [{ field: 'phone', url: 'https://test.example/contact' }] }] }), annotations: [{ url: 'https://test.example/contact' }] }] }],
  } : { candidates: [{ content: { parts: [{ text: JSON.stringify({ businesses: [{ name: 'Test Dental', phone: '09876543210', review_count: 120, rating: 4.8,
    evidence: ['phone', 'review_count', 'rating'].map(field => ({ field, url: 'https://maps.google.com/test' })) }] }) }] },
    groundingMetadata: { groundingChunks: [{ maps: { title: 'Test Dental', placeId: 'places/ChIJ_test12345678901234567890', uri: 'https://maps.google.com/test' } }] } }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100 } } });
  const app = new Hono();
  app.use('*', async (c, next) => { c.set('tenantId', 'test-tenant'); await next(); });
  app.onError((err,c) => c.json({ error: err.message }, err.status || 500));
  app.route('/', discoveryRoutes);
  try {
    const invalid = await app.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 18.5, lng: 73.8, source: 'combined', categories: ['dental_clinic'], requestLimit: 1 }) });
    assert.equal(invalid.status, 400);
    const res = await app.request('/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: 18.5, lng: 73.8, source: 'combined', categories: ['dental_clinic'], areaLabel: 'Pune', regionCode: 'IN', maxPages: 1, requestLimit: 8 }) });
    assert.equal(res.status, 201); assert.equal(inserted.jobs[0].kind, 'discovery');
    await runDiscovery({ runId: run.id });
    assert.equal(inserted.leads.length, 1);
    assert.equal(inserted.leads[0].status, 'pending_review');
    assert.equal(inserted.leads[0].stage, null);
    assert.equal(inserted.leads[0].phone_normalized, '+919876543210');
    const provenance = JSON.parse(inserted.leads[0].field_provenance);
    assert.equal(provenance.phone.source, 'luna'); assert.equal(provenance.review_count.source, 'gemini');
    assert.equal(finalPatch.status, 'done'); assert.equal(finalPatch.new_count, 1);
    const params = JSON.parse(finalPatch.params);
    assert.equal(params.attemptedRequests, 2);
    assert.equal(params.discoveryReports[0].overlap, 1);
    assert.equal(inserted.api_usage.length, 1);
  } finally {
    client.acquireConnection = saved.acquire; client.releaseConnection = saved.release; client._query = saved.query;
    globalThis.fetch = saved.fetch; Object.assign(config.combined, saved.combined); config.gemini.apiKey = saved.key;
    await knex.destroy();
  }
});
