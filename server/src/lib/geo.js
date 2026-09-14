import config from '../config.js';
import { costPerCall } from './places.js';
import { sleep } from './util.js';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const UA = 'TanzLeadOS/0.1 (local business lead research)';

/**
 * Area resolution. Anywhere on earth: type a place name, get a centre point,
 * pair it with a radius. No pincode tables, no country-specific logic.
 */

/** Offline fallback so area search works with no API key at all. */
const OFFLINE_PLACES = [
  // the pilot areas from the original plan
  { label: 'Aundh, Pune', region: 'Maharashtra', country: 'IN', lat: 18.5590, lng: 73.8077 },
  { label: 'New Sangvi, Pune', region: 'Maharashtra', country: 'IN', lat: 18.5793, lng: 73.8143 },
  { label: 'Pimpri, Pune', region: 'Maharashtra', country: 'IN', lat: 18.6280, lng: 73.7997 },
  { label: 'Chinchwad, Pune', region: 'Maharashtra', country: 'IN', lat: 18.6414, lng: 73.7997 },
  { label: 'Akurdi, Pune', region: 'Maharashtra', country: 'IN', lat: 18.6492, lng: 73.7707 },
  { label: 'Thakur Village, Kandivali East, Mumbai', region: 'Maharashtra', country: 'IN', lat: 19.2094, lng: 72.8712 },

  { label: 'Pune, India', region: 'Maharashtra', country: 'IN', lat: 18.5204, lng: 73.8567 },
  { label: 'Mumbai, India', region: 'Maharashtra', country: 'IN', lat: 19.0760, lng: 72.8777 },
  { label: 'Delhi, India', region: 'Delhi', country: 'IN', lat: 28.6139, lng: 77.2090 },
  { label: 'Bengaluru, India', region: 'Karnataka', country: 'IN', lat: 12.9716, lng: 77.5946 },
  { label: 'Hyderabad, India', region: 'Telangana', country: 'IN', lat: 17.3850, lng: 78.4867 },
  { label: 'Chennai, India', region: 'Tamil Nadu', country: 'IN', lat: 13.0827, lng: 80.2707 },
  { label: 'Ahmedabad, India', region: 'Gujarat', country: 'IN', lat: 23.0225, lng: 72.5714 },
  { label: 'Kolkata, India', region: 'West Bengal', country: 'IN', lat: 22.5726, lng: 88.3639 },
  { label: 'Jaipur, India', region: 'Rajasthan', country: 'IN', lat: 26.9124, lng: 75.7873 },
  { label: 'Surat, India', region: 'Gujarat', country: 'IN', lat: 21.1702, lng: 72.8311 },
  { label: 'Nagpur, India', region: 'Maharashtra', country: 'IN', lat: 21.1458, lng: 79.0882 },
  { label: 'Indore, India', region: 'Madhya Pradesh', country: 'IN', lat: 22.7196, lng: 75.8577 },
  { label: 'Kochi, India', region: 'Kerala', country: 'IN', lat: 9.9312, lng: 76.2673 },
  { label: 'Chandigarh, India', region: 'Chandigarh', country: 'IN', lat: 30.7333, lng: 76.7794 },

  { label: 'Dubai, UAE', region: 'Dubai', country: 'AE', lat: 25.2048, lng: 55.2708 },
  { label: 'Abu Dhabi, UAE', region: 'Abu Dhabi', country: 'AE', lat: 24.4539, lng: 54.3773 },
  { label: 'Riyadh, Saudi Arabia', region: 'Riyadh', country: 'SA', lat: 24.7136, lng: 46.6753 },
  { label: 'Doha, Qatar', region: 'Doha', country: 'QA', lat: 25.2854, lng: 51.5310 },
  { label: 'Singapore', region: 'Singapore', country: 'SG', lat: 1.3521, lng: 103.8198 },
  { label: 'Kuala Lumpur, Malaysia', region: 'Kuala Lumpur', country: 'MY', lat: 3.1390, lng: 101.6869 },
  { label: 'Bangkok, Thailand', region: 'Bangkok', country: 'TH', lat: 13.7563, lng: 100.5018 },
  { label: 'Jakarta, Indonesia', region: 'Jakarta', country: 'ID', lat: -6.2088, lng: 106.8456 },
  { label: 'Manila, Philippines', region: 'Metro Manila', country: 'PH', lat: 14.5995, lng: 120.9842 },
  { label: 'Ho Chi Minh City, Vietnam', region: 'HCMC', country: 'VN', lat: 10.8231, lng: 106.6297 },
  { label: 'Colombo, Sri Lanka', region: 'Western', country: 'LK', lat: 6.9271, lng: 79.8612 },
  { label: 'Dhaka, Bangladesh', region: 'Dhaka', country: 'BD', lat: 23.8103, lng: 90.4125 },
  { label: 'Karachi, Pakistan', region: 'Sindh', country: 'PK', lat: 24.8607, lng: 67.0011 },
  { label: 'Tokyo, Japan', region: 'Tokyo', country: 'JP', lat: 35.6762, lng: 139.6503 },
  { label: 'Seoul, South Korea', region: 'Seoul', country: 'KR', lat: 37.5665, lng: 126.9780 },
  { label: 'Sydney, Australia', region: 'NSW', country: 'AU', lat: -33.8688, lng: 151.2093 },
  { label: 'Melbourne, Australia', region: 'Victoria', country: 'AU', lat: -37.8136, lng: 144.9631 },
  { label: 'Auckland, New Zealand', region: 'Auckland', country: 'NZ', lat: -36.8485, lng: 174.7633 },

  { label: 'London, United Kingdom', region: 'England', country: 'GB', lat: 51.5074, lng: -0.1278 },
  { label: 'Manchester, United Kingdom', region: 'England', country: 'GB', lat: 53.4808, lng: -2.2426 },
  { label: 'Dublin, Ireland', region: 'Leinster', country: 'IE', lat: 53.3498, lng: -6.2603 },
  { label: 'Paris, France', region: 'Ile-de-France', country: 'FR', lat: 48.8566, lng: 2.3522 },
  { label: 'Berlin, Germany', region: 'Berlin', country: 'DE', lat: 52.5200, lng: 13.4050 },
  { label: 'Amsterdam, Netherlands', region: 'North Holland', country: 'NL', lat: 52.3676, lng: 4.9041 },
  { label: 'Madrid, Spain', region: 'Madrid', country: 'ES', lat: 40.4168, lng: -3.7038 },
  { label: 'Barcelona, Spain', region: 'Catalonia', country: 'ES', lat: 41.3851, lng: 2.1734 },
  { label: 'Milan, Italy', region: 'Lombardy', country: 'IT', lat: 45.4642, lng: 9.1900 },
  { label: 'Lisbon, Portugal', region: 'Lisbon', country: 'PT', lat: 38.7223, lng: -9.1393 },
  { label: 'Warsaw, Poland', region: 'Masovia', country: 'PL', lat: 52.2297, lng: 21.0122 },
  { label: 'Istanbul, Turkey', region: 'Istanbul', country: 'TR', lat: 41.0082, lng: 28.9784 },

  { label: 'New York, USA', region: 'New York', country: 'US', lat: 40.7128, lng: -74.0060 },
  { label: 'Los Angeles, USA', region: 'California', country: 'US', lat: 34.0522, lng: -118.2437 },
  { label: 'Chicago, USA', region: 'Illinois', country: 'US', lat: 41.8781, lng: -87.6298 },
  { label: 'Houston, USA', region: 'Texas', country: 'US', lat: 29.7604, lng: -95.3698 },
  { label: 'Miami, USA', region: 'Florida', country: 'US', lat: 25.7617, lng: -80.1918 },
  { label: 'Toronto, Canada', region: 'Ontario', country: 'CA', lat: 43.6532, lng: -79.3832 },
  { label: 'Vancouver, Canada', region: 'British Columbia', country: 'CA', lat: 49.2827, lng: -123.1207 },
  { label: 'Mexico City, Mexico', region: 'CDMX', country: 'MX', lat: 19.4326, lng: -99.1332 },
  { label: 'Sao Paulo, Brazil', region: 'Sao Paulo', country: 'BR', lat: -23.5505, lng: -46.6333 },
  { label: 'Buenos Aires, Argentina', region: 'Buenos Aires', country: 'AR', lat: -34.6037, lng: -58.3816 },

  { label: 'Dubai Marina, Dubai', region: 'Dubai', country: 'AE', lat: 25.0805, lng: 55.1403 },
  { label: 'Nairobi, Kenya', region: 'Nairobi', country: 'KE', lat: -1.2921, lng: 36.8219 },
  { label: 'Lagos, Nigeria', region: 'Lagos', country: 'NG', lat: 6.5244, lng: 3.3792 },
  { label: 'Cairo, Egypt', region: 'Cairo', country: 'EG', lat: 30.0444, lng: 31.2357 },
  { label: 'Johannesburg, South Africa', region: 'Gauteng', country: 'ZA', lat: -26.2041, lng: 28.0473 },
  { label: 'Cape Town, South Africa', region: 'Western Cape', country: 'ZA', lat: -33.9249, lng: 18.4241 },
];

