import knex, { logUsage } from '../db/knex.js';
import { appSearch } from '../lib/prompts.js';
import { geminiSearchAvailable, geminiKeyStatus, activeProvider } from '../lib/llm.js';
import {
  appsInHtml, packagesFromAssetLinks, appsFromAasa, searchAppStore, judgeStoreSearch, searchedStores, decideAppStatus,
} from '../lib/appPresence.js';
import { fetchSite, visibleText } from '../lib/websiteAudit.js';
import { APP_PITCH_IDS } from '../lib/categories.js';
import { now, addDays, asObject, daysSince, HttpError } from '../lib/util.js';
import { recordProvenance } from './lifecycle.js';
import { rescoreLead } from './discovery.js';
import { enqueue, registerHandler } from '../lib/queue.js';

/**
 * The app check: does this school or coaching class have an app of its own?
 *
 * Three looks, cheapest first, and the paid one only when the free ones did
 * not settle it:
 *
 *   their own site   store links, smart banners, deep links, and the
 *                    /.well-known files a domain publishes for its own apps
 *   the App Store    Apple's public search API, free and keyless
 *   Google Play      no search API exists, so the provider's web search, with
 *                    the store id required to appear in a page it returned
 *
 * The verdict rules live in lib/appPresence.js. A status a person set is never
 * overwritten - the evidence is refreshed alongside it instead.
 */

const empty = () => ({ android: [], ios: [], developerPage: false, deepLink: false, mentions: false, platform: null, assetLinks: [], aasa: [] });

