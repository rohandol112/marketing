import { Hono } from 'hono';
import knex from '../db/knex.js';
import { HttpError } from '../lib/util.js';
import {
  getPrecallBrief, getWhatsappOpener, extractNote, getNextStep, recordAction, suggestionQuality, getResearch, verifyByResearch, enrichLeadSocial,
} from '../services/ai.js';
import { logActivity } from '../services/leads.js';
import { llmStatus } from '../lib/llm.js';

const app = new Hono();

app.get('/status', (c) => c.json(llmStatus()));

/** Generated when a rep opens the lead, not when it was discovered. */
app.get('/leads/:id/brief', async (c) => {
  const brief = await getPrecallBrief({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
    userId: c.get('userId'),
    force: c.req.query('force') === 'true',
  });
  return c.json(brief);
});

/** Grounded web research with citations. Cached for 30 days per business. */
app.get('/leads/:id/research', async (c) => {
  const r = await getResearch({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
    force: c.req.query('force') === 'true',
  });
  return c.json(r);
});

/**
 * Check a recalled lead against the live web. Confirms existence, and pulls in
 * whatever the search found that we did not already have.
 */
app.post('/leads/:id/verify-by-research', async (c) => {
  return c.json(await verifyByResearch({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
  }));
});

/** Find the social presence and tenure that Maps and the auditor cannot. */
app.post('/leads/:id/enrich-social', async (c) => {
  return c.json(await enrichLeadSocial({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
  }));
});

/** Queue social enrichment across a filtered set. */
app.post('/enrich-social', async (c) => {
  const tenantId = c.get('tenantId');
  const b = await c.req.json().catch(() => ({}));
  const { enqueue } = await import('../lib/queue.js');

  let q = knex('leads').where({ tenant_id: tenantId }).whereNull('ig_followers');
  if (Array.isArray(b.ids) && b.ids.length) q = q.whereIn('id', b.ids);
  const rows = await q.limit(Number(b.limit || 100)).select('id');

  for (const r of rows) {
    await enqueue({ tenantId, kind: 'enrich_social', payload: { leadId: r.id, tenantId }, priority: 150 });
  }
  return c.json({ queued: rows.length });
});

app.get('/leads/:id/whatsapp', async (c) => {
  const msg = await getWhatsappOpener({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
    userId: c.get('userId'),
    force: c.req.query('force') === 'true',
  });
  return c.json(msg);
});

app.get('/leads/:id/next-step', async (c) => {
  const next = await getNextStep({
    tenantId: c.get('tenantId'),
    leadId: c.req.param('id'),
    userId: c.get('userId'),
    force: c.req.query('force') === 'true',
  });
  return c.json(next);
});

/**
 * Turn a rep's free-text note into structure, and optionally log it as the
 * activity in one round trip - that is the whole point, the rep types once.
 */
app.post('/leads/:id/extract-note', async (c) => {
  const tenantId = c.get('tenantId');
  const leadId = c.req.param('id');
  const b = await c.req.json();
  if (!b.note || !String(b.note).trim()) throw new HttpError(400, 'note is required');

  const result = await extractNote({ tenantId, leadId, note: b.note });

  let activity = null;
  if (b.logActivity !== false) {
    const e = result.output;
    const nextDueAt = e.next_due_in_days != null
      ? new Date(Date.now() + e.next_due_in_days * 86400000).toISOString()
      : null;

    activity = await logActivity({
      tenantId,
      leadId,
      userId: c.get('userId'),
      type: b.type || 'call',
      channel: b.channel || 'phone',
      body: b.note,
      outcome: e.outcome,
      extracted: e,
      nextDueAt,
    });
  }

  return c.json({ ...result, activity });
});

/**
 * Accept / edit / reject. This is not analytics decoration - it is the eval
 * dataset, and the reason the analytics page can tell you which prompt to fix.
 */
app.post('/suggestions/:id/action', async (c) => {
  const b = await c.req.json();
  const r = await recordAction({
    tenantId: c.get('tenantId'),
    suggestionId: c.req.param('id'),
    action: b.action,
    editedText: b.editedText,
  });
  return c.json(r);
});

app.get('/quality', async (c) => c.json(await suggestionQuality(c.get('tenantId'))));

/** The raw log, for eyeballing what the model has actually been producing. */
app.get('/suggestions', async (c) => {
  const rows = await knex('ai_suggestions')
    .leftJoin('leads', 'ai_suggestions.lead_id', 'leads.id')
    .where('ai_suggestions.tenant_id', c.get('tenantId'))
    .select('ai_suggestions.*', 'leads.name as lead_name')
    .orderBy('ai_suggestions.created_at', 'desc')
    .limit(Number(c.req.query('limit') || 50));
  return c.json(rows);
});

export default app;
