import crypto from 'node:crypto';

/**
 * The news product, for news channels, newspapers, agencies and portals.
 *
 * Tanz built a news app and newsroom admin for a news channel. A news house
 * the app check finds without an app raises the `no_news_app` gap (not
 * `no_app`), and this service and package answer it - so a channel is priced
 * the newsroom product and a school the institute app, never each other's.
 * The package holds only the news service on purpose: anything tagged
 * `no_app` in it would make it a candidate for every school too.
 *
 * Added for tenants that do not have them yet; edit the price in Settings.
 */
const SERVICE = {
  group_name: 'Information Technology (IT)',
  sub_group: 'Software Technology',
  name: 'News App and Newsroom Admin',
  gap_tags: ['no_news_app'],
};

const PACKAGE = {
  name: 'Newsroom App',
  tagline: 'Their own news app with push alerts, and the newsroom admin to run it.',
  price_min: 150000,
  price_max: 350000,
  billing: 'one_time',
  sort_order: 8,
  best_for: 'A news channel, newspaper or portal whose readers have no app of theirs',
  includes: ['News App and Newsroom Admin'],
};

const id = (prefix) => prefix + crypto.randomBytes(9).toString('base64url');

export async function up(knex) {
  const tenants = await knex('tenants').select('id', 'currency');
  for (const t of tenants) {
    // Only tenants with a catalogue: a bare tenant gets the seed's.
    const catalogue = await knex('service_catalog').where({ tenant_id: t.id }).count({ n: '*' }).first();
    if (!Number(catalogue.n)) continue;

    const service = await knex('service_catalog').where({ tenant_id: t.id, name: SERVICE.name }).first('id');
    if (!service) {
      await knex('service_catalog').insert({
        id: id('sv_'), tenant_id: t.id, group_name: SERVICE.group_name, sub_group: SERVICE.sub_group,
        name: SERVICE.name, gap_tags: JSON.stringify(SERVICE.gap_tags), active: true,
      });
    }
    const pkg = await knex('packages').where({ tenant_id: t.id, name: PACKAGE.name }).first('id');
    if (!pkg) {
      await knex('packages').insert({
        id: id('pk_'), tenant_id: t.id, name: PACKAGE.name, tagline: PACKAGE.tagline,
        price_min: PACKAGE.price_min, price_max: PACKAGE.price_max, currency: t.currency || 'INR',
        billing: PACKAGE.billing, includes: JSON.stringify(PACKAGE.includes), best_for: PACKAGE.best_for,
        sort_order: PACKAGE.sort_order, active: true,
      });
    }
  }
}

export async function down(knex) {
  await knex('packages').where({ name: PACKAGE.name }).del();
  await knex('service_catalog').where({ name: SERVICE.name }).del();
}
