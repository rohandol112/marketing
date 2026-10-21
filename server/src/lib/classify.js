import { normalizeName, normalizeHost, nameSimilarity } from './util.js';

/**
 * Who is not a prospect, whatever they score, and what a business actually is.
 *
 * Both questions are deterministic and both sit before scoring, because no
 * weight can fix them afterwards. A Tanishq showroom with 4,000 reviews and no
 * Instagram of its own scores beautifully and will never sign: the store
 * manager has no budget, and the brand's marketing is bought in Mumbai by
 * people who do not take cold calls. A municipal school is not a buyer at all.
 * The last sweep put 87 chain outlets and 42 government bodies into the queue.
 */

/* ------------------------------------------------------------------ */
/* Platforms: hosts a business can be listed on but does not own      */
/* ------------------------------------------------------------------ */

const PLATFORMS = [
  ['facebook.com', 'social'], ['fb.com', 'social'], ['fb.me', 'social'], ['instagram.com', 'social'],
  ['instagr.am', 'social'], ['linkedin.com', 'social'], ['twitter.com', 'social'], ['x.com', 'social'],
  ['youtube.com', 'social'], ['youtu.be', 'social'], ['tiktok.com', 'social'], ['pinterest.com', 'social'],
  ['threads.net', 'social'], ['wa.me', 'social'], ['whatsapp.com', 'social'], ['t.me', 'social'],
  ['linktr.ee', 'social'], ['linktree.com', 'social'], ['bio.link', 'social'], ['beacons.ai', 'social'],
  ['justdial.com', 'directory'], ['indiamart.com', 'directory'], ['sulekha.com', 'directory'],
  ['practo.com', 'directory'], ['lybrate.com', 'directory'], ['credihealth.com', 'directory'],
  ['zomato.com', 'directory'], ['swiggy.com', 'directory'], ['magicpin.in', 'directory'],
  ['eazydiner.com', 'directory'], ['dineout.co.in', 'directory'], ['tripadvisor.com', 'directory'],
  ['tripadvisor.in', 'directory'], ['booking.com', 'directory'], ['makemytrip.com', 'directory'],
  ['goibibo.com', 'directory'], ['oyorooms.com', 'directory'], ['fabhotels.com', 'directory'],
  ['treebo.com', 'directory'], ['yelp.com', 'directory'], ['urbancompany.com', 'directory'],
  ['housing.com', 'directory'], ['99acres.com', 'directory'], ['magicbricks.com', 'directory'],
  ['nobroker.in', 'directory'], ['weddingwire.in', 'directory'], ['wedmegood.com', 'directory'],
  ['shaadisaga.com', 'directory'], ['amazon.in', 'directory'], ['amazon.com', 'directory'],
  ['flipkart.com', 'directory'], ['meesho.com', 'directory'],
  // Google Business Profile sites were switched off in 2024 and now bounce to Maps.
  ['business.site', 'google'], ['g.page', 'google'], ['business.google.com', 'google'],
  ['google.com', 'google'], ['google.co.in', 'google'], ['goo.gl', 'google'], ['maps.app.goo.gl', 'google'],
];

