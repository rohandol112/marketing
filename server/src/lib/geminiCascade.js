import { sleep } from './util.js';

const transient = e => [429, 500, 502, 503, 504].includes(e.status)
  || ['TimeoutError', 'AbortError'].includes(e.name) || e instanceof TypeError;

// Process-local model health, shared across categories. Already-running calls
// are not cancelled. A new process starts with a clean health record.
export function createGeminiCascade({ now = Date.now, sleepImpl = sleep, random = Math.random } = {}) {
  const health = new Map();
  return async function cascade(models, attempt, { retry = true, onWarning = () => {} } = {}) {
    const retryCandidates = new Map();
    const fail = (model, error) => {
      if (error.keyRefused || error.dailyQuota || !transient(error) && error.status !== 404) throw error;
      const failures = Math.min(4, (health.get(model)?.failures || 0) + 1);
      const delay = error.status === 404 ? 300000 : Math.min(300000, 60000 * 2 ** (failures - 1));
      const retryAfterMs = Math.max(0, Number(error.retryAfterMs) || 0);
      health.set(model, { failures, until: now() + Math.max(delay, retryAfterMs) });
      onWarning(model + ': ' + (error.status ? 'HTTP ' + error.status : ['TimeoutError', 'AbortError'].includes(error.name) ? 'provider timeout' : 'network/request failure') + '; trying fallback.');
      if (transient(error) && !retryCandidates.has(model)) retryCandidates.set(model, { model, retryAfterMs, retryAt: now() + retryAfterMs });
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

    // One delayed second pass, strongest to weakest, over temporary failures
    // from this invocation only. Later categories still respect model cooldowns.
    const retryQueue = [...retryCandidates.values()].filter(c => c.retryAfterMs <= 60000);
    if (retry && retryQueue.length) {
      onWarning('Gemini fallback chain exhausted; one delayed retry cascade.');
      const firstReady = Math.min(...retryQueue.map(c => Math.max(0, c.retryAt - now())));
      await sleepImpl(Math.max(firstReady, 1000 + Math.floor(random() * 300)));
      for (const { model, retryAt } of retryQueue) {
        const remaining = retryAt - now();
        if (remaining > 0) await sleepImpl(remaining);
        try {
          const result = await call(model);
          if (result != null) return result;
        } catch (error) { fail(model, error); }
      }
    }
    return null;
  };
}
