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
    // Overridable so a sweep can be exercised against a local stand-in.
    baseUrl: (process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com').replace(/\/+$/, ''),
    modelFast: process.env.GEMINI_MODEL_FAST || 'gemini-3.5-flash-lite',
    modelMain: process.env.GEMINI_MODEL_MAIN || 'gemini-3.6-flash',
    rpm: num(process.env.GEMINI_RPM, 10),
    rpd: num(process.env.GEMINI_RPD, 250),
    concurrency: num(process.env.GEMINI_CONCURRENCY, 1),
    get mock() { return !this.apiKey; },
  },

  /**
   * Google Maps grounding, for discovery and single-business lookups.
   *
   * Measured on gemini-3.6-flash: at the default thinking level one Maps call
   * takes 45-70s and spends 6-8k thought tokens. At "minimal" the same query
   * returns in ~17s with no thought tokens, and the businesses both settings
   * found carried identical ratings, review counts, phones and place ids.
   * Applied to gemini-3.x flash only (see thinkingFor): gemini-2.5-flash with
   * thinking off returned no businesses at all. "default" switches it off.
   */
  maps: {
    thinkingLevel: (process.env.MAPS_THINKING_LEVEL || 'minimal').toLowerCase(),
    // Maps calls in flight at once, across sweeps and lookups. Kept apart from
    // the drafting limiter so a sweep never starves a rep's brief.
    concurrency: num(process.env.MAPS_CONCURRENCY, 4),
    // Categories swept side by side; each runs its search angles in parallel.
    categoryConcurrency: num(process.env.DISCOVERY_CATEGORY_CONCURRENCY, 2),
  },

  /**
   * Instagram's own Business Discovery API: follower count, post count and
   * recent posts for any public business or creator account, looked up through
   * your agency's Instagram business account. The legitimate route to the
   * numbers - no scraping, no login cookies, nothing that breaks Meta's terms.
   */
  instagram: {
    token: process.env.META_GRAPH_TOKEN || process.env.INSTAGRAM_ACCESS_TOKEN || '',
    businessId: process.env.INSTAGRAM_BUSINESS_ID || '',
    version: process.env.META_GRAPH_VERSION || 'v23.0',
    get enabled() { return Boolean(this.token && this.businessId); },
  },

  enrich: {
    // Look every new directory lead up on Google Maps after a sweep, for its
    // review count, rating, phone and trading status.
    mapsOnDiscovery: bool(process.env.MAPS_ENRICH_ON_DISCOVERY, true),
    mapsMaxPerRun: num(process.env.MAPS_ENRICH_MAX_PER_RUN, 200),
  },

  overpassUrls: (process.env.OVERPASS_URLS || '')
    .split(',').map((s) => s.trim()).filter(Boolean),

  worker: {
    concurrency: num(process.env.WORKER_CONCURRENCY, 3),
  },

  maintenance: {
    auto: bool(process.env.MAINTENANCE_AUTO, true),
    intervalHours: num(process.env.MAINTENANCE_INTERVAL_HOURS, 24),
    jobRetentionDays: num(process.env.JOB_RETENTION_DAYS, 7),
    failedJobRetentionDays: num(process.env.FAILED_JOB_RETENTION_DAYS, 30),
    usageRetentionDays: num(process.env.USAGE_RETENTION_DAYS, 400),
    aiCacheRetentionDays: num(process.env.AI_CACHE_RETENTION_DAYS, 45),
    rejectedLeadRetentionDays: num(process.env.REJECTED_LEAD_RETENTION_DAYS, 60),
    runRetentionDays: num(process.env.RUN_RETENTION_DAYS, 30),
  },

  verboseAudit: bool(process.env.VERBOSE_AUDIT, false),

  combined: {
    openaiKey: process.env.OPENAI_API_KEY || '',
    lunaModel: process.env.DISCOVERY_LUNA_MODEL || 'gpt-6-luna',
    lunaEffort: process.env.DISCOVERY_LUNA_EFFORT || 'max',
    geminiModels: (process.env.DISCOVERY_GEMINI_MODELS || 'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite').split(',').map(s => s.trim()).filter(Boolean),
    thinking: process.env.DISCOVERY_GEMINI_THINKING || 'medium',
    geminiTool: process.env.DISCOVERY_GEMINI_TOOL === 'maps' ? 'google_maps' : 'google_search',
    mapsKey: process.env.MAPS_MCP_API_KEY || process.env['X-Goog-Api-Key'] || '',
    mapsMcp: bool(process.env.DISCOVERY_MAPS_MCP, true),
    results: Math.max(1, Math.min(30, num(process.env.DISCOVERY_RESULTS_PER_PASS, 15))),
    maxOutput: Math.max(2048, Math.min(64000, num(process.env.DISCOVERY_MAX_OUTPUT_TOKENS, 16000))),
    retries: Math.max(0, Math.min(3, num(process.env.DISCOVERY_RETRIES, 2))),
  },
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
  // the gates need - so it outranks both recall and OpenStreetMap. Not with a
  // key Google has already refused, though: that sweep can only come back empty.
  if (config.gemini.apiKey && !geminiKeyRefused) return 'maps';
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

/** Set by the key check in llm.js; read here so `auto` never picks a dead source. */
let geminiKeyRefused = false;
export function setGeminiKeyRefused(v) {
  geminiKeyRefused = Boolean(v);
}

export default config;
