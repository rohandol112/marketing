import { sleep } from './util.js';

const transient = e => [429, 500, 502, 503, 504].includes(e.status)
  || ['TimeoutError', 'AbortError'].includes(e.name) || e instanceof TypeError;

// Process-local model health, shared across categories. Already-running calls
// are not cancelled. A new process starts with a clean health record.
export function createGeminiCascade({ now = Date.now, sleepImpl = sleep, random = Math.random } = {}) {
  const health = new Map();
  return async function cascade(models, attempt, { retry = true, onWarning = () => {} } = {}) {
    let retryCandidate = null;
    const fail = (model, error) => {
      if (error.keyRefused || error.dailyQuota || !transient(error) && error.status !== 404) throw error;
      const failures = Math.min(4, (health.get(model)?.failures || 0) + 1);
      const delay = error.status === 404 ? 300000 : Math.min(300000, 60000 * 2 ** (failures - 1));
      const retryAfterMs = Math.max(0, Number(error.retryAfterMs) || 0);
      health.set(model, { failures, until: now() + Math.max(delay, retryAfterMs) });
      onWarning(model + ': ' + (error.status ? 'HTTP ' + error.status : 'temporary request failure') + '; trying fallback.');
      if (transient(error) && !retryCandidate) retryCandidate = { model, retryAfterMs };
    };
    const call = async model => {
      const result = await attempt(model);
      health.delete(model);
      return result;
    };

    for (const model of new Set(models)) {
      if (health.get(model)?.until > now()) {
        onWarning(model + ': cooldown active; skipped.');
        continue;
      }
      try {
        const result = await call(model);
        if (result != null) return result;
      } catch (error) { fail(model, error); }
    }

    // Only one final retry, after trying alternatives. Do not tie up a sweep
    // waiting on a long Retry-After; future categories can recover after cooldown.
    if (retry && retryCandidate && retryCandidate.retryAfterMs <= 60000) {
      const { model, retryAfterMs } = retryCandidate;
      onWarning(model + ': fallback chain exhausted; one final retry.');
      await sleepImpl(Math.max(retryAfterMs, 1000 + Math.floor(random() * 300)));
      try { return await call(model); } catch (error) { fail(model, error); }
    }
    return null;
  };
}
