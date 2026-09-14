import crypto from 'node:crypto';

const uid = (p) => p + crypto.randomBytes(9).toString('base64url');
const now = () => new Date().toISOString();

const TENANT_ID = 'tenant_tanz';

/**
 * The service catalogue is transcribed from the Tanz Corp service profile deck.
 * `gapTags` is the bit that earns its keep: it maps a gap the scorer detected
 * onto the service that answers it, so the pitch is never generic.
 */
const CATALOG = [
  ['Marketing (Digital)', 'Social Media Marketing', 'Social Media Management', ['low_instagram', 'high_review_ratio', 'stale_gbp']],
  ['Marketing (Digital)', 'Social Media Marketing', 'Influencer Marketing', ['low_instagram', 'high_review_ratio']],
  ['Marketing (Digital)', 'Social Media Marketing', 'Digital Talent Management', []],
  ['Marketing (Digital)', 'Social Media Marketing', 'Content Management', ['low_instagram', 'stale_gbp']],
  ['Marketing (Digital)', 'Strategic Reach', 'Lead Generation', ['no_ads']],
  ['Marketing (Digital)', 'Strategic Reach', 'Follow-Up Campaign', []],
  ['Marketing (Digital)', 'Strategic Reach', 'Sponsored Ads', ['no_ads']],
  ['Marketing (Digital)', 'Strategic Reach', 'Pay-Per-Click Ads', ['no_ads']],
  ['Marketing (Digital)', 'Email Marketing', 'Email Campaign', []],
  ['Marketing (Digital)', 'Email Marketing', 'Cold Mailing', []],
  ['Marketing (Digital)', 'Email Marketing', 'Trigger Automation', []],
  ['Marketing (Digital)', 'Email Marketing', 'Email Segmentation', []],
  ['Marketing (Digital)', 'SEO', 'Increase site index', ['no_seo', 'no_website']],
  ['Marketing (Digital)', 'SEO', 'Optimised content creation', ['no_seo', 'placeholder_site']],
  ['Marketing (Digital)', 'SEO', 'SEO Audit', ['no_seo', 'slow_site']],
  ['Marketing (Digital)', 'SEO', 'Competitor Analysis', ['no_seo']],

  ['Marketing (Traditional)', 'Advertising', 'Printed Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Broadcast Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Digital Advertising', ['no_ads']],
  ['Marketing (Traditional)', 'Advertising', 'Outdoor Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Indoor Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Direct Mail Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Commercial Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Cinema Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Newspaper Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Television Advertising', []],
  ['Marketing (Traditional)', 'Advertising', 'Radio Broadcasting', []],
  ['Marketing (Traditional)', 'Branding', 'Vehicle Branding', []],
  ['Marketing (Traditional)', 'Branding', 'Public Transport Branding', []],
  ['Marketing (Traditional)', 'Event Marketing', 'Event Planning & Strategy', []],
  ['Marketing (Traditional)', 'Event Marketing', 'Branding and Design', ['no_branding']],
  ['Marketing (Traditional)', 'Event Marketing', 'Online Promotion', ['low_instagram']],
  ['Marketing (Traditional)', 'Event Marketing', 'Public Relation', []],
  ['Marketing (Traditional)', 'Event Marketing', 'Sponsorship Management', []],

  ['Information Technology (IT)', 'Web Technology', 'Custom Website Development', ['no_website', 'placeholder_site', 'broken_site']],
  ['Information Technology (IT)', 'Web Technology', 'Wordpress Development', ['no_website', 'placeholder_site']],
  ['Information Technology (IT)', 'Web Technology', 'Shopify E-Commerce', ['no_website']],
  ['Information Technology (IT)', 'Web Technology', 'Wix Custom Development', ['placeholder_site']],
  ['Information Technology (IT)', 'Software Technology', 'Android Development', []],
  ['Information Technology (IT)', 'Software Technology', 'iOS Development', []],
  ['Information Technology (IT)', 'Software Technology', 'Software Development', []],
  ['Information Technology (IT)', 'Software Technology', 'Productivity Software', []],

  ['Creativity', 'Design', 'Graphic Design', ['no_branding']],
  ['Creativity', 'Design', 'Logo Design', ['no_branding']],
  ['Creativity', 'Design', 'Branding & Identity Design', ['no_branding']],
  ['Creativity', 'Design', 'Social Media Graphic', ['low_instagram']],
  ['Creativity', 'Design', 'Flyer, Brochure Design', []],
  ['Creativity', 'Tech', 'UI/UX Design', ['placeholder_site', 'not_mobile']],
  ['Creativity', 'Tech', 'Web Design', ['no_website', 'placeholder_site', 'not_mobile']],
  ['Creativity', 'Tech', 'App Design', []],
  ['Creativity', 'Visionary', 'Photo Editing', ['low_instagram']],
  ['Creativity', 'Visionary', 'Video Editing', ['no_video', 'low_instagram']],
  ['Creativity', 'Visionary', '2D-3D Animation', ['no_video']],
  ['Creativity', 'Visionary', 'Motion Graphic', ['no_video']],
  ['Creativity', 'Visionary', 'VR-AR reality Design', []],

  ['Ai Technology', null, 'Ai Conversation Agent', []],
  ['Ai Technology', null, 'Ai Chatbot Agent', ['no_website']],
  ['Ai Technology', null, 'Ai Process Automation', []],

  ['Video Commercial', null, 'Professional Advertisement', ['no_video']],
  ['Video Commercial', null, 'Reel Contents', ['no_video', 'low_instagram']],
  ['Video Commercial', null, 'Influencer Reel Contents', ['low_instagram', 'high_review_ratio']],
  ['Video Commercial', null, 'Product Videos', ['no_video']],
];