async function wellKnown(origin, path, fetchImpl) {
  try {
    const res = await fetchImpl(origin + path, {
      headers: { Accept: 'application/json' },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.text()).slice(0, 200000);
    // A site that answers every path with its homepage is not vouching for an app.
    return /^\s*[[{]/.test(body) ? body : null;
  } catch {
    return null;
  }
}

/** What their own website says, from the last audit when it read apps, else fetched now. */
async function siteEvidence(lead, fetchImpl) {
  if (!lead.website || ['none', 'social_only'].includes(lead.website_status)) return { ...empty(), checked: 'no_site' };

  const audit = asObject(lead.website_audit);
  const age = daysSince(audit.checkedAt);
  let apps = Number(audit.v) >= 3 && audit.apps && age !== null && age < 30 ? audit.apps : null;
  let base = audit.finalUrl || lead.website;
  if (!apps) {
    const site = await fetchSite(lead.website, { fetchImpl });
    if (!site.ok || !site.html || site.protectedBy) return { ...empty(), checked: 'unreachable' };
    apps = appsInHtml(site.html, visibleText(site.html));
    base = site.url || base;
  }

  let origin = null;
  try { origin = new URL(base).origin; } catch { /* no origin, no well-known files */ }
  const [links, aasa] = origin
    ? await Promise.all([
      wellKnown(origin, '/.well-known/assetlinks.json', fetchImpl),
      wellKnown(origin, '/.well-known/apple-app-site-association', fetchImpl),
    ])
    : [null, null];

  return {
    ...empty(),
    ...apps,
    checked: 'read',
    assetLinks: links ? packagesFromAssetLinks(links) : [],
    aasa: aasa ? appsFromAasa(aasa) : [],
  };
}

/**
 * @param leadId
 * @param force     check again even if checked in the last 30 days, or excluded
 * @param fetchImpl for the site and the App Store; the Play search goes through llm.js
 */
export async function checkApp({ leadId, force = false, fetchImpl = fetch }) {
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!lead) return { skipped: 'Lead no longer exists' };

  const prev = asObject(lead.app_audit);
  if (!force) {
    if (lead.exclusion && lead.exclusion !== 'none') return { skipped: 'Excluded: ' + (lead.exclusion_reason || lead.exclusion) };
    const age = daysSince(prev.checkedAt);
    if (lead.app_status && age !== null && age < 30) return { skipped: 'Checked ' + age + ' days ago', status: lead.app_status };
  }
  if (!geminiSearchAvailable()) {
    const key = geminiKeyStatus();
    const err = new HttpError(409, activeProvider() === 'gemini' && key.ok === false
      ? 'Google refused GEMINI_API_KEY (' + key.reason + '), so the Google Play search is off. Replace the key and restart.'
      : 'The app check searches Google Play through the web search of the AI provider. Set OPENAI_API_KEY with LLM_PROVIDER=openai, or a working GEMINI_API_KEY with LLM_PROVIDER=gemini.');
    err.retryable = false;
    throw err;
  }

  const started = Date.now();
  const site = await siteEvidence(lead, fetchImpl);
  const appStore = await searchAppStore(lead, { fetchImpl });

  // A link on their own site settles it. The billed search is for everyone else.
  const settled = site.android.length > 0 || site.ios.length > 0 || site.assetLinks.length > 0;
  let play = { ran: false, searched: false, apps: [], possible: [], reason: 'not needed - their own site links their app' };
  let r = null;
  if (!settled) {
    r = await appSearch({ lead });
    let tries = 1;
    // Whether to search is the model's call, made fresh each time.
    if (!r.fallback && !searchedStores(r)) { r = await appSearch({ lead }); tries++; }
    if (r.fallback) {
      play = { ran: false, searched: false, apps: [], possible: [], reason: 'the Google Play search failed (' + r.reason + ')', retryable: Boolean(r.retryable) };
    } else {
      const searched = searchedStores(r);
      play = { ran: true, searched, ...judgeStoreSearch(lead, r.data, r.sources), reason: searched ? null : 'the search never looked at an app store' };
      await logUsage({
        tenantId: lead.tenant_id, provider: r.provider || 'openai', operation: 'app_search', units: tries,
        meta: { model: r.model, queries: (r.queries || []).length, sources: (r.sources || []).length, tokensIn: r.tokensIn, tokensOut: r.tokensOut },
      });
    }
  }

  const verdict = decideAppStatus({ site, appStore, play });
  const at = now();
  const audit = {
    v: 1,
    checkedAt: at,
    status: verdict.status,
    summary: verdict.summary,
    apps: verdict.apps,
    possible: verdict.possible,
    platform: verdict.platform,
    checks: {
      website: site.checked,
      appStore: appStore.ran ? 'searched' : appStore.error || 'failed',
      googlePlay: play.ran ? (play.searched ? 'searched' : 'not searched') : play.reason,
    },
    site: site.checked === 'read'
      ? { mentions: site.mentions, deepLink: site.deepLink, platform: site.platform, assetLinks: site.assetLinks, aasa: site.aasa }
      : undefined,
    queries: r ? (r.queries || []).slice(0, 8) : [],
    sources: r ? (r.sources || []).map((s) => s.uri).filter(Boolean).slice(0, 8) : [],
    model: r ? r.model : null,
    ms: Date.now() - started,
  };

  const prov = asObject(lead.field_provenance);
  const byPerson = prov.app_status && prov.app_status.source === 'human';
  const patch = { updated_at: at };
  if (!verdict.status && lead.app_status) {
    // An inconclusive look says nothing new: keep the last real answer and note the attempt.
    patch.app_audit = JSON.stringify({ ...prev, lastAttempt: { at, summary: verdict.summary } });
  } else {
    patch.app_audit = JSON.stringify(audit);
    if (verdict.status && !byPerson) {
      patch.app_status = verdict.status;
      const first = verdict.apps[0];
      patch.field_provenance = JSON.stringify(recordProvenance(prov, ['app_status'], {
        source: 'app_check',
        method: first ? first.via : 'store_search',
        by: first ? first.url : audit.sources[0] || null,
        confidence: verdict.status === 'unclear' ? 'low' : 'high',
      }));
    }
  }
  await knex('leads').where({ id: leadId }).update(patch);
  const evaluation = await rescoreLead(leadId);

  console.log(
    '[apps] "' + lead.name + '": ' + (verdict.status || 'not settled') + ' - ' + verdict.summary
    + (byPerson && verdict.status ? ' (kept the status a person set: ' + lead.app_status + ')' : '')
    + ' (' + ((Date.now() - started) / 1000).toFixed(1) + 's)'
  );

  return {
    status: byPerson ? lead.app_status : verdict.status || lead.app_status || null,
    found: verdict.status,
    summary: verdict.summary,
    apps: verdict.apps,
    possible: verdict.possible,
    checks: audit.checks,
    retryable: !verdict.status && Boolean(play.retryable),
    evaluation,
  };
}

/**
 * Queue app checks, the leads a rep would ring first at the top: a number on
 * file, then deal readiness, then demand. Schools, colleges, coaching classes
 * and preschools unless ids are given; never anything excluded, disqualified,
 * already queued, a person has answered, or checked in the last 30 days.
 */
export async function queueAppChecks({ tenantId, ids = null, runId = null, limit = 100, refresh = false }) {
  if (!geminiSearchAvailable()) return { queued: 0, available: false };
  const cutoff = addDays(now(), -30);

  let q = knex('leads')
    .where({ tenant_id: tenantId, disqualified: false })
    .andWhere((qb) => qb.whereNull('exclusion').orWhere('exclusion', 'none'))
    .andWhere((qb) => qb.whereNull('discovery_status').orWhereNot('discovery_status', 'rejected'))
    .whereNotExists(
      knex('jobs')
        .whereIn('jobs.status', ['queued', 'running'])
        .andWhere('jobs.kind', 'app_check')
        .andWhereRaw("jobs.payload->>'leadId' = leads.id")
    );
  if (Array.isArray(ids) && ids.length) q = q.whereIn('id', ids);
  else q = q.whereIn('normalized_category', APP_PITCH_IDS);
  if (runId) q = q.where('run_id', runId);
  if (!refresh) {
    q = q
      .andWhere((qb) => qb.whereNull('app_status').orWhereRaw("(app_audit->>'checkedAt') < ?", [cutoff]))
      .whereRaw("coalesce(field_provenance->'app_status'->>'source', '') <> 'human'");
  }

  const rows = await q
    .orderByRaw('case when phone_normalized is not null then 0 else 1 end')
    .orderByRaw('deal_score desc nulls last, review_count desc nulls last')
    .limit(Math.min(Number(limit) || 100, 500))
    .select('id');

  for (const r of rows) {
    await enqueue({ tenantId, kind: 'app_check', payload: { leadId: r.id } });
  }
  return { queued: rows.length, available: true };
}

/** Where the app-pitch categories stand, for the queue's header. */
export async function appCheckSummary(tenantId) {
  const [rows, queued] = await Promise.all([
    knex('leads')
      .where({ tenant_id: tenantId, disqualified: false })
      .whereIn('normalized_category', APP_PITCH_IDS)
      .andWhere((qb) => qb.whereNull('exclusion').orWhere('exclusion', 'none'))
      .andWhere((qb) => qb.whereNull('discovery_status').orWhereNot('discovery_status', 'rejected'))
      .select(knex.raw("coalesce(app_status, 'unchecked') as status"))
      .count({ n: '*' })
      .groupByRaw("coalesce(app_status, 'unchecked')"),
    knex('jobs').where({ tenant_id: tenantId, kind: 'app_check' }).whereIn('status', ['queued', 'running']).count({ n: '*' }).first(),
  ]);
  const counts = { no_app: 0, unclear: 0, has_app: 0, white_label: 0, unchecked: 0 };
  for (const r of rows) counts[r.status] = Number(r.n);
  return { counts, queued: Number(queued.n), available: geminiSearchAvailable() };
}

registerHandler('app_check', async ({ leadId }) => {
  const r = await checkApp({ leadId });
  // Throttled or timed out: nothing was learned, so try again later rather
  // than leave the lead unchecked for good.
  if (r && r.retryable) {
    const err = new Error(r.summary || 'App check failed');
    err.retryable = true;
    throw err;
  }
});
