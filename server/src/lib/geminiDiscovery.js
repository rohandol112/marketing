import config from '../config.js';
import { activeProvider, modelsFor, parseLooseJson } from './llm.js';
import { CATEGORY_BY_ID } from './categories.js';
import { normalizeHost, normalizeName } from './util.js';

/**
 * Discovery via Gemini, for when there is no Places API key.
 *
 * Read this before changing anything here.
 *
 * A language model asked to list businesses is recalling training data, not
 * querying a directory. It will invent plausible businesses, and it will invent
 * them most confidently for exactly the small local operators we care about.
 * That is not a bug to be prompted away - it is what the tool is.
 *
 * So this module is built around one rule: a hallucination must cost a rep five
 * seconds, never a phone call to a stranger.
 *
 *   1. The schema has no phone field. The model is never given the chance to
 *      produce a number someone could dial. Phone stays null and is filled in
 *      by a human during verification.
 *   2. Every lead lands in discovery_status 'discovered'. It cannot reach a
 *      rep's board until a person opens the Maps link and confirms the
 *      business is real, and a CHECK constraint enforces that in the database.
 *   3. No rating, no review count. Those drive the DEMAND score, and a made-up
 *      review count would quietly corrupt every ranking in the system. Unknown
 *      scores zero and costs data confidence, so a candidate cannot look good
 *      simply by being unmeasured.
 *   4. The website, if the model gives one, is independently fetched by the
 *      auditor. A site that does not resolve is treated as evidence the
 *      business may not exist.
 *
 * Google Search grounding turns this from recall into retrieval and is far
 * safer. It is attempted first on every call; on this key it currently returns
 * 429 because grounded requests have their own quota that opens up with
 * billing. When that is enabled, this module upgrades itself with no code
 * change - watch for `grounded: true` in the run result.
 */

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

const DISCOVERY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    businesses: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: { type: 'STRING', description: 'The exact trading name, as it appears on their signage' },
          locality: { type: 'STRING', description: 'Neighbourhood or suburb' },
          approximate_address: { type: 'STRING', description: 'Street or landmark. Never invent a house number.' },
          website: { type: 'STRING', description: 'Official website domain only if you are confident it exists, otherwise empty string' },
          instagram_handle: { type: 'STRING', description: 'Handle without the @, only if confident, otherwise empty string' },
          confidence: {
            type: 'STRING',
            enum: ['high', 'medium', 'low'],
            description: 'high = you are certain this specific business exists at this location',
          },
          basis: { type: 'STRING', description: 'One short phrase on why you believe this exists. Say "uncertain" if you are guessing.' },
        },
        required: ['name', 'locality', 'confidence', 'basis'],
      },
    },
  },
  required: ['businesses'],
};

const SYSTEM = [
  'You help a sales team build a list of local businesses to research.',
  '',
  'Accuracy matters more than length. A short list of businesses that genuinely exist is worth far more than a long list padded with plausible names.',
  '',
  'RULES',
  '1. Only list businesses you actually believe exist at the named location. If you can only think of three, return three.',
  '2. Never output a phone number, an email address or a street number. There is no field for them and inventing one could cause a real person to be called.',
  '3. Do not invent websites. Leave the field empty unless you are confident of the domain.',
  '4. Set confidence honestly. "low" is the correct answer for a name you are reconstructing rather than recalling, and low-confidence entries are discarded rather than shown.',
  '5. Do not list national or international chains - this team sells to independent local businesses.',
  '6. Do not repeat the same business under variant spellings.',
].join('\n');

async function callGemini({ model, system, user, schema, useGrounding }) {
  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: 'low' },
      maxOutputTokens: 8192,
    },
  };

  if (useGrounding) {
    // Grounding and responseSchema cannot be combined. The comment said to ask
    // for JSON in the prompt instead - but nothing ever did, so the grounded
    // path had no JSON instruction at all and every call failed with "model did
    // not return JSON" and silently fell back to ungrounded recall.
    body.tools = [{ google_search: {} }];
    body.contents[0].parts[0].text = [
      user,
      '',
      'Search the web before answering. Base every business on a page you actually found.',
      '',
      'Return ONLY a JSON object of this exact shape. No prose, no markdown fence:',
      '{"businesses":[{"name":"","locality":"","approximate_address":"","website":"","instagram_handle":"","confidence":"high|medium|low","basis":""}]}',
    ].join('\n');
  } else {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = schema;
  }

  const res = await fetch(BASE + model + ':generateContent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error('Gemini ' + res.status + ': ' + text.slice(0, 300));
    err.status = res.status;
    throw err;
  }

  const json = await res.json();
  const cand = json.candidates?.[0];
  const text = cand?.content?.parts?.map((p) => p.text).join('') || '';
  const grounding = cand?.groundingMetadata || null;

  const parsed = parseLooseJson(text);
  if (!parsed) throw new Error('Model did not return JSON');

  const businesses = Array.isArray(parsed) ? parsed : parsed.businesses || [];
  return { businesses, grounding, tokensIn: json.usageMetadata?.promptTokenCount, tokensOut: json.usageMetadata?.candidatesTokenCount };
}

