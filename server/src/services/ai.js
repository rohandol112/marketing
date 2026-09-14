import knex, { logUsage } from '../db/knex.js';
import { uid, now, sha1 } from '../lib/util.js';
import {
  generatePrecallBrief,
  generateWhatsappOpener,
  extractCallNote,
  suggestNextStep,
  researchBusiness,
  enrichSocial,
} from '../lib/prompts.js';
import { renderDeep, templateVars, unresolvedTokens } from '../lib/render.js';
import { waLink, telLink, mailtoLink, adLibraryLinks } from '../lib/wa.js';

/**
 * The AI layer.
 *
 * Two rules the rest of the app depends on:
 *   1. Nothing is generated on ingest. Suggestions are produced lazily when a
 *      rep actually opens a lead, and cached on the inputs that would change
 *      the answer. A 200-lead sweep that eagerly generated briefs would burn a
 *      day of quota on leads nobody opens.
 *   2. Every suggestion is logged with what the rep did to it. Accept, edit and
 *      reject are the eval dataset. Without them there is no way to know which
 *      prompt is broken, and no number to show the next agency you sell this to.
 */

async function tenantContext(tenantId) {
  const [tenant, catalog, packages] = await Promise.all([
    knex('tenants').where({ id: tenantId }).first(),
    knex('service_catalog').where({ tenant_id: tenantId, active: true }).orderBy('group_name'),
    knex('packages').where({ tenant_id: tenantId, active: true }).orderBy('sort_order'),
  ]);
  if (!tenant) throw new Error('Tenant not found: ' + tenantId);
  return { tenant, catalog, packages };
}

/**
 * The cache key is every input that should change the answer, and nothing else.
 * Opening the same lead twice must not cost a second request.
 */
function cacheKey(kind, lead, extra = {}) {
  return sha1(
    JSON.stringify({
      kind,
      lead: lead.id,
      stage: lead.stage,
      score: lead.score,
      website: lead.website_status,
      ig: lead.ig_followers,
      li: lead.li_followers,
      reviews: lead.review_count,
      lastActivity: extra.lastActivityId || null,
      note: extra.noteHash || null,
      v: 2,
    })
  );
}

async function findCached(tenantId, kind, hash) {
  return knex('ai_suggestions')
    .where({ tenant_id: tenantId, kind, input_hash: hash })
    .orderBy('created_at', 'desc')
    .first();
}

async function persist({ tenantId, leadId, kind, stage, hash, result }) {
  const id = uid('ai_');
  await knex('ai_suggestions').insert({
    id,
    tenant_id: tenantId,
    lead_id: leadId,
    kind,
    stage,
    input_hash: hash,
    output: JSON.stringify(result.data),
    model: result.model,
    latency_ms: result.latencyMs,
    tokens_in: result.tokensIn,
    tokens_out: result.tokensOut,
    fallback: !!result.fallback,
    created_at: now(),
  });
  if (!result.fallback) {
    await logUsage({
      tenantId,
      provider: 'gemini',
      operation: kind,
      units: 1,
      meta: { model: result.model, tokensIn: result.tokensIn, tokensOut: result.tokensOut },
    });
  }
  return id;
}

function shape(row, extra = {}) {
  return {
    id: row.id,
    kind: row.kind,
    output: typeof row.output === 'string' ? JSON.parse(row.output) : row.output,
    model: row.model,
    latencyMs: row.latency_ms,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    fallback: !!row.fallback,
    action: row.action || null,
    cached: !!extra.cached,
    createdAt: row.created_at,
    ...extra,
  };
}

/* ------------------------------------------------------------------ */
/* Grounded research                                                  */
/* ------------------------------------------------------------------ */

/**
 * Research is cached far more aggressively than a brief.
 *
 * A brief changes whenever the score does. What a hospital *is* does not - so
 * research keys only on the business identity and is reused across every later
 * brief, message and next-step for that lead. It is the expensive call
 * (grounded search, ~2.5k tokens) and it should be paid for once.
 */
