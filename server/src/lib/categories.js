/**
 * Global category catalogue.
 *
 * `tier` is the AFFORDABILITY tier - how much lifetime value a business in this
 * category is worth to a full-service agency. It is deliberately not a guess
 * about how nice the business is.
 *
 *   T1 - high ticket, long sales cycle, big retainers
 *   T2 - mid ticket, recurring social/creative work
 *   T3 - low ticket, one-off website or a small social package
 *
 * `q` is the text query sent to Places Text Search. `type` maps to the Places
 * `includedType` filter where a good one exists (it narrows results hard, so it
 * is left null when the official type is broader than what we actually want).
 *
 * `appPitch` marks the categories where "they have no app of their own" is a
 * sale in itself - students and parents who get fees, results and notices over
 * WhatsApp groups, readers who get the news from someone else's app. Those
 * leads are checked for an app (services/appCheck.js). `appGap` names the gap
 * tag a missing app raises, so a news house is priced the newsroom product and
 * a school the institute app.
 */

export const CATEGORIES = [
  // ---------- T1: weddings + events ----------
  { id: 'wedding_venue', label: 'Wedding venue', group: 'Events', tier: 'T1', q: 'wedding venue', type: 'wedding_venue', season: [10, 11, 0, 1] },
  { id: 'banquet_hall', label: 'Banquet hall', group: 'Events', tier: 'T1', q: 'banquet hall', type: 'banquet_hall', season: [10, 11, 0, 1] },
  { id: 'destination_wedding_planner', label: 'Wedding planner', group: 'Events', tier: 'T1', q: 'wedding planner', type: null, season: [9, 10, 11, 0] },
  { id: 'resort', label: 'Resort', group: 'Hospitality', tier: 'T1', q: 'resort', type: 'resort_hotel', season: [10, 11, 2, 3] },

  // ---------- T1: property + build ----------
  { id: 'real_estate_developer', label: 'Real estate developer', group: 'Property', tier: 'T1', q: 'real estate developer builder', type: null },
  { id: 'interior_designer', label: 'Interior designer', group: 'Property', tier: 'T1', q: 'interior designer', type: null },
  { id: 'modular_kitchen', label: 'Modular kitchen studio', group: 'Property', tier: 'T1', q: 'modular kitchen showroom', type: null },
  { id: 'architecture_firm', label: 'Architecture firm', group: 'Property', tier: 'T1', q: 'architect office', type: null },
  { id: 'luxury_furniture', label: 'Luxury furniture showroom', group: 'Property', tier: 'T1', q: 'luxury furniture showroom', type: 'furniture_store' },
  { id: 'solar_installer', label: 'Solar installer', group: 'Property', tier: 'T1', q: 'solar panel installation company', type: null },

  // ---------- T1: high-ticket healthcare ----------
  { id: 'cosmetic_surgery', label: 'Cosmetic / plastic surgery', group: 'Healthcare', tier: 'T1', q: 'plastic surgery clinic', type: null },
  { id: 'hair_transplant', label: 'Hair transplant clinic', group: 'Healthcare', tier: 'T1', q: 'hair transplant clinic', type: null },
  { id: 'dental_implants', label: 'Dental implant / cosmetic dentistry', group: 'Healthcare', tier: 'T1', q: 'dental implant cosmetic dentistry', type: 'dentist' },
  { id: 'orthodontist', label: 'Orthodontist', group: 'Healthcare', tier: 'T1', q: 'orthodontist braces clinic', type: null },
  { id: 'ivf_fertility', label: 'IVF / fertility clinic', group: 'Healthcare', tier: 'T1', q: 'IVF fertility centre', type: null },
  { id: 'dermatology', label: 'Dermatology / skin clinic', group: 'Healthcare', tier: 'T1', q: 'skin clinic dermatologist', type: null },
  { id: 'med_spa', label: 'Med spa / aesthetics', group: 'Healthcare', tier: 'T1', q: 'medical aesthetics clinic', type: null },
  { id: 'diagnostic_centre', label: 'Diagnostic / imaging centre', group: 'Healthcare', tier: 'T1', q: 'diagnostic imaging centre', type: null },
  { id: 'private_hospital', label: 'Private hospital', group: 'Healthcare', tier: 'T1', q: 'private multispeciality hospital', type: 'hospital' },
  { id: 'veterinary_hospital', label: 'Veterinary hospital', group: 'Healthcare', tier: 'T1', q: 'veterinary hospital', type: 'veterinary_care' },

  // ---------- T1: professional + retail ----------
  { id: 'jewellery_store', label: 'Jewellery store', group: 'Retail', tier: 'T1', q: 'jewellery showroom', type: 'jewelry_store', season: [9, 10, 11] },
  { id: 'car_dealer', label: 'Car dealership', group: 'Automotive', tier: 'T1', q: 'car dealership showroom', type: 'car_dealer' },
  // Tanz built a news app and newsroom admin for a news channel. The same
  // product sells to the next channel, paper or portal without an app.
  { id: 'media_house', label: 'Media house / news channel', group: 'Media', tier: 'T1', q: 'news channel newspaper media house', type: null, appPitch: true, appGap: 'no_news_app' },
  { id: 'law_firm', label: 'Law firm', group: 'Professional', tier: 'T1', q: 'law firm advocates', type: 'lawyer' },
  { id: 'wealth_management', label: 'Wealth management / financial advisor', group: 'Professional', tier: 'T1', q: 'financial advisor wealth management', type: null },
  { id: 'private_school', label: 'Private school', group: 'Education', tier: 'T1', q: 'private school', type: 'school', season: [2, 3, 4], appPitch: true },
  { id: 'college', label: 'College / institute', group: 'Education', tier: 'T1', q: 'college institute', type: null, season: [4, 5, 6], appPitch: true },
  // JEE, NEET, UPSC, MPSC, CA and bank-exam coaching: hundreds of students at
  // lakh-a-year fees, and test series and recorded lectures are the product -
  // the institutes that most need an app of their own.
  { id: 'exam_coaching', label: 'Competitive exam coaching', group: 'Education', tier: 'T1', q: 'JEE NEET UPSC MPSC competitive exam coaching institute', type: null, season: [3, 4, 5], appPitch: true },

  // ---------- T2: beauty + wellness ----------
  { id: 'salon', label: 'Salon', group: 'Beauty', tier: 'T2', q: 'hair salon', type: 'hair_salon' },
  { id: 'spa', label: 'Spa', group: 'Beauty', tier: 'T2', q: 'spa', type: 'spa' },
  { id: 'nail_studio', label: 'Nail / lash studio', group: 'Beauty', tier: 'T2', q: 'nail studio', type: 'nail_salon' },
  { id: 'tattoo_studio', label: 'Tattoo studio', group: 'Beauty', tier: 'T2', q: 'tattoo studio', type: null },
  { id: 'gym', label: 'Gym / fitness centre', group: 'Fitness', tier: 'T2', q: 'gym fitness centre', type: 'gym', season: [0, 1] },
  { id: 'yoga_studio', label: 'Yoga / pilates studio', group: 'Fitness', tier: 'T2', q: 'yoga studio', type: 'yoga_studio', season: [0, 1] },
  { id: 'nutritionist', label: 'Nutritionist / dietician', group: 'Fitness', tier: 'T2', q: 'dietician nutritionist clinic', type: null, season: [0, 1] },

  // ---------- T2: everyday healthcare ----------
  { id: 'dental_clinic', label: 'Dental clinic', group: 'Healthcare', tier: 'T2', q: 'dental clinic', type: 'dentist' },
  { id: 'physiotherapy', label: 'Physiotherapy clinic', group: 'Healthcare', tier: 'T2', q: 'physiotherapy clinic', type: 'physiotherapist' },
  { id: 'chiropractor', label: 'Chiropractor', group: 'Healthcare', tier: 'T2', q: 'chiropractor', type: 'chiropractor' },
  { id: 'eye_clinic', label: 'Eye clinic / optician', group: 'Healthcare', tier: 'T2', q: 'eye clinic optician', type: null },
  { id: 'polyclinic', label: 'Polyclinic / general practice', group: 'Healthcare', tier: 'T2', q: 'polyclinic general physician', type: null },
  { id: 'pediatric_clinic', label: 'Pediatric clinic', group: 'Healthcare', tier: 'T2', q: 'child specialist clinic', type: null },
  { id: 'pet_grooming', label: 'Pet grooming / vet clinic', group: 'Healthcare', tier: 'T2', q: 'pet grooming clinic', type: null },

  // ---------- T2: hospitality + events ----------
  { id: 'hotel', label: 'Hotel', group: 'Hospitality', tier: 'T2', q: 'hotel', type: 'hotel' },
  { id: 'event_planner', label: 'Event planner', group: 'Events', tier: 'T2', q: 'event management company', type: null },
  { id: 'caterer', label: 'Caterer', group: 'Events', tier: 'T2', q: 'catering service', type: 'catering_service', season: [10, 11, 0] },
  { id: 'photography_studio', label: 'Photography studio', group: 'Events', tier: 'T2', q: 'photography studio', type: null, season: [10, 11, 0] },

  // ---------- T2: services + trades ----------
  { id: 'packers_movers', label: 'Packers and movers', group: 'Services', tier: 'T2', q: 'packers and movers', type: 'moving_company' },
  { id: 'travel_agency', label: 'Travel agency', group: 'Services', tier: 'T2', q: 'travel agency', type: 'travel_agency', season: [3, 4, 9] },
  { id: 'news_agency', label: 'News agency / digital news portal', group: 'Media', tier: 'T2', q: 'news agency local news portal online news', type: null, appPitch: true, appGap: 'no_news_app' },
  { id: 'driving_school', label: 'Driving school', group: 'Education', tier: 'T2', q: 'driving school', type: null },
  { id: 'coaching_institute', label: 'Coaching institute', group: 'Education', tier: 'T2', q: 'coaching classes institute', type: null, season: [3, 4, 5], appPitch: true },
  { id: 'preschool', label: 'Preschool / daycare', group: 'Education', tier: 'T2', q: 'preschool daycare', type: 'preschool', season: [2, 3, 4], appPitch: true },
  { id: 'car_service', label: 'Car service centre', group: 'Automotive', tier: 'T2', q: 'car service centre', type: 'car_repair' },
  { id: 'pest_control', label: 'Pest control', group: 'Services', tier: 'T2', q: 'pest control service', type: null },
  { id: 'cleaning_service', label: 'Cleaning service', group: 'Services', tier: 'T2', q: 'cleaning service company', type: null },
  { id: 'hvac', label: 'HVAC / AC service', group: 'Services', tier: 'T2', q: 'air conditioning service company', type: null, season: [3, 4, 5] },
  { id: 'plumber_electrician', label: 'Plumbing / electrical contractor', group: 'Services', tier: 'T2', q: 'plumbing electrical contractor', type: null },
  { id: 'landscaping', label: 'Landscaping / gardening', group: 'Services', tier: 'T2', q: 'landscaping company', type: null },
  { id: 'roofing', label: 'Roofing / waterproofing', group: 'Services', tier: 'T2', q: 'roofing waterproofing contractor', type: 'roofing_contractor' },

  // Brokers, not builders. OpenStreetMap tags both office=estate_agent, and
  // putting every broker under "developer" priced them as T1.
  { id: 'real_estate_agent', label: 'Real estate agent / broker', group: 'Property', tier: 'T2', q: 'real estate agent', type: 'real_estate_agency' },

  // ---------- T2: retail ----------
  { id: 'furniture_store', label: 'Furniture store', group: 'Retail', tier: 'T2', q: 'furniture store', type: 'furniture_store' },
  { id: 'boutique', label: 'Boutique / apparel', group: 'Retail', tier: 'T2', q: 'clothing boutique', type: 'clothing_store' },
  { id: 'electronics_store', label: 'Electronics store', group: 'Retail', tier: 'T2', q: 'electronics store', type: 'electronics_store' },
  { id: 'home_appliance', label: 'Home appliance showroom', group: 'Retail', tier: 'T2', q: 'home appliance showroom', type: null },
  { id: 'optical_store', label: 'Optical store', group: 'Retail', tier: 'T2', q: 'optical store eyewear', type: null },

  // ---------- T3: food + convenience ----------
  { id: 'restaurant', label: 'Restaurant', group: 'Food', tier: 'T3', q: 'restaurant', type: 'restaurant' },
  { id: 'cafe', label: 'Cafe', group: 'Food', tier: 'T3', q: 'cafe', type: 'cafe' },
  { id: 'bakery', label: 'Bakery', group: 'Food', tier: 'T3', q: 'bakery', type: 'bakery' },
  { id: 'cloud_kitchen', label: 'Cloud kitchen / takeaway', group: 'Food', tier: 'T3', q: 'takeaway cloud kitchen', type: null },
  { id: 'pharmacy', label: 'Pharmacy', group: 'Retail', tier: 'T3', q: 'pharmacy chemist', type: 'pharmacy' },
  { id: 'grocery', label: 'Grocery / supermarket', group: 'Retail', tier: 'T3', q: 'supermarket grocery store', type: 'supermarket' },
  { id: 'mobile_repair', label: 'Mobile repair / accessories', group: 'Retail', tier: 'T3', q: 'mobile phone repair shop', type: null },
  { id: 'laundry', label: 'Laundry / dry cleaning', group: 'Services', tier: 'T3', q: 'laundry dry cleaning', type: 'laundry' },
  { id: 'stationery', label: 'Stationery / book store', group: 'Retail', tier: 'T3', q: 'stationery book store', type: 'book_store' },
  { id: 'florist', label: 'Florist', group: 'Retail', tier: 'T3', q: 'florist flower shop', type: 'florist' },
];