/** { host, kind, label } when a URL or host is a platform page, else null. */
export function platformOf(urlOrHost) {
  if (!urlOrHost) return null;
  const s = String(urlOrHost);
  const host = /[/:]/.test(s) ? normalizeHost(s) : s.toLowerCase().replace(/^www\./, '');
  if (!host) return null;
  for (const [h, kind] of PLATFORMS) {
    if (host === h || host.endsWith('.' + h)) {
      const label = kind === 'google'
        ? 'Google Business Profile'
        : h.split('.')[0].replace(/^./, (c) => c.toUpperCase());
      return { host: h, kind, label };
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Chains                                                             */
/* ------------------------------------------------------------------ */

/**
 * Chains and franchise networks whose marketing is bought centrally, in their
 * normalised form, each list scoped to the categories it belongs to.
 *
 * The scoping is what keeps this honest. Unscoped, "Aurelia Mansion" (a banquet
 * hall) was excluded as the clothing brand, "Oliva" (a restaurant) as the skin
 * clinic chain, and a "Kotak Dental Clinic" would go as the bank - Kotak is a
 * surname. A brand name only means the brand inside its own industry.
 *
 * Car brands are deliberately absent. A Kia showroom is a local dealer group
 * that runs its own local marketing, and is a perfectly good prospect.
 */
const HEALTH_CATS = [
  'cosmetic_surgery', 'hair_transplant', 'dental_implants', 'orthodontist', 'ivf_fertility', 'dermatology', 'med_spa',
  'diagnostic_centre', 'private_hospital', 'veterinary_hospital', 'dental_clinic', 'physiotherapy', 'chiropractor',
  'eye_clinic', 'polyclinic', 'pediatric_clinic', 'pet_grooming', 'pharmacy', 'nutritionist', 'optical_store',
];
const BEAUTY_CATS = ['salon', 'spa', 'nail_studio', 'med_spa', 'gym', 'yoga_studio', 'nutritionist', 'dermatology', 'tattoo_studio'];
const RETAIL_CATS = [
  'boutique', 'furniture_store', 'luxury_furniture', 'electronics_store', 'home_appliance', 'grocery', 'mobile_repair',
  'stationery', 'optical_store', 'jewellery_store', 'florist', 'pharmacy', 'modular_kitchen', 'interior_designer',
];
const FOOD_CATS = ['restaurant', 'cafe', 'bakery', 'cloud_kitchen', 'caterer'];
const HOTEL_CATS = ['hotel', 'resort', 'wedding_venue', 'banquet_hall', 'restaurant'];
const EDU_CATS = ['preschool', 'coaching_institute', 'private_school', 'college', 'driving_school'];
const FINANCE_CATS = ['wealth_management', 'law_firm'];

const CHAIN_GROUPS = [
  {
    cats: ['jewellery_store', 'boutique', 'optical_store', 'eye_clinic'],
    phrases: [
      'tanishq', 'mia by tanishq', 'kalyan jewellers', 'malabar gold', 'caratlane', 'bluestone', 'pc jeweller',
      'senco gold', 'joyalukkas', 'jos alukkas', 'tbz', 'tribhovandas bhimji zaveri', 'reliance jewels', 'candere',
      'giva', 'p n gadgil', 'pn gadgil', 'png jewellers', 'waman hari pethe', 'chandukaka saraf', 'grt jewellers',
      'lalithaa jewellery', 'bhima jewellers', 'kirtilal kalidas',
    ],
  },
  {
    cats: ['eye_clinic', 'optical_store', 'boutique', 'electronics_store'],
    phrases: ['lenskart', 'titan eye', 'titan eyeplus', 'titan world', 'specsmakers', 'gkb opticals', 'vision express', 'fastrack'],
  },
  {
    cats: RETAIL_CATS,
    phrases: [
      'croma', 'reliance digital', 'reliance trends', 'reliance smart', 'reliance fresh', 'reliance retail', 'jiomart',
      'vijay sales', 'poorvika', 'sangeetha mobiles', 'dmart', 'd mart', 'big bazaar', 'more supermarket', 'more megastore',
      'star bazaar', 'spencers', 'natures basket', 'lifestyle stores', 'pantaloons', 'westside', 'max fashion', 'zudio',
      'shoppers stop', 'fabindia', 'biba', 'w for woman', 'aurelia', 'global desi', 'raymond', 'peter england',
      'allen solly', 'van heusen', 'louis philippe', 'manyavar', 'bata', 'metro shoes', 'mochi', 'woodland',
      'decathlon', 'ikea', 'pepperfry', 'urban ladder', 'home centre', 'hometown', 'godrej interio', 'nilkamal',
      'damro', 'wakefit', 'durian', 'jio', 'airtel', 'vodafone', 'vi store', 'bsnl',
    ],
  },
  {
    cats: FOOD_CATS,
    phrases: [
      'mcdonalds', 'kfc', 'burger king', 'dominos', 'pizza hut', 'subway', 'starbucks', 'cafe coffee day', 'ccd',
      'barista', 'costa coffee', 'chaayos', 'chai point', 'third wave coffee', 'blue tokai', 'haldirams', 'bikanervala',
      'wow momo', 'faasos', 'behrouz biryani', 'box8', 'biryani by kilo', 'la pinoz', 'us pizza', 'papa johns',
      'taco bell', 'dunkin', 'krispy kreme', 'baskin robbins', 'keventers', 'theobroma', 'monginis', 'barbeque nation',
      'mainland china', 'sagar ratna', 'wendys',
    ],
  },
  {
    cats: HEALTH_CATS,
    phrases: [
      'apollo hospital', 'apollo hospitals', 'apollo clinic', 'apollo pharmacy', 'apollo diagnostics', 'apollo spectra',
      'apollo cradle', 'apollo sugar', 'fortis', 'manipal hospital', 'manipal hospitals', 'max hospital', 'max healthcare',
      'max super speciality', 'narayana health', 'aster cmi', 'aster rv', 'aster clinic', 'aster hospital', 'cloudnine',
      'motherhood hospital', 'rainbow childrens hospital', 'medanta', 'columbia asia', 'metropolis', 'dr lal pathlabs',
      'lal pathlabs', 'thyrocare', 'srl diagnostics', 'redcliffe labs', 'healthians', 'tata 1mg', '1mg', 'pharmeasy',
      'netmeds', 'medplus', 'wellness forever', 'guardian pharmacy', 'frank ross', 'clove dental', 'sabka dentist',
      'dr batras', 'vlcc', 'kaya skin', 'kaya clinic', 'oliva', 'kolors', 'nova ivf', 'nova ivi', 'indira ivf',
      'birla fertility', 'oasis fertility', 'milann', 'centre for sight', 'sharp sight', 'dr agarwals eye',
      'dr agarwal eye', 'vasan eye care', 'asg eye', 'advanced grohair', 'dhi india',
    ],
  },
  {
    cats: BEAUTY_CATS,
    phrases: [
      'lakme salon', 'naturals salon', 'naturals unisex', 'enrich salon', 'jawed habib', 'green trends', 'toni guy',
      'bodycraft', 'looks salon', 'geetanjali salon', 'golds gym', 'anytime fitness', 'cult fit', 'cultfit',
      'snap fitness', 'talwalkars', 'f45', 'fitness first', 'vlcc', 'kaya skin', 'kaya clinic', 'oliva', 'kolors',
    ],
  },
  {
    cats: EDU_CATS,
    phrases: [
      'kidzee', 'eurokids', 'euro kids', 'little millennium', 'firstcry intellitots', 'shemrock', 'bachpan',
      'podar jumbo kids', 'allen career', 'aakash institute', 'aakash byjus', 'fiitjee', 'byjus',
      'vidyamandir classes', 'career launcher', 'ims learning',
    ],
  },
  {
    cats: HOTEL_CATS,
    phrases: [
      'taj hotel', 'taj lands end', 'taj mahal palace', 'vivanta', 'ginger hotel', 'oyo', 'fabhotel', 'fabexpress',
      'treebo', 'marriott', 'courtyard by marriott', 'fairfield by marriott', 'four points', 'sheraton', 'westin',
      'hyatt', 'novotel', 'ibis', 'radisson', 'holiday inn', 'crowne plaza', 'itc grand', 'itc maratha', 'itc hotel',
      'welcomhotel', 'fortune hotel', 'fortune park', 'lemon tree', 'the leela', 'leela palace', 'oberoi', 'trident',
      'hilton', 'doubletree', 'conrad', 'sofitel', 'pullman', 'st regis', 'ritz carlton', 'citrus hotel', 'keys hotel',
      'sayaji', 'royal orchid', 'regenta', 'zostel', 'mercure', 'four seasons hotel', 'renaissance hotel', 'aloft',
      'le meridien', 'intercontinental', 'shangri la', 'mandarin oriental', 'the park hotel', 'accor',
    ],
  },
  {
    cats: FINANCE_CATS,
    phrases: [
      'state bank of india', 'sbi', 'hdfc', 'icici', 'axis bank', 'kotak', 'bank of baroda', 'punjab national bank',
      'canara bank', 'union bank', 'idbi', 'yes bank', 'indusind', 'bajaj finserv', 'bajaj finance', 'muthoot',
      'manappuram', 'life insurance corporation', 'lic of india',
    ],
  },
];

const phraseRegex = (phrases) => new RegExp(
  '(?:^| )(' + [...new Set(phrases.map((p) => normalizeName(p)).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') + ')(?: |$)'
);

const CHAIN_INDEX = CHAIN_GROUPS.map((g) => ({ cats: new Set(g.cats), re: phraseRegex(g.phrases) }));

/** "Blood bank" and "food bank" are not banks. */
const BANK_RE = /(?<!blood |food |eye |milk |power |sperm |cord |data |gene )\bbank\b/;

/** Categories where an OSM brand tag names what they sell, not who owns them. */
const BRAND_IS_PRODUCT = new Set(['car_dealer', 'car_service']);

/**
 * The chain a name belongs to, within its category. An unknown category is
 * checked against every list.
 */
export function chainMatch(name, category = null) {
  const norm = normalizeName(name);
  if (!norm) return null;
  for (const g of CHAIN_INDEX) {
    if (category && !g.cats.has(category)) continue;
    const m = norm.match(g.re);
    if (m) return m[1];
  }
  if (BANK_RE.test(norm)) return 'bank branch';
  return null;
}

/* ------------------------------------------------------------------ */
/* Government and public bodies                                       */
/* ------------------------------------------------------------------ */

const GOV_PATTERNS = [
  /\b(municipal|municipality|government|govt|zilla parishad|nagar palika|nagar nigam|mahanagar palika|panchayat|cantonment board|collectorate|tehsil)\b/,
  /\b(police|railway|army|military|naval|navy|air force|defence|defense|cghs|esic|esi|bsf|crpf|cisf|ordnance)\b.*\b(hospital|dispensary|school|college|clinic|health|polyclinic|vidyalaya|canteen)\b/,
  /\b(hospital|dispensary|school|college|clinic|polyclinic|vidyalaya)\b.*\b(police|railway|army|military|navy|air force|cghs|esic)\b/,
  /\b(bmc|pmc|pcmc|mcgm|ndmc|mcd|ghmc|bbmp|tmc|kdmc|nmmc)\b.*\b(school|hospital|dispensary|clinic|maternity|health)\b/,
  /\b(kendriya vidyalaya|navodaya vidyalaya|sainik school|army public school|air force school|navy children school|zp school|zp primary)\b/,
  /\b(primary health centre|community health centre|urban health centre|civil hospital|district hospital|sub district hospital|rural hospital|aiims|post office|tata memorial)\b/,
];

/** .gov.in, .nic.in, .gov, .gov.uk, .mil and the like. */
const GOV_HOST = /(^|\.)(gov|nic|mil|gouv|gob)(\.[a-z]{2})?$|(^|\.)gc\.ca$/;

export function governmentMatch(name) {
  const norm = normalizeName(name);
  if (!norm) return null;
  for (const re of GOV_PATTERNS) {
    const m = norm.match(re);
    if (m) return m[0];
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Placeholders                                                       */
/* ------------------------------------------------------------------ */

const PLACEHOLDER_NAMES = new Set([
  'xyz', 'abc', 'test', 'testing', 'unknown', 'unnamed', 'no name', 'na', 'n a', 'none', 'null', 'demo',
  'sample', 'shop', 'store', 'clinic', 'hospital', 'hotel', 'restaurant', 'cafe', 'salon', 'gym', 'school',
  'office', 'building', 'house', 'home', 'business', 'my business', 'your business',
]);

/* ------------------------------------------------------------------ */
/* Exclusion                                                          */
/* ------------------------------------------------------------------ */

export const EXCLUSION_KINDS = ['chain', 'government', 'non_commercial', 'junk', 'out_of_area', 'duplicate'];

export const EXCLUSION_LABELS = {
  chain: 'Chain or franchise outlet',
  government: 'Government or public body',
  non_commercial: 'Non-commercial organisation',
  junk: 'Not a real business listing',
  out_of_area: 'Outside the sweep area',
  duplicate: 'Duplicate of another lead',
  none: 'Cleared by a person',
};

/** Element tags stored at discovery, when there are any. */
function osmTagsOf(lead) {
  const src = lead.source_url && typeof lead.source_url === 'object' ? lead.source_url : {};
  return (src.osm && src.osm.tags) || {};
}

/**
 * Why this lead is not a prospect, or null.
 *
 * Every rule here can be wrong about a particular business, which is why the
 * result lands in its own column with a reason a person can read, and why a
 * person can clear it (exclusion = 'none') and never see it come back.
 *
 * @returns {{ kind: string, reason: string } | null}
 */
export function detectExclusion(lead, { tags } = {}) {
  const name = lead.name || '';
  const norm = normalizeName(name);
  const t = tags || osmTagsOf(lead);

  if (!norm || !/\p{L}/u.test(norm)) {
    return { kind: 'junk', reason: 'No usable business name' };
  }
  if (PLACEHOLDER_NAMES.has(norm)) {
    return { kind: 'junk', reason: '"' + name.trim() + '" is a placeholder, not a business name' };
  }

  const host = lead.website_host || normalizeHost(lead.website);
  if (host && GOV_HOST.test(host)) {
    return { kind: 'government', reason: 'Government website (' + host + ') - not a buyer' };
  }

  const opType = String(t['operator:type'] || '').toLowerCase();
  if (['government', 'public', 'military'].includes(opType) || t.government || t.office === 'government') {
    return { kind: 'government', reason: 'OpenStreetMap records this as run by the government - not a buyer' };
  }
  if (['religious', 'ngo', 'charitable', 'community'].includes(opType)) {
    return { kind: 'non_commercial', reason: 'OpenStreetMap records this as ' + opType + '-run - no marketing budget to sell into' };
  }

  const gov = governmentMatch(name);
  if (gov) return { kind: 'government', reason: 'Government or public body ("' + gov + '") - not a buyer' };

  const chain = chainMatch(name, lead.normalized_category || null);
  if (chain) {
    return {
      kind: 'chain',
      reason: chain === 'bank branch'
        ? 'Bank branch - marketing is bought at head office'
        : 'Chain outlet (' + chain + ') - marketing is bought centrally, a branch cannot sign',
    };
  }

  // OpenStreetMap's Name Suggestion Index tags chain outlets with their brand.
  // Only trust it when the outlet is named after the brand: a phone shop
  // tagged brand=Samsung is a reseller, not Samsung.
  if (!BRAND_IS_PRODUCT.has(lead.normalized_category)) {
    const brand = t.brand || null;
    if (brand && (nameSimilarity(brand, name) >= 0.6 || norm.includes(normalizeName(brand)))) {
      return { kind: 'chain', reason: 'OpenStreetMap tags this as a ' + brand + ' outlet - marketing is bought centrally' };
    }
    if (!brand && t['brand:wikidata']) {
      return { kind: 'chain', reason: 'OpenStreetMap tags this as an outlet of a registered brand' };
    }
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Category refinement                                                */
/* ------------------------------------------------------------------ */

/**
 * OpenStreetMap tags are broad. healthcare=clinic is every clinic in the city,
 * and it was mapped to cosmetic surgery, hair transplant, IVF and dermatology at
 * once - so whichever of those the sweep ran first claimed every GP's surgery
 * as a T1 cosmetic surgeon. 135 leads in the last export were "cosmetic
 * surgery". The same thing made every hotel a resort and every dentist an
 * implant studio.
 *
 * The name and the specialist tags decide instead. Each family returns its most
 * specific match, or the honest generic default.
 */
/**
 * Two categories are reachable from two families each: an eye clinic from the
 * healthcare tags and the optician tags, a med spa from healthcare and beauty.
 * One definition each, shared, or a lead re-sorted under one family gets
 * re-sorted back under the other on the next cleanup, forever.
 */
const EYE_CLINIC_RE = /\beye\b|netra|nethra|ophthal|lasik|retina|cataract|glaucoma|optometr/;
const MED_SPA_RE = /aesthetic|med ?spa|medispa|laser|slimming|botox|hydrafacial|anti ?ag(e)?ing|beauty clinic|cosmetolog/;
const OPTICAL_RETAIL_RE = /optic(al|ian)?s?\b|spectacle|specs|eyewear|lens|frames|chas?hma/;

const HEALTH_SPECIALITY = [
  [/fertility|reproductive|ivf/, 'ivf_fertility'],
  [/plastic|cosmetic_surgery/, 'cosmetic_surgery'],
  [/orthodontics/, 'orthodontist'],
  [/dentist|dental|oral/, 'dental_clinic'],
  [/ophthalmology|optometry/, 'eye_clinic'],
  [/radiology|pathology|laboratory|diagnostic/, 'diagnostic_centre'],
  [/dermatology|venereology/, 'dermatology'],
  [/paediatrics|pediatrics|neonatology/, 'pediatric_clinic'],
  [/physiotherapy|rehabilitation/, 'physiotherapy'],
  [/chiropractic/, 'chiropractor'],
  [/nutrition|dietetics/, 'nutritionist'],
];

const HEALTH_NAMES = [
  [/\bivf\b|fertility|test ?tube|reproductive|infertility|embryo|\biui\b|\bicsi\b/, 'ivf_fertility'],
  // Not "hair clinic": "Skin & Hair Clinic" is how half the dermatologists in
  // India name their practice.
  [/hair (transplant|restoration|fixing|replacement)|trichol|\bfue\b|baldness|hair ?loss/, 'hair_transplant'],
  [/plastic|cosmetic surg|aesthetic surg|rhinoplast|liposuc|body contour|gynecomastia|tummy tuck/, 'cosmetic_surgery'],
  [/orthodont|braces|aligner/, 'orthodontist'],
  [/implant|cosmetic dent|smile design|maxillofacial|dental (studio|spa|lounge|boutique)/, 'dental_implants'],
  // Before "hospital": a dental hospital is a dental practice.
  [/dental|dentist|teeth|tooth|\bsmile\b|endodont|periodont|\bbds\b|\bmds\b/, 'dental_clinic'],
  [/hospital|nursing home|maternity home|medical (centre|center|college|foundation)|multi ?speciality|super ?speciality/, 'private_hospital'],
  [EYE_CLINIC_RE, 'eye_clinic'],
  [/diagnost|imaging|\bscans?\b|\bmri\b|\bct\b|x ?ray|patholog|\blabs?\b|laborator|sonograph|radiolog|ultrasound|blood (test|collection)/, 'diagnostic_centre'],
  [/derma|\bskin\b|vitiligo|psoriasis|acne/, 'dermatology'],
  [MED_SPA_RE, 'med_spa'],
  [/child|children|paediatric|pediatric|\bkids\b|neonat|infant|\bbaby\b|bal rugnalay/, 'pediatric_clinic'],
  [/physio|rehab|sports injur/, 'physiotherapy'],
  [/chiropract/, 'chiropractor'],
  [/dietit|dietic|nutrition|weight loss/, 'nutritionist'],
];

function pickHealth(text, tags) {
  const spec = String(tags['healthcare:speciality'] || '').toLowerCase();
  if (spec) for (const [re, id] of HEALTH_SPECIALITY) if (re.test(spec)) return id;
  for (const [re, id] of HEALTH_NAMES) if (re.test(text)) return id;
  if (tags.amenity === 'hospital' || tags.healthcare === 'hospital') return 'private_hospital';
  if (tags.amenity === 'dentist' || tags.healthcare === 'dentist') return 'dental_clinic';
  if (tags.healthcare === 'laboratory') return 'diagnostic_centre';
  if (tags.healthcare === 'optometrist') return 'eye_clinic';
  if (tags.healthcare === 'physiotherapist') return 'physiotherapy';
  if (tags.healthcare === 'chiropractor') return 'chiropractor';
  if (tags.healthcare === 'nutrition_counselling') return 'nutritionist';
  return 'polyclinic';
}

function pickLodging(text, tags) {
  if (tags.tourism === 'resort') return 'resort';
  return /resort|retreat|farm ?(house|stay)|homestay|jungle|camp|valley|lake ?(view|side)|villa/.test(text) ? 'resort' : 'hotel';
}

function pickVenue(text, tags) {
  if (/lawn|wedding|marriage|mangal|karyalay|kalyan ?mandap|vivah|shaadi|shadi|garden/.test(text)) return 'wedding_venue';
  if (/banquet|\bhall\b|party|convention|conference|celebration|\bevents?\b|club ?house/.test(text)) return 'banquet_hall';
  // A community centre with no wedding or party words is usually a civic hall.
  return tags.amenity === 'community_centre' ? null : 'banquet_hall';
}

function pickProperty(text) {
  return /developers?|builders?|constructions?|\binfra|realty|promoters|projects|lifespaces|buildcon|buildtech|buildwell/.test(text)
    ? 'real_estate_developer'
    : 'real_estate_agent';
}

function pickFurniture(text) {
  return /luxury|premium|designer|italian|imported|decor|interiors?|studio|gallery|collection|boutique|lounge|atelier|living/.test(text)
    ? 'luxury_furniture'
    : 'furniture_store';
}

function pickBeauty(text, tags) {
  if (MED_SPA_RE.test(text) || /skin (clinic|care cent)|derma/.test(text)) return 'med_spa';
  if (/nails?\b|lash|brow|extensions?/.test(text) || /nails/.test(String(tags.beauty || ''))) return 'nail_studio';
  if (/salon|hair|unisex|parlou?r|barber|beauty/.test(text) || tags.shop === 'hairdresser') return 'salon';
  if (tags.leisure === 'spa' || tags.shop === 'massage' || /\bspa\b|massage|thai|ayurved/.test(text)) return 'spa';
  return 'salon';
}

function pickFitness(text) {
  return /yoga|pilates|zumba|dance|meditation/.test(text) ? 'yoga_studio' : 'gym';
}

function pickOptical(text) {
  // "Shree Opticals" sells frames; "Shree Eye Centre" treats eyes. A shop that
  // says both is still a shop unless a doctor or a procedure is named.
  const clinical = /hospital|clinic|ophthal|lasik|retina|cataract|glaucoma|\bdr\b/.test(text);
  if (OPTICAL_RETAIL_RE.test(text) && !clinical) return 'optical_store';
  return EYE_CLINIC_RE.test(text) || clinical ? 'eye_clinic' : 'optical_store';
}

function pickCleaning(text, tags) {
  return tags.craft === 'cleaning' || /clean(ing)? (service|solution)|housekeeping|facility|deep clean|sanitiz/.test(text)
    ? 'cleaning_service'
    : 'laundry';
}

const FAMILIES = {
  health: pickHealth,
  lodging: pickLodging,
  venue: pickVenue,
  property: pickProperty,
  furniture: pickFurniture,
  beauty: pickBeauty,
  fitness: pickFitness,
  optical: pickOptical,
  cleaning: pickCleaning,
};

/** Which family a category's leads were swept under, when no element tags survive. */
const FAMILY_OF_CATEGORY = {
  ivf_fertility: 'health', hair_transplant: 'health', cosmetic_surgery: 'health', orthodontist: 'health',
  dental_implants: 'health', dental_clinic: 'health', diagnostic_centre: 'health', dermatology: 'health',
  pediatric_clinic: 'health', physiotherapy: 'health', polyclinic: 'health', chiropractor: 'health',
  nutritionist: 'health', private_hospital: 'health',
  resort: 'lodging', hotel: 'lodging',
  wedding_venue: 'venue', banquet_hall: 'venue',
  real_estate_developer: 'property', real_estate_agent: 'property',
  luxury_furniture: 'furniture', furniture_store: 'furniture',
  med_spa: 'beauty', nail_studio: 'beauty', salon: 'beauty', spa: 'beauty',
  gym: 'fitness', yoga_studio: 'fitness',
  eye_clinic: 'optical', optical_store: 'optical',
  laundry: 'cleaning', cleaning_service: 'cleaning',
};

export function familyForTags(tags = {}) {
  if (tags.shop === 'optician' || tags.healthcare === 'optometrist') return 'optical';
  if (tags.healthcare || ['clinic', 'doctors', 'hospital', 'dentist'].includes(tags.amenity)) return 'health';
  if (['beauty', 'hairdresser', 'massage'].includes(tags.shop) || tags.leisure === 'spa') return 'beauty';
  if (['hotel', 'resort', 'guest_house'].includes(tags.tourism)) return 'lodging';
  if (tags.amenity === 'events_venue' || tags.amenity === 'community_centre') return 'venue';
  if (tags.office === 'estate_agent' || tags.office === 'property_management') return 'property';
  if (tags.shop === 'furniture') return 'furniture';
  if (tags.leisure === 'fitness_centre' || tags.shop === 'yoga') return 'fitness';
  if (['dry_cleaning', 'laundry'].includes(tags.shop) || tags.craft === 'cleaning') return 'cleaning';
  return null;
}

/** ['healthcare=clinic', 'amenity=clinic'] -> { healthcare: 'clinic', amenity: 'clinic' } */
export function tagListToObject(list) {
  const out = {};
  for (const kv of Array.isArray(list) ? list : []) {
    const [k, v] = String(kv).split('=');
    if (k && v && !(k in out)) out[k] = v;
  }
  return out;
}

/**
 * The category this business belongs in.
 *
 * @param currentId  the category it was swept under
 * @param opts.name  the business name
 * @param opts.tags  OSM element tags, when known
 * @param opts.hint  extra text, e.g. Google's own category from a Maps lookup
 * @returns a category id, the current one when nothing better is known, or
 *          null when it does not belong in this family at all
 */
export function refineCategory(currentId, { name = '', tags = {}, hint = '' } = {}) {
  const family = familyForTags(tags) || FAMILY_OF_CATEGORY[currentId] || null;
  if (!family) return currentId;
  const text = (normalizeName(name) + ' ' + normalizeName(hint)).trim();
  return FAMILIES[family](text, tags || {});
}
