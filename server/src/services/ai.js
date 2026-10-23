import knex, { logUsage } from '../db/knex.js';
import {
  uid, now, sha1, normalizeUrl, normalizeHost, cleanInstagramHandle, asObject, daysSince, nameSimilarity,
  handleMatchesName, parseHumanCount, HttpError,
} from '../lib/util.js';
import {
  generatePrecallBrief,
  generateWhatsappOpener,
  extractCallNote,
  suggestNextStep,
  researchBusiness,
  enrichSocial,
} from '../lib/prompts.js';
import { renderDeep, templateVars, unresolvedTokens } from '../lib/render.js';
import { waLink, telLink, mailtoLink, adLibraryLinks, whatsappNumber } from '../lib/wa.js';

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
      // 3: the prompt now carries the verified urgent issue, Instagram activity
      // and the kind of number on file, so older drafts are stale.
      v: 3,
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
    const site = normalizeUrl(dp.website);
    if (!lead.website && site) {
      patch.website = site;
      patch.website_host = normalizeHost(site);
      patch.website_status = null;   // let the auditor decide, do not assume
    }
    const handle = cleanInstagramHandle(dp.instagram);
    if (!lead.ig_handle && handle) patch.ig_handle = handle;
    // An "estimate" is the model's word for a number it did not read off the
    // profile, so it is offered, not written. ("500 members" used to parse as
    // 500 million: any "m" in the text multiplied.)
    const estimate = lead.ig_followers == null ? parseHumanCount(dp.followers_estimate) : null;
    if (estimate !== null && estimate > 0) propose('ig_followers', estimate, (r.sources || [])[0]?.uri);
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
 * Social presence through Google search: the Instagram handle, the Facebook
 * and LinkedIn pages, and - now and then - their numbers.
 *
 * What the search is trusted with was measured, not assumed. Asked about two
 * real Pune clinics, gemini-3.6-flash at low thinking never searched once, yet
 * answered with a handle, a "last post two days ago" date, years in business,
 * and an evidence line naming pages it never opened. Across a dozen real
 * searches it returned no follower count at all. So:
 *
 *   - nothing is written unless the search actually ran (it gets two tries);
 *   - a handle is written when it reads as the business's name, otherwise it
 *     waits for a person as a candidate;
 *   - counts, post dates and tenure need a cited page from that network, and a
 *     count is only written for an account known to be theirs - otherwise it
 *     is a candidate;
 *   - a value a person typed is never overwritten.
 */