const PACKAGES = [
  {
    name: 'Starter Site',
    tagline: 'Get them on the map properly, in two weeks.',
    price_min: 15000, price_max: 25000, billing: 'one_time', sort_order: 1,
    best_for: 'A business with real reviews and no website at all',
    includes: ['Custom Website Development', 'Logo Design', 'Increase site index'],
  },
  {
    name: 'Digital Presence',
    tagline: 'Website, identity and search, done once and done right.',
    price_min: 25000, price_max: 45000, billing: 'one_time', sort_order: 2,
    best_for: 'A placeholder or broken site that needs replacing',
    includes: ['Custom Website Development', 'UI/UX Design', 'Branding & Identity Design', 'SEO Audit', 'Optimised content creation'],
  },
  {
    name: 'Social Growth',
    tagline: 'Turn the customers they already have into an audience.',
    price_min: 18000, price_max: 35000, billing: 'monthly', sort_order: 3,
    best_for: 'High review count, almost no followers',
    includes: ['Social Media Management', 'Social Media Graphic', 'Reel Contents', 'Content Management'],
  },
  {
    name: 'Growth Engine',
    tagline: 'Presence plus paid acquisition, measured monthly.',
    price_min: 45000, price_max: 75000, billing: 'monthly', sort_order: 4,
    best_for: 'Established business ready to spend on acquisition',
    includes: ['Social Media Management', 'Sponsored Ads', 'Pay-Per-Click Ads', 'Lead Generation', 'SEO Audit', 'Reel Contents'],
  },
  {
    name: 'Full Stack Brand',
    tagline: 'Complete rebuild: identity, site, film and launch.',
    price_min: 75000, price_max: 150000, billing: 'one_time', sort_order: 5,
    best_for: 'Multi-location or high-ticket business with a dated brand',
    includes: ['Branding & Identity Design', 'Custom Website Development', 'UI/UX Design', 'Professional Advertisement', 'Product Videos', 'Motion Graphic'],
  },
  {
    name: 'PRO Retainer',
    tagline: 'The whole agency, on call.',
    price_min: 100000, price_max: null, billing: 'monthly', sort_order: 6,
    best_for: 'Chains, hospitals, developers, anyone with a real marketing budget',
    includes: ['Social Media Management', 'Influencer Marketing', 'Sponsored Ads', 'Lead Generation', 'Ai Chatbot Agent', 'Ai Process Automation', 'Professional Advertisement', 'Public Relation'],
  },
];

