import test from 'node:test';
import assert from 'node:assert/strict';
import { createGeminiCascade } from './geminiCascade.js';

const busy = (status = 503, extra = {}) => Object.assign(new Error('upstream'), { status, ...extra });

test('overload cascades immediately and success stops further models', async () => {
  const calls = [], waits = [];
  const run = createGeminiCascade({ sleepImpl: async ms => waits.push(ms) });
  const result = await run(['3.8', '3.7', '3.6', '3.5'], async model => {
    calls.push(model);
    if (model === '3.8') throw busy();
    return { model };
  });
  assert.deepEqual(calls, ['3.8', '3.7']);
  assert.deepEqual(waits, []);
  assert.equal(result.model, '3.7');
});

test('after exhausting the chain retries transient models once in top-down order', async () => {
  const calls = [], waits = [];
  const run = createGeminiCascade({ sleepImpl: async ms => waits.push(ms), random: () => 0 });
  const result = await run(['3.8', '3.7', '3.6', '3.5'], async model => {
    calls.push(model);
    if (calls.length <= 5) throw busy();
    return { model };
  });
  assert.deepEqual(calls, ['3.8', '3.7', '3.6', '3.5', '3.8', '3.7']);
  assert.deepEqual(waits, [1000]);
  assert.equal(result.model, '3.7');
});

test('cooldown skips overloaded models across categories, doubles, and expires', async () => {
  let time = 0; const calls = [], warnings = [];
  const run = createGeminiCascade({ now: () => time, random: () => 0 });
  const attempt = async model => { calls.push(model); if (model === '3.8') throw busy(); return { model }; };
  const options = { retry: false, onWarning: warning => warnings.push(warning) };
  await run(['3.8', '3.7'], attempt, options);
  time = 100;
  await run(['3.8', '3.7'], attempt, options);
  assert.deepEqual(calls, ['3.8', '3.7', '3.7']);
  assert.match(warnings.join(' '), /cooldown/i);
  time = 60001;
  await run(['3.8', '3.7'], attempt, options);
  time = 120002;
  await run(['3.8', '3.7'], attempt, options);
  assert.equal(calls.filter(m => m === '3.8').length, 2, 'second failure cools for 120 seconds');
  time = 180002;
  const recovered = await run(['3.8', '3.7'], async model => ({ model }), options);
  assert.equal(recovered.model, '3.8');
});

test('Retry-After is honored and long retry delays do not block the cascade', async () => {
  const waits = [];
  let time = 0;
  const run = createGeminiCascade({ now: () => time, sleepImpl: async ms => { waits.push(ms); time += ms; }, random: () => 0 });
  let calls = 0;
  await run(['short'], async () => { if (++calls === 1) throw busy(429, { retryAfterMs: 2500 }); return {}; });
  assert.deepEqual(waits, [2500]);
  calls = 0;
  assert.equal(await run(['long'], async () => { calls++; throw busy(429, { retryAfterMs: 90000 }); }), null);
  assert.equal(calls, 1);
  assert.deepEqual(waits, [2500]);
});

test('auth, daily quota and request-limit errors stop without retries or fallback', async () => {
  for (const error of [busy(401), busy(403), busy(429, { dailyQuota: true }), new Error('request_limit')]) {
    let calls = 0;
    const run = createGeminiCascade({ sleepImpl: async () => assert.fail('must not wait') });
    await assert.rejects(run(['3.8', '3.7'], async () => { calls++; throw error; }), e => e === error);
    assert.equal(calls, 1);
  }
});

test('missing model and invalid output advance, valid empty results stop the chain', async () => {
  const calls = [];
  const run = createGeminiCascade({ now: () => 0 });
  const attempt = async model => {
    calls.push(model);
    if (model === 'missing') throw busy(404);
    return model === 'uncited' ? null : { leads: [] };
  };
  assert.deepEqual(await run(['missing', 'uncited', 'empty', 'unused'], attempt), { leads: [] });
  await run(['missing', 'empty'], attempt);
  assert.deepEqual(calls, ['missing', 'uncited', 'empty', 'empty']);
});

test('retries can be disabled and exhausted failures preserve a null result', async () => {
  for (const retry of [true, false]) {
    let calls = 0;
    const run = createGeminiCascade({ sleepImpl: async () => {}, random: () => 0 });
    const result = await run(['3.8', '3.7'], async () => { calls++; throw busy(); }, { retry });
    assert.equal(result, null);
    assert.equal(calls, retry ? 4 : 2);
  }
});
