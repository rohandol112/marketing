import knex, { logUsage } from '../db/knex.js';
import { lookupBusiness, mapsLookupAvailable } from '../lib/mapsDiscovery.js';
import { lookupInstagram, instagramAvailable } from '../lib/instagram.js';
import { geminiSearchAvailable, geminiKeyStatus } from '../lib/llm.js';
import { refineCategory } from '../lib/classify.js';
import { CATEGORY_BY_ID } from '../lib/categories.js';
import {
  now, addDays, asObject, daysSince, phoneInfo, normalizeHost, nameSimilarity, cleanInstagramHandle, countryFor, HttpError,
} from '../lib/util.js';
import { recordProvenance } from './lifecycle.js';
import { buildDedupeKey, rescoreLead, tenantCountry } from './discovery.js';
import { enqueue, registerHandler } from '../lib/queue.js';

/**
 * Enrichment: the numbers a directory never has, from the sources that do.
 *
 * Every value lands one of two ways. If the source is unambiguous about this
 * business, it is written with its provenance. If it might be a different
 * business, it becomes a candidate a person accepts with one click. A value a
 * person typed is never overwritten - it is offered alongside instead.
 */

const typedByPerson = (prov, field) => prov[field] && prov[field].source === 'human';

function candidate(value, source, extra = {}) {
  return { value, source: source || null, found_at: now(), ...extra };
}

/* ------------------------------------------------------------------ */
/* Google Maps                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param leadId
 * @param refresh  re-read Google fields even if present (the 30-day obligation)
 * @param force    look up even if it was checked recently or is excluded
 */