/**
 * Discover one category in one area.
 * @returns {{leads: Array, calls: number, grounded: boolean, warnings: string[]}}
 */
export async function discoverCategory({ categoryId, areaLabel, center, radiusM, regionCode, limit = 20, tryGrounding = true }) {
  const cat = CATEGORY_BY_ID.get(categoryId);
  if (!cat) throw new Error('Unknown category: ' + categoryId);

  const radiusKm = Math.round((radiusM / 1000) * 10) / 10;
  const user = [
    'List up to ' + limit + ' independent ' + cat.label.toLowerCase() + ' businesses in and around ' + areaLabel +
      (regionCode ? ' (' + regionCode + ')' : '') + '.',
    'The area centre is approximately ' + center.lat.toFixed(4) + ', ' + center.lng.toFixed(4) + ', within about ' + radiusKm + ' km.',
    '',
    'Remember: no phone numbers, no street numbers, no invented websites. Mark anything you are reconstructing as low confidence.',
  ].join('\n');

  const discoveryModel = modelsFor(activeProvider()).main;
  const warnings = [];
  let result = null;
  let grounded = false;
  let calls = 0;

  // Grounded first - it turns recall into retrieval, which is the whole
  // ballgame. But the model does not invoke search for open-ended "list
  // businesses here" prompts (measured repeatedly: 200 OK, zero
  // groundingMetadata), so once a run proves that, the caller stops asking and
  // we save a wasted call per category.
  if (!tryGrounding) {
    result = await callGemini({
      model: discoveryModel,
      system: SYSTEM,
      user,
      schema: DISCOVERY_SCHEMA,
      useGrounding: false,
    });
    calls++;
  } else {
  try {
    result = await callGemini({
      model: discoveryModel,
      system: SYSTEM,
      user,
      schema: DISCOVERY_SCHEMA,
      useGrounding: true,
    });
    calls++;
    grounded = Boolean(result.grounding);
    if (!grounded) warnings.push('Grounding tool returned no sources; treating results as unverified recall.');
  } catch (e) {
    calls++;
    if (e.status === 429) {
      warnings.push('Google Search grounding is over quota. Results come from model recall only and every lead will need verifying. Grounded discovery needs billing enabled on the Gemini project.');
    } else {
      warnings.push('Grounded discovery failed (' + e.message.slice(0, 120) + '), fell back to ungrounded.');
    }
    result = await callGemini({
      model: discoveryModel,
      system: SYSTEM,
      user,
      schema: DISCOVERY_SCHEMA,
      useGrounding: false,
    });
    calls++;
  }
  }

  const sources = (result.grounding?.groundingChunks || [])
    .map((ch) => ch.web?.uri)
    .filter(Boolean);

  const seen = new Set();
  const leads = [];

  for (const b of result.businesses || []) {
    if (!b.name || typeof b.name !== 'string') continue;

    // A model that says "low" is telling you it made this up. Believe it.
    if (b.confidence === 'low') continue;

    const norm = normalizeName(b.name);
    if (!norm || norm.length < 3 || seen.has(norm)) continue;
    seen.add(norm);

    // Guard against generic placeholders the model falls back on.
    if (/^(the |a )?(local|best|top|popular|various|multiple|several)\b/i.test(b.name)) continue;

    const website = b.website && /\./.test(b.website) ? b.website.trim() : null;
    const mapsSearch =
      'https://www.google.com/maps/search/' +
      encodeURIComponent(b.name + ' ' + (b.locality || areaLabel));

    leads.push({
      google_place_id: null,
      // Grounded results are backed by citations, which is evidence of
      // existence. Recalled ones are not, and must stay unverified.
      external_source: grounded ? 'gemini_grounded' : null,
      external_id: grounded ? 'g:' + norm.replace(/\s+/g, '-').slice(0, 60) : null,
      name: b.name.trim(),
      category: cat.label,
      normalized_category: cat.id,
      address: b.approximate_address || null,
      locality: b.locality || areaLabel,
      region: null,
      country_code: regionCode || null,
      postal_code: null,
      lat: null,
      lng: null,
      distance_m: null,

      // Deliberately empty. The model was never asked and must never be asked.
      phone: null,
      phone_normalized: null,
      email: null,

      website,
      website_host: normalizeHost(website),
      maps_url: mapsSearch,

      // Deliberately null: a fabricated review count would corrupt every ranking.
      rating: null,
      review_count: null,
      business_status: null,
      website_status: website ? null : 'unknown',
      ig_handle: b.instagram_handle ? String(b.instagram_handle).replace(/^@/, '') : null,

      // Existence is not asserted here. With no place id and no human check,
      // evaluate() lands this in discovery_status 'discovered', and the CHECK
      // constraint on leads makes it impossible to put into a sales stage.

      source_url: {
        provider: grounded ? 'gemini_search_grounded' : 'gemini_recall',
        model: discoveryModel,
        confidence: b.confidence,
        basis: b.basis,
        groundingSources: sources.slice(0, 5),
        grounded,
        discoveredAt: new Date().toISOString(),
      },
    });
  }

  return {
    leads, calls, grounded, warnings,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    model: discoveryModel,
  };
}

export { DISCOVERY_SCHEMA };
