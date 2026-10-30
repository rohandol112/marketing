import crypto from 'node:crypto';

/**
 * Whether a business publishes a mobile app of its own.
 *
 *   app_status  has_app | white_label | unclear | no_app, NULL until checked.
 *               no_app is only written after their site, a Google Play search
 *               and the App Store all came back empty (lib/appPresence.js).
 *   app_audit   the evidence: what was found where, and what was searched.
 *
 * The app services in the catalogue had no gap tag, so nothing ever
 * recommended them. They answer "no_app" now, and tenants seeded before this
 * get an app package to price the pitch with - edit it in Settings.
 */
const STATUSES = ['has_app', 'white_label', 'unclear', 'no_app'];
const APP_SERVICES = ['Android Development', 'iOS Development', 'App Design'];

const APP_PACKAGE = {
  name: 'Institute App',
  tagline: 'Their own Android and iOS app for students and parents.',
  price_min: 120000,
  price_max: 300000,
  billing: 'one_time',
  sort_order: 7,
  best_for: 'A school or coaching institute whose students and parents have no app of theirs',
  includes: ['App Design', 'Android Development', 'iOS Development'],
};

export async function up(knex) {
  await knex.schema.alterTable('leads', (t) => {
    t.text('app_status');
    t.jsonb('app_audit').defaultTo('{}');
  });
  await knex.raw(
    'ALTER TABLE leads ADD CONSTRAINT leads_app_status_chk CHECK (app_status IS NULL OR app_status IN (' +
    STATUSES.map((s) => "'" + s + "'").join(',') + '))'
  );
  await knex.raw('CREATE INDEX IF NOT EXISTS leads_app_idx ON leads (tenant_id, app_status)');

  // Only services nobody has tagged yet: a tenant's own tags stand.
  await knex('service_catalog')
    .whereIn('name', APP_SERVICES)
    .whereRaw("gap_tags = '[]'::jsonb")
    .update({ gap_tags: JSON.stringify(['no_app']) });

  const tenants = await knex('tenants').select('id', 'currency');
  for (const t of tenants) {
    const services = await knex('service_catalog').where({ tenant_id: t.id }).whereIn('name', APP_SERVICES).count({ n: '*' }).first();
    if (!Number(services.n)) continue;
    const existing = await knex('packages').where({ tenant_id: t.id, name: APP_PACKAGE.name }).first('id');
    if (existing) continue;
    await knex('packages').insert({
      id: 'pk_' + crypto.randomBytes(9).toString('base64url'),
      tenant_id: t.id,
      name: APP_PACKAGE.name,
      tagline: APP_PACKAGE.tagline,
      price_min: APP_PACKAGE.price_min,
      price_max: APP_PACKAGE.price_max,
      currency: t.currency || 'INR',
      billing: APP_PACKAGE.billing,
      includes: JSON.stringify(APP_PACKAGE.includes),
      best_for: APP_PACKAGE.best_for,
      sort_order: APP_PACKAGE.sort_order,
      active: true,
    });
  }
}

export async function down(knex) {
  await knex('packages').where({ name: APP_PACKAGE.name }).del();
  await knex('service_catalog')
    .whereIn('name', APP_SERVICES)
    .whereRaw(`gap_tags = '["no_app"]'::jsonb`)
    .update({ gap_tags: JSON.stringify([]) });
  await knex.raw('DROP INDEX IF EXISTS leads_app_idx');
  await knex.raw('ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_app_status_chk');
  await knex.schema.alterTable('leads', (t) => {
    t.dropColumn('app_status');
    t.dropColumn('app_audit');
  });
}