export async function enrichFromMaps({ leadId, refresh = false, force = false }) {
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!lead) return { skipped: 'Lead no longer exists' };
  if (!mapsLookupAvailable()) {
    const key = geminiKeyStatus();
    const err = new HttpError(409, key.ok === false
      ? 'Google refused GEMINI_API_KEY (' + key.reason + '). Replace it and restart to use Maps lookups.'
      : 'Google Maps lookup needs LLM_PROVIDER=gemini and a GEMINI_API_KEY with Maps grounding enabled.');
    err.retryable = false;
    throw err;
  }

  const prov = asObject(lead.field_provenance);
  if (!force && !refresh) {
    if (lead.exclusion && lead.exclusion !== 'none') return { skipped: 'Excluded: ' + (lead.exclusion_reason || lead.exclusion) };
    const age = daysSince(prov.maps_lookup && prov.maps_lookup.at);
    if (age !== null && age < 30) return { skipped: 'Looked up ' + age + ' days ago', match: prov.maps_lookup.match };
  }

  const country = countryFor(lead, await tenantCountry(lead.tenant_id));
  const r = await lookupBusiness(lead);
  await logUsage({
    tenantId: lead.tenant_id,
    provider: 'gemini',
    operation: 'maps_lookup',
    units: 1,
    meta: { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, match: r.match },
  });

  const at = now();
  const res = r.result;
  const patch = {};
  const cand = { ...asObject(lead.candidates) };
  const written = [];
  const source = (res && res.maps_url) || 'google_maps';

  if (r.match === 'strong' && res) {
    const write = (field, value) => {
      if (value === null || value === undefined) return;
      if (lead[field] !== null && lead[field] !== undefined && typedByPerson(prov, field)) {
        if (String(lead[field]) !== String(value)) cand[field] = candidate(value, source, { via: 'maps_lookup', note: 'Google Maps differs from what was typed in' });
        return;
      }
      if (String(lead[field]) === String(value)) return;
      patch[field] = value;
      written.push(field);
    };
    write('rating', res.rating);
    write('review_count', res.review_count);
    write('business_status', res.business_status);

    if (res.phone) {
      const info = phoneInfo(res.phone, country);
      if (info.valid && !lead.phone) {
        patch.phone = res.phone;
        patch.phone_normalized = info.e164;
        patch.phone_type = info.type;
        written.push('phone');
      } else if (info.valid && lead.phone_normalized !== info.e164) {
        cand.phone = candidate(res.phone, source, { via: 'maps_lookup', note: 'Google Maps lists a different number' });
      }
    }

    if (res.website && !lead.website) {
      patch.website = res.website;
      patch.website_host = normalizeHost(res.website);
      patch.website_status = null;   // the auditor decides, nothing is assumed
      written.push('website');
    }

    if (res.place_id && !lead.google_place_id) {
      const other = await knex('leads')
        .where({ tenant_id: lead.tenant_id, google_place_id: res.place_id })
        .whereNot('id', lead.id)
        .first('id', 'name');
      if (other) {
        // Two leads, one Google listing: the cleanup merges them.
        prov.duplicate_of = other.id;
        if (!lead.exclusion) {
          patch.exclusion = 'duplicate';
          patch.exclusion_reason = 'Same Google Maps listing as ' + other.name;
        }
      } else {
        patch.google_place_id = res.place_id;
        written.push('google_place_id');
      }
    }
    if (res.maps_url && (!lead.maps_url || /openstreetmap\.org|\/maps\/search\//.test(lead.maps_url))) {
      patch.maps_url = res.maps_url;
    }

    // Google's own category settles what a broad map tag could not.
    if (lead.external_source === 'openstreetmap' && res.category && !typedByPerson(prov, 'normalized_category')) {
      const refined = refineCategory(lead.normalized_category, { name: lead.name, hint: res.category });
      if (refined && refined !== lead.normalized_category && CATEGORY_BY_ID.has(refined)) {
        patch.normalized_category = refined;
        patch.category = CATEGORY_BY_ID.get(refined).label;
      }
    }

    patch.fields_refreshed_at = at;
    patch.stale_after = addDays(at, 30);
  } else if (r.match === 'medium' && res) {
    const note = 'On Maps as "' + res.name + '" (' + Math.round(r.similarity * 100) + '% name match) - check it is the same business';
    for (const [field, value] of [['review_count', res.review_count], ['rating', res.rating], ['phone', res.phone], ['website', res.website]]) {
      if (value === null || value === undefined || (lead[field] !== null && lead[field] !== undefined)) continue;
      cand[field] = candidate(value, source, { via: 'maps_lookup', note });
    }
  }

  const nextProv = recordProvenance(prov, written, {
    source: 'gemini_maps_grounding',
    method: 'maps_lookup',
    confidence: r.match === 'strong' ? 'high' : 'medium',
  });
  nextProv.maps_lookup = { at, match: r.match, similarity: r.similarity, name: res ? res.name : null, grounded: r.grounded };

  if (patch.phone) patch.dedupe_key = buildDedupeKey({ ...lead, ...patch });
  await knex('leads').where({ id: leadId }).update({
    ...patch,
    candidates: JSON.stringify(cand),
    field_provenance: JSON.stringify(nextProv),
    updated_at: at,
  });

  const evaluation = await rescoreLead(leadId);
  if (patch.website) await enqueue({ tenantId: lead.tenant_id, kind: 'audit_lead', payload: { leadId } });

  console.log(
    '[maps] lookup "' + lead.name + '": ' + r.match + (r.match === 'none' ? '' : ' match')
    + (written.length ? ', wrote ' + written.join(', ') : '')
    + (Object.keys(cand).length > Object.keys(asObject(lead.candidates)).length ? ', left candidates for a person' : '')
    + (r.ms != null ? ' (' + (r.ms / 1000).toFixed(1) + 's)' : '')
  );

  return {
    match: r.match,
    similarity: r.similarity,
    written,
    candidates: Object.keys(cand),
    found: res,
    evaluation,
  };
}

/* ------------------------------------------------------------------ */
/* Instagram                                                          */
/* ------------------------------------------------------------------ */

/**
 * Social presence for one lead, by the best route there is.
 *
 *   Meta's API     exact followers, posts and last-post date - needs a handle
 *                  and META_GRAPH_TOKEN.
 *   Google search  finds the handle and the Facebook and LinkedIn pages. It
 *                  almost never sees follower counts (measured: none in a dozen
 *                  real searches), so counts usually still come from Meta or
 *                  from a rep pasting the Instagram line off Google.
 *
 * A handle the search finds is handed straight to Meta when that is set up.
 */
export async function enrichSocialPresence({ leadId, force = false }) {
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!lead) return { skipped: 'Lead no longer exists' };

  const handle = cleanInstagramHandle(lead.ig_handle);
  if (instagramAvailable() && handle) {
    return { via: 'instagram_api', ...(await enrichInstagram({ leadId, force })) };
  }
  if (geminiSearchAvailable()) {
    const { enrichLeadSocial } = await import('./ai.js');
    const found = await enrichLeadSocial({ tenantId: lead.tenant_id, leadId, force });
    if (instagramAvailable() && !handle && found.handleWritten) {
      const exact = await enrichInstagram({ leadId, force: true });
      return { via: 'google_search+instagram_api', ...found, instagram: exact.instagram, evaluation: exact.evaluation || found.evaluation };
    }
    return { via: 'google_search', ...found };
  }
  if (instagramAvailable()) return { via: 'instagram_api', skipped: 'No Instagram handle on this lead yet - add one, or set GEMINI_API_KEY so search can find it.' };

  const key = geminiKeyStatus();
  const err = new HttpError(409, key.ok === false
    ? 'Google refused GEMINI_API_KEY (' + key.reason + '), so social search is off. Replace the key and restart - or paste the Instagram line from Google in Details.'
    : 'Social lookup is off. Set GEMINI_API_KEY for Google search, or META_GRAPH_TOKEN and INSTAGRAM_BUSINESS_ID for Instagram\'s own numbers.');
  err.retryable = false;
  throw err;
}