export async function getResearch({ tenantId, leadId, force = false, maxAgeDays = 30 }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new Error('Lead not found');

  const hash = sha1(JSON.stringify({
    kind: 'research', name: lead.name, locality: lead.locality,
    category: lead.normalized_category, website: lead.website, v: 1,
  }));

  if (!force) {
    const cached = await findCached(tenantId, 'research', hash);
    if (cached) {
      const ageDays = (Date.now() - new Date(cached.created_at).getTime()) / 86400000;
      if (ageDays < maxAgeDays) {
        return { ...shape(cached, { cached: true }), sources: cached.output?.__sources || [] };
      }
    }
  }

  const result = await researchBusiness({ lead });

  // Citations travel with the research, so a rep can check any claim it made.
  const payload = { ...result.data, __sources: result.sources || [], __grounded: result.grounded };
  const id = await persist({
    tenantId, leadId, kind: 'research', stage: lead.stage, hash,
    result: { ...result, data: payload },
  });

  return {
    id,
    kind: 'research',
    output: payload,
    sources: result.sources || [],
    queries: result.queries || [],
    grounded: result.grounded,
    model: result.model,
    latencyMs: result.latencyMs,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    fallback: result.fallback,
    reason: result.reason,
    cached: false,
  };
}

/**
 * Confirm a recalled lead actually exists, using grounded search.
 *
 * Gemini will not invoke Google Search for an open-ended "list businesses in
 * this area" prompt - measured repeatedly, it answers from memory and returns
 * no groundingMetadata. It *does* search reliably when asked about one specific
 * named business.
 *
 * So the two capabilities compose: recall proposes a name, grounded research
 * checks whether that name corresponds to a real business with a real web
 * footprint. A lead that comes back with citations has been evidenced; one that
 * does not stays a candidate.
 */