function offlineSearch(q, limit) {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return OFFLINE_PLACES.slice(0, limit);
  const scored = OFFLINE_PLACES.map((p) => {
    const hay = (p.label + ' ' + p.region + ' ' + p.country).toLowerCase();
    let s = 0;
    if (hay.startsWith(needle)) s = 3;
    else if (hay.includes(needle)) s = 2;
    else if (needle.split(/[ ,]+/).some((w) => w.length > 2 && hay.includes(w))) s = 1;
    return { p, s };
  })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit);
  return scored.map((x) => x.p);
}

function toResult(p) {
  return {
    label: p.label,
    region: p.region,
    countryCode: p.country,
    lat: p.lat,
    lng: p.lng,
    source: 'offline',
  };
}

/**
 * Nominatim, OpenStreetMap's geocoder. Free, no key, and it knows every
 * neighbourhood on earth - Kothrud, Bandra West, Viman Nagar, Powai - which the
 * hardcoded city list emphatically does not.
 *
 * Their usage policy is one request per second, absolute. It is a donated
 * service, so the gate below is not optional.
 */
let lastNominatimCall = 0;
let gate = Promise.resolve();

/**
 * Serialise calls one second apart.
 *
 * Reading a shared timestamp and writing it later is a race: two concurrent
 * requests both see the same `lastNominatimCall`, both decide they can go, and
 * the policy is broken. Chaining onto a promise makes the spacing actually
 * hold, whatever arrives concurrently.
 */
