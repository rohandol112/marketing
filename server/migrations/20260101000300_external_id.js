/**
 * A generic external identifier, so a lead can be matched back to whatever
 * directory it came from.
 *
 * `google_place_id` already does this for Places. OpenStreetMap needs the same
 * thing, and so will the next source, so this is the generic version rather
 * than a third id column later.
 *
 * It matters for dedupe: an OSM business often has no phone, so its dedupe key
 * is name plus locality. The moment a mapper adds a phone number, that key
 * changes and the next sweep would insert a duplicate. A stable external id
 * makes re-sweeps exact.
 */

export async function up(knex) {
  await knex.schema.alterTable('leads', (t) => {
    t.text('external_id');
    t.text('external_source');
  });

  await knex.raw(`
    CREATE UNIQUE INDEX leads_tenant_external_uq
    ON leads (tenant_id, external_source, external_id)
    WHERE external_id IS NOT NULL
  `);

  await knex.raw(`
    UPDATE leads
    SET external_id = google_place_id, external_source = 'google_places'
    WHERE google_place_id IS NOT NULL
  `);
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS leads_tenant_external_uq');
  await knex.schema.alterTable('leads', (t) => {
    t.dropColumn('external_id');
    t.dropColumn('external_source');
  });
}
