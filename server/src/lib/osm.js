import config from '../config.js';
import { CATEGORY_BY_ID } from './categories.js';
import { haversineMeters, normalizePhone, normalizeHost, sleep } from './util.js';

/**
 * OpenStreetMap discovery, via the Overpass API.
 *
 * This is the default source when there is no Places API key, and it is a
 * genuinely different kind of thing from model recall: every result is a
 * business some human actually surveyed and put on a map, with real
 * coordinates. It cannot hallucinate a business, because it is a database
 * query, not a generation.
 *
 * What it gives you: name, coordinates, address, and - where a mapper bothered -
 * phone, website, opening hours. Roughly a fifth of entries carry a phone.
 *
 * What it does not give you: ratings and review counts. Those are Google's, and
 * they drive the whole DEMAND score. So an OSM lead still needs a human to fill
 * in the review count before it can qualify, which is exactly what the
 * verification queue is for.
 *
 * Free, no key, no quota beyond fair use. Be a good citizen: a real User-Agent,
 * a sane timeout, and no hammering.
 */

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const UA = 'TanzLeadOS/0.1 (local business lead research)';

/**
 * Our categories mapped onto OSM tags. Kept here rather than in categories.js
 * so OSM's tagging conventions stay an OSM problem.
 *
 * Multiple tags per category are OR-ed. Tag choices follow the OSM wiki's
 * common usage, which is not always the most logical option available.
 */
const OSM_TAGS = {
  wedding_venue: ['amenity=events_venue', 'amenity=community_centre'],
  banquet_hall: ['amenity=events_venue'],
  destination_wedding_planner: ['shop=wedding', 'office=event_management'],
  resort: ['tourism=resort', 'tourism=hotel'],

  real_estate_developer: ['office=estate_agent', 'office=property_management'],
  interior_designer: ['shop=interior_decoration', 'office=interior_design'],
  modular_kitchen: ['shop=kitchen'],
  architecture_firm: ['office=architect'],
  luxury_furniture: ['shop=furniture'],
  solar_installer: ['shop=solar', 'craft=solar'],

  cosmetic_surgery: ['healthcare=clinic', 'amenity=clinic'],
  hair_transplant: ['healthcare=clinic'],
  dental_implants: ['amenity=dentist', 'healthcare=dentist'],
  orthodontist: ['amenity=dentist', 'healthcare=dentist'],
  ivf_fertility: ['healthcare=clinic'],
  dermatology: ['healthcare=clinic'],
  med_spa: ['shop=beauty'],
  diagnostic_centre: ['healthcare=laboratory', 'amenity=clinic'],
  private_hospital: ['amenity=hospital'],
  veterinary_hospital: ['amenity=veterinary'],

  jewellery_store: ['shop=jewelry'],
  car_dealer: ['shop=car'],
  law_firm: ['office=lawyer'],
  wealth_management: ['office=financial', 'office=financial_advisor'],
  private_school: ['amenity=school'],
  college: ['amenity=college', 'amenity=university'],

  salon: ['shop=hairdresser'],
  spa: ['leisure=spa', 'shop=massage'],
  nail_studio: ['shop=beauty'],
  tattoo_studio: ['shop=tattoo'],
  gym: ['leisure=fitness_centre'],
  yoga_studio: ['leisure=fitness_centre', 'shop=yoga'],
  nutritionist: ['healthcare=nutrition_counselling'],

  dental_clinic: ['amenity=dentist', 'healthcare=dentist'],
  physiotherapy: ['healthcare=physiotherapist'],
  chiropractor: ['healthcare=chiropractor'],
  eye_clinic: ['shop=optician', 'healthcare=optometrist'],
  polyclinic: ['amenity=clinic', 'amenity=doctors'],
  pediatric_clinic: ['healthcare=centre', 'amenity=doctors'],
  pet_grooming: ['shop=pet_grooming', 'shop=pet'],

  hotel: ['tourism=hotel', 'tourism=guest_house'],
  event_planner: ['office=event_management'],
  caterer: ['shop=caterer', 'craft=caterer'],
  photography_studio: ['shop=photo', 'craft=photographer'],

  packers_movers: ['office=moving_company', 'shop=moving_company'],
  travel_agency: ['shop=travel_agency'],
  driving_school: ['amenity=driving_school'],
  coaching_institute: ['amenity=training', 'office=educational_institution'],
  preschool: ['amenity=kindergarten'],
  car_service: ['shop=car_repair'],
  pest_control: ['craft=pest_control'],
  cleaning_service: ['craft=cleaning', 'shop=dry_cleaning'],
  hvac: ['craft=hvac'],
  plumber_electrician: ['craft=plumber', 'craft=electrician'],
  landscaping: ['craft=gardener', 'shop=garden_centre'],
  roofing: ['craft=roofer'],

  furniture_store: ['shop=furniture'],
  boutique: ['shop=clothes', 'shop=boutique'],
  electronics_store: ['shop=electronics'],
  home_appliance: ['shop=appliance', 'shop=houseware'],
  optical_store: ['shop=optician'],

  restaurant: ['amenity=restaurant'],
  cafe: ['amenity=cafe'],
  bakery: ['shop=bakery'],
  cloud_kitchen: ['amenity=fast_food'],
  pharmacy: ['amenity=pharmacy', 'shop=chemist'],
  grocery: ['shop=supermarket', 'shop=convenience'],
  mobile_repair: ['shop=mobile_phone'],
  laundry: ['shop=laundry', 'shop=dry_cleaning'],
  stationery: ['shop=stationery', 'shop=books'],
  florist: ['shop=florist'],
};

