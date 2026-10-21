import test from 'node:test';
import assert from 'node:assert/strict';
import { detectExclusion, refineCategory, platformOf, chainMatch, governmentMatch, tagListToObject } from './classify.js';

/**
 * Real names from the last export. The exclusions have to catch these, and -
 * just as important - must not catch the independent businesses next to them.
 */

const lead = (name, extra = {}) => ({ name, normalized_category: 'jewellery_store', ...extra });

test('national chains are excluded by name, within their own industry', () => {
  for (const [name, cat] of [
    ['Tanishq', 'jewellery_store'], ['Kalyan Jewellers', 'jewellery_store'], ['Caratlane', 'jewellery_store'],
    ['Lakmé Salon', 'salon'], ["Gold's Gym", 'gym'], ['Metropolis', 'diagnostic_centre'],
    ['Golwilkar Metropolis', 'diagnostic_centre'], ['Apollo Diagnostics', 'diagnostic_centre'],
    ['Manipal Hospital', 'private_hospital'], ['Holiday Inn Express Pune Hinjawadi', 'hotel'],
    ['FabHotels FabExpress The Corporate Hub', 'resort'], ['Four Seasons Hotel', 'hotel'],
    ["Domino's Pizza", 'restaurant'], ['Lenskart', 'optical_store'], ['Euro Kids', 'preschool'],
  ]) {
    assert.equal(detectExclusion(lead(name, { normalized_category: cat }))?.kind, 'chain', name + ' should be a chain');
  }
});

test('a brand name outside its industry is just a name', () => {
  // All four were excluded before the lists were scoped by category.
  for (const [name, cat] of [
    ['Sai Krupa Banquets & Aurelia Mansion', 'wedding_venue'],
    ['Oliva', 'restaurant'],
    ['Four Seasons Restaurant & Bar', 'restaurant'],
    ['Kotak Dental Clinic', 'dental_clinic'],
    ['Dr. Raymond Skin Clinic', 'dermatology'],
    ['Woodland Resort', 'resort'],
  ]) {
    assert.equal(detectExclusion(lead(name, { normalized_category: cat })), null, name + ' is independent');
  }
});

test('independent businesses with ordinary words in their names are not chains', () => {
  for (const name of ['Urban Lifestyle Salon', 'Narenkumar Jewellers', 'Mauli Garden Lawns', 'Tangent Interiors',
    'Aster Beauty Parlour', 'Max Dental Clinic', 'Central Perk Cafe', 'Apollo Tailors', 'Ranka Jewellers', 'Purple Box Interiors']) {
    assert.equal(detectExclusion(lead(name)), null, name + ' is independent');
  }
});

test('banks are chains, blood banks are not', () => {
  assert.equal(chainMatch('Saraswat Co-operative Bank'), 'bank branch');
  assert.equal(chainMatch('HDFC Bank ATM'), 'hdfc');
  assert.equal(chainMatch('Sahyadri Blood Bank'), null);
  assert.equal(chainMatch('Food Bank Pune'), null);
});

test('government and public bodies are excluded', () => {
  for (const name of ['Globe Mill Passage Municipal School', 'Nagpada Police Hospital', 'Municipal TB Hospital',
    'CGHS Dispensary No.11, Byculla', 'Dr. Babasaheb Ambedkar Memorial Central Railway Hospital', 'Kendriya Vidyalaya No. 2',
    'PMC School No. 12', 'Tata Memorial Hospital']) {
    assert.equal(detectExclusion(lead(name, { normalized_category: 'private_hospital' }))?.kind, 'government', name);
  }
});

test('"Vidya Mandir" is a school name, and a trust hospital is still a hospital', () => {
  assert.equal(governmentMatch('Dadar Vidya Mandir Junior College'), null);
  assert.equal(detectExclusion(lead('Lilavati Hospital and Research Centre', { normalized_category: 'private_hospital' })), null);
  assert.equal(detectExclusion(lead('Railway Station Cafe', { normalized_category: 'cafe' })), null);
});

test('a government website gives a body away', () => {
  const ex = detectExclusion(lead('CGHS Polyclinic Koliwada', { website: 'http://nb.bsf.gov.in/CGHS%20DIspenseries.pdf' }));
  assert.equal(ex.kind, 'government');
  assert.equal(detectExclusion(lead('Some Office', { website_host: 'pmc.gov.in' })).kind, 'government');
  assert.equal(detectExclusion(lead('Some Office', { website_host: 'mysite.in' })), null);
});

