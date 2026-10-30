import config from '../config.js';
import {
  activeProvider, modelsFor, parseLooseJson, RateLimiter, geminiUsable, isKeyRefusal, googleErrorSummary, noteGeminiKey,
} from './llm.js';
import { CATEGORY_BY_ID } from './categories.js';
import { normalizeHost, normalizeUrl, normalizeName, firstPhone, nameSimilarity, addressKey, sleep } from './util.js';

/**
 * Discovery through Gemini's Google Maps grounding.
 *
 * This is the source that unblocked the product, and the reason to trust it is
 * measurable rather than hopeful. Asked the same question four times with the
 * maps tool attached, the answer is byte-identical:
 *
 *     4.8 · 9,361 reviews · +91 20 2542 2202     (×4, no variance)
 *
 * Asked without the tool, the same model invents a different business each time:
 *
 *     4.4 / 2,640 / +91 20 2542 3555
 *     4.3 / 4,120 / +91 20 2538 2212
 *     4.4 / 2,412 / +91 20 2542 2203
 *
 * Three different phone numbers for one shop. That is the exact failure the
 * no-phone guardrail was written against, and it is why plain recall stays
 * behind human verification while this does not: a stable lookup against Maps
 * is the same class of evidence as the Places API, arriving through a different
 * door.
 *
 * What it returns that recall never could: rating, review count, phone and
 * website - the four fields whose absence left 668 leads unqualifiable.
 *
 * Caveat kept honest: `groundingChunks` come back inconsistently (4-11 on some
 * calls, 0 on others) even when the data is identical, so citations cannot be
 * used as a gate. The stability of the values is the evidence, not the metadata.
 *
 * Speed. At its default thinking level gemini-3.6-flash spent 45-70s and 6-8k
 * thought tokens on every Maps call, and a sweep ran its passes one after
 * another - three minutes a category, a three-hour sweep, and no log line to
 * show it was alive. At "minimal" thinking the same query takes ~17s with no
 * thought tokens, and businesses found at both settings carried identical
 * ratings, review counts, phones and place ids (7 of 7 checked). Passes now run
 * side by side under one limiter.
 */

const SYSTEM = [
  'You find real physical businesses using Google Maps.',
  '',
  'RULES',
  '1. Every business must come from Google Maps. Never add one from memory.',
  '2. Report rating, review count, phone and website exactly as Maps has them. If Maps does not have a field, use null - never estimate, never round, never reconstruct a phone number.',
  '3. Prefer independent and regional businesses. Skip national chains, franchise outlets, government offices and anything permanently closed.',
  '4. No duplicates, including the same business under a different spelling.',
  '5. Do not judge whether a business is a good sales prospect. Only find real ones.',
  '6. Return JSON only. No prose, no markdown fence.',
].join('\n');

const SHAPE = '{"businesses":[{"name":"","locality":"","address":"","rating":0,"review_count":0,'
  + '"phone":"","website":"","maps_place_id":"","business_status":"OPERATIONAL|CLOSED|UNKNOWN"}]}';

const LOOKUP_SYSTEM = [
  'You look up one specific business on Google Maps and report what Maps holds for it.',
  '',
  'RULES',
  '1. Use the Google Maps tool. Never answer from memory.',
  '2. It must be the same business: the same name, allowing for spelling variants, at the same location. A different branch, a similarly named business elsewhere, or a neighbour is NOT a match - return {"found": false}.',
  '3. Copy rating, review count, phone, website and category exactly as Maps shows them. Use null for anything Maps does not have. Never estimate, never round, never reconstruct a phone number.',
  '4. Return JSON only. No prose, no markdown fence.',
].join('\n');

const LOOKUP_SHAPE = '{"found":true,"name":"","address":"","category":"","rating":0,"review_count":0,'
  + '"phone":"","website":"","maps_place_id":"","business_status":"OPERATIONAL|CLOSED_TEMPORARILY|CLOSED_PERMANENTLY"}';

/**
 * Every Maps call - sweeps and single lookups - shares this, and only this.
 * The drafting limiter stays free for a rep who opens a brief mid-sweep.
 */
export const mapsLimiter = new RateLimiter({ rpm: config.gemini.rpm, concurrency: config.maps.concurrency });

export function mapsLookupAvailable() {
  return geminiUsable();
}

/** Models that turned a thinking setting down once are not sent it again. */
const noThinking = new Set();

