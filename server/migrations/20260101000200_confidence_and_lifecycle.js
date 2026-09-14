/**
 * Splits the discovery lifecycle from the sales pipeline, and separates "how
 * good is this lead" from "how much of this do we actually know".
 *
 * The bug this fixes: a lead discovered by model recall, with no place id, no
 * phone, no rating and no review count, was scoring 46 and sitting in a sales
 * stage. Unknown was being paid points. Now unknown scores zero and costs
 * confidence, and nothing reaches a rep until a human has confirmed the
 * business exists.
 *
 * Three columns, three jobs:
 *   discovery_status - does this business exist and do we know enough about it
 *   status           - the team lead's review decision, only once qualified
 *   stage            - the sales pipeline, null until the lead is approved
 */

export async function up(knex) {
  await knex.schema.alterTable('leads', (t) => {
    // discovered -> verifying -> verified -> qualified, or rejected
    t.text('discovery_status').notNullable().defaultTo('discovered');

    // 0-100, how much of this record is actually evidenced
    t.integer('confidence').defaultTo(0);
    t.jsonb('confidence_breakdown').defaultTo('{}');

    // per-field provenance: { phone: { source, verified_at, verified_by, confidence } }
    t.jsonb('field_provenance').defaultTo('{}');

    t.timestamp('verified_at', { useTz: true });
    t.text('verified_by');
  });

  // A lead only has a sales stage once it is in the sales pipeline.
  await knex.raw('ALTER TABLE leads ALTER COLUMN stage DROP NOT NULL');
  await knex.raw("ALTER TABLE leads ALTER COLUMN stage SET DEFAULT NULL");

  await knex.raw('CREATE INDEX leads_discovery_status_idx ON leads (tenant_id, discovery_status)');
  await knex.raw('CREATE INDEX leads_confidence_idx ON leads (tenant_id, confidence)');

  // Backfill: anything that came from Places already has a verified identity.
  await knex.raw(`
    UPDATE leads SET discovery_status = 'verified'
    WHERE google_place_id IS NOT NULL AND disqualified = false
  `);
  await knex.raw(`
    UPDATE leads SET discovery_status = 'rejected', stage = NULL
    WHERE disqualified = true
  `);
  await knex.raw(`
    UPDATE leads SET stage = NULL
    WHERE status <> 'approved' OR discovery_status <> 'qualified'
  `);
  await knex.raw(`UPDATE leads SET field_provenance = COALESCE(source_url, '{}'::jsonb)`);

  // Constraints go on last, once the backfill above has made every existing row
  // satisfy them.
  await knex.raw(`
    ALTER TABLE leads ADD CONSTRAINT leads_discovery_status_chk
    CHECK (discovery_status IN ('discovered','verifying','verified','qualified','rejected'))
  `);

  /**
   * A lead in a sales stage must be approved, and an approved lead must be
   * qualified. This is the invariant the old schema could not express, and the
   * reason a disqualified candidate could sit in "To Do".
   */
  await knex.raw(`
    ALTER TABLE leads ADD CONSTRAINT leads_stage_requires_approval_chk
    CHECK (stage IS NULL OR (status = 'approved' AND discovery_status = 'qualified'))
  `);
}

export async function down(knex) {
  await knex.raw('ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_stage_requires_approval_chk');
  await knex.raw('ALTER TABLE leads DROP CONSTRAINT IF EXISTS leads_discovery_status_chk');
  await knex.raw('DROP INDEX IF EXISTS leads_discovery_status_idx');
  await knex.raw('DROP INDEX IF EXISTS leads_confidence_idx');
  await knex.raw("UPDATE leads SET stage = 'todo' WHERE stage IS NULL");
  await knex.raw("ALTER TABLE leads ALTER COLUMN stage SET DEFAULT 'todo'");
  await knex.raw('ALTER TABLE leads ALTER COLUMN stage SET NOT NULL');
  await knex.schema.alterTable('leads', (t) => {
    t.dropColumn('discovery_status');
    t.dropColumn('confidence');
    t.dropColumn('confidence_breakdown');
    t.dropColumn('field_provenance');
    t.dropColumn('verified_at');
    t.dropColumn('verified_by');
  });
}