test('OpenStreetMap brand and operator tags', () => {
  const brand = { source_url: { osm: { tags: { brand: 'Lakmé', 'brand:wikidata': 'Q123' } } } };
  assert.equal(detectExclusion(lead('Lakme Salon Baner', brand)).kind, 'chain');

  // A phone shop tagged with the brand it resells is not that brand.
  const reseller = { source_url: { osm: { tags: { brand: 'Samsung' } } } };
  assert.equal(detectExclusion(lead('Sai Mobiles', reseller)), null);

  // A car showroom's brand tag is the cars it sells; dealers buy local marketing.
  const dealer = { normalized_category: 'car_dealer', source_url: { osm: { tags: { brand: 'Kia', 'brand:wikidata': 'Q35349' } } } };
  assert.equal(detectExclusion(lead('Kia Aman Motors', dealer)), null);

  assert.equal(detectExclusion(lead('Ward Office Clinic', { source_url: { osm: { tags: { 'operator:type': 'government' } } } })).kind, 'government');
  assert.equal(detectExclusion(lead('Sai Mandir Hall', { source_url: { osm: { tags: { 'operator:type': 'religious' } } } })).kind, 'non_commercial');
});

test('placeholder listings are junk; real short names and other scripts are not', () => {
  assert.equal(detectExclusion(lead('XYZ')).kind, 'junk');
  assert.equal(detectExclusion(lead('Clinic')).kind, 'junk');
  assert.equal(detectExclusion(lead('---')).kind, 'junk');
  assert.equal(detectExclusion(lead('G5A')), null);
  assert.equal(detectExclusion(lead('साई मोटर्स')), null);
});

test('platform hosts, including subdomains the old regex missed', () => {
  assert.equal(platformOf('https://link.zomato.com/xqzv/rshare?id=1').host, 'zomato.com');
  assert.equal(platformOf('https://m.facebook.com/somepage').host, 'facebook.com');
  assert.equal(platformOf('https://chinmay-nursing-home.business.site/').kind, 'google');
  assert.equal(platformOf('https://www.google.com/search?q=sattva').kind, 'google');
  assert.equal(platformOf('https://www.lilavatihospital.com/'), null);
  assert.equal(platformOf('facebook.com.evil.example'), null);
});

test('a general clinic swept as cosmetic surgery is a polyclinic', () => {
  // healthcare=clinic was mapped to four T1 specialties at once.
  assert.equal(refineCategory('cosmetic_surgery', { name: 'Dr. Joshi Clinic', tags: { amenity: 'clinic' } }), 'polyclinic');
  assert.equal(refineCategory('cosmetic_surgery', { name: 'Aesthetic & Plastic Surgery Centre', tags: { healthcare: 'clinic' } }), 'cosmetic_surgery');
  assert.equal(refineCategory('dermatology', { name: 'Skin & Hair Clinic', tags: { healthcare: 'clinic' } }), 'dermatology');
  assert.equal(refineCategory('ivf_fertility', { name: 'Shree Fertility & IVF Centre', tags: {} }), 'ivf_fertility');
  assert.equal(refineCategory('hair_transplant', { name: 'Hair Transplant Clinic', tags: { healthcare: 'clinic' } }), 'hair_transplant');
  assert.equal(refineCategory('polyclinic', { name: 'Sunshine Children Clinic', tags: { amenity: 'doctors' } }), 'pediatric_clinic');
});

test('specialist tags beat the name', () => {
  assert.equal(refineCategory('cosmetic_surgery', { name: 'City Clinic', tags: { healthcare: 'clinic', 'healthcare:speciality': 'dermatology' } }), 'dermatology');
  assert.equal(refineCategory('polyclinic', { name: 'City Clinic', tags: { 'healthcare:speciality': 'paediatrics' } }), 'pediatric_clinic');
});

test('dentists, hotels, venues, brokers and furniture land in the right tier', () => {
  assert.equal(refineCategory('dental_implants', { name: 'Smile Dental Clinic', tags: { amenity: 'dentist' } }), 'dental_clinic');
  assert.equal(refineCategory('dental_implants', { name: 'Advanced Dental Implant Centre', tags: { amenity: 'dentist' } }), 'dental_implants');
  assert.equal(refineCategory('orthodontist', { name: 'Braces & Aligner Studio', tags: { amenity: 'dentist' } }), 'orthodontist');
  assert.equal(refineCategory('resort', { name: 'Hotel Sai Palace', tags: { tourism: 'hotel' } }), 'hotel');
  assert.equal(refineCategory('resort', { name: 'Green Valley Resort', tags: { tourism: 'hotel' } }), 'resort');
  assert.equal(refineCategory('wedding_venue', { name: 'Mauli Garden Lawns', tags: { amenity: 'events_venue' } }), 'wedding_venue');
  assert.equal(refineCategory('wedding_venue', { name: 'Ward 12 Hall', tags: { amenity: 'community_centre' } }), 'banquet_hall');
  assert.equal(refineCategory('wedding_venue', { name: 'Shivaji Nagar Samaj', tags: { amenity: 'community_centre' } }), null);
  assert.equal(refineCategory('real_estate_developer', { name: 'Kumar Properties Brokers', tags: { office: 'estate_agent' } }), 'real_estate_agent');
  assert.equal(refineCategory('real_estate_developer', { name: 'Kolte Patil Developers', tags: { office: 'estate_agent' } }), 'real_estate_developer');
  assert.equal(refineCategory('furniture_store', { name: 'Italian Living Gallery', tags: { shop: 'furniture' } }), 'luxury_furniture');
  assert.equal(refineCategory('luxury_furniture', { name: 'Sharma Furniture', tags: { shop: 'furniture' } }), 'furniture_store');
});

