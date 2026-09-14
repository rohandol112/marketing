import config from '../config.js';
import { activeProvider, modelsFor, parseLooseJson } from './llm.js';
import { CATEGORY_BY_ID } from './categories.js';
import { normalizeHost, normalizePhone, sleep } from './util.js';

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
  '3. Prefer independent and regional businesses. Skip national chains, government offices and anything permanently closed.',
  '4. No duplicates, including the same business under a different spelling.',
  '5. Do not judge whether a business is a good sales prospect. Only find real ones.',
  '6. Return JSON only. No prose, no markdown fence.',
].join('\n');

const SHAPE = '{"businesses":[{"name":"","locality":"","address":"","rating":0,"review_count":0,'
  + '"phone":"","website":"","maps_place_id":"","business_status":"OPERATIONAL|CLOSED|UNKNOWN"}]}';

async function callMaps({ model, user, timeoutMs = 90000 }) {
  const res = await fetch(BASE + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
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
  const chunks = gm.groundingChunks || [];

  return {
    businesses: Array.isArray(parsed) ? parsed : parsed?.businesses || [],
    placeIds: chunks.map((c) => c.maps?.placeId).filter(Boolean),
    chunkCount: chunks.length,
    tokensIn: json.usageMetadata?.promptTokenCount ?? null,
    tokensOut: json.usageMetadata?.candidatesTokenCount ?? null,
  };
}

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};

const str = (v) => {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s && s !== 'null' && s !== 'N/A' ? s : null;
};

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

    for (let i = 0; i < (r.businesses || []).length; i++) {
      const b = r.businesses[i];
      const name = str(b?.name);
      if (!name) continue;

      const status = String(b.business_status || '').toUpperCase();
      if (status.includes('CLOSED')) continue;

      // Place id is the exact key when Maps returns one; fall back to the name
      // plus locality, which is still far better than nothing.
      const placeId = str(b.maps_place_id) || r.placeIds[i] || null;
      const key = placeId || (name.toLowerCase() + '|' + String(b.locality || '').toLowerCase());
      if (seen.has(key)) continue;

      const phone = str(b.phone);
      const website = str(b.website);
      const reviews = num(b.review_count);
      const rating = num(b.rating);

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
        phone_normalized: normalizePhone(phone),
        email: null,
        website,
        website_host: normalizeHost(website),
        maps_url: placeId
          ? 'https://www.google.com/maps/place/?q=place_id:' + placeId
          : 'https://www.google.com/maps/search/' + encodeURIComponent(name + ' ' + (b.locality || areaLabel)),

        rating,
        review_count: reviews,
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
