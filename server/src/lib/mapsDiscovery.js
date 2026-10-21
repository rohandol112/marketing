import config from '../config.js';
import { activeProvider, modelsFor, parseLooseJson, limiter } from './llm.js';
import { CATEGORY_BY_ID } from './categories.js';
import { normalizeHost, normalizeUrl, firstPhone, nameSimilarity, sleep } from './util.js';

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
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

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

export function mapsLookupAvailable() {
  return activeProvider() === 'gemini' && Boolean(config.gemini.apiKey);
}

export async function callMaps({ model, system = SYSTEM, user, timeoutMs = 90000, fetchImpl = fetch }) {
  const res = await fetchImpl(BASE + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      // Maps grounding cannot be combined with google_search - that pairing is
      // a 400 on this model, whatever the docs imply.
      tools: [{ google_maps: {} }],
      generationConfig: { temperature: 0.1 },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error('Maps grounding ' + res.status + ': ' + text.slice(0, 200));
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }

  const json = await res.json();
  const cand = json.candidates?.[0];
  const parsed = parseLooseJson(cand?.content?.parts?.map((p) => p.text).join('') || '');
  const gm = cand?.groundingMetadata || {};
  const chunks = (gm.groundingChunks || [])
    .map((c) => c.maps)
    .filter((m) => m && (m.placeId || m.title))
    .map((m) => ({ placeId: m.placeId || null, title: m.title || null, uri: m.uri || null }));

  return {
    parsed,
    businesses: Array.isArray(parsed) ? parsed : parsed?.businesses || [],
    chunks,
    chunkCount: (gm.groundingChunks || []).length,
    tokensIn: json.usageMetadata?.promptTokenCount ?? null,
    tokensOut: json.usageMetadata?.candidatesTokenCount ?? null,
  };
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

const PLACE_ID = /^[A-Za-z0-9_-]{20,}$/;

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
  const own = str(declared);
  if (own && PLACE_ID.test(own)) return own;
  let best = null;
  for (const c of chunks || []) {
    if (!c.placeId || !c.title) continue;
    const sim = nameSimilarity(name, c.title);
    if (sim >= 0.8 && (!best || sim > best.sim)) best = { sim, placeId: c.placeId };
  }
  return best ? best.placeId : null;
}

/**
 * One category, one area.
 *
 * Runs a few differently-worded passes rather than one broad request: "premium
 * jewellers", "independent jewellers" and "gold and diamond shops" surface
 * genuinely different businesses from the same radius, and deduping on place id
 * afterwards is exact.
 */
export async function discoverCategory({
  categoryId, areaLabel, center, radiusM, regionCode, limit = 15, passes = 2,
}) {
  const cat = CATEGORY_BY_ID.get(categoryId);
  if (!cat) throw new Error('Unknown category: ' + categoryId);

  const model = modelsFor(activeProvider()).main;
  const radiusKm = Math.round((radiusM / 1000) * 10) / 10;
  const label = cat.label.toLowerCase();

  const angles = [
    label,
    'independent or family-run ' + label,
    'well established ' + label,
  ].slice(0, Math.max(1, passes));

  const seen = new Map();
  const warnings = [];
  let calls = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let groundedAny = false;

  for (const angle of angles) {
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

    let r;
    try {
      r = await callMaps({ model, user });
      calls++;
    } catch (e) {
      calls++;
      if (e.retryable) {
        await sleep(1500);
        try { r = await callMaps({ model, user }); calls++; }
        catch (e2) { warnings.push(cat.label + ': ' + e2.message.slice(0, 120)); continue; }
      } else {
        warnings.push(cat.label + ': ' + e.message.slice(0, 120));
        continue;
      }
    }

    tokensIn += r.tokensIn || 0;
    tokensOut += r.tokensOut || 0;
    if (r.chunkCount > 0) groundedAny = true;

    for (const b of r.businesses || []) {
      const name = str(b?.name);
      if (!name) continue;

      const status = String(b.business_status || '').toUpperCase();
      if (status.includes('CLOSED')) continue;

      // Place id is the exact key when Maps returns one; fall back to the name
      // plus locality, which is still far better than nothing.
      const placeId = placeIdFor(name, r.chunks, b.maps_place_id);
      const key = placeId || (name.toLowerCase() + '|' + String(b.locality || '').toLowerCase());
      if (seen.has(key)) continue;

      const phone = firstPhone(str(b.phone));
      const website = normalizeUrl(str(b.website));

      seen.set(key, {
        google_place_id: placeId,
        external_id: placeId || 'm:' + key.slice(0, 80),
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
        maps_url: placeId
          ? 'https://www.google.com/maps/place/?q=place_id:' + placeId
          : 'https://www.google.com/maps/search/' + encodeURIComponent(name + ' ' + (b.locality || areaLabel)),

        rating: parseRating(b.rating),
        review_count: parseCount(b.review_count),
        business_status: status.includes('OPERATIONAL') ? 'OPERATIONAL' : null,
        website_status: website ? null : 'unknown',

        source_url: {
          provider: 'gemini_maps_grounding',
          model,
          placeId,
          angle,
          discoveredAt: new Date().toISOString(),
        },
      });
    }

    await sleep(400);
  }

  const leads = [...seen.values()];
  if (!leads.length) warnings.push('Maps returned nothing for ' + cat.label + ' near ' + areaLabel + '.');

  return { leads, calls, grounded: groundedAny, warnings, tokensIn, tokensOut, model };
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

  if (!(await limiter.acquire(20000))) {
    const err = new Error('Gemini rate limiter busy - try again shortly');
    err.retryable = true;
    throw err;
  }
  let r;
  try {
    r = await callMaps({ model, system: LOOKUP_SYSTEM, user, timeoutMs: 60000, fetchImpl });
  } finally {
    limiter.release();
  }

  const p = r.parsed && !Array.isArray(r.parsed) ? (r.parsed.businesses ? r.parsed.businesses[0] : r.parsed) : (r.parsed || [])[0];
  const meta = { model, grounded: r.chunkCount > 0, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  const name = p && p.found !== false ? str(p.name) : null;
  if (!name) return { match: 'none', similarity: 0, result: null, ...meta };

  const phone = firstPhone(str(p.phone));
  const website = normalizeUrl(str(p.website));
  const status = String(p.business_status || '').toUpperCase();
  const placeId = placeIdFor(name, r.chunks, p.maps_place_id);
  const result = {
    name,
    address: str(p.address),
    category: str(p.category),
    rating: parseRating(p.rating),
    review_count: parseCount(p.review_count),
    phone,
    website,
    place_id: placeId,
    business_status: /PERMANENT/.test(status) ? 'CLOSED_PERMANENTLY'
      : /TEMPOR/.test(status) ? 'CLOSED_TEMPORARILY'
        : /OPERATIONAL|OPEN/.test(status) ? 'OPERATIONAL' : null,
    maps_url: placeId ? 'https://www.google.com/maps/place/?q=place_id:' + placeId : null,
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