export async function enrichLeadSocial({ tenantId, leadId, force = false }) {
  const lead = await knex('leads').where({ id: leadId, tenant_id: tenantId }).first();
  if (!lead) throw new HttpError(404, 'Lead not found');

  const prov = asObject(lead.field_provenance);
  if (!force) {
    const age = daysSince(prov.social_lookup && prov.social_lookup.at);
    if (age !== null && age < 14) return { skipped: 'Searched ' + age + ' days ago', filled: 0 };
  }

  const searchedFor = (x) => (x.queries || []).length > 0 || (x.sources || []).length > 0;
  let r = await enrichSocial({ lead });
  let tries = 1;
  // Whether to search is the model's own call, made fresh each time.
  if (!r.fallback && !searchedFor(r)) { r = await enrichSocial({ lead }); tries++; }

  if (r.fallback) {
    // Throttled, timed out, out of quota: says nothing about the business, so
    // nothing is recorded and it can be tried again.
    console.warn('[social] search for "' + lead.name + '" failed: ' + r.reason);
    return { skipped: true, filled: 0, reason: 'Social search failed: ' + r.reason, retryable: Boolean(r.retryable) };
  }
  await logUsage({
    tenantId, provider: 'gemini', operation: 'social_search', units: tries,
    meta: { model: r.model, queries: (r.queries || []).length, sources: (r.sources || []).length },
  });

  const at = now();
  const d = r.data || {};
  const searched = searchedFor(r);
  const sources = (r.sources || []).filter((s) => s.uri || s.title);
  const citedFrom = (re) => sources.some((s) => re.test(String(s.title || '') + ' ' + String(s.uri || '')));
  const igCited = citedFrom(/instagram/i);
  const fbCited = citedFrom(/facebook/i);
  const liCited = citedFrom(/linkedin/i);
  const evidence = sources.find((s) => /^https?:/.test(s.uri || ''))?.uri || null;

  const social = asObject(lead.social_audit);
  const cand = { ...asObject(lead.candidates) };
  const before = Object.keys(cand).length;
  const patch = {};
  const written = [];
  const typedByPerson = (field) => prov[field] && prov[field].source === 'human';
  const propose = (field, value, note) => {
    if (value === null || value === undefined) return;
    if (lead[field] !== null && lead[field] !== undefined && String(lead[field]) === String(value)) return;
    cand[field] = { value, source: evidence, found_at: at, via: 'social_search', note };
  };
  const write = (field, value, method) => {
    if (value === null || value === undefined) return;
    if (lead[field] !== null && lead[field] !== undefined) {
      if (String(lead[field]) === String(value)) return;
      // A number an earlier search wrote is refreshed; one a person typed,
      // Instagram's API returned, or nobody recorded the source of is not.
      const src = prov[field] && prov[field].source;
      if (src !== 'gemini_search_grounding') {
        propose(field, value, 'Search found a different value from the one on file');
        return;
      }
    }
    patch[field] = value;
    prov[field] = { source: 'gemini_search_grounding', method, by: evidence, confidence: 'medium', verified_at: at };
    written.push(field);
  };

  /* ---------- Instagram ---------- */
  const existingHandle = cleanInstagramHandle(lead.ig_handle);
  const foundHandle = cleanInstagramHandle(d.instagram_handle || d.instagram_url);
  const namesMatch = Boolean(foundHandle && (handleMatchesName(foundHandle, lead.name)
    || (d.instagram_name && nameSimilarity(d.instagram_name, lead.name) >= 0.8)));
  let handle = existingHandle;
  let handleWritten = false;
  if (foundHandle && !existingHandle) {
    if (searched && namesMatch && !typedByPerson('ig_handle')) {
      patch.ig_handle = foundHandle;
      prov.ig_handle = { source: 'gemini_search_grounding', method: 'social_search', by: evidence, confidence: 'medium', verified_at: at };
      written.push('ig_handle');
      handle = foundHandle;
      handleWritten = true;
    } else {
      propose('ig_handle', foundHandle, searched
        ? 'Found by search, but the handle does not read as this business - open it and check'
        : 'Suggested without a search - open the profile and check before accepting');
    }
  }

  // Numbers are only trusted for an account known to be theirs: a handle off
  // their own website, one a person entered, or one Instagram's API confirmed -
  // and the search must have read that same account on Instagram itself. A
  // handle that merely reads like their name could be the namesake in the next
  // city, so its numbers wait for a person.
  const igSource = prov.ig_handle && prov.ig_handle.source;
  const sameAccount = Boolean(handle && foundHandle === handle);
  const ours = sameAccount && !handleWritten && ['website_audit', 'human', 'instagram_graph_api'].includes(igSource);
  const igNumbersTrusted = searched && igCited && ours;

  const followers = parseHumanCount(d.instagram_followers);
  const posts = parseHumanCount(d.instagram_posts);
  let lastPostAt = null;
  if (d.instagram_last_post_date) {
    const t = Date.parse(d.instagram_last_post_date);
    // Instagram opened in October 2010; a date after today is not a post.
    if (Number.isFinite(t) && t >= Date.parse('2010-10-06') && t <= Date.now() + 86400000) lastPostAt = new Date(t).toISOString();
  }

  if (igNumbersTrusted && followers !== null) {
    write('ig_followers', followers, 'social_search');
  } else if (searched && followers !== null && foundHandle) {
    propose('ig_followers', followers, igCited
      ? 'Read off @' + foundHandle + ' on Instagram - check it is their account'
      : 'Search gave @' + foundHandle + ' this many followers without citing Instagram - check before accepting');
  }

  // The Instagram block drives the "dormant" and "no posts" signals, so it is
  // only built from what was cited - and never over Meta's or a person's own.
  const prevIg = social.instagram || {};
  const prevIsSearch = !prevIg.found || prevIg.source === 'gemini_search_grounding';
  let igAudit = null;
  if (handle && prevIsSearch && searched && (handleWritten || sameAccount)) {
    igAudit = {
      found: true,
      handle,
      username: handle,
      name: d.instagram_name || prevIg.name || null,
      followers: igNumbersTrusted && followers !== null ? followers : prevIg.followers ?? null,
      mediaCount: igNumbersTrusted && posts !== null ? posts : prevIg.mediaCount ?? null,
      // An account with no posts has no last post, whatever an older check said.
      lastPostAt: igNumbersTrusted && posts === 0 ? null
        : igNumbersTrusted && lastPostAt ? lastPostAt : prevIg.lastPostAt ?? null,
      checkedAt: at,
      source: 'gemini_search_grounding',
      cited: igCited,
      evidence,
    };
  }

  /* ---------- Facebook and LinkedIn ---------- */
  const fbUrl = normalizeUrl(d.facebook_url);
  const fbFollowers = parseHumanCount(d.facebook_followers);
  const fbOurs = Boolean(fbUrl && /facebook\.com/i.test(fbUrl) && d.facebook_name && nameSimilarity(d.facebook_name, lead.name) >= 0.8);
  let fbAudit = null;
  if (searched && fbUrl && /facebook\.com/i.test(fbUrl)) {
    fbAudit = { found: true, url: fbUrl, name: d.facebook_name || null, followers: fbCited && fbOurs ? fbFollowers : null, checkedAt: at, source: 'gemini_search_grounding', cited: fbCited };
    if (fbCited && fbFollowers !== null) {
      if (fbOurs) write('fb_followers', fbFollowers, 'social_search');
      else propose('fb_followers', fbFollowers, 'Facebook page "' + (d.facebook_name || fbUrl) + '" - check it is theirs');
    }
  }

  const liUrl = normalizeUrl(d.linkedin_url);
  const liFollowers = parseHumanCount(d.linkedin_followers);
  const liSlug = liUrl ? (liUrl.match(/linkedin\.com\/company\/([^/?#]+)/i) || [])[1] : null;
  const liOurs = Boolean(liSlug && handleMatchesName(liSlug, lead.name));
  let liAudit = null;
  if (searched && liUrl && /linkedin\.com/i.test(liUrl)) {
    liAudit = { found: true, url: liUrl, followers: liCited && liOurs ? liFollowers : null, checkedAt: at, source: 'gemini_search_grounding', cited: liCited };
    if (liCited && liFollowers !== null) {
      if (liOurs) write('li_followers', liFollowers, 'social_search');
      else propose('li_followers', liFollowers, 'LinkedIn page ' + liUrl + ' - check it is theirs');
    }
  }

  /* ---------- Tenure and branches ---------- */
  if (searched) {
    const year = new Date().getFullYear();
    const yrs = parseHumanCount(d.years_in_business);
    const founded = parseHumanCount(d.founded_year);
    const tenure = yrs !== null && yrs > 0 && yrs < 200 ? yrs
      : founded !== null && founded > 1850 && founded <= year ? year - founded : null;
    const locs = parseHumanCount(d.locations_count);
    const branches = locs !== null && locs > 0 && locs < 10000 ? locs : null;
    const cited = sources.length > 0;
    if (lead.years_in_business == null && tenure !== null) {
      if (cited) write('years_in_business', tenure, 'social_search');
      else propose('years_in_business', tenure, 'From search without a cited page - check before accepting');
    }
    if (lead.locations_count == null && branches !== null) {
      if (cited) write('locations_count', branches, 'social_search');
      else propose('locations_count', branches, 'From search without a cited page - check before accepting');
    }
  }

  // Every completed search is recorded, found or not, so the same lead is not
  // searched again for a fortnight.
  prov.social_lookup = {
    at, searched, tries, sources: sources.length, cited: { instagram: igCited, facebook: fbCited, linkedin: liCited },
    handle: foundHandle, model: r.model,
  };

  const nextSocial = {
    ...social,
    ...(igAudit ? { instagram: igAudit } : {}),
    ...(fbAudit ? { facebook: fbAudit } : {}),
    ...(liAudit ? { linkedin: liAudit } : {}),
  };
  if (igAudit || fbAudit || liAudit) patch.social_audit = JSON.stringify(nextSocial);
  patch.candidates = JSON.stringify(cand);
  patch.field_provenance = JSON.stringify(prov);
  patch.updated_at = at;
  await knex('leads').where({ id: leadId }).update(patch);

  const { rescoreLead } = await import('./discovery.js');
  const evaluation = await rescoreLead(leadId);

  const proposed = Object.keys(cand).length - before;
  console.log(
    '[social] search for "' + lead.name + '": '
    + (searched ? 'searched (' + sources.length + ' cited page' + (sources.length === 1 ? '' : 's') + ')' : 'no search after ' + tries + ' tries')
    + (handle ? ', @' + handle : '')
    + (written.length ? ', wrote ' + written.join(', ') : ', nothing written')
    + (proposed > 0 ? ', ' + proposed + ' left for a person' : '')
    + ' (' + ((r.latencyMs || 0) / 1000).toFixed(1) + 's)'
  );

  return {
    filled: written.length,
    written,
    searched,
    sources: sources.length,
    handle: handle || null,
    handleWritten,
    social_audit: nextSocial,
    candidates: Object.keys(cand),
    evaluation,
    reason: searched
      ? (written.length || proposed > 0 ? null : 'Searched, but found nothing new for this business.')
      : 'Google search did not run for this business, so nothing was written'
        + (proposed > 0 ? ' - a suggested handle is below for you to check.' : '. Try again later, or paste the Instagram line from Google in Details.'),
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
      whatsapp: waLink(whatsappNumber(lead), rendered.opener || rendered.message || ''),
      tel: telLink(lead.phone_normalized),
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
  const number = whatsappNumber(lead);
  return {
    ...base,
    links: {
      ...base.links,
      whatsapp: waLink(number, base.output.message || ''),
      whatsappFollowUp: waLink(number, base.output.follow_up_if_no_reply || ''),
    },
    whatsappTo: number,
    canSend: Boolean(number),
    blockedReason: number
      ? null
      : lead.phone
        ? 'The phone number on this lead cannot be dialled - fix it before sending.'
        : 'No phone number on this lead - add one before sending.',
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