export async function verifyByResearch({ tenantId, leadId }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new Error('Lead not found');

  const r = await getResearch({ tenantId, leadId, force: true });
  const found = r.output || {};
  const confirmed = r.grounded && (r.sources || []).length > 0 && found.confidence !== 'low';

  const patch = { updated_at: now() };
  const prov = { ...(lead.field_provenance || {}) };

  if (confirmed) {
    patch.external_source = 'gemini_grounded';
    patch.external_id = 'g:' + String(lead.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
    prov.groundingSources = (r.sources || []).slice(0, 5).map((x) => x.uri).filter(Boolean);
    prov.research_verification = { at: now(), method: 'grounded_search', sources: (r.sources || []).length };

    /**
     * Retrieved values become candidates, never direct writes. A rep accepts
     * them with one click and the source travels with the value - which is the
     * difference between "the AI said so" and "here is the page it read".
     */
    const contact = found.contact || {};
    const cand = { ...(lead.candidates || {}) };
    const propose = (field, value, source) => {
      if (value === null || value === undefined || value === '') return;
      cand[field] = { value, source: source || null, found_at: now(), via: 'grounded_search' };
    };

    // A "source" that is an image or asset file is not something a rep can read
    // a number off. Require a page.
    const citable = (u) => typeof u === 'string' && /^https?:\/\//i.test(u) &&
      !/\.(png|jpe?g|gif|webp|svg|css|js|ico|pdf)(\?|$)/i.test(u);

    if (!lead.phone && contact.phone && citable(contact.phone_source)) {
      propose('phone', String(contact.phone).trim(), contact.phone_source);
    }
    if (lead.review_count == null && contact.google_reviews) {
      propose('review_count', Number(contact.google_reviews), 'google');
    }
    if (lead.rating == null && contact.google_rating) {
      propose('rating', Number(contact.google_rating), 'google');
    }

    // Anything the search actually found and we did not already have.
    const dp = found.digital_presence || {};
    if (!lead.website && dp.website) {
      patch.website = dp.website;
      patch.website_status = null;   // let the auditor decide, do not assume
    }
    if (!lead.ig_handle && dp.instagram) patch.ig_handle = String(dp.instagram).replace('@', '');
    if (lead.ig_followers == null && dp.followers_estimate) {
      const n = Number(String(dp.followers_estimate).replace(/[^0-9.]/g, ''));
      const mult = /k/i.test(String(dp.followers_estimate)) ? 1000 : /m/i.test(String(dp.followers_estimate)) ? 1000000 : 1;
      if (Number.isFinite(n) && n > 0) patch.ig_followers = Math.round(n * mult);
    }
    if (dp.website && !lead.website) propose('website', dp.website, (r.sources || [])[0]?.uri);
    if (Object.keys(cand).length) patch.candidates = JSON.stringify(cand);
    patch.field_provenance = JSON.stringify(prov);
  }

  await knex('leads').where({ id: leadId }).update(patch);

  const { rescoreLead } = await import('./discovery.js');
  const evaluation = await rescoreLead(leadId);

  if (confirmed && patch.website) {
    const { enqueue } = await import('../lib/queue.js');
    await enqueue({ tenantId, kind: 'audit_lead', payload: { leadId } });
  }

  return {
    confirmed,
    sources: (r.sources || []).length,
    grounded: r.grounded,
    found: confirmed
      ? {
          website: patch.website,
          ig_handle: patch.ig_handle,
          ig_followers: patch.ig_followers,
          candidates: patch.candidates ? JSON.parse(patch.candidates) : null,
        }
      : null,
    evaluation,
    reason: confirmed ? null : (r.reason || 'Search returned no citations for this business - it may not exist.'),
  };
}


/**
 * Fill the social columns nothing else can reach.
 *
 * Maps grounding gives phone, rating, reviews and address. The website auditor
 * lifts handles off a business's own site. Neither gives a follower count, and
 * there is no lawful API that does - the Instagram Graph API needs the business
 * to grant access, and scraping profiles breaks Meta terms and stops working
 * within weeks. Search is the one route that stays legitimate.
 *
 * Numbers land as candidates with their evidence, same as a retrieved phone:
 * a person accepts them, and the provenance survives.
 */
export async function enrichLeadSocial({ tenantId, leadId }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new Error('Lead not found');

  const r = await enrichSocial({ lead });

  /**
   * If the search tool did not fire, this is recall and the numbers are
   * fiction - measured: PNG Jewellers came back at 453 Instagram followers,
   * off by orders of magnitude. Writing that as a candidate would put an
   * invented figure in front of a rep with a provenance label on it, which is
   * worse than leaving the column empty.
   */
  if (!r.grounded) {
    return {
      filled: 0,
      grounded: false,
      sources: 0,
      handle: lead.ig_handle || null,
      candidates: {},
      skipped: true,
      reason: 'Search did not ground for this business, so nothing was written. '
        + (r.reason || 'Retry later, or fill the followers in by hand.'),
    };
  }

  const d = r.data || {};
  const patch = { updated_at: now() };
  const cand = { ...(lead.candidates || {}) };
  const prov = { ...(lead.field_provenance || {}) };
  let filled = 0;

  const toNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const raw = String(v).trim();
    const n = Number(raw.replace(/[^0-9.]/g, ''));
    if (!Number.isFinite(n) || n <= 0) return null;
    const mult = /m|million/i.test(raw) ? 1e6 : /k|thousand/i.test(raw) ? 1e3 : 1;
    return Math.round(n * mult);
  };

  // A handle is cheap to verify by eye, so it goes straight on the lead.
  const handle = typeof d.instagram_handle === 'string'
    ? d.instagram_handle.replace('@', '').trim() : null;
  if (!lead.ig_handle && handle) {
    patch.ig_handle = handle;
    prov.ig_handle = { source: 'grounded_search', method: 'social_enrichment', verified_at: now() };
    filled++;
  }

  // A number a rep will quote out loud does not go on the record unasked.
  const propose = (field, value, note) => {
    if (value === null) return;
    cand[field] = { value, source: d.evidence || note || 'grounded search', found_at: now(), via: 'social_enrichment' };
    filled++;
  };

  if (lead.ig_followers == null) propose('ig_followers', toNum(d.instagram_followers));
  if (lead.li_followers == null) propose('li_followers', toNum(d.linkedin_followers));
  if (lead.fb_followers == null) propose('fb_followers', toNum(d.facebook_followers));
  if (lead.locations_count == null) propose('locations_count', toNum(d.locations_count));

  if (lead.years_in_business == null) {
    const yrs = toNum(d.years_in_business);
    const founded = toNum(d.founded_year);
    const derived = yrs || (founded && founded > 1850 && founded <= new Date().getFullYear()
      ? new Date().getFullYear() - founded : null);
    propose('years_in_business', derived, founded ? 'founded ' + founded : null);
  }

  if (Object.keys(cand).length) patch.candidates = JSON.stringify(cand);
  patch.field_provenance = JSON.stringify(prov);
  await knex('leads').where({ id: leadId }).update(patch);

  const { rescoreLead } = await import('./discovery.js');
  const evaluation = await rescoreLead(leadId);

  return {
    filled,
    grounded: r.grounded,
    sources: (r.sources || []).length,
    handle: patch.ig_handle || lead.ig_handle || null,
    candidates: cand,
    evaluation,
    reason: r.reason,
  };
}

/* ------------------------------------------------------------------ */
/* Pre-call brief                                                     */
/* ------------------------------------------------------------------ */