export const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

export const GROUPS = [...new Set(CATEGORIES.map((c) => c.group))];

/** Categories whose leads are checked for an app, and pitched one when they have none. */
export const APP_PITCH_IDS = CATEGORIES.filter((c) => c.appPitch).map((c) => c.id);

export function isAppPitch(categoryId) {
  return Boolean(CATEGORY_BY_ID.get(categoryId)?.appPitch);
}

/** The gap tag a confirmed "no app" raises for this category (lib/deal.js). */
export function appGapOf(categoryId) {
  return CATEGORY_BY_ID.get(categoryId)?.appGap || 'no_app';
}

/** Sensible starting sweep: everything a full-service agency can actually sell into. */
export const PRESETS = {
  high_value: {
    label: 'High value only (T1)',
    note: 'Fewest calls, biggest deals. Start here.',
    ids: CATEGORIES.filter((c) => c.tier === 'T1').map((c) => c.id),
  },
  balanced: {
    label: 'Balanced sweep (T1 + T2)',
    note: 'The default. Roughly 60 queries.',
    ids: CATEGORIES.filter((c) => c.tier !== 'T3').map((c) => c.id),
  },
  healthcare: {
    label: 'Healthcare cluster',
    note: 'Clinics and hospitals. High LTV, weak digital presence almost everywhere.',
    ids: CATEGORIES.filter((c) => c.group === 'Healthcare').map((c) => c.id),
  },
  weddings: {
    label: 'Weddings and events',
    note: 'Seasonal. Sweep 3 months before the local wedding season.',
    ids: CATEGORIES.filter((c) => c.group === 'Events' || c.id === 'jewellery_store' || c.id === 'resort').map((c) => c.id),
  },
  education_apps: {
    label: 'Schools and coaching (app pitch)',
    note: 'Schools, colleges, coaching classes and preschools. Each lead is checked for an app of its own.',
    ids: CATEGORIES.filter((c) => c.appPitch && c.group === 'Education').map((c) => c.id),
  },
  news_media: {
    label: 'News and media (app pitch)',
    note: 'News channels, newspapers, agencies and portals. Each is checked for an app; the pitch is our news app and newsroom admin.',
    ids: CATEGORIES.filter((c) => c.group === 'Media').map((c) => c.id),
  },
  property: {
    label: 'Property and interiors',
    ids: CATEGORIES.filter((c) => c.group === 'Property').map((c) => c.id),
  },
  everything: {
    label: 'Everything',
    note: 'Full catalogue. Expensive - only for a market you already believe in.',
    ids: CATEGORIES.map((c) => c.id),
  },
};

/** Map a raw Google primary type back onto our catalogue, best effort. */
export function normalizeCategory(googleType, googleTypeDisplay, fallbackId) {
  if (fallbackId && CATEGORY_BY_ID.has(fallbackId)) return fallbackId;
  if (googleType) {
    const direct = CATEGORIES.find((c) => c.type === googleType);
    if (direct) return direct.id;
  }
  const hay = String(googleTypeDisplay || googleType || '').toLowerCase();
  if (!hay) return null;
  let best = null;
  for (const c of CATEGORIES) {
    const words = c.label.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
    const hits = words.filter((w) => hay.includes(w)).length;
    if (hits && (!best || hits > best.hits)) best = { id: c.id, hits };
  }
  return best ? best.id : null;
}

export function tierOf(categoryId) {
  return CATEGORY_BY_ID.get(categoryId)?.tier || null;
}

export function isInSeason(categoryId, date = new Date()) {
  const c = CATEGORY_BY_ID.get(categoryId);
  if (!c || !c.season) return false;
  return c.season.includes(date.getMonth());
}