/**
 * The thinking setting for a Maps call, or null for the model's own default.
 *
 * Turned down only where it was measured to be safe: on gemini-3.x flash the
 * same businesses came back with the same values in a third of the time. Not
 * on 2.5 - gemini-2.5-flash with thinking off answered with no businesses at
 * all - and not on models nobody has measured, unless MAPS_THINKING_LEVEL is
 * set on purpose.
 */
export function thinkingFor(model, level = config.maps.thinkingLevel, explicit = Boolean(process.env.MAPS_THINKING_LEVEL)) {
  if (!level || level === 'default' || noThinking.has(model)) return null;
  if (!/^gemini-3/i.test(model)) return null;
  return explicit || /^gemini-3(\.\d+)?-flash(?!-lite)/i.test(model) ? { thinkingLevel: level } : null;
}

/**
 * A failed Maps call, classified for the sweep. `fatal` means every remaining
 * category would fail the same way - a refused key, a model that does not
 * exist, the day's quota gone - so the sweep stops and says why.
 */
export function mapsError(status, text) {
  const summary = googleErrorSummary(status, text);
  const err = new Error('Maps grounding ' + summary);
  err.status = status;
  err.keyRefused = isKeyRefusal(status, text);
  err.dailyQuota = status === 429 && /PerDay/i.test(text);
  err.retryable = !err.dailyQuota && (status === 429 || status >= 500);
  err.fatal = err.keyRefused || err.dailyQuota || [400, 401, 403, 404].includes(status);
  if (err.keyRefused) noteGeminiKey(false, summary);
  return err;
}

