import config from '../config.js';
import { sleep } from './util.js';

/**
 * Provider-agnostic LLM adapter.
 *
 * Everything AI-shaped goes through generateJson(). That is the single place
 * that owns provider choice, rate limiting, schema validation, retries,
 * fallbacks and the contact-info guardrail.
 *
 * Why this stopped being Gemini-specific: gemini-3.6-flash allows *20 requests
 * per day* on the free tier. Not 250 - twenty. In practice that meant 33 of the
 * first 36 suggestions were silently template fallbacks, each after the limiter
 * blocked for a minute and a half first. A single hard-coded provider with an
 * undiscoverable daily cap is not something to build a sales tool on.
 *
 * Four providers, all reachable from one interface:
 *
 *   gemini     Google AI Studio. Also serves Gemma, which is open weights and
 *              has its own separate quota - so `gemma-4-26b-a4b-it` keeps
 *              working after gemini-3.6-flash is exhausted for the day.
 *   groq       Open models (Llama, Gemma) at very high free limits.
 *   ollama     Fully local, open weights, no quota and no key at all.
 *   openrouter Aggregator, including several `:free` open models.
 *
 * The last three are OpenAI-compatible and share one code path.
 */

/* ------------------------------------------------------------------ */
/* Providers                                                          */
/* ------------------------------------------------------------------ */

export const PROVIDERS = {
  gemini: {
    label: 'Google AI Studio',
    needsKey: true,
    openWeights: false,
    note: 'gemini-3.6-flash is capped at 20 requests/day on the free tier. Gemma models on the same key have their own quota.',
  },
  groq: {
    label: 'Groq',
    needsKey: true,
    openWeights: true,
    baseUrl: 'https://api.groq.com/openai/v1',
    note: 'Open models on very fast hardware. Free tier is thousands of requests a day, not twenty.',
  },
  ollama: {
    label: 'Ollama (local)',
    needsKey: false,
    openWeights: true,
    baseUrl: (process.env.OLLAMA_URL || 'http://127.0.0.1:11434') + '/v1',
    note: 'Runs on this machine. No key, no quota, no per-request cost. Needs the model pulled first.',
  },
  openrouter: {
    label: 'OpenRouter',
    needsKey: true,
    openWeights: true,
    baseUrl: 'https://openrouter.ai/api/v1',
    note: 'Aggregator. Models suffixed :free cost nothing but are rate limited.',
  },
};

export function activeProvider() {
  const p = (process.env.LLM_PROVIDER || '').toLowerCase();
  if (p && PROVIDERS[p]) return p;
  if (process.env.GROQ_API_KEY) return 'groq';
  if (config.gemini.apiKey) return 'gemini';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  return 'ollama';
}

function apiKeyFor(provider) {
  if (provider === 'gemini') return config.gemini.apiKey;
  if (provider === 'groq') return process.env.GROQ_API_KEY || '';
  if (provider === 'openrouter') return process.env.OPENROUTER_API_KEY || '';
  return 'local';
}

export function modelsFor(provider) {
  const main = process.env.LLM_MODEL_MAIN;
  const fast = process.env.LLM_MODEL_FAST;
  const defaults = {
    // Gemma is open weights and has quota left when gemini-3.6-flash does not.
    gemini: { main: 'gemma-4-26b-a4b-it', fast: 'gemini-3.5-flash-lite' },
    groq: { main: 'llama-3.3-70b-versatile', fast: 'llama-3.1-8b-instant' },
    ollama: { main: 'llama3.2', fast: 'llama3.2' },
    openrouter: { main: 'meta-llama/llama-3.3-70b-instruct:free', fast: 'meta-llama/llama-3.2-3b-instruct:free' },
  }[provider] || { main: 'llama3.2', fast: 'llama3.2' };

  return { main: main || defaults.main, fast: fast || defaults.fast };
}

export function isMock() {
  const provider = activeProvider();
  return PROVIDERS[provider].needsKey && !apiKeyFor(provider);
}

