import config from '../config.js';
import { CATEGORY_BY_ID } from './categories.js';
import { refineCategory } from './classify.js';
import { haversineMeters, normalizeHost, normalizeUrl, normalizeName, cleanEmail, cleanInstagramHandle, firstPhone, sleep } from './util.js';

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
 * they drive the whole DEMAND score. So an OSM lead still needs a review count
 * before it can qualify - the Maps lookup after each sweep fills it in, and the
 * verification queue covers whatever that cannot.
 *
 * Free, no key, no quota beyond fair use. Be a good citizen: a real User-Agent,
 * a sane timeout, and no hammering.
 */

const DEFAULT_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const UA = 'TanzLeadOS/0.2 (local business lead research)';

/**
 * Our categories mapped onto OSM tags. Kept here rather than in categories.js
 * so OSM's tagging conventions stay an OSM problem.
 *
 * Multiple tags per category are OR-ed. Several categories share a tag -
 * healthcare=clinic is every clinic in the city - so each element is sorted
 * into the right one by refineCategory() before it is kept.
 */
const OSM_TAGS = {
  wedding_venue: ['amenity=events_venue', 'amenity=community_centre'],
  banquet_hall: ['amenity=events_venue'],
  destination_wedding_planner: ['shop=wedding', 'office=event_management'],
  resort: ['tourism=resort', 'tourism=hotel'],

  real_estate_developer: ['office=estate_agent', 'office=property_management'],
  real_estate_agent: ['office=estate_agent'],
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

  salon: ['shop=hairdresser', 'shop=beauty'],
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
  exam_coaching: ['amenity=training', 'office=educational_institution'],
  media_house: ['office=newspaper', 'amenity=studio'],
  news_agency: ['office=newspaper', 'office=news_agency'],
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

/**
 * The element tags worth keeping: what identifies a chain or a government body,
 * what proves the listing is current, and the specialist detail that decides
 * the category.
 */
const KEEP_TAGS = [
  'brand', 'brand:wikidata', 'operator', 'operator:type', 'government', 'religion',
  'amenity', 'shop', 'office', 'craft', 'tourism', 'leisure', 'healthcare', 'healthcare:speciality', 'beauty',
  'opening_hours', 'check_date', 'survey:date', 'start_date', 'website', 'contact:instagram', 'contact:facebook',
];

export function osmTagsFor(categoryId) {
  return OSM_TAGS[categoryId] || null;
}

export function coverageReport() {
  const all = [...CATEGORY_BY_ID.keys()];
  const mapped = all.filter((id) => OSM_TAGS[id]);
  return { total: all.length, mapped: mapped.length, unmapped: all.filter((id) => !OSM_TAGS[id]) };
}

function buildQuery(tags, center, radiusM, timeoutS = 90) {
  const clauses = tags
    .map((t) => {
      const [k, v] = t.split('=');
      return '  nwr["' + k + '"="' + v + '"](around:' + Math.round(radiusM) + ',' +
        center.lat.toFixed(6) + ',' + center.lng.toFixed(6) + ');';
    })
    .join('\n');
  return '[out:json][timeout:' + timeoutS + '];\n(\n' + clauses + '\n);\nout center tags;';
}

function endpoints() {
  return config.overpassUrls.length ? config.overpassUrls : DEFAULT_ENDPOINTS;
}

/**
 * Overpass sheds load three different ways: a 429 or 504, a connection that
 * hangs past the timeout, and a 200 whose `remark` says the query timed out
 * with nothing in it. All three are worth a retry against the next mirror - the
 * old code only retried the first, so the other two silently dropped whole
 * categories from a sweep.
 */
async function overpass(query, attempt = 0) {
  const list = endpoints();
  const url = list[attempt % list.length];
  const retry = async (why) => {
    if (attempt >= Math.max(2, list.length)) {
      const err = new Error('Overpass unavailable after ' + (attempt + 1) + ' attempts: ' + why);
      err.status = 503;
      throw err;
    }
    await sleep(1500 * (attempt + 1));
    return overpass(query, attempt + 1);
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
        Accept: 'application/json',
      },
      body: 'data=' + encodeURIComponent(query),
      signal: AbortSignal.timeout(100000),
    });
  } catch (e) {
    return retry(e.name === 'TimeoutError' ? 'timeout' : e.cause?.code || e.message);
  }

  if (res.status === 429 || res.status === 504 || res.status === 502 || res.status === 503) {
    return retry('HTTP ' + res.status);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error('Overpass ' + res.status + ': ' + body.slice(0, 200));
    err.status = res.status;
    throw err;
  }
  const json = await res.json();
  if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark) && !(json.elements || []).length) {
    return retry(json.remark.slice(0, 120));
  }
  return json;
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

