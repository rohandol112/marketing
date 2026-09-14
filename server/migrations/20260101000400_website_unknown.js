/**
 * Correct 'none' to 'unknown' for leads from sources that do not actually know.
 *
 * OpenStreetMap records a website tag for roughly 8% of businesses. Absence of
 * the tag says nothing about whether a website exists - most of those
 * businesses do have one. Storing 'none' turned "we did not look" into "they
 * have no website", which awarded 12 digital-gap points to about 1,600 leads
 * and made the score actively misleading.
 *
 * Google Places is different: if it has no websiteUri for a business, that is
 * an authoritative negative and stays 'none'.
 *
 * The general rule this encodes, learned twice now: never let a missing field
 * be scored as a known-bad value.
 */

export async function up(knex) {
  const { rowCount } = await knex.raw(`
    UPDATE leads
    SET website_status = 'unknown'
    WHERE website IS NULL
      AND website_status = 'none'
      AND (external_source IS DISTINCT FROM 'google_places')
  `);
  console.log('[migration] website_status none -> unknown for ' + (rowCount ?? 0) + ' lead(s)');
}

export async function down(knex) {
  await knex.raw(`
    UPDATE leads SET website_status = 'none'
    WHERE website IS NULL AND website_status = 'unknown'
  `);
}
