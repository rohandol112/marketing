import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryRateLimiter } from './discoveryRate.js';

test('independent provider budgets do not consume each other allowances', async () => {
  const luna = new DiscoveryRateLimiter({ rpm: 2, now: () => 0, sleepImpl: async () => assert.fail('must not share quota') });
  const gemini = new DiscoveryRateLimiter({ rpm: 2, now: () => 0, sleepImpl: async () => assert.fail('must not share quota') });
  await Promise.all([luna.acquire(), luna.acquire(), gemini.acquire(), gemini.acquire()]);
});

test('parallel callers share a rolling minute budget without waiting for responses', async () => {
  let time = 0;
  const limiter = new DiscoveryRateLimiter({ rpm: 3, now: () => time, sleepImpl: async ms => { time += ms; } });
  const starts = [];
  await Promise.all(Array.from({ length: 10 }, async () => { await limiter.acquire(); starts.push(time); }));
  for (const t of starts) assert.ok(starts.filter(s => s > t - 60000 && s <= t).length <= 3);
  assert.equal(time, 180000);
});

test('a later sweep shares the remaining budget and slots expire on the rolling boundary', async () => {
  let time = 0; const waits = [];
  const limiter = new DiscoveryRateLimiter({ rpm: 2, now: () => time, sleepImpl: async ms => { waits.push(ms); time += ms; } });
  await limiter.acquire(); time = 30000; await limiter.acquire();
  await limiter.acquire();
  assert.equal(time, 60000); assert.deepEqual(waits, [30000]);
  await limiter.acquire(); assert.equal(time, 90000);
});