export async function getPrecallBrief({ tenantId, leadId, userId, force = false }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new Error('Lead not found');

  const hash = cacheKey('precall_brief', lead);
  if (!force) {
    const cached = await findCached(tenantId, 'precall_brief', hash);
    if (cached) return decorate(shape(cached, { cached: true }), lead, tenantId, userId);
  }

  const { tenant, catalog, packages } = await tenantContext(tenantId);

  // Research first, brief second. The brief is only as good as what it knows,
  // and scored observations alone produce advice that fits any business in the
  // category rather than this one.
  let research = null;
  try {
    const r = await getResearch({ tenantId, leadId });
    if (!r.fallback) research = r.output;
  } catch (e) {
    console.warn('[ai] research step failed, briefing on observations only:', e.message);
  }

  const result = await generatePrecallBrief({ tenant, catalog, packages, lead, research });
  const id = await persist({ tenantId, leadId, kind: 'precall_brief', stage: lead.stage, hash, result });

  return decorate(
    {
      id,
      kind: 'precall_brief',
      output: result.data,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      fallback: result.fallback,
      reason: result.reason,
      research,
      cached: false,
      action: null,
    },
    lead,
    tenantId,
    userId
  );
}

/**
 * Template tokens are filled here, from the database. The model never saw a
 * phone number and never will.
 */
async function decorate(suggestion, lead, tenantId, userId) {
  const [tenant, user] = await Promise.all([
    knex('tenants').where({ id: tenantId }).first(),
    userId ? knex('users').where({ id: userId }).first() : null,
  ]);
  const vars = templateVars({ lead, user, tenant });
  const rendered = renderDeep(suggestion.output, vars);

  const missing = new Set();
  const collect = (v) => {
    if (typeof v === 'string') unresolvedTokens(v, vars).forEach((t) => missing.add(t));
    else if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(suggestion.output);

  return {
    ...suggestion,
    output: rendered,
    raw: suggestion.output,
    unresolved: [...missing],
    links: {
      whatsapp: waLink(lead.phone, rendered.opener || rendered.message || ''),
      tel: telLink(lead.phone),
      mailto: mailtoLink(lead.email, 'A quick look at ' + lead.name, rendered.message || ''),
      ...adLibraryLinks(lead),
    },
  };
}

/* ------------------------------------------------------------------ */
/* WhatsApp opener                                                    */
/* ------------------------------------------------------------------ */

export async function getWhatsappOpener({ tenantId, leadId, userId, force = false }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new Error('Lead not found');

  const hash = cacheKey('whatsapp_opener', lead);
  if (!force) {
    const cached = await findCached(tenantId, 'whatsapp_opener', hash);
    if (cached) return decorateWa(shape(cached, { cached: true }), lead, tenantId, userId);
  }

  const { tenant, catalog, packages } = await tenantContext(tenantId);
  const result = await generateWhatsappOpener({ tenant, catalog, packages, lead });
  const id = await persist({ tenantId, leadId, kind: 'whatsapp_opener', stage: lead.stage, hash, result });

  return decorateWa(
    {
      id,
      kind: 'whatsapp_opener',
      output: result.data,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      fallback: result.fallback,
      reason: result.reason,
      cached: false,
      action: null,
    },
    lead,
    tenantId,
    userId
  );
}

async function decorateWa(suggestion, lead, tenantId, userId) {
  const base = await decorate(suggestion, lead, tenantId, userId);
  return {
    ...base,
    links: {
      ...base.links,
      whatsapp: waLink(lead.phone, base.output.message || ''),
      whatsappFollowUp: waLink(lead.phone, base.output.follow_up_if_no_reply || ''),
    },
    canSend: Boolean(lead.phone),
    blockedReason: lead.phone ? null : 'No phone number on this lead - add one before sending.',
  };
}

/* ------------------------------------------------------------------ */
/* Call-note extraction                                               */
/* ------------------------------------------------------------------ */

export async function extractNote({ tenantId, leadId, note }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new Error('Lead not found');

  const hash = cacheKey('note_extract', lead, { noteHash: sha1(note) });
  const cached = await findCached(tenantId, 'note_extract', hash);
  if (cached) return shape(cached, { cached: true });

  const { tenant, catalog, packages } = await tenantContext(tenantId);
  const result = await extractCallNote({ tenant, catalog, packages, lead, note });
  const id = await persist({ tenantId, leadId, kind: 'note_extract', stage: lead.stage, hash, result });

  return {
    id,
    kind: 'note_extract',
    output: result.data,
    model: result.model,
    provider: result.provider,
    latencyMs: result.latencyMs,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    fallback: result.fallback,
    reason: result.reason,
    cached: false,
  };
}

/* ------------------------------------------------------------------ */
/* Stage-aware next step                                              */
/* ------------------------------------------------------------------ */

/**
 * Stage on its own produces horoscopes. What makes the suggestion worth reading
 * is the activity log plus what actually closed in this category before.
 */
async function categoryPatterns(tenantId, lead) {
  if (!lead.normalized_category) return null;

  const rows = await knex('leads')
    .where({ tenant_id: tenantId, normalized_category: lead.normalized_category })
    .whereIn('stage', ['success', 'failed'])
    .select('stage', 'loss_reason', 'won_amount', 'score')
    .limit(50);

  if (rows.length < 3) return null;

  const won = rows.filter((r) => r.stage === 'success');
  const lost = rows.filter((r) => r.stage === 'failed');
  const lossCounts = {};
  for (const l of lost) {
    if (l.loss_reason) lossCounts[l.loss_reason] = (lossCounts[l.loss_reason] || 0) + 1;
  }
  const topLoss = Object.entries(lossCounts).sort((a, b) => b[1] - a[1])[0];

  const parts = [
    won.length + ' won and ' + lost.length + ' lost in this category so far.',
  ];
  if (won.length) {
    const amounts = won.map((w) => w.won_amount).filter(Boolean);
    if (amounts.length) {
      parts.push('Typical closed amount: ' + Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length) + '.');
    }
    parts.push('Average score of a won lead: ' + Math.round(won.reduce((a, b) => a + b.score, 0) / won.length) + '.');
  }
  if (topLoss) parts.push('Most common loss reason: ' + topLoss[0] + ' (' + topLoss[1] + ' times).');

  return parts.join(' ');
}

