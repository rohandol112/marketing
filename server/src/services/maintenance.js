import knex from '../db/knex.js';
import config from '../config.js';
import {
  uid, now, addDays, asObject, tidyText, normalizeUrl, normalizeHost, normalizeLocality, normalizeName, cleanEmail,
  cleanInstagramHandle, nameSimilarity, haversineMeters, phoneInfo, phoneFields, countryFor, addressKey,
} from '../lib/util.js';
import { detectExclusion, refineCategory, platformOf } from '../lib/classify.js';
import { auditWebsite } from '../lib/websiteAudit.js';
import { isOfflinePoint } from '../lib/geo.js';
import { CATEGORY_BY_ID } from '../lib/categories.js';
import { buildDedupeKey, getScoringConfig, suppressionKeys, tenantCountry, refreshStaleLeads } from './discovery.js';
import { evaluationPatch } from './lifecycle.js';
import { enqueue, registerHandler } from '../lib/queue.js';

/**
 * Data maintenance: the cleanup that keeps the lead table worth trusting.
 *
 * Every run does the same steps in the same order, and every one of them can be
 * previewed first - a dry run computes the full report and writes nothing.
 *
 *   1. normalise   phones read in the right country, emails and handles that are
 *                  real, one spelling per locality, dedupe keys rebuilt
 *   2. reclassify  directory leads filed under the wrong category
 *   3. exclude     chains, government bodies and placeholder listings
 *   4. merge       the same business entered twice; activities, AI history and
 *                  proposals move to the survivor before anything is removed
 *   5. housekeep   finished jobs, old usage rows, unused AI cache, orphaned
 *                  runs, and rejected leads past their retention
 *   6. rescore     everything, so the queue reflects what changed
 *   7. vacuum      reclaim what was deleted
 *
 * Nothing a person decided is undone: a human-cleared exclusion stays cleared,
 * a human-typed value is never "normalised" into something else, and leads in
 * the sales pipeline are never merged automatically or purged.
 *
 * What was removed leaves its keys in lead_suppressions, so the next sweep does
 * not quietly bring it back, and the full report is kept in maintenance_runs.
 */

const SAMPLE = 15;
const BATCH = 500;

const LIGHT_COLUMNS = [
  'id', 'tenant_id', 'name', 'category', 'normalized_category', 'phone', 'phone_normalized', 'phone_type', 'email',
  'website', 'website_host', 'website_status', 'ig_handle', 'ig_followers', 'li_followers', 'fb_followers',
  'years_in_business', 'locations_count', 'locality', 'postal_code', 'country_code', 'address', 'lat', 'lng', 'distance_m',
  'rating', 'review_count', 'business_status', 'google_place_id', 'external_id', 'external_source', 'dedupe_key',
  'exclusion', 'exclusion_reason', 'status', 'stage', 'discovery_status', 'disqualified', 'assigned_to',
  'activity_count', 'last_activity_at', 'verified_at', 'verified_by', 'confidence', 'created_at', 'updated_at',
  'run_id', 'source_url', 'maps_url', 'candidates',
];

/** Fields a person can type. Normalising these rewrites only the derived columns. */
const HUMAN_TEXT = ['name', 'email', 'ig_handle', 'locality', 'website'];

/** Name words too common to prove two places are one chain. */
const COMMON_NAME_WORDS = new Set([
  'sai', 'shree', 'shri', 'sri', 'om', 'jai', 'ganesh', 'ganesha', 'laxmi', 'lakshmi', 'mahalaxmi', 'balaji',
  'krishna', 'durga', 'siddhivinayak', 'gurukrupa', 'datta', 'new', 'royal', 'star', 'city', 'modern', 'super',
  'clinic', 'hospital', 'medical', 'dental', 'care', 'centre', 'center', 'store', 'shop', 'hotel', 'cafe',
  'restaurant', 'salon', 'gym', 'school', 'the', 'and', 'of', 'dr', 'india', 'enterprises', 'traders',
]);

/** Categories where one name at many places is the product brand on dealer showrooms. */
const BRANDED_DEALERS = new Set(['car_dealer', 'car_service']);

const same = (a, b) => (a === null || a === undefined ? null : a) === (b === null || b === undefined ? null : b);

/** addDays() truncates fractions (Date#setDate does), so hours need their own helper. */
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

function newReport(tenantId, dryRun, trigger) {
  return {
    tenantId,
    dryRun,
    trigger,
    startedAt: now(),
    steps: {},
    totals: {},
  };
}

/* ------------------------------------------------------------------ */
/* Plan: an in-memory model of the tenant's leads, edited step by step */
/* ------------------------------------------------------------------ */