test('beauty shops split into salon, nails and med spa', () => {
  assert.equal(refineCategory('med_spa', { name: 'Sakhi Beauty Parlour', tags: { shop: 'beauty' } }), 'salon');
  assert.equal(refineCategory('med_spa', { name: 'Glow Aesthetic & Laser Clinic', tags: { shop: 'beauty' } }), 'med_spa');
  assert.equal(refineCategory('nail_studio', { name: 'Polished Nails & Lashes', tags: { shop: 'beauty' } }), 'nail_studio');
  assert.equal(refineCategory('spa', { name: 'Thai Massage Spa', tags: { leisure: 'spa' } }), 'spa');
});

test('re-sorting is stable: a second pass never moves a lead again', () => {
  // The cleanup re-sorts every run. If two families disagree, a lead
  // ping-pongs between categories forever - it did, between eye_clinic and
  // optical_store.
  const names = [
    'Shree Eye Centre', 'Netra Jyoti Eye Hospital', 'GKB Opticals', 'Vision Opticians', 'Dr. Mehta Eye Clinic',
    'Glow Aesthetic & Laser Clinic', 'Anti Ageing Clinic', 'Skin & Hair Clinic', 'Cosmetologist Dr. Rao',
    'Sakhi Beauty Parlour', 'Polished Nails', 'Thai Massage Spa', 'Smile Dental Hospital', 'Advanced Dental Implant Centre',
    'Braces Studio', 'Shree Fertility & IVF Centre', 'Hair Transplant Clinic', 'Aesthetic & Plastic Surgery Centre',
    'City Diagnostics', 'Krsnaa Pathology Lab', 'Sunshine Children Clinic', 'Rehab Physio Centre', 'Dr. Joshi Clinic',
    'Sai Nursing Home', 'Hotel Sai Palace', 'Green Valley Resort', 'Mauli Garden Lawns', 'Royal Banquet Hall',
    'Kolte Patil Developers', 'Kumar Properties', 'Italian Living Gallery', 'Sharma Furniture', 'Power Yoga Studio',
    'Iron Gym', 'Quick Dry Cleaners', 'Sparkle Cleaning Services', 'Diet Clinic', 'Spine Chiropractic',
  ];
  const categories = [
    'cosmetic_surgery', 'hair_transplant', 'ivf_fertility', 'dermatology', 'med_spa', 'dental_implants', 'orthodontist',
    'dental_clinic', 'eye_clinic', 'optical_store', 'diagnostic_centre', 'pediatric_clinic', 'physiotherapy', 'polyclinic',
    'chiropractor', 'nutritionist', 'salon', 'spa', 'nail_studio', 'resort', 'hotel', 'wedding_venue', 'banquet_hall',
    'real_estate_developer', 'real_estate_agent', 'luxury_furniture', 'furniture_store', 'gym', 'yoga_studio',
    'laundry', 'cleaning_service',
  ];
  for (const cat of categories) {
    for (const name of names) {
      const once = refineCategory(cat, { name, tags: {} });
      if (!once || once === cat) continue;
      const twice = refineCategory(once, { name, tags: {} });
      assert.equal(twice, once, name + ': ' + cat + ' -> ' + once + ' -> ' + twice);
    }
  }
});

test('categories with precise tags are left alone', () => {
  assert.equal(refineCategory('jewellery_store', { name: 'Ranka Jewellers', tags: { shop: 'jewelry' } }), 'jewellery_store');
  assert.equal(refineCategory('private_hospital', { name: 'Ruby Hall Clinic', tags: { amenity: 'hospital' } }), 'private_hospital');
  assert.deepEqual(tagListToObject(['healthcare=clinic', 'amenity=clinic']), { healthcare: 'clinic', amenity: 'clinic' });
});