export async function getNextStep({ tenantId, leadId, userId, force = false }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new Error('Lead not found');

  const activities = await knex('activities')
    .where({ lead_id: leadId })
    .orderBy('occurred_at', 'desc')
    .limit(5);

  const hash = cacheKey('stage_next', lead, { lastActivityId: activities[0]?.id || null });
  if (!force) {
    const cached = await findCached(tenantId, 'stage_next', hash);
    if (cached) return decorate(shape(cached, { cached: true }), lead, tenantId, userId);
  }

  const { tenant, catalog, packages } = await tenantContext(tenantId);
  const patterns = await categoryPatterns(tenantId, lead);
  const result = await suggestNextStep({
    tenant, catalog, packages, lead, stage: lead.stage, activities, patterns,
  });
  const id = await persist({ tenantId, leadId, kind: 'stage_next', stage: lead.stage, hash, result });

  return decorate(
    {
      id,
      kind: 'stage_next',
      output: result.data,
      model: result.model,
      provider: result.provider,
      latencyMs: result.latencyMs,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      fallback: result.fallback,
      reason: result.reason,
      cached: false,
      action: null,
    },
    lead,
    tenantId,
    userId
  );
}

/* ------------------------------------------------------------------ */
/* Feedback - the part that makes the rest worth having                */
/* ------------------------------------------------------------------ */

export async function recordAction({ tenantId, suggestionId, action, editedText }) {
  if (!['accepted', 'edited', 'rejected'].includes(action)) {
    throw new Error('action must be accepted, edited or rejected');
  }
  const n = await knex('ai_suggestions')
    .where({ id: suggestionId, tenant_id: tenantId })
    .update({ action, edited_text: editedText || null, acted_at: now() });
  if (!n) throw new Error('Suggestion not found');
  return { ok: true };
}

/** Accept rate per prompt per stage. Under 40% at any stage means it is broken. */
export async function suggestionQuality(tenantId) {
  const rows = await knex('ai_suggestions')
    .where({ tenant_id: tenantId })
    .whereNotNull('action')
    .select('kind', 'stage', 'action', 'fallback')
    .count('* as n')
    .groupBy('kind', 'stage', 'action', 'fallback');

  const byKind = {};
  for (const r of rows) {
    const key = r.kind + (r.stage ? '@' + r.stage : '');
    byKind[key] ||= { kind: r.kind, stage: r.stage, accepted: 0, edited: 0, rejected: 0, total: 0 };
    byKind[key][r.action] += Number(r.n);
    byKind[key].total += Number(r.n);
  }

  return Object.values(byKind)
    .map((b) => ({
      ...b,
      acceptRate: b.total ? Math.round(((b.accepted + b.edited) / b.total) * 100) : null,
      cleanAcceptRate: b.total ? Math.round((b.accepted / b.total) * 100) : null,
      verdict: b.total < 10 ? 'not enough data' : (b.accepted + b.edited) / b.total < 0.4 ? 'BROKEN - rewrite this prompt' : 'ok',
    }))
    .sort((a, b) => b.total - a.total);
}
