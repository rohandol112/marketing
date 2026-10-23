import test from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.js';
import { generateGrounded, modelsFor } from './llm.js';

/**
 * Search-grounded calls run on their own model, because whether the model
 * searches at all decides whether the answer is worth anything.
 */

test('search uses its own model, and falls back to the main one if that model is retired', async () => {
  const saved = { fetch: globalThis.fetch, key: config.gemini.apiKey, provider: process.env.LLM_PROVIDER, search: process.env.LLM_MODEL_SEARCH };
  process.env.LLM_PROVIDER = 'gemini';
  delete process.env.LLM_MODEL_SEARCH;
  config.gemini.apiKey = 'test-key';
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    if (/gemini-2\.5-flash:/.test(url)) {
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: { code: 404, message: 'models/gemini-2.5-flash is not found' } }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text: '{"instagram_handle":"kothari.jewellers"}' }] },
          groundingMetadata: { webSearchQueries: ['kothari jewellers instagram'], groundingChunks: [{ web: { uri: 'https://www.instagram.com/kothari.jewellers/', title: 'instagram.com' } }] },
        }],
      }),
    };
  };
  try {
    assert.equal(modelsFor('gemini').search, 'gemini-2.5-flash');
    const r = await generateGrounded({ system: 's', user: 'u', shape: { instagram_handle: '' }, raw: true });
    assert.equal(r.fallback, false);
    assert.equal(r.data.instagram_handle, 'kothari.jewellers');
    assert.equal(r.sources.length, 1);
    assert.match(urls[0], /gemini-2\.5-flash:generateContent/);
    assert.doesNotMatch(urls[1], /gemini-2\.5-flash/);
    assert.equal(modelsFor('gemini').search, modelsFor('gemini').main, 'and it stays on the main model');
  } finally {
    globalThis.fetch = saved.fetch;
    config.gemini.apiKey = saved.key;
    if (saved.provider === undefined) delete process.env.LLM_PROVIDER; else process.env.LLM_PROVIDER = saved.provider;
    if (saved.search !== undefined) process.env.LLM_MODEL_SEARCH = saved.search;
  }
});