export async function callMaps({ model, system = SYSTEM, user, timeoutMs = 90000, fetchImpl = fetch, thinkingLevel, onRequest, groundingTool = 'google_maps' }) {
  const generationConfig = { temperature: 0.1 };
  const thinking = thinkingLevel ? thinkingFor(model, thinkingLevel, true) : thinkingFor(model);
  if (thinking) generationConfig.thinkingConfig = thinking;
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    // Maps grounding cannot be combined with google_search - that pairing is
    // a 400 on this model, whatever the docs imply.
    tools: groundingTool ? [{ [groundingTool]: {} }] : undefined,
    generationConfig,
  };
  const post = () => { onRequest?.(); return fetchImpl(config.gemini.baseUrl + '/v1beta/models/' + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  }); };

  let res = await post();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // A model that does not take this thinking setting says so with a 400.
    // Remember, and ask again at its default rather than failing the sweep.
    if (res.status === 400 && thinking && /thinking/i.test(text)) {
      noThinking.add(model);
      console.warn('[maps] ' + model + ' does not accept ' + JSON.stringify(thinking) + ' - using its default thinking');
      delete generationConfig.thinkingConfig;
      res = await post();
      if (!res.ok) throw mapsError(res.status, await res.text().catch(() => ''));
    } else {
      throw mapsError(res.status, text);
    }
  }
  noteGeminiKey(true);

  const json = await res.json();
  const cand = json.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text || '').join('') || '';
  const parsed = parseLooseJson(text);
  const gm = cand?.groundingMetadata || {};
  const chunks = (gm.groundingChunks || [])
    .map((c) => c.maps)
    .filter((m) => m && (m.placeId || m.title))
    .map((m) => ({ placeId: m.placeId ? String(m.placeId).replace(/^places\//, '') : null, title: m.title || null, uri: m.uri || null }));

  return {
    text,
    parsed,
    businesses: Array.isArray(parsed) ? parsed : parsed?.businesses || [],
    chunks,
    chunkCount: (gm.groundingChunks || []).length,
    webChunks: (gm.groundingChunks || []).map(c => c.web).filter(Boolean),
    searchQueries: Array.isArray(gm.webSearchQueries) ? gm.webSearchQueries.length : null,
    tokensIn: json.usageMetadata?.promptTokenCount ?? null,
    tokensOut: json.usageMetadata?.candidatesTokenCount ?? null,
    thoughtTokens: json.usageMetadata?.thoughtsTokenCount ?? null,
  };
}

/**
 * One Maps call holding a limiter slot, with one retry for throttling, a 5xx or
 * a timeout. Background work, so it waits for a slot rather than giving up.
 */
async function limitedCall(args, { maxWaitMs = 180000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    if (!(await mapsLimiter.acquire(maxWaitMs))) {
      const err = new Error('Every Maps slot stayed busy for ' + Math.round(maxWaitMs / 1000) + 's');
      err.retryable = true;
      throw err;
    }
    try {
      return await callMaps(args);
    } catch (e) {
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      const transient = e.retryable || timedOut || /fetch failed|ECONNRESET|socket/i.test(e.message);
      if (!transient || e.fatal || attempt >= 1) {
        if (!timedOut) throw e;
        const err = new Error('Maps grounding did not answer within ' + Math.round((args.timeoutMs || 90000) / 1000) + 's');
        err.retryable = true;
        throw err;
      }
    } finally {
      mapsLimiter.release();
    }
    await sleep(1500);
  }
}

const str = (v) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && !/^(null|n\/a|none|unknown|-)$/i.test(s) ? s : null;
};

/** 1-5 with one decimal, or null. "4,8" is a rating too. */
export function parseRating(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n * 10) / 10 : null;
}

/** "1,234", "1234 reviews", "1.2k" -> integer; zero is a real answer. */
export function parseCount(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
  const m = String(v).toLowerCase().replace(/,/g, '').trim().match(/^(\d+(?:\.\d+)?)\s*(k)?\b/);
  if (!m) return null;
  const n = Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
  return Number.isFinite(n) && n >= 0 && n < 5000000 ? n : null;
}

// A place id always has letters in it; an all-digit string is a CID.
const PLACE_ID = /^(?=.*[A-Za-z])[A-Za-z0-9_-]{20,}$/;
const FEATURE_ID = /^0x[0-9a-f]+:0x([0-9a-f]+)$/i;
const CID = /^\d{10,20}$/;

/**
 * Maps hands its listing id back in one of three shapes, and which one varies
 * from call to call for the same business: a place id ("ChIJ..."), a feature
 * id ("0x3bc2bf...:0x6a1d..."), or a bare CID ("10111481897763..."). The CID is
 * the second half of the feature id, and either opens the listing directly.
 * Only a real place id is stored as google_place_id.
 */
export function mapsIdentity(raw) {
  let s = null;
  if (typeof raw === 'string') s = str(raw);
  // A 19-digit CID sent as a JSON number has already lost its last digits.
  else if (typeof raw === 'number' && Number.isSafeInteger(raw)) s = String(raw);
  if (!s) return { placeId: null, cid: null };
  s = s.replace(/^places\//, '');
  if (PLACE_ID.test(s)) return { placeId: s, cid: null };
  const f = s.match(FEATURE_ID);
  if (f) {
    try { return { placeId: null, cid: BigInt('0x' + f[1]).toString() }; } catch { return { placeId: null, cid: null }; }
  }
  if (CID.test(s)) return { placeId: null, cid: s };
  return { placeId: null, cid: null };
}

export function mapsUrlFor({ placeId, cid, name, place }) {
  if (placeId) return 'https://www.google.com/maps/place/?q=place_id:' + placeId;
  if (cid) return 'https://maps.google.com/?cid=' + cid;
  return 'https://www.google.com/maps/search/' + encodeURIComponent([name, place].filter(Boolean).join(' '));
}

/**
 * The place id for a named business, from the grounding chunks.
 *
 * Chunks are not in the same order as the businesses in the answer, and there
 * are often more of them. Pairing business i with chunk i - which is what this
 * used to do - stamped some businesses with a neighbour's place id: the wrong
 * Maps link, the wrong identity, and unique-index collisions that looked like
 * duplicates. Match on the title instead.
 */
export function placeIdFor(name, chunks, declared) {
  const own = mapsIdentity(declared).placeId;
  if (own) return own;
  let best = null;
  for (const c of chunks || []) {
    if (!c.placeId || !c.title || !PLACE_ID.test(c.placeId)) continue;
    const sim = nameSimilarity(name, c.title);
    if (sim >= 0.8 && (!best || sim > best.sim)) best = { sim, placeId: c.placeId };
  }
  return best ? best.placeId : null;
}

/** Place id from the answer or the chunks; otherwise the CID, which still links exactly. */
function identityFor(name, chunks, declared) {
  const placeId = placeIdFor(name, chunks, declared);
  return { placeId, cid: placeId ? null : mapsIdentity(declared).cid };
}

/**
 * Differently-worded searches surface genuinely different businesses from the
 * same radius; deduping on place id afterwards is exact. `passes` picks how many.
 */
const ANGLES = [
  (label) => label,
  (label) => 'independent or family-run ' + label,
  (label) => 'well established ' + label,
  (label) => 'premium ' + label,
  (label) => 'highly rated ' + label,
];

/**
 * One category, one area.
 *
 * Every pass runs at once. A refused key, a missing model or the day's quota
 * is thrown, not folded into warnings: those fail every category the same way,
 * and swallowing them is how a dead key once produced a sweep that ran for
 * minutes, found nothing and logged nothing.
 */
export async function discoverCategory({
  categoryId, areaLabel, center, radiusM, regionCode, limit = 15, passes = 2, fetchImpl = fetch,
}) {
  const cat = CATEGORY_BY_ID.get(categoryId);
  if (!cat) throw new Error('Unknown category: ' + categoryId);

  const model = modelsFor(activeProvider()).main;
  const radiusKm = Math.round((radiusM / 1000) * 10) / 10;
  const label = cat.label.toLowerCase();
  const angles = ANGLES.slice(0, Math.min(ANGLES.length, Math.max(1, passes))).map((f) => f(label));
  const started = Date.now();

  const settled = await Promise.allSettled(angles.map((angle) => {
    const user = [
      'Find up to ' + limit + ' ' + angle + ' businesses on Google Maps within ' + radiusKm + ' km of:',
      areaLabel + (regionCode ? ' (' + regionCode + ')' : ''),
      'Coordinates: ' + center.lat.toFixed(5) + ', ' + center.lng.toFixed(5),
      '',
      'For each, report exactly what Google Maps holds. Use null for anything Maps does not have.',
      '',
      'Return ONLY this JSON shape:',
      SHAPE,
    ].join('\n');
    return limitedCall({ model, user, fetchImpl });
  }));

  const fatal = settled.find((s) => s.status === 'rejected' && s.reason && s.reason.fatal);
  if (fatal) {
    fatal.reason.calls = angles.length;
    throw fatal.reason;
  }

  const seen = new Map();
  // The same shop can come back from two searches with two different ids - the
  // model copies the id out of the Maps result, and copies are not perfect. The
  // same name at the same street address is one shop either way.
  const seenAt = new Set();
  const warnings = [];
  let tokensIn = 0;
  let tokensOut = 0;
  let groundedAny = false;
  let failed = 0;

  settled.forEach((s, i) => {
    const angle = angles[i];
    if (s.status === 'rejected') {
      failed++;
      warnings.push(cat.label + ' (' + angle + '): ' + String(s.reason && s.reason.message).slice(0, 140));
      return;
    }
    const r = s.value;
    tokensIn += r.tokensIn || 0;
    tokensOut += r.tokensOut || 0;
    if (r.chunkCount > 0) groundedAny = true;

    for (const b of r.businesses || []) {
      const name = str(b?.name);
      if (!name) continue;

      const status = String(b.business_status || '').toUpperCase();
      if (status.includes('CLOSED')) continue;

      // Place id is the exact key when Maps returns one, then the CID; the
      // name plus locality is the fallback, still far better than nothing.
      const { placeId, cid } = identityFor(name, r.chunks, b.maps_place_id);
      const key = placeId || (cid ? 'cid:' + cid : name.toLowerCase() + '|' + String(b.locality || '').toLowerCase());
      const at = addressKey(str(b.address));
      const nameAt = at ? normalizeName(name) + '|' + at : null;
      if (seen.has(key) || (nameAt && seenAt.has(nameAt))) continue;
      if (nameAt) seenAt.add(nameAt);

      const phone = firstPhone(str(b.phone));
      const website = normalizeUrl(str(b.website));

      seen.set(key, {
        google_place_id: placeId,
        external_id: placeId || (cid ? 'cid:' + cid : 'm:' + key.slice(0, 80)),
        external_source: 'google_maps',
        name,
        category: cat.label,
        normalized_category: cat.id,
        address: str(b.address),
        locality: str(b.locality) || areaLabel,
        region: null,
        country_code: regionCode || null,
        postal_code: null,
        lat: null,
        lng: null,
        distance_m: null,

        phone,
        email: null,
        website,
        website_host: normalizeHost(website),
        maps_url: mapsUrlFor({ placeId, cid, name, place: str(b.locality) || areaLabel }),

        rating: parseRating(b.rating),
        review_count: parseCount(b.review_count),
        business_status: status.includes('OPERATIONAL') ? 'OPERATIONAL' : null,
        website_status: website ? null : 'unknown',

        source_url: {
          provider: 'gemini_maps_grounding',
          model,
          placeId,
          cid,
          angle,
          discoveredAt: new Date().toISOString(),
        },
      });
    }
  });

  const leads = [...seen.values()];
  if (!leads.length && !failed) warnings.push('Maps returned nothing for ' + cat.label + ' near ' + areaLabel + '.');

  return {
    leads, calls: angles.length, failed, grounded: groundedAny, warnings, tokensIn, tokensOut, model,
    ms: Date.now() - started,
  };
}

/* ------------------------------------------------------------------ */
/* One business                                                       */
/* ------------------------------------------------------------------ */

/**
 * Look one known business up on Google Maps.
 *
 * This is how a directory lead gets the numbers a directory never has: the
 * review count that is the whole demand score, the rating, a phone, and whether
 * it is still trading. The risk is attaching another business's reviews to
 * this one, so the answer is graded:
 *
 *   strong  - the names agree, or a phone or website we already hold matches.
 *             Written straight onto the lead.
 *   medium  - plausibly the same place. Offered as candidates a person accepts.
 *   none    - not found, or not the same business. Nothing is written.
 */
export async function lookupBusiness(lead, { fetchImpl = fetch } = {}) {
  const model = modelsFor(activeProvider()).main;
  const where = [lead.address, lead.locality, lead.region].filter(Boolean).join(', ');
  const user = [
    'Look up this business on Google Maps:',
    'Name: ' + lead.name,
    where ? 'Address: ' + where : null,
    lead.lat != null && lead.lng != null ? 'Coordinates: ' + Number(lead.lat).toFixed(5) + ', ' + Number(lead.lng).toFixed(5) : null,
    lead.category ? 'Type: ' + lead.category : null,
    lead.phone_normalized ? 'Phone we have on file: ' + lead.phone_normalized : null,
    lead.website ? 'Website we have on file: ' + lead.website : null,
    '',
    'If Maps has this exact business, report what Maps holds for it. If it does not, or you are not sure it is the same place, return {"found": false}.',
    '',
    'Return ONLY this JSON shape:',
    LOOKUP_SHAPE,
  ].filter((l) => l !== null).join('\n');

  const started = Date.now();
  const r = await limitedCall({ model, system: LOOKUP_SYSTEM, user, timeoutMs: 60000, fetchImpl }, { maxWaitMs: 120000 });

  const p = r.parsed && !Array.isArray(r.parsed) ? (r.parsed.businesses ? r.parsed.businesses[0] : r.parsed) : (r.parsed || [])[0];
  const meta = { model, grounded: r.chunkCount > 0, tokensIn: r.tokensIn, tokensOut: r.tokensOut, ms: Date.now() - started };
  const name = p && p.found !== false ? str(p.name) : null;
  if (!name) return { match: 'none', similarity: 0, result: null, ...meta };

  const phone = firstPhone(str(p.phone));
  const website = normalizeUrl(str(p.website));
  const status = String(p.business_status || '').toUpperCase();
  const { placeId, cid } = identityFor(name, r.chunks, p.maps_place_id);
  const result = {
    name,
    address: str(p.address),
    category: str(p.category),
    rating: parseRating(p.rating),
    review_count: parseCount(p.review_count),
    phone,
    website,
    place_id: placeId,
    cid,
    business_status: /PERMANENT/.test(status) ? 'CLOSED_PERMANENTLY'
      : /TEMPOR/.test(status) ? 'CLOSED_TEMPORARILY'
        : /OPERATIONAL|OPEN/.test(status) ? 'OPERATIONAL' : null,
    maps_url: placeId || cid ? mapsUrlFor({ placeId, cid }) : null,
  };

  const similarity = nameSimilarity(lead.name, name);
  const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
  const phoneMatch = Boolean(lead.phone_normalized && phone && digits(phone).length === 10 && digits(phone) === digits(lead.phone_normalized));
  const hostMatch = Boolean(lead.website_host && website && normalizeHost(website) === lead.website_host);

  let match = 'none';
  if (similarity >= 0.8 || ((phoneMatch || hostMatch) && similarity >= 0.5)) match = 'strong';
  else if (similarity >= 0.6 || phoneMatch || hostMatch) match = 'medium';

  return { match, similarity: Math.round(similarity * 100) / 100, phoneMatch, hostMatch, result, ...meta };
}