const USERS = [
  { name: 'Pratik', role: 'admin', cap: 40 },
  { name: 'Team Lead', role: 'team_lead', cap: 40 },
  { name: 'Rep One', role: 'rep', cap: 25 },
  { name: 'Rep Two', role: 'rep', cap: 25 },
  { name: 'Rep Three', role: 'rep', cap: 25 },
];

const AREAS = [
  ['Aundh, Pune', 18.5590, 73.8077, 4000],
  ['New Sangvi, Pune', 18.5793, 73.8143, 3500],
  ['Pimpri, Pune', 18.6280, 73.7997, 4000],
  ['Chinchwad, Pune', 18.6414, 73.7997, 4000],
  ['Akurdi, Pune', 18.6492, 73.7707, 3500],
  ['Thakur Village, Kandivali East, Mumbai', 19.2094, 72.8712, 3000],
];

export async function seed(knex) {
  const { DEFAULT_SCORING_CONFIG } = await import('../src/lib/scoring.js');

  const existing = await knex('tenants').where({ id: TENANT_ID }).first();
  if (existing) {
    console.log('Tenant already seeded. Delete it first if you want a clean slate:');
    console.log("  psql -c \"delete from tenants where id='" + TENANT_ID + "'\"");
    return;
  }

  await knex('tenants').insert({
    id: TENANT_ID,
    name: 'Tanz Corp',
    country_code: '91',
    currency: 'INR',
    timezone: 'Asia/Kolkata',
    brand_voice:
      'Direct, warm and specific. Short sentences. No agency jargon. Tanz Corp has been doing this since 2019 and sounds like it - confident, not salesy. Never imply the business is doing badly; they built something real offline and the online part is simply unclaimed.',
    created_at: now(),
  });

  const users = USERS.map((u) => ({
    id: uid('us_'),
    tenant_id: TENANT_ID,
    name: u.name,
    email: null,
    role: u.role,
    open_lead_cap: u.cap,
    active: true,
    created_at: now(),
  }));
  await knex('users').insert(users);

  await knex('service_catalog').insert(
    CATALOG.map(([group, sub, name, tags]) => ({
      id: uid('sv_'),
      tenant_id: TENANT_ID,
      group_name: group,
      sub_group: sub,
      name,
      gap_tags: JSON.stringify(tags),
      active: true,
    }))
  );

  await knex('packages').insert(
    PACKAGES.map((p) => ({
      id: uid('pk_'),
      tenant_id: TENANT_ID,
      name: p.name,
      tagline: p.tagline,
      price_min: p.price_min,
      price_max: p.price_max,
      currency: 'INR',
      billing: p.billing,
      includes: JSON.stringify(p.includes),
      best_for: p.best_for,
      sort_order: p.sort_order,
      active: true,
    }))
  );

  await knex('scoring_configs').insert({
    id: uid('sc_'),
    tenant_id: TENANT_ID,
    version: 1,
    config: JSON.stringify(DEFAULT_SCORING_CONFIG),
    active: true,
    note: 'Starting weights. Retune from closed-won data after roughly 30 closes.',
    created_at: now(),
  });

  await knex('areas').insert(
    AREAS.map(([label, lat, lng, radius]) => ({
      id: uid('ar_'),
      tenant_id: TENANT_ID,
      label,
      country_code: 'IN',
      region_code: 'IN',
      language_code: 'en',
      lat,
      lng,
      radius_m: radius,
      created_at: now(),
    }))
  );

  console.log('Seeded Tanz Corp:');
  console.log('  ' + users.length + ' users, ' + CATALOG.length + ' services, ' + PACKAGES.length + ' packages, ' + AREAS.length + ' saved areas');
}