function keptTags(t) {
  const out = {};
  for (const k of KEEP_TAGS) if (t[k] !== undefined) out[k] = String(t[k]).slice(0, 200);
  return out;
}

/**
 * One category, one area.
 *
 * @param allowed  the run's category ids. An element that turns out to belong
 *                 to a category nobody asked for is skipped, not mislabelled.
 * @returns {{leads: Array, calls: number, warnings: string[], skipped: number}}
 */
export async function discoverCategory({ categoryId, center, radiusM, regionCode, areaLabel, allowed }) {
  const cat = CATEGORY_BY_ID.get(categoryId);
  if (!cat) throw new Error('Unknown category: ' + categoryId);

  const tags = osmTagsFor(categoryId);
  if (!tags) {
    return {
      leads: [],
      calls: 0,
      skipped: 0,
      warnings: ['No OpenStreetMap tag mapping for "' + cat.label + '" - skipped. Add one in lib/osm.js.'],
    };
  }

  const json = await overpass(buildQuery(tags, center, radiusM));
  const warnings = [];
  const leads = [];
  const seen = new Set();
  const keep = allowed instanceof Set ? allowed : new Set(allowed || [categoryId]);
  let skipped = 0;

  for (const el of json.elements || []) {
    const t = el.tags || {};
    // An unnamed node is a map feature, not a business we can sell to.
    if (!t.name) continue;

    const lat = el.lat ?? el.center?.lat ?? null;
    const lng = el.lon ?? el.center?.lon ?? null;

    // The same business is often both a node and a building outline. Two
    // branches with one name are not, so the key includes where it is.
    const key = normalizeName(t.name) + '|' + (lat != null ? lat.toFixed(3) + ',' + lng.toFixed(3) : el.type + el.id);
    if (seen.has(key)) continue;
    seen.add(key);

    // Overpass `around` is generous at the edges; keep the circle honest.
    const dist = lat != null ? Math.round(haversineMeters(center, { lat, lng })) : null;
    if (dist != null && dist > radiusM) continue;

    const refined = refineCategory(categoryId, { name: t.name, tags: t });
    if (!refined || !keep.has(refined)) {
      skipped++;
      continue;
    }
    const refinedCat = CATEGORY_BY_ID.get(refined) || cat;

    const phone = firstPhone(t.phone || t['contact:phone'] || t['contact:mobile'] || null);
    const website = normalizeUrl(t.website || t['contact:website'] || t.url || null);
    const ig = cleanInstagramHandle(t['contact:instagram'] || t.instagram || null);
    const osmUrl = 'https://www.openstreetmap.org/' + el.type + '/' + el.id;
    const elementTags = keptTags(t);

    leads.push({
      google_place_id: null,
      external_id: el.type + '/' + el.id,
      external_source: 'openstreetmap',
      name: t.name.trim(),
      category: refinedCat.label,
      normalized_category: refinedCat.id,
      address: addressFrom(t),
      locality: t['addr:suburb'] || t['addr:city'] || areaLabel || null,
      region: t['addr:state'] || null,
      country_code: t['addr:country'] || regionCode || null,
      postal_code: t['addr:postcode'] || null,
      lat,
      lng,
      distance_m: dist,

      phone,
      email: cleanEmail(t.email || t['contact:email'] || null),
      website,
      website_host: normalizeHost(website),
      maps_url: osmUrl,

      // OSM has no ratings. Left null on purpose: a fabricated review count
      // would corrupt every ranking, and unknown correctly scores zero.
      rating: null,
      review_count: null,
      business_status: null,
      // Only ~8% of OSM entries carry a website tag. Absence of a tag is not
      // absence of a website, and asserting 'none' here handed 12 free points
      // to 1,600 businesses that mostly do have sites.
      website_status: website ? null : 'unknown',
      ig_handle: ig,

      source_url: {
        provider: 'openstreetmap',
        osm: {
          url: osmUrl,
          tags: elementTags,
          checkDate: t.check_date || t['survey:date'] || null,
        },
        osmTags: tags,
        sweptAs: categoryId,
        licence: 'ODbL - attribution required if you publish this data',
        discoveredAt: new Date().toISOString(),
      },
    });
  }

  if (!leads.length && !skipped) {
    warnings.push(
      'OpenStreetMap has nothing tagged as ' + tags.join(' or ') + ' within ' +
      Math.round(radiusM / 1000) + 'km of ' + (areaLabel || 'this area') + '. Coverage varies a lot by city.'
    );
  }

  return { leads, calls: 1, warnings, skipped };
}
