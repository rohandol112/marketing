import config from '../config.js';
import { sleep, haversineMeters, normalizePhone, normalizeHost } from './util.js';
import { CATEGORY_BY_ID } from './categories.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';

/**
 * Field masks decide the SKU, and therefore the bill. Two honest options:
 *
 *   enterprise - the real sweep. rating, userRatingCount, phone and websiteUri
 *                are all Enterprise-tier fields, and every one of them feeds
 *                the score. There is no cheaper mask that still produces a
 *                usable lead.
 *
 *   pro        - a counting pre-scan. Name and address only, no contact detail,
 *                no ratings. Useful to answer "how many jewellers are in this
 *                circle and what will the real sweep cost" before spending.
 *
 * `reviews` is deliberately absent. It jumps to the Enterprise + Atmosphere SKU
 * and we never use the review text.
 */
const FIELD_MASKS = {
  enterprise: [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.addressComponents',
    'places.location',
    'places.googleMapsUri',
    'places.businessStatus',
    'places.primaryType',
    'places.primaryTypeDisplayName',
    'places.types',
    'places.rating',
    'places.userRatingCount',
    'places.nationalPhoneNumber',
    'places.internationalPhoneNumber',
    'places.websiteUri',
    'nextPageToken',
  ].join(','),
  pro: [
    'places.id',
    'places.displayName',
    'places.formattedAddress',
    'places.addressComponents',
    'places.location',
    'places.googleMapsUri',
    'places.businessStatus',
    'places.primaryType',
    'places.primaryTypeDisplayName',
    'places.types',
    'nextPageToken',
  ].join(','),
};

/** USD per 1,000 requests, by SKU. Update if Google reprices. */
export const PRICE_PER_1K = { enterprise: 35, pro: 32, atmosphere: 40, ids_only: 0 };

export function costPerCall(tier = config.places.fieldTier) {
  return (PRICE_PER_1K[tier] ?? PRICE_PER_1K.enterprise) / 1000;
}

/**
 * Estimate a sweep before running it. Shown in the UI so nobody accidentally
 * spends a hundred dollars discovering that a category is empty.
 */
export function estimateSweep({ categoryCount, maxPages = config.places.maxPages, tier = config.places.fieldTier }) {
  const calls = categoryCount * maxPages;
  const usd = calls * costPerCall(tier);
  return {
    calls,
    maxResults: categoryCount * maxPages * 20,
    costUsd: Math.round(usd * 100) / 100,
    tier,
    note: config.places.mock ? 'Mock mode: no API key set, this run costs nothing and returns synthetic leads.' : null,
  };
}

async function callPlaces(body, tier) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': config.places.apiKey,
      'X-Goog-FieldMask': FIELD_MASKS[tier] || FIELD_MASKS.enterprise,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error('Places API ' + res.status + ': ' + text.slice(0, 400));
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  return res.json();
}

/**
 * One category, up to maxPages of 20. Text Search only supports a *circle bias*
 * (not a hard circle restriction), so results outside the radius come back and
 * are filtered here by real distance.
 */
export async function searchCategory({
  categoryId,
  center,
  radiusM,
  regionCode,
  languageCode = 'en',
  maxPages = config.places.maxPages,
  tier = config.places.fieldTier,
  onPage,
}) {
  const cat = CATEGORY_BY_ID.get(categoryId);
  if (!cat) throw new Error('Unknown category: ' + categoryId);

  if (config.places.mock) {
    return mockCategory({ cat, center, radiusM, regionCode });
  }

  const out = [];
  let pageToken = null;
  let calls = 0;

  for (let page = 0; page < maxPages; page++) {
    const body = {
      textQuery: cat.q,
      pageSize: 20,
      languageCode,
      locationBias: {
        circle: {
          center: { latitude: center.lat, longitude: center.lng },
          radius: Math.min(Math.max(radiusM, 100), 50000),
        },
      },
    };
    if (regionCode) body.regionCode = regionCode;
    if (cat.type) body.includedType = cat.type;
    if (pageToken) body.pageToken = pageToken;

    let json;
    try {
      json = await callPlaces(body, tier);
      calls++;
    } catch (e) {
      if (e.retryable && page === 0) {
        await sleep(1500);
        json = await callPlaces(body, tier);
        calls++;
      } else if (page > 0) {
        break; // partial results beat a failed run
      } else {
        e.calls = calls;
        throw e;
      }
    }

    const places = json.places || [];
    for (const p of places) out.push(mapPlace(p, cat, center));
    if (onPage) onPage({ page, got: places.length, calls });

    pageToken = json.nextPageToken || null;
    if (!pageToken || places.length === 0) break;
    await sleep(400); // next_page_token needs a moment to become valid
  }

  const withinRadius = out.filter((p) => p.distance_m == null || p.distance_m <= radiusM);
  return { leads: withinRadius, calls, filteredOut: out.length - withinRadius.length };
}

function pickComponent(components, type) {
  if (!components) return null;
  const c = components.find((x) => (x.types || []).includes(type));
  return c ? c.shortText || c.longText : null;
}