/* ------------------------------------------------------------------ */
/* Rate limiting and quota memory                                     */
/* ------------------------------------------------------------------ */

/**
 * Per-model daily exhaustion. When a provider says "you are out for today",
 * remember it and stop asking - the previous version retried into the same wall
 * and made every suggestion take 90+ seconds before failing anyway.
 */
const exhausted = new Map(); // model -> ISO date it is exhausted for

/**
 * Free tiers get slow as well as capped. A trivial "say OK" against Google has
 * been measured at 26-31s on this key, so a 45s ceiling was cutting off calls
 * that would have succeeded. Generous by default, overridable when a provider
 * is fast.
 */
const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 90000);

function markExhausted(model) {
  exhausted.set(model, new Date().toISOString().slice(0, 10));
}

function isExhausted(model) {
  return exhausted.get(model) === new Date().toISOString().slice(0, 10);
}

class RateLimiter {
  constructor({ rpm, concurrency }) {
    this.rpm = rpm;
    this.concurrency = Math.max(1, concurrency);
    this.minuteHits = [];
    this.active = 0;
  }

  stats() {
    this._trim();
    return { rpmLimit: this.rpm, rpmUsed: this.minuteHits.length, active: this.active };
  }

  _trim() {
    const cutoff = Date.now() - 60000;
    while (this.minuteHits.length && this.minuteHits[0] < cutoff) this.minuteHits.shift();
  }

  /** Waits at most `maxWaitMs`, then gives up so the caller can fall back. */
  async acquire(maxWaitMs = 8000) {
    const deadline = Date.now() + maxWaitMs;
    while (true) {
      this._trim();
      if (this.active < this.concurrency && this.minuteHits.length < this.rpm) {
        this.active++;
        this.minuteHits.push(Date.now());
        return true;
      }
      if (Date.now() > deadline) return false;
      await sleep(200);
    }
  }

  release() { this.active = Math.max(0, this.active - 1); }
}

export const limiter = new RateLimiter(config.gemini);

/* ------------------------------------------------------------------ */
/* Guardrail                                                          */
/* ------------------------------------------------------------------ */

const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * The model never emits a phone number, an email or a URL. If a rep dials a
 * hallucinated number once and it turns out to be a stranger's house, the sales
 * team stops trusting the tool permanently. Real values are substituted from
 * the database after generation.
 */
export function stripContactInfo(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(URL_RE, '{{link}}')
    .replace(EMAIL_RE, '{{email}}')
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '{{phone}}' : m));
}

/** Strips phones and emails but keeps URLs. For research findings only. */
export function stripContactsOnly(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(EMAIL_RE, '{{email}}')
    .replace(PHONE_RE, (m) => (m.replace(/\D/g, '').length >= 8 ? '{{phone}}' : m));
}

function scrubContactsOnly(value) {
  if (typeof value === 'string') return stripContactsOnly(value);
  if (Array.isArray(value)) return value.map(scrubContactsOnly);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubContactsOnly(v);
    return out;
  }
  return value;
}

function scrubDeep(value) {
  if (typeof value === 'string') return stripContactInfo(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v);
    return out;
  }
  return value;
}


/**
 * Models wrap JSON in a markdown fence often enough that not stripping it is a
 * bug, not a nicety - grounded discovery was failing with "did not return JSON"
 * on responses that were perfectly good JSON inside ```json ... ```.
 */