class Plan {
  constructor(leads) {
    this.leads = leads;
    this.byId = new Map(leads.map((l) => [l.id, l]));
    this.patches = new Map();
    this.removed = new Set();
    this.audits = new Map();      // id -> website_audit to write
  }

  /** Change a field on the model, remembering it for the write phase. */
  set(lead, field, value) {
    if (same(lead[field], value)) return false;
    let p = this.patches.get(lead.id);
    if (!p) { p = {}; this.patches.set(lead.id, p); }
    p[field] = value;
    lead[field] = value;
    return true;
  }

  live() {
    return this.leads.filter((l) => !this.removed.has(l.id));
  }
}

/* ------------------------------------------------------------------ */
/* 1. normalise                                                       */
/* ------------------------------------------------------------------ */

async function normalise(plan, country) {
  const s = { scanned: plan.leads.length, changed: 0, fields: {}, samples: [] };

  for (const l of plan.leads) {
    const changes = [];
    const prov = asObject(l.field_provenance_human);
    const mark = (field, value) => {
      const before = l[field];
      if (plan.set(l, field, value)) {
        s.fields[field] = (s.fields[field] || 0) + 1;
        changes.push({ field, from: before, to: value });
      }
    };

    // A typed value keeps its wording; only what is derived from it changes.
    const typed = (field) => Boolean(prov[field]);

    if (!typed('name')) mark('name', tidyText(l.name) || l.name);

    const phones = phoneFields(l.phone, countryFor(l, country));
    mark('phone_normalized', phones.phone_normalized);
    mark('phone_type', phones.phone_type);

    if (l.email && !typed('email')) mark('email', cleanEmail(l.email));
    if (l.ig_handle && !typed('ig_handle')) mark('ig_handle', cleanInstagramHandle(l.ig_handle));

    if (l.website) {
      const url = normalizeUrl(l.website);
      if (!typed('website')) mark('website', url);
      mark('website_host', normalizeHost(url || l.website));
      if (!url) {
        if (l.website_status && !['none', 'unknown'].includes(l.website_status)) mark('website_status', 'unknown');
      } else if (platformOf(url) && l.website_status !== 'social_only') {
        // A Facebook page or a dead Google Business Profile link is not a
        // website, and saying so needs no network call.
        const a = await auditWebsite(url);
        mark('website_status', a.website_status);
        plan.audits.set(l.id, a.website_audit);
      }
    } else if (l.website_host) {
      mark('website_host', null);
    }

    // A point off the area picker's offline list is not where a business is.
    // Geocoding used to fall back to it for any address OpenStreetMap could not
    // read, so whole sweeps of Kothrud clinics sat on "Aundh" - and were then
    // excluded as out of the area. A directory's own coordinates are left be.
    if (l.lat != null && l.external_source !== 'openstreetmap' && isOfflinePoint(l.lat, l.lng)) {
      mark('lat', null);
      mark('lng', null);
      mark('distance_m', null);
      if (l.exclusion === 'out_of_area' && /^About [\d.]+ km from the centre of the /.test(l.exclusion_reason || '')) {
        mark('exclusion', null);
        mark('exclusion_reason', null);
      }
    }

    if (l.locality && !typed('locality')) mark('locality', normalizeLocality(l.locality));
    if (l.postal_code) {
      const pc = tidyText(l.postal_code);
      mark('postal_code', pc && /^\d{3}\s\d{3}$/.test(pc) ? pc.replace(/\s/g, '') : pc);
    }

    mark('dedupe_key', buildDedupeKey(l));

    if (changes.length) {
      s.changed++;
      if (s.samples.length < SAMPLE) s.samples.push({ id: l.id, name: l.name, changes });
    }
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 2. reclassify                                                      */
/* ------------------------------------------------------------------ */

/**
 * Leads swept before element tags were kept only have their name to go on.
 * Dentists were swept under a dentist tag, so that much is known for them; a
 * hospital's amenity=hospital tag was precise and is left alone.
 */
const BASE_TAGS = {
  dental_implants: { amenity: 'dentist' },
  orthodontist: { amenity: 'dentist' },
  dental_clinic: { amenity: 'dentist' },
  // Swept under one precise tag each, so the tag is known even without the element.
  physiotherapy: { healthcare: 'physiotherapist' },
  chiropractor: { healthcare: 'chiropractor' },
  nutritionist: { healthcare: 'nutrition_counselling' },
};

function reclassify(plan) {
  const s = { changed: 0, moves: {}, samples: [] };
  for (const l of plan.live()) {
    if (l.external_source !== 'openstreetmap') continue;
    if (l.category_source === 'human') continue;
    const src = asObject(l.source_url);
    const elementTags = src.osm && src.osm.tags ? src.osm.tags : null;
    if (!elementTags && l.normalized_category === 'private_hospital') continue;

    const next = refineCategory(l.normalized_category, { name: l.name, tags: elementTags || BASE_TAGS[l.normalized_category] || {} });
    if (!next || next === l.normalized_category || !CATEGORY_BY_ID.has(next)) continue;

    const from = l.normalized_category;
    plan.set(l, 'normalized_category', next);
    plan.set(l, 'category', CATEGORY_BY_ID.get(next).label);
    s.changed++;
    const key = from + ' -> ' + next;
    s.moves[key] = (s.moves[key] || 0) + 1;
    if (s.samples.length < SAMPLE) s.samples.push({ id: l.id, name: l.name, from, to: next });
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 3. exclude                                                         */
/* ------------------------------------------------------------------ */

function exclude(plan) {
  const s = { flagged: 0, byKind: {}, samples: [] };
  const flag = (l, kind, reason) => {
    plan.set(l, 'exclusion', kind);
    plan.set(l, 'exclusion_reason', reason);
    s.flagged++;
    s.byKind[kind] = (s.byKind[kind] || 0) + 1;
    if (s.samples.length < SAMPLE) s.samples.push({ id: l.id, name: l.name, kind, reason });
  };

  for (const l of plan.live()) {
    if (l.exclusion) continue;          // includes 'none': a person cleared it
    const ex = detectExclusion(l);
    if (ex) flag(l, ex.kind, ex.reason);
  }

  // The chains nobody listed: one distinctive name at four or more places.
  const groups = new Map();
  for (const l of plan.live()) {
    if (l.exclusion || BRANDED_DEALERS.has(l.normalized_category)) continue;
    const norm = normalizeName(l.name);
    const distinctive = norm.split(' ').filter((t) => t.length > 2 && !COMMON_NAME_WORDS.has(t));
    if (!distinctive.length || distinctive.join('').length < 5) continue;
    if (!groups.has(norm)) groups.set(norm, []);
    groups.get(norm).push(l);
  }
  for (const group of groups.values()) {
    if (group.length < 4) continue;
    const places = new Set(group.map((l) => (normalizeLocality(l.locality) || '').toLowerCase() || (l.lat != null ? Number(l.lat).toFixed(2) + ',' + Number(l.lng).toFixed(2) : l.id)));
    if (places.size < 3) continue;
    for (const l of group) {
      flag(l, 'chain', 'The same name appears at ' + group.length + ' places in your data - a chain, with marketing bought centrally');
    }
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 4. merge                                                           */
/* ------------------------------------------------------------------ */

class UnionFind {
  constructor() { this.parent = new Map(); this.why = new Map(); }
  find(x) {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r);
    while (this.parent.get(x) !== r) { const n = this.parent.get(x); this.parent.set(x, r); x = n; }
    return r;
  }
  union(a, b, why) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    this.parent.set(rb, ra);
    this.why.set(ra, [...(this.why.get(ra) || []), ...(this.why.get(rb) || []), why]);
  }
}

const inPipeline = (l) => l.status === 'approved' && l.stage != null;

/** Which record survives: the one people have worked, then the one we know most about. */
function survivorRank(l) {
  let r = 0;
  if (inPipeline(l)) r += 100000;
  r += Number(l.activity_count || 0) * 1000;
  if (l.verified_at) r += 500;
  if (l.google_place_id) r += 200;
  if (l.review_count != null) r += 150;
  if (l.phone_normalized) r += 120;
  if (l.website) r += 40;
  if (l.lat != null) r += 20;
  r += Number(l.confidence || 0);
  return r;
}

/** Pairs of leads that are the same business, bucketed so it is not n-squared. */
function findClusters(leads) {
  const uf = new UnionFind();
  const byPhone = new Map();
  const byHost = new Map();
  const byName = new Map();
  const grid = new Map();
  const cell = (lat, lng) => Math.floor(lat / 0.002) + ':' + Math.floor(lng / 0.002);
  const push = (map, k, l) => { if (!map.has(k)) map.set(k, []); map.get(k).push(l); };

  for (const l of leads) {
    if (l.phone_normalized) push(byPhone, l.phone_normalized, l);
    if (l.website_host && !platformOf(l.website_host)) push(byHost, l.website_host, l);
    const n = normalizeName(l.name);
    if (n) push(byName, n, l);
    if (l.lat != null && l.lng != null) push(grid, cell(Number(l.lat), Number(l.lng)), l);
    if (l.duplicate_of && leads.some((x) => x.id === l.duplicate_of)) uf.union(l.duplicate_of, l.id, 'same Google Maps listing');
  }

  const pairwise = (group, test, why) => {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (test(group[i], group[j])) uf.union(group[i].id, group[j].id, why);
      }
    }
  };

  // A shared phone or website is one business only in one place. Branches of a
  // chain, or four government dispensaries linking one PDF, share both and are
  // still different places.
  const samePlace = (a, b) => {
    if (a.lat != null && b.lat != null) {
      return haversineMeters({ lat: Number(a.lat), lng: Number(a.lng) }, { lat: Number(b.lat), lng: Number(b.lng) }) <= 1000;
    }
    const la = (normalizeLocality(a.locality) || '').toLowerCase();
    const lb = (normalizeLocality(b.locality) || '').toLowerCase();
    return !la || !lb || la === lb;
  };
  for (const g of byPhone.values()) {
    if (g.length > 1 && g.length <= 25) {
      pairwise(g, (a, b) => nameSimilarity(a.name, b.name) >= 0.5 && samePlace(a, b), 'same phone number');
    }
  }
  for (const g of byHost.values()) {
    if (g.length > 1 && g.length <= 25) {
      pairwise(g, (a, b) => nameSimilarity(a.name, b.name) >= 0.6 && samePlace(a, b), 'same website');
    }
  }
  for (const g of byName.values()) {
    if (g.length < 2 || g.length > 50) continue;
    // The same name at the same street address is one shop, however its
    // locality was written: Maps answers have given one jeweller as both
    // "Chaitanya Nagar, Kothrud" and "Kothrud", each with its own place id.
    pairwise(g, (a, b) => {
      const ka = addressKey(a.address);
      return Boolean(ka && ka === addressKey(b.address));
    }, 'same name at the same address');
    pairwise(g, (a, b) => {
      if (a.lat != null && b.lat != null) return false;   // the grid pass decides these
      const la = (normalizeLocality(a.locality) || '').toLowerCase();
      const lb = (normalizeLocality(b.locality) || '').toLowerCase();
      return Boolean(la && la === lb);
    }, 'same name in the same locality');
  }
  for (const [key, g] of grid) {
    const [x, y] = key.split(':').map(Number);
    const near = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) near.push(...(grid.get((x + dx) + ':' + (y + dy)) || []));
    for (const a of g) {
      for (const b of near) {
        if (a.id >= b.id) continue;
        const d = haversineMeters({ lat: Number(a.lat), lng: Number(a.lng) }, { lat: Number(b.lat), lng: Number(b.lng) });
        if (d <= 150 && nameSimilarity(a.name, b.name) >= 0.85) uf.union(a.id, b.id, 'same name within 150m');
      }
    }
  }

  const clusters = new Map();
  for (const l of leads) {
    const root = uf.find(l.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(l);
  }
  return [...clusters.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([root, members]) => ({ members, why: [...new Set(uf.why.get(root) || [])] }));
}

const FILL_FIELDS = [
  'phone', 'phone_normalized', 'phone_type', 'email', 'website', 'website_host', 'ig_handle', 'ig_followers',
  'li_followers', 'fb_followers', 'years_in_business', 'review_count', 'rating', 'business_status', 'address',
  'postal_code', 'lat', 'lng', 'google_place_id', 'verified_at', 'verified_by',
];

/** What the survivor takes from the others: every gap one of them can fill. */
function mergePlan(survivor, losers) {
  const patch = {};
  for (const field of FILL_FIELDS) {
    if (survivor[field] !== null && survivor[field] !== undefined) continue;
    const donor = losers.find((l) => l[field] !== null && l[field] !== undefined);
    if (donor) patch[field] = donor[field];
  }
  // A Google listing beats a map link.
  const better = losers.find((l) => l.maps_url && /google\.com\/maps\/place/.test(l.maps_url));
  if (better && !/google\.com\/maps\/place/.test(survivor.maps_url || '')) patch.maps_url = better.maps_url;
  if (patch.website) patch.website_status = null;

  // Branches far apart are one owner with several sites, which is worth knowing.
  const points = [survivor, ...losers].filter((l) => l.lat != null).map((l) => ({ lat: Number(l.lat), lng: Number(l.lng) }));
  let sites = 1;
  for (let i = 1; i < points.length; i++) {
    if (points.slice(0, i).every((p) => haversineMeters(p, points[i]) > 300)) sites++;
  }
  if (sites > 1 && (survivor.locations_count == null || survivor.locations_count < sites)) patch.locations_count = sites;

  patch.activity_count = [survivor, ...losers].reduce((n, l) => n + Number(l.activity_count || 0), 0);
  const last = [survivor, ...losers].map((l) => l.last_activity_at).filter(Boolean).map((d) => new Date(d).getTime());
  if (last.length) patch.last_activity_at = new Date(Math.max(...last)).toISOString();
  return patch;
}

async function merge(plan, dryRun) {
  const s = { clusters: 0, merged: 0, needsReview: 0, samples: [], review: [] };
  const clusters = findClusters(plan.live());

  for (const { members, why } of clusters) {
    s.clusters++;
    if (members.filter(inPipeline).length > 1) {
      // Two reps may be working these. A person decides.
      s.needsReview++;
      if (s.review.length < SAMPLE) s.review.push({ names: members.map((m) => m.name), ids: members.map((m) => m.id), why });
      continue;
    }

    const [survivor, ...losers] = [...members].sort((a, b) => survivorRank(b) - survivorRank(a));
    const patch = mergePlan(survivor, losers);
    s.merged += losers.length;
    if (s.samples.length < SAMPLE) {
      s.samples.push({ kept: { id: survivor.id, name: survivor.name }, removed: losers.map((l) => ({ id: l.id, name: l.name })), why });
    }

    for (const l of losers) plan.removed.add(l.id);
    if (dryRun) continue;

    await knex.transaction(async (trx) => {
      const ids = losers.map((l) => l.id);
      for (const table of ['activities', 'lead_stage_history', 'ai_suggestions', 'proposals']) {
        await trx(table).whereIn('lead_id', ids).update({ lead_id: survivor.id });
      }
      for (const l of losers) {
        for (const k of suppressionKeys(l)) {
          await trx('lead_suppressions')
            .insert({ id: uid('sup_'), tenant_id: survivor.tenant_id, ...k, reason: 'merged into ' + survivor.id, lead_name: l.name, created_at: now() })
            .onConflict(['tenant_id', 'kind', 'value']).ignore();
        }
      }
      await trx('leads').whereIn('id', ids).del();
      // The survivor takes the place id only after the duplicate holding it is gone.
      await trx('leads').where({ id: survivor.id }).update({
        ...patch,
        field_provenance: trx.raw(
          "coalesce(field_provenance, '{}'::jsonb) || jsonb_build_object('merged', coalesce(field_provenance->'merged', '[]'::jsonb) || ?::jsonb)",
          [JSON.stringify(losers.map((l) => ({ id: l.id, name: l.name, at: now(), why })))]
        ),
        updated_at: now(),
      });
    });
    if (patch.website) await enqueue({ tenantId: survivor.tenant_id, kind: 'audit_lead', payload: { leadId: survivor.id } });
    Object.assign(survivor, patch);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* 5. housekeep                                                       */
/* ------------------------------------------------------------------ */

async function count(q) {
  const row = await q.clone().clearSelect().clearOrder().count('* as n').first();
  return Number(row?.n || 0);
}

async function housekeep(plan, tenantId, country, dryRun) {
  const m = config.maintenance;
  const ago = (days) => addDays(now(), -days);
  const s = {};
  const remove = async (name, q) => { s[name] = dryRun ? await count(q) : await q.del(); };

  await remove('finishedJobs', knex('jobs').where({ tenant_id: tenantId, status: 'done' }).where('finished_at', '<', ago(m.jobRetentionDays)));
  await remove('failedJobs', knex('jobs').where({ tenant_id: tenantId, status: 'failed' }).where('finished_at', '<', ago(m.failedJobRetentionDays)));
  await remove('usageRows', knex('api_usage').where({ tenant_id: tenantId }).where('created_at', '<', ago(m.usageRetentionDays)));

  // Generated text nobody acted on is a cache, not a record. What a rep
  // accepted, edited or rejected is the eval dataset and is kept.
  await remove('aiCache', knex('ai_suggestions').where({ tenant_id: tenantId }).whereNull('action').where('created_at', '<', ago(m.aiCacheRetentionDays)));
  const supersededSql = `
    FROM ai_suggestions a
    WHERE a.tenant_id = ? AND a.action IS NULL AND EXISTS (
      SELECT 1 FROM ai_suggestions b
      WHERE b.tenant_id = a.tenant_id AND b.kind = a.kind AND b.input_hash = a.input_hash
        AND b.created_at > a.created_at
    )`;
  s.aiSuperseded = dryRun
    ? Number((await knex.raw('SELECT count(*)::int AS n ' + supersededSql, [tenantId])).rows[0].n)
    : (await knex.raw('DELETE ' + supersededSql, [tenantId])).rowCount;

  // Runs that say "running" with nothing working on them. Six hours old, so a
  // run inserted a moment before its job is never caught in between.
  const orphaned = knex('discovery_runs')
    .where({ tenant_id: tenantId })
    .whereIn('status', ['queued', 'running'])
    .where('created_at', '<', hoursAgo(6))
    .whereNotExists(
      knex('jobs').whereIn('jobs.status', ['queued', 'running']).andWhere('jobs.kind', 'discovery')
        .andWhereRaw("jobs.payload->>'runId' = discovery_runs.id")
    );
  s.orphanedRuns = dryRun
    ? await count(orphaned)
    : await orphaned.update({ status: 'failed', error: 'Orphaned: no worker was running it', finished_at: now() });

  await remove('emptyRuns', knex('discovery_runs')
    .where({ tenant_id: tenantId })
    .whereIn('status', ['failed', 'cancelled'])
    .where('created_at', '<', ago(m.runRetentionDays))
    .whereNotExists(knex('leads').whereRaw('leads.run_id = discovery_runs.id')));

  // Rejected leads nobody worked, past their retention. Their keys stay behind
  // so the next sweep does not bring them straight back.
  const purgeable = plan.live().filter((l) =>
    (l.status === 'rejected' || l.discovery_status === 'rejected') &&
    !inPipeline(l) && l.status !== 'approved' &&
    Number(l.activity_count || 0) === 0 &&
    new Date(l.updated_at).getTime() < new Date(ago(m.rejectedLeadRetentionDays)).getTime()
  );
  let purged = 0;
  if (purgeable.length) {
    const ids = purgeable.map((l) => l.id);
    const worked = new Set([
      ...(await knex('activities').whereIn('lead_id', ids).distinct('lead_id')).map((r) => r.lead_id),
      ...(await knex('proposals').whereIn('lead_id', ids).distinct('lead_id')).map((r) => r.lead_id),
    ]);
    const doomed = purgeable.filter((l) => !worked.has(l.id));
    purged = doomed.length;
    for (const l of doomed) plan.removed.add(l.id);
    if (!dryRun && doomed.length) {
      for (let i = 0; i < doomed.length; i += BATCH) {
        const chunk = doomed.slice(i, i + BATCH);
        await knex.transaction(async (trx) => {
          const rows = chunk.flatMap((l) => suppressionKeys(l).map((k) => ({
            id: uid('sup_'), tenant_id: tenantId, ...k, reason: 'purged: ' + (l.exclusion || l.discovery_status), lead_name: l.name, created_at: now(),
          })));
          if (rows.length) await trx('lead_suppressions').insert(rows).onConflict(['tenant_id', 'kind', 'value']).ignore();
          await trx('leads').whereIn('id', chunk.map((l) => l.id)).del();
        });
      }
    }
  }
  s.rejectedLeads = purged;

  // Candidates: drop the ones already on the lead and the ones nobody took.
  let candidatesCleaned = 0;
  const staleBefore = new Date(ago(90)).getTime();
  for (const l of plan.live()) {
    const cand = asObject(l.candidates);
    const keys = Object.keys(cand);
    if (!keys.length) continue;
    const kept = {};
    for (const k of keys) {
      const c = cand[k] || {};
      const taken = l[k] !== null && l[k] !== undefined && String(l[k]) === String(c.value);
      const old = c.found_at && new Date(c.found_at).getTime() < staleBefore;
      if (!taken && !old) kept[k] = c;
    }
    if (Object.keys(kept).length !== keys.length) {
      candidatesCleaned++;
      plan.set(l, 'candidates', JSON.stringify(kept));
    }
  }
  s.candidates = candidatesCleaned;

  const dangling = knex('leads')
    .where({ tenant_id: tenantId })
    .whereNotNull('run_id')
    .whereNotExists(knex('discovery_runs').whereRaw('discovery_runs.id = leads.run_id'));
  s.danglingRunIds = dryRun ? await count(dangling) : await dangling.update({ run_id: null });

  // Do-not-contact rows typed in by hand were stored raw, so a number written
  // "98220 12345" never matched a lead's +919822012345.
  const dnc = await knex('dnc').where({ tenant_id: tenantId }).orderBy('created_at');
  const seen = new Set();
  let dncFixed = 0;
  let dncDupes = 0;
  for (const row of dnc) {
    const e164 = row.phone_normalized ? phoneInfo(row.phone_normalized, country).e164 || row.phone_normalized : null;
    const email = row.email ? cleanEmail(row.email) || row.email.trim().toLowerCase() : null;
    const key = (e164 || '') + '|' + (email || '');
    if (seen.has(key)) {
      dncDupes++;
      if (!dryRun) await knex('dnc').where({ id: row.id }).del();
      continue;
    }
    seen.add(key);
    if (e164 !== row.phone_normalized || email !== row.email) {
      dncFixed++;
      if (!dryRun) await knex('dnc').where({ id: row.id }).update({ phone_normalized: e164, email });
    }
  }
  s.dncNormalised = dncFixed;
  s.dncDuplicates = dncDupes;

  const keepRuns = await knex('maintenance_runs').where({ tenant_id: tenantId }).orderBy('started_at', 'desc').limit(20).select('id');
  await remove('oldMaintenanceRuns', knex('maintenance_runs')
    .where({ tenant_id: tenantId })
    .where('started_at', '<', ago(90))
    .whereNotIn('id', keepRuns.map((r) => r.id)));

  return s;
}

/* ------------------------------------------------------------------ */
/* Writing and rescoring                                              */
/* ------------------------------------------------------------------ */

async function writePatches(plan) {
  let written = 0;
  for (const [id, patch] of plan.patches) {
    if (plan.removed.has(id)) continue;
    const row = { ...patch, updated_at: now() };
    if (plan.audits.has(id)) row.website_audit = JSON.stringify(plan.audits.get(id));
    await knex('leads').where({ id }).update(row);
    written++;
  }
  // Audits computed for leads whose fields did not otherwise change.
  for (const [id, audit] of plan.audits) {
    if (plan.removed.has(id) || plan.patches.has(id)) continue;
    await knex('leads').where({ id }).update({ website_audit: JSON.stringify(audit), updated_at: now() });
  }
  return written;
}

/** Only the parts of an evaluation that change what anyone sees. */
function signature(row) {
  const b = asObject(row.score_breakdown);
  const labels = ['demand', 'digital', 'affordability', 'trigger']
    .map((k) => (b[k] && b[k].signals ? b[k].signals.map((x) => x.label + x.points).join(',') : ''))
    .join('|');
  return [row.score, row.tier, row.confidence, row.discovery_status, row.disqualified, row.disqualify_reason, row.deal_score, labels].join('~');
}

async function rescore(plan, tenantId, dryRun) {
  const cfg = await getScoringConfig(tenantId);
  const s = { scanned: 0, changed: 0, qualified: 0, hot: 0, warm: 0, statusMoves: {} };
  let lastId = '';

  for (;;) {
    const rows = await knex('leads').where({ tenant_id: tenantId }).where('id', '>', lastId).orderBy('id').limit(BATCH);
    if (!rows.length) break;
    lastId = rows[rows.length - 1].id;

    for (const stored of rows) {
      if (plan.removed.has(stored.id)) continue;
      // In a dry run the database has not changed, so score the planned version.
      const lead = dryRun ? { ...stored, ...(plan.patches.get(stored.id) || {}) } : stored;
      if (dryRun && plan.audits.has(stored.id)) lead.website_audit = plan.audits.get(stored.id);
      const { patch, evaluation } = evaluationPatch(lead, cfg);
      s.scanned++;
      if (evaluation.discovery_status === 'qualified') s.qualified++;
      if (evaluation.deal && evaluation.deal.band === 'hot' && lead.phone_normalized) s.hot++;
      if (evaluation.deal && evaluation.deal.band === 'warm' && lead.phone_normalized) s.warm++;

      const before = signature(stored);
      const after = signature({ ...patch, score_breakdown: evaluation.score_breakdown });
      const clearsStage = Object.prototype.hasOwnProperty.call(patch, 'stage');
      if (before === after && !clearsStage) continue;
      s.changed++;
      if (stored.discovery_status !== evaluation.discovery_status) {
        const k = stored.discovery_status + ' -> ' + evaluation.discovery_status;
        s.statusMoves[k] = (s.statusMoves[k] || 0) + 1;
      }
      if (!dryRun) await knex('leads').where({ id: stored.id }).update({ ...patch, updated_at: now() });
    }
  }
  return s;
}

/* ------------------------------------------------------------------ */
/* The run                                                            */
/* ------------------------------------------------------------------ */

export const STEPS = ['normalise', 'reclassify', 'exclude', 'merge', 'housekeep', 'rescore', 'refresh', 'vacuum'];

/**
 * @param tenantId
 * @param dryRun   compute the full report, write nothing
 * @param trigger  schedule | manual | cli
 */
export async function runMaintenance({ tenantId, dryRun = false, trigger = 'manual' }) {
  if (!tenantId) throw new Error('tenantId is required');
  const report = newReport(tenantId, dryRun, trigger);
  const started = Date.now();

  let runId = null;
  if (!dryRun) {
    const busy = await knex('maintenance_runs')
      .where({ tenant_id: tenantId, status: 'running', dry_run: false })
      .where('started_at', '>', hoursAgo(2))
      .first('id');
    if (busy) return { ...report, skipped: 'Another cleanup is already running for this workspace.' };
    runId = uid('mnt_');
    await knex('maintenance_runs').insert({ id: runId, tenant_id: tenantId, status: 'running', dry_run: false, trigger, started_at: report.startedAt });
  }

  try {
    const country = await tenantCountry(tenantId);
    const leads = await knex('leads')
      .where({ tenant_id: tenantId })
      .select(LIGHT_COLUMNS)
      .select(knex.raw("field_provenance->>'duplicate_of' as duplicate_of"))
      .select(knex.raw("field_provenance->'normalized_category'->>'source' as category_source"))
      .select(knex.raw(
        "jsonb_strip_nulls(jsonb_build_object(" +
        "'name', case when field_provenance->'name'->>'source' = 'human' then true end, " +
        "'email', case when field_provenance->'email'->>'source' = 'human' then true end, " +
        "'ig_handle', case when field_provenance->'ig_handle'->>'source' = 'human' then true end, " +
        "'locality', case when field_provenance->'locality'->>'source' = 'human' then true end, " +
        "'website', case when field_provenance->'website'->>'source' = 'human' then true end" +
        ")) as field_provenance_human"
      ));
    report.totals.leadsBefore = leads.length;
    const plan = new Plan(leads);

    report.steps.normalise = await normalise(plan, country);
    report.steps.reclassify = reclassify(plan);
    report.steps.exclude = exclude(plan);
    if (!dryRun) await writePatches(plan);
    report.steps.merge = await merge(plan, dryRun);
    report.steps.housekeep = await housekeep(plan, tenantId, country, dryRun);
    if (!dryRun) {
      // Candidate clean-ups planned during housekeeping.
      const pending = [...plan.patches].filter(([id, p]) => !plan.removed.has(id) && p.candidates !== undefined);
      for (const [id, p] of pending) await knex('leads').where({ id }).update({ candidates: p.candidates });
    }
    report.steps.rescore = await rescore(plan, tenantId, dryRun);

    if (!dryRun) {
      const r = await refreshStaleLeads({ tenantId, limit: 50 });
      report.steps.refresh = { staleGoogleData: r.staleCount, queuedLookups: r.queued };
    }

    const deleted = (report.steps.merge.merged || 0) + Object.entries(report.steps.housekeep)
      .filter(([k]) => !['orphanedRuns', 'candidates', 'danglingRunIds', 'dncNormalised'].includes(k))
      .reduce((n, [, v]) => n + (Number(v) || 0), 0);
    report.steps.vacuum = { ran: false };
    if (!dryRun && deleted > 0) {
      try {
        await knex.raw('VACUUM (ANALYZE) leads, jobs, ai_suggestions, api_usage, discovery_runs, lead_suppressions');
        report.steps.vacuum = { ran: true };
      } catch (e) {
        report.steps.vacuum = { ran: false, error: e.message };
      }
    }

    report.totals.leadsAfter = report.totals.leadsBefore - plan.removed.size;
    report.totals.removed = plan.removed.size;
    report.totals.changed = plan.patches.size;
    report.finishedAt = now();
    report.durationMs = Date.now() - started;

    if (runId) {
      await knex('maintenance_runs').where({ id: runId }).update({
        status: 'done', report: JSON.stringify(report), finished_at: report.finishedAt,
      });
    }
    return { id: runId, ...report };
  } catch (e) {
    if (runId) {
      await knex('maintenance_runs').where({ id: runId }).update({
        status: 'failed', error: String(e.message).slice(0, 2000), report: JSON.stringify(report), finished_at: now(),
      }).catch(() => {});
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Schedule                                                           */
/* ------------------------------------------------------------------ */

/** Queue a cleanup for every workspace that has not had one recently. */
export async function scheduleDue() {
  const tenants = await knex('tenants').select('id');
  let queued = 0;
  for (const t of tenants) {
    const pending = await knex('jobs')
      .where({ tenant_id: t.id, kind: 'maintenance' })
      .whereIn('status', ['queued', 'running'])
      .first('id');
    if (pending) continue;
    const last = await knex('maintenance_runs')
      .where({ tenant_id: t.id, dry_run: false })
      .orderBy('started_at', 'desc')
      .first('started_at');
    if (last && Date.now() - new Date(last.started_at).getTime() < config.maintenance.intervalHours * 3600000) continue;
    await enqueue({ tenantId: t.id, kind: 'maintenance', payload: { tenantId: t.id, trigger: 'schedule' } });
    queued++;
  }
  return queued;
}

let timer = null;

/**
 * Daily, on its own, starting a minute after boot - so the first deploy of new
 * rules cleans up under them without anyone remembering to.
 */
export function startMaintenanceScheduler() {
  if (!config.maintenance.auto || timer) return;
  const tick = () => scheduleDue().catch((e) => console.warn('[maintenance] schedule check failed:', e.message));
  setTimeout(tick, 60000).unref?.();
  timer = setInterval(tick, 15 * 60000);
  timer.unref?.();
}

export function stopMaintenanceScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

registerHandler('maintenance', ({ tenantId, trigger, dryRun }) =>
  runMaintenance({ tenantId, trigger: trigger || 'schedule', dryRun: Boolean(dryRun) })
);

// The pure parts, for the tests.
export { findClusters, mergePlan, survivorRank };