function mapPlace(p, cat, center) {
  const loc = p.location ? { lat: p.location.latitude, lng: p.location.longitude } : null;
  const phone = p.internationalPhoneNumber || p.nationalPhoneNumber || null;
  const comps = p.addressComponents;
  return {
    google_place_id: p.id,
    external_id: p.id,
    external_source: 'google_places',
    name: p.displayName?.text || 'Unknown',
    category: p.primaryTypeDisplayName?.text || p.primaryType || cat.label,
    normalized_category: cat.id,
    address: p.formattedAddress || null,
    locality: pickComponent(comps, 'locality') || pickComponent(comps, 'postal_town'),
    region: pickComponent(comps, 'administrative_area_level_1'),
    country_code: pickComponent(comps, 'country'),
    postal_code: pickComponent(comps, 'postal_code'),
    lat: loc?.lat ?? null,
    lng: loc?.lng ?? null,
    distance_m: loc && center ? Math.round(haversineMeters(center, loc)) : null,
    phone,
    phone_normalized: normalizePhone(phone),
    website: p.websiteUri || null,
    website_host: normalizeHost(p.websiteUri),
    maps_url: p.googleMapsUri || null,
    rating: p.rating ?? null,
    review_count: p.userRatingCount ?? null,
    business_status: p.businessStatus || null,
    // Authoritative: if Google has no website for a business, it has no website.
    website_status: p.websiteUri ? null : 'none',
    source_url: {
      name: p.googleMapsUri || null,
      phone: p.googleMapsUri || null,
      website: p.websiteUri || null,
      provider: 'google_places_api_new',
    },
  };
}

/* ------------------------------------------------------------------ */
/* Mock mode                                                          */
/* ------------------------------------------------------------------ */

const MOCK_FIRST = ['Shree', 'Royal', 'Elite', 'Prime', 'Golden', 'Urban', 'Silver', 'Crown', 'Green', 'Blue', 'Star', 'Grand', 'Nova', 'Apex', 'Lotus', 'Orchid', 'Pearl', 'Sunrise'];
const MOCK_SECOND = ['Palace', 'House', 'Point', 'Hub', 'Studio', 'Centre', 'Works', 'Collective', 'Gallery', 'Corner', 'Junction', 'Avenue', 'Square', 'Court'];

/** Deterministic PRNG so a mock run is reproducible from its seed. */
function rng(seed) {
  let s = 0;
  for (const ch of String(seed)) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function mockCategory({ cat, center, radiusM, regionCode }) {
  const r = rng(cat.id + ':' + center.lat.toFixed(3) + ':' + center.lng.toFixed(3));
  const count = 8 + Math.floor(r() * 18);
  const leads = [];

  for (let i = 0; i < count; i++) {
    const name =
      MOCK_FIRST[Math.floor(r() * MOCK_FIRST.length)] + ' ' +
      cat.label.split(/[ /]/)[0] + ' ' +
      MOCK_SECOND[Math.floor(r() * MOCK_SECOND.length)];

    // Skew towards the shape we actually see in the field: strong offline
    // signal, thin online presence.
    const reviews = Math.floor(Math.pow(10, 1 + r() * 2.6));
    const hasSite = r() > 0.42;
    const sitePlaceholder = hasSite && r() > 0.62;
    const igFollowers = Math.floor(Math.pow(10, 1.4 + r() * 2.6));

    const bearing = r() * Math.PI * 2;
    const dist = Math.sqrt(r()) * radiusM;
    const dLat = (dist * Math.cos(bearing)) / 111320;
    const dLng = (dist * Math.sin(bearing)) / (111320 * Math.cos((center.lat * Math.PI) / 180));
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '');

    leads.push({
      google_place_id: 'mock_' + cat.id + '_' + i + '_' + Math.floor(r() * 1e6),
      name,
      category: cat.label,
      normalized_category: cat.id,
      address: Math.floor(r() * 200) + ' Main Road, ' + (regionCode || 'XX'),
      locality: null,
      region: null,
      country_code: regionCode || null,
      postal_code: null,
      lat: center.lat + dLat,
      lng: center.lng + dLng,
      distance_m: Math.round(dist),
      phone: null,
      phone_normalized: null,
      website: hasSite ? 'https://' + slug + '.example' : null,
      website_host: hasSite ? slug + '.example' : null,
      maps_url: null,
      rating: Math.round((3.5 + r() * 1.5) * 10) / 10,
      review_count: reviews,
      business_status: r() > 0.97 ? 'CLOSED_TEMPORARILY' : 'OPERATIONAL',
      website_status: !hasSite ? 'none' : sitePlaceholder ? 'placeholder' : 'ok',
      has_https: hasSite ? r() > 0.25 : null,
      mobile_friendly: hasSite ? r() > 0.4 : null,
      psi_mobile: hasSite ? Math.floor(20 + r() * 75) : null,
      ig_followers: igFollowers,
      li_followers: Math.floor(r() * 400),
      years_in_business: 1 + Math.floor(r() * 25),
      locations_count: r() > 0.82 ? 2 + Math.floor(r() * 4) : 1,
      source_url: { provider: 'mock' },
    });
  }

  return { leads, calls: 0, filteredOut: 0, mock: true };
}