function rateGate() {
  const mine = gate.then(async () => {
    const wait = 1100 - (Date.now() - lastNominatimCall);
    if (wait > 0) await sleep(wait);
    lastNominatimCall = Date.now();
  });
  gate = mine.catch(() => {});
  return mine;
}

/**
 * Typing "Kothrud" is seven keystrokes and the debounce does not collapse them
 * all. Without a cache every prefix costs a second of someone's attention and a
 * request against a service that is donated. Prefixes of a query that already
 * returned results are answered from memory.
 */
const geoCache = new Map();
const GEO_CACHE_MAX = 500;
const GEO_CACHE_TTL_MS = 30 * 60 * 1000;

function cacheGet(key) {
  const hit = geoCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > GEO_CACHE_TTL_MS) { geoCache.delete(key); return null; }
  // refresh recency
  geoCache.delete(key);
  geoCache.set(key, hit);
  return hit.value;
}

function cacheSet(key, value) {
  geoCache.set(key, { at: Date.now(), value });
  while (geoCache.size > GEO_CACHE_MAX) geoCache.delete(geoCache.keys().next().value);
}

async function nominatimSearch(query, limit, regionCode, signal) {
  await rateGate();

  const u = new URL(NOMINATIM);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', String(Math.min(limit, 15)));
  u.searchParams.set('addressdetails', '1');
  if (regionCode) u.searchParams.set('countrycodes', String(regionCode).toLowerCase());

  const res = await fetch(u, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: signal || AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error('Nominatim ' + res.status);

  const rows = await res.json();
  return rows
    .map((r) => {
      const a = r.address || {};
      const locality = a.suburb || a.neighbourhood || a.city_district || a.town || a.village || a.city;
      return {
        label: r.name || String(r.display_name).split(',')[0],
        address: r.display_name,
        locality: locality || null,
        region: a.state || a.state_district || null,
        countryCode: a.country_code ? a.country_code.toUpperCase() : null,
        lat: Number(r.lat),
        lng: Number(r.lon),
        kind: r.addresstype || r.type || null,
        source: 'openstreetmap',
      };
    })
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));
}