export function parseLooseJson(text) {
  if (typeof text !== 'string') return null;
  let t = text.trim();

  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();

  try { return JSON.parse(t); } catch {}

  // last resort: the outermost object or array in the response
  const first = t.search(/[{[]/);
  if (first === -1) return null;
  const open = t[first];
  const close = open === '{' ? '}' : ']';
  const last = t.lastIndexOf(close);
  if (last <= first) return null;
  try { return JSON.parse(t.slice(first, last + 1)); } catch { return null; }
}

/* ------------------------------------------------------------------ */
/* Schema                                                             */
/* ------------------------------------------------------------------ */

export function validateAgainstSchema(data, schema, path = 'root') {
  const errs = [];
  const type = String(schema.type || '').toUpperCase();

  if (data === null || data === undefined) {
    if (schema.nullable) return errs;
    errs.push(path + ' is missing');
    return errs;
  }

  if (type === 'OBJECT') {
    if (typeof data !== 'object' || Array.isArray(data)) return [path + ' should be an object'];
    for (const req of schema.required || []) {
      if (data[req] === undefined || data[req] === null || data[req] === '') {
        errs.push(path + '.' + req + ' is required');
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (data[key] !== undefined && data[key] !== null) {
        errs.push(...validateAgainstSchema(data[key], sub, path + '.' + key));
      }
    }
  } else if (type === 'ARRAY') {
    if (!Array.isArray(data)) return [path + ' should be an array'];
    if (schema.minItems && data.length < schema.minItems) {
      errs.push(path + ' needs at least ' + schema.minItems + ' items, got ' + data.length);
    }
    if (schema.items) {
      data.forEach((item, i) => errs.push(...validateAgainstSchema(item, schema.items, path + '[' + i + ']')));
    }
  } else if (type === 'STRING') {
    if (typeof data !== 'string') errs.push(path + ' should be a string');
    else if (schema.enum && !schema.enum.includes(data)) {
      errs.push(path + ' must be one of ' + schema.enum.join(', ') + ', got ' + data);
    }
  } else if (type === 'NUMBER' || type === 'INTEGER') {
    if (typeof data !== 'number' || Number.isNaN(data)) errs.push(path + ' should be a number');
  } else if (type === 'BOOLEAN') {
    if (typeof data !== 'boolean') errs.push(path + ' should be a boolean');
  }

  return errs;
}

/** Gemini uses an OpenAPI dialect with uppercase types; everyone else wants JSON Schema. */
function toJsonSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const type = String(s.type || '').toLowerCase();
  const out = { type: type === 'integer' ? 'integer' : type };
  if (s.description) out.description = s.description;
  if (s.enum) out.enum = s.enum;
  if (type === 'object') {
    out.properties = Object.fromEntries(Object.entries(s.properties || {}).map(([k, v]) => [k, toJsonSchema(v)]));
    out.required = s.required || [];
    out.additionalProperties = false;
  }
  if (type === 'array') {
    out.items = toJsonSchema(s.items);
    if (s.minItems) out.minItems = s.minItems;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Transports                                                         */
/* ------------------------------------------------------------------ */

function quotaFrom(text) {
  try {
    const j = JSON.parse(text);
    const v = (j.error?.details || []).flatMap((d) => d.violations || [])[0];
    return v ? v.quotaId + ' = ' + v.quotaValue : null;
  } catch { return null; }
}

async function callGoogle({ model, system, user, schema, temperature }) {
  const body = {
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: temperature ?? 0.4,
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: 2048,
    },
  };
  // Gemma has no systemInstruction field; fold it into the prompt.
  if (system) {
    if (/^gemma/i.test(model)) body.contents[0].parts[0].text = system + '\n\n---\n\n' + user;
    else body.systemInstruction = { parts: [{ text: system }] };
  }
  // Gemini 3.x rejects thinkingBudget; thinkingLevel is the current field.
  if (/^gemini-3/i.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  const res = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKeyFor('gemini') },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(model + ' ' + res.status + ': ' + (quotaFrom(text) || text.slice(0, 200)));
    err.status = res.status;
    err.dailyQuota = res.status === 429 && /PerDay/i.test(text);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const json = await res.json();
  return {
    text: json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '',
    tokensIn: json.usageMetadata?.promptTokenCount ?? null,
    tokensOut: json.usageMetadata?.candidatesTokenCount ?? null,
  };
}

/** Groq, Ollama and OpenRouter all speak the OpenAI chat API. */
async function callOpenAICompatible({ provider, model, system, user, schema, temperature }) {
  const base = PROVIDERS[provider].baseUrl;
  const headers = { 'Content-Type': 'application/json' };
  const key = apiKeyFor(provider);
  if (PROVIDERS[provider].needsKey) headers.Authorization = 'Bearer ' + key;

  const body = {
    model,
    temperature: temperature ?? 0.4,
    max_tokens: 2048,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'result', schema: toJsonSchema(schema), strict: false },
    },
  };

  let res = await fetch(base + '/chat/completions', {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // Not every open model supports json_schema; json_object is the fallback.
  if (res.status === 400) {
    body.response_format = { type: 'json_object' };
    body.messages[body.messages.length - 1].content += '\n\nReturn JSON only, matching this shape: ' +
      JSON.stringify(toJsonSchema(schema));
    res = await fetch(base + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(provider + '/' + model + ' ' + res.status + ': ' + text.slice(0, 200));
    err.status = res.status;
    err.dailyQuota = res.status === 429 && /day|daily|RPD/i.test(text);
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const json = await res.json();
  return {
    text: json.choices?.[0]?.message?.content || '',
    tokensIn: json.usage?.prompt_tokens ?? null,
    tokensOut: json.usage?.completion_tokens ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Grounded research                                                  */
/* ------------------------------------------------------------------ */

/**
 * Search-grounded generation, with citations.
 *
 * This is a different capability from generateJson and deserves its own door.
 * generateJson asks a model to reason over facts we already hold. This asks it
 * to go and find facts, and hand back where each came from.
 *
 * It needs billing enabled - the tool is 429 on the free tier - and it is worth
 * enabling for exactly one reason: it turns "the model thinks this business
 * exists" into "here are its bed count, its Instagram handle and the article
 * that said so".
 *
 * Grounding cannot be combined with responseSchema, so JSON is requested in the
 * prompt and parsed out of prose.
 */
export async function generateGrounded({ system, user, shape, fallback, temperature = 0.2, preserveLinks = false, raw = false }) {
  const provider = activeProvider();
  const model = modelsFor(provider).main;
  const started = Date.now();

  /**
   * Scrubbing exists so a model never writes a phone number into copy a rep
   * sends. Research is not copy - it is internal, structured, and every value
   * carries the URL it was read from. Scrubbing it there deletes the finding
   * and leaves the field blank, which is how 668 leads ended up with no phone
   * number that a citation-backed search had already located.
   *
   * `raw` is only ever set by research. Whatever it returns lands in
   * `candidates` behind a human click, never straight onto the lead.
   */
  const clean = (v) => (raw ? v : preserveLinks ? scrubContactsOnly(v) : scrubDeep(v));

  const bail = (reason) => ({
    data: clean(fallback ? fallback() : {}),
    model, provider, grounded: false, sources: [], queries: [],
    latencyMs: Date.now() - started, fallback: true, reason,
  });

  if (provider !== 'gemini' || isMock()) {
    return bail('Search grounding needs the Google provider with billing enabled.');
  }
  if (isExhausted(model)) return bail(model + ' is out of quota for today.');
  if (!(await limiter.acquire(8000))) return bail('Rate limiter busy.');

  try {
    const body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{
        role: 'user',
        parts: [{
          text: [
            user,
            '',
            'Return ONLY a JSON object of this shape. No prose, no markdown fence:',
            JSON.stringify(shape),
          ].join('\n'),
        }],
      }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature },
    };
    if (/^gemini-3/i.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };

    const res = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKeyFor('gemini') },
        body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      if (res.status === 429 && /PerDay/i.test(text)) markExhausted(model);
      return bail('Grounded search failed: ' + (quotaFrom(text) || res.status));
    }

    const json = await res.json();
    const cand = json.candidates?.[0];
    const raw = cand?.content?.parts?.map((p) => p.text).join('') || '';

    const parsed = parseLooseJson(raw);
    if (!parsed) return bail('Grounded response was not JSON');

    const gm = cand?.groundingMetadata || {};
    return {
      data: clean(parsed),
      model, provider,
      grounded: Boolean(gm.groundingChunks?.length),
      sources: (gm.groundingChunks || []).map((c) => ({ title: c.web?.title, uri: c.web?.uri })).filter((x) => x.title),
      queries: gm.webSearchQueries || [],
      tokensIn: json.usageMetadata?.promptTokenCount ?? null,
      tokensOut: json.usageMetadata?.candidatesTokenCount ?? null,
      latencyMs: Date.now() - started,
      fallback: false,
    };
  } catch (e) {
    return bail(e.message);
  } finally {
    limiter.release();
  }
}

/* ------------------------------------------------------------------ */
/* The entry point                                                    */
/* ------------------------------------------------------------------ */

/**
 * Always resolves. If the provider is unavailable, rate limited, out of daily
 * quota or simply wrong, the caller gets `fallback()` flagged as such - never an
 * exception, never a half-formed object, and never a 90-second wait first.
 */
export async function generateJson({
  system, user, schema, fallback, fast = false, temperature = 0.4, maxRetries = 1,
}) {
  const provider = activeProvider();
  const models = modelsFor(provider);
  const model = fast ? models.fast : models.main;
  const started = Date.now();

  const bail = (reason) => ({
    data: scrubDeep(fallback ? fallback() : {}),
    provider,
    model,
    latencyMs: Date.now() - started,
    tokensIn: null,
    tokensOut: null,
    fallback: true,
    reason,
  });

  if (isMock()) return bail('No API key for ' + PROVIDERS[provider].label + ' - showing the deterministic template.');

  // Do not spend 90 seconds rediscovering a limit we already hit today.
  if (isExhausted(model)) {
    return bail(model + ' is out of free quota for today. Set LLM_PROVIDER=groq or LLM_MODEL_MAIN to another model.');
  }

  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const got = await limiter.acquire(8000);
    if (!got) { lastError = new Error('Rate limiter busy'); break; }

    try {
      const suffix = attempt === 0
        ? ''
        : '\n\nThe previous response did not match the required schema. Return valid JSON matching it exactly, with every required field filled.';

      const args = { provider, model, system, user: user + suffix, schema, temperature };
      const res = provider === 'gemini' ? await callGoogle(args) : await callOpenAICompatible(args);

      let parsed;
      try {
        parsed = JSON.parse(res.text);
      } catch {
        const m = res.text.match(/\{[\s\S]*\}/);
        if (!m) throw new Error('Model did not return JSON');
        parsed = JSON.parse(m[0]);
      }

      const errs = validateAgainstSchema(parsed, schema);
      if (errs.length) { lastError = new Error('Schema mismatch: ' + errs.slice(0, 4).join('; ')); continue; }

      return {
        data: scrubDeep(parsed),
        provider,
        model,
        latencyMs: Date.now() - started,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        fallback: false,
      };
    } catch (e) {
      lastError = e;
      if (e.name === 'TimeoutError' || /aborted due to timeout/i.test(e.message)) {
        lastError = new Error(
          model + ' did not respond within ' + Math.round(TIMEOUT_MS / 1000) +
          's. Free tiers throttle under load - LLM_PROVIDER=groq is dramatically faster.'
        );
        if (attempt < maxRetries) continue;
        break;
      }
      if (e.dailyQuota) { markExhausted(model); break; }   // no point retrying today
      if (e.retryable && attempt < maxRetries) { await sleep(900 * (attempt + 1)); continue; }
      break;
    } finally {
      limiter.release();
    }
  }

  return bail(lastError ? lastError.message : 'Unknown model failure');
}

export function llmStatus() {
  const provider = activeProvider();
  const models = modelsFor(provider);
  return {
    provider,
    providerLabel: PROVIDERS[provider].label,
    openWeights: PROVIDERS[provider].openWeights,
    note: PROVIDERS[provider].note,
    configured: !isMock(),
    mock: isMock(),
    modelMain: models.main,
    modelFast: models.fast,
    timeoutMs: TIMEOUT_MS,
    exhaustedToday: [...exhausted.entries()]
      .filter(([, day]) => day === new Date().toISOString().slice(0, 10))
      .map(([m]) => m),
    ...limiter.stats(),
  };
}

// Kept so existing imports keep working.
export const geminiStatus = llmStatus;
