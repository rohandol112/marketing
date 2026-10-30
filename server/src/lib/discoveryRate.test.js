import test from 'node:test';
import assert from 'node:assert/strict';
import { DiscoveryRateLimiter } from './discoveryRate.js';

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