/** "18.5590, 73.8077" typed straight into the box. */
function parseCoordinates(query) {
  const m = String(query).trim().match(/^(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return [{
    label: lat.toFixed(4) + ', ' + lng.toFixed(4),
    address: 'Exact coordinates',
    lat, lng,
    countryCode: null,
    source: 'coordinates',
  }];
}

/**
 * Search for an area centre, anywhere on earth.
 *
 * Three tiers, best first: Places if a key is set, then Nominatim which is free
 * and complete, then a small offline list as a last resort so a geocoder outage
 * never blocks an operator from starting a sweep.
 */
export async function searchAreas(query, { limit = 8, regionCode, signal } = {}) {
  const coords = parseCoordinates(query);
  if (coords) return { results: coords, cost: 0, source: 'coordinates' };

  const cacheKey = String(query).trim().toLowerCase() + '|' + limit + '|' + (regionCode || '');
  const cached = cacheGet(cacheKey);
  if (cached) return { ...cached, cached: true };

  if (config.places.mock) {
    try {
      const results = await nominatimSearch(query, limit, regionCode, signal);
      if (results.length) {
        const payload = { results, cost: 0, source: 'openstreetmap' };
        cacheSet(cacheKey, payload);
        return payload;
      }
      return {
        results: offlineSearch(query, limit).map(toResult),
        cost: 0,
        source: 'offline',
        warning: 'OpenStreetMap found nothing for that. Try adding the city, or paste coordinates.',
      };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return {
        results: offlineSearch(query, limit).map(toResult),
        cost: 0,
        source: 'offline',
        warning: 'Area search is unavailable right now (' + e.message + '), showing offline matches.',
      };
    }
  }

  const body = {
    textQuery: query,
    pageSize: Math.min(limit, 20),
    languageCode: 'en',
  };
  if (regionCode) body.regionCode = regionCode;

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': config.places.apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location,places.addressComponents',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) throw new Error('geo ' + res.status);
    const json = await res.json();

    const results = (json.places || []).map((p) => {
      const comps = p.addressComponents || [];
      const country = comps.find((c) => (c.types || []).includes('country'));
      const admin = comps.find((c) => (c.types || []).includes('administrative_area_level_1'));
      return {
        label: p.displayName?.text || p.formattedAddress,
        address: p.formattedAddress,
        region: admin ? admin.longText : null,
        countryCode: country ? country.shortText : null,
        lat: p.location?.latitude ?? null,
        lng: p.location?.longitude ?? null,
        source: 'places',
      };
    }).filter((r) => r.lat !== null);

    return { results, cost: costPerCall('pro'), source: 'places' };
  } catch (e) {
    // Places failed - Nominatim is a better fallback than a hardcoded list.
    try {
      const results = await nominatimSearch(query, limit, regionCode, signal);
      if (results.length) {
        return { results, cost: 0, source: 'openstreetmap', warning: 'Places lookup failed, used OpenStreetMap instead.' };
      }
    } catch { /* fall through to offline */ }

    return {
      results: offlineSearch(query, limit).map(toResult),
      cost: 0,
      source: 'offline',
      warning: 'Live area search failed (' + e.message + '), showing offline matches.',
    };
  }
}

export { OFFLINE_PLACES };
