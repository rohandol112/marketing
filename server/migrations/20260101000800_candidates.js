/**
 * Candidate field values, each with the source it came from.
 *
 * The rule "the model never emits a phone number" was written for ungrounded
 * generation, where a number is invented and dialling it could reach a
 * stranger. It is the right rule there and it stays.
 *
 * Grounded search is a different thing. A number retrieved from a page, stored
 * with the URL it came from, is checkable - a rep can click the source before
 * dialling. Treating those two cases identically is what left 668 leads with no
 * phone number and nothing on the board: every one of them needed a human to
 * find and type a number that a citation-backed search had already found.
 *
 * So a retrieved value lands here as a *candidate*, never directly in the field.
 * Accepting it is one click, and the provenance survives the click.
 */

export async function up(knex) {
  await knex.schema.alterTable('leads', (t) => {
    // { phone: { value, source, found_at }, website: {...}, ig_followers: {...} }
    t.jsonb('candidates').defaultTo('{}');
  });
  await knex.raw("CREATE INDEX leads_candidates_idx ON leads USING gin (candidates)");
}

export async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS leads_candidates_idx');
  await knex.schema.alterTable('leads', (t) => t.dropColumn('candidates'));
}