/** Instagram's own numbers, through Meta's Business Discovery API. */
export async function enrichInstagram({ leadId, force = false }) {
  const lead = await knex('leads').where({ id: leadId }).first();
  if (!lead) return { skipped: 'Lead no longer exists' };
  if (!instagramAvailable()) {
    const err = new HttpError(409, 'Instagram lookup is not configured. Set META_GRAPH_TOKEN and INSTAGRAM_BUSINESS_ID.');
    err.retryable = false;
    throw err;
  }
  const handle = cleanInstagramHandle(lead.ig_handle);
  if (!handle) return { skipped: 'No Instagram handle on this lead yet' };

  const social = asObject(lead.social_audit);
  const age = daysSince(social.instagram && social.instagram.checkedAt);
  if (!force && age !== null && age < 7) return { skipped: 'Checked ' + age + ' days ago', instagram: social.instagram };

  const r = await lookupInstagram(handle);
  await logUsage({ tenantId: lead.tenant_id, provider: 'instagram', operation: 'business_discovery', units: 1, meta: { found: r.found } });

  const prov = asObject(lead.field_provenance);
  const cand = { ...asObject(lead.candidates) };
  const patch = { social_audit: JSON.stringify({ ...social, instagram: r }) };
  let nextProv = prov;

  if (r.found && r.followers !== null) {
    // Is this account theirs? A handle lifted off their own site is; so is one
    // whose profile links back to their site, or carries their name.
    const fromOwnSite = prov.ig_handle && prov.ig_handle.source === 'website_audit';
    const linksBack = Boolean(r.website && lead.website_host && normalizeHost(r.website) === lead.website_host);
    const sameName = nameSimilarity(r.name || r.username, lead.name) >= 0.6;
    const source = 'https://www.instagram.com/' + handle + '/';

    if (lead.ig_followers !== null && typedByPerson(prov, 'ig_followers')) {
      if (Number(lead.ig_followers) !== r.followers) {
        cand.ig_followers = candidate(r.followers, source, { via: 'instagram_api', note: 'Instagram reports a different count' });
      }
    } else if (fromOwnSite || linksBack || sameName) {
      patch.ig_followers = r.followers;
      nextProv = recordProvenance(prov, ['ig_followers'], {
        source: 'instagram_graph_api', method: 'business_discovery', confidence: 'high', by: source,
      });
    } else {
      cand.ig_followers = candidate(r.followers, source, { via: 'instagram_api', note: 'Check @' + handle + ' is really their account' });
    }
  }

  await knex('leads').where({ id: leadId }).update({
    ...patch,
    candidates: JSON.stringify(cand),
    field_provenance: JSON.stringify(nextProv),
    updated_at: now(),
  });
  const evaluation = await rescoreLead(leadId);
  console.log(
    '[social] Instagram API @' + handle + ' for "' + lead.name + '": '
    + (r.found ? Number(r.followers || 0).toLocaleString('en-IN') + ' followers, ' + (r.mediaCount ?? '?') + ' posts'
      + (patch.ig_followers !== undefined ? ', saved' : ', left for a person to confirm') : 'not found - ' + (r.reason || 'no business account'))
  );
  return { instagram: r, written: patch.ig_followers !== undefined, evaluation };
}

registerHandler('enrich_maps', enrichFromMaps);
registerHandler('enrich_instagram', enrichInstagram);

// One lead per job, so progress shows and one failure cannot sink a batch. A
// search that failed for a passing reason - throttled, timed out - goes back
// on the queue instead of being recorded as "nothing found".
registerHandler('enrich_social', async ({ leadId }) => {
  const r = await enrichSocialPresence({ leadId });
  if (r && r.retryable) {
    const err = new Error(r.reason || 'Social search failed');
    err.retryable = true;
    throw err;
  }
});
