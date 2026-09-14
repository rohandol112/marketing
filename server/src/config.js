import 'dotenv/config';

const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));
const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

export const config = {
  port: num(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH || './data/app.db',
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',

  places: {
    apiKey: process.env.GOOGLE_PLACES_API_KEY || '',
    fieldTier: (process.env.PLACES_FIELD_TIER || 'enterprise').toLowerCase(),
    maxPages: num(process.env.PLACES_MAX_PAGES, 3),
    get mock() { return !this.apiKey; },
  },

  pagespeed: {
    apiKey: process.env.PAGESPEED_API_KEY || '',
    get enabled() { return Boolean(this.apiKey); },
  },

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    modelFast: process.env.GEMINI_MODEL_FAST || 'gemini-3.5-flash-lite',
    modelMain: process.env.GEMINI_MODEL_MAIN || 'gemini-3.6-flash',
    rpm: num(process.env.GEMINI_RPM, 10),
    rpd: num(process.env.GEMINI_RPD, 250),
    concurrency: num(process.env.GEMINI_CONCURRENCY, 1),
    get mock() { return !this.apiKey; },
  },

  verboseAudit: bool(process.env.VERBOSE_AUDIT, false),
};

/**
 * Which engine finds businesses.
 *
 *   places - Google Places API (New). Authoritative, has ratings and review
 *            counts, costs money. The best option, full stop.
 *   osm    - OpenStreetMap via Overpass. Real businesses surveyed by humans,
 *            with coordinates. Free, no key. No ratings, so leads still need a
 *            review count filled in before they can qualify.
 *   gemini - the model recalls businesses from training data. Free, and
 *            unverified by construction. Only when explicitly asked for.
 *   mock   - synthetic data, for working on the UI.
 *
 * Auto prefers real data over generated data, always. Gemini is never chosen
 * automatically: having a Gemini key means you want AI interpretation, not AI
 * invention of the business list.
 */
export function discoverySource() {
  const explicit = (process.env.DISCOVERY_SOURCE || 'auto').toLowerCase();
  if (explicit !== 'auto') return explicit;
  if (config.places.apiKey) return 'places';
  // Maps grounding returns rating, reviews, phone and a place id - everything
  // the gates need - so it outranks both recall and OpenStreetMap.
  if (config.gemini.apiKey) return 'maps';
  // Grounded Gemini is retrieval with citations, which beats OSM's thin
  // coverage. Ungrounded it is recall, and OSM is the safer default - so this
  // only prefers Gemini when search grounding is actually available.
  if (config.gemini.apiKey && groundingAvailable()) return 'gemini';
  return 'osm';
}

/**
 * Search grounding needs billing. It is probed once at startup rather than
 * guessed, because the difference between grounded and ungrounded discovery is
 * the difference between real businesses and plausible ones.
 */
let groundingProbe = null;
export function groundingAvailable() {
  return groundingProbe === null ? Boolean(config.gemini.apiKey) : groundingProbe;
}
export function setGroundingAvailable(v) {
  groundingProbe = v;
}

export default config;