export function osmTagsFor(categoryId) {
  return OSM_TAGS[categoryId] || null;
}

export function coverageReport() {
  const all = [...CATEGORY_BY_ID.keys()];
  const mapped = all.filter((id) => OSM_TAGS[id]);
  return { total: all.length, mapped: mapped.length, unmapped: all.filter((id) => !OSM_TAGS[id]) };
}

function buildQuery(tags, center, radiusM, timeoutS = 45) {
  const clauses = tags
    .map((t) => {
      const [k, v] = t.split('=');
      return '  nwr["' + k + '"="' + v + '"](around:' + Math.round(radiusM) + ',' +
        center.lat.toFixed(6) + ',' + center.lng.toFixed(6) + ');';
    })
    .join('\n');
  return '[out:json][timeout:' + timeoutS + '];\n(\n' + clauses + '\n);\nout center tags;';
}

async function overpass(query, attempt = 0) {
  const url = ENDPOINTS[attempt % ENDPOINTS.length];
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      Accept: 'application/json',
    },
    body: 'data=' + encodeURIComponent(query),
    signal: AbortSignal.timeout(60000),
  });

  // Overpass sheds load with 429 and 504 under contention. Both are worth one
  // retry against the mirror before giving up on the category.
  if ((res.status === 429 || res.status === 504) && attempt < 2) {
    await sleep(2000 * (attempt + 1));
    return overpass(query, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error('Overpass ' + res.status + ': ' + body.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function addressFrom(t) {
  const parts = [
    [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '),
    t['addr:suburb'] || t['addr:neighbourhood'],
    t['addr:city'],
    t['addr:postcode'],
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

function socialFrom(t) {
  const out = {};
  const ig = t['contact:instagram'] || t.instagram;
  if (ig) {
    const m = String(ig).match(/instagram\.com\/([A-Za-z0-9._]+)/);
    out.ig_handle = (m ? m[1] : String(ig)).replace(/^@/, '').replace(/\/$/, '');
  }
  return out;
}

/**
 * One category, one area.
 * @returns {{leads: Array, calls: number, warnings: string[]}}
 */
export async function discoverCategory({ categoryId, center, radiusM, regionCode, areaLabel }) {
  const cat = CATEGORY_BY_ID.get(categoryId);
  if (!cat) throw new Error('Unknown category: ' + categoryId);

  const tags = osmTagsFor(categoryId);
  if (!tags) {
    return {
      leads: [],
      calls: 0,
      warnings: ['No OpenStreetMap tag mapping for "' + cat.label + '" - skipped. Add one in lib/osm.js.'],
    };
  }

  const json = await overpass(buildQuery(tags, center, radiusM));
  const warnings = [];
  const leads = [];
  const seen = new Set();

  for (const el of json.elements || []) {
    const t = el.tags || {};
    // An unnamed node is a map feature, not a business we can sell to.
    if (!t.name) continue;

    const key = t.name.toLowerCase().trim();
    if (seen.has(key)) continue;
    seen.add(key);

    const lat = el.lat ?? el.center?.lat ?? null;
    const lng = el.lon ?? el.center?.lon ?? null;

    // Overpass `around` is generous at the edges; keep the circle honest.
    const dist = lat != null ? Math.round(haversineMeters(center, { lat, lng })) : null;
    if (dist != null && dist > radiusM) continue;

    const phoneRaw = t.phone || t['contact:phone'] || t['contact:mobile'] || null;
    // Mappers often cram several numbers into one tag.
    const phone = phoneRaw ? String(phoneRaw).split(/[;,/]/)[0].trim() : null;
    const website = t.website || t['contact:website'] || null;
    const brand = t.brand || t.operator || null;

    leads.push({
      google_place_id: null,
      external_id: el.type + '/' + el.id,
      external_source: 'openstreetmap',
      name: t.name.trim(),
      category: cat.label,
      normalized_category: cat.id,
      address: addressFrom(t),
      locality: t['addr:suburb'] || t['addr:city'] || areaLabel || null,
      region: t['addr:state'] || null,
      country_code: t['addr:country'] || regionCode || null,
      postal_code: t['addr:postcode'] || null,
      lat,
      lng,
      distance_m: dist,

      phone,
      phone_normalized: normalizePhone(phone),
      email: t.email || t['contact:email'] || null,
      website,
      website_host: normalizeHost(website),
      maps_url: 'https://www.openstreetmap.org/' + el.type + '/' + el.id,

      // OSM has no ratings. Left null on purpose: a fabricated review count
      // would corrupt every ranking, and unknown correctly scores zero.
      rating: null,
      review_count: null,
      business_status: null,
      // Only ~8% of OSM entries carry a website tag. Absence of a tag is not
      // absence of a website, and asserting 'none' here handed 12 free points
      // to 1,600 businesses that mostly do have sites.
      website_status: website ? null : 'unknown',
      ...socialFrom(t),

      source_url: {
        provider: 'openstreetmap',
        osm: 'https://www.openstreetmap.org/' + el.type + '/' + el.id,
        osmTags: tags,
        brand: brand || undefined,
        licence: 'ODbL - attribution required if you publish this data',
        discoveredAt: new Date().toISOString(),
      },
    });
  }

  if (!leads.length) {
    warnings.push(
      'OpenStreetMap has nothing tagged as ' + tags.join(' or ') + ' within ' +
      Math.round(radiusM / 1000) + 'km of ' + (areaLabel || 'this area') + '. Coverage varies a lot by city.'
    );
  }

  return { leads, calls: 1, warnings };
}
