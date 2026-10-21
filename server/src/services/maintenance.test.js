import test from 'node:test';
import assert from 'node:assert/strict';
import { findClusters, mergePlan, survivorRank } from './maintenance.js';

/**
 * Merging is the one cleanup step that destroys rows, so its rules are pinned
 * here: what counts as the same business, which record survives, and what the
 * survivor inherits.
 */

let n = 0;
const lead = (over) => ({
  id: 'ld_' + String(++n).padStart(4, '0'),
  name: 'Lead ' + n,
  status: 'pending_review',
  stage: null,
  activity_count: 0,
  confidence: 40,
  ...over,
});

const ids = (clusters) => clusters.map((c) => c.members.map((m) => m.name).sort());

test('the same name within 150 metres is one business', () => {
  const a = lead({ name: 'Enrich Salon', lat: 18.5204, lng: 73.8567 });
  const b = lead({ name: 'Enrich Salon', lat: 18.5210, lng: 73.8570 });       // ~75m away
  const far = lead({ name: 'Enrich Salon', lat: 18.5600, lng: 73.8100 });     // another branch
  const other = lead({ name: 'Glamour Salon', lat: 18.5205, lng: 73.8568 });  // next door, different shop
  assert.deepEqual(ids(findClusters([a, b, far, other])), [['Enrich Salon', 'Enrich Salon']]);
});

test('a shared phone merges similar names, not strangers sharing a reception desk', () => {
  const a = lead({ name: 'Infinity Medical Centre', phone_normalized: '+912025531234' });
  const b = lead({ name: 'Infinity Medical Center', phone_normalized: '+912025531234' });
  const c = lead({ name: 'Sunrise Physiotherapy', phone_normalized: '+912025531234' });
  assert.deepEqual(ids(findClusters([a, b, c])), [['Infinity Medical Center', 'Infinity Medical Centre']]);
});

test('a shared website merges listings of one place; platform hosts never do', () => {
  const a = lead({ name: 'Infinity Medical Centre 1', website_host: 'infinitymedicalcentre.com' });
  const b = lead({ name: 'Infinity Medical Centre 2', website_host: 'infinitymedicalcentre.com' });
  const f1 = lead({ name: 'FabExpress SRH', website_host: 'fabhotels.com' });
  const f2 = lead({ name: 'FabExpress Corporate Hub', website_host: 'fabhotels.com' });
  assert.deepEqual(ids(findClusters([a, b, f1, f2])), [['Infinity Medical Centre 1', 'Infinity Medical Centre 2']]);
});

test('a shared website or phone across distant places is several places', () => {
  // Four dispensaries linking one PDF were being merged into one.
  const byculla = lead({ name: 'CGHS Dispensary No.11, Byculla', website_host: 'nb.bsf.gov.in', lat: 18.9790, lng: 72.8330 });
  const worli = lead({ name: 'CGHS Dispensary No.3, Worli', website_host: 'nb.bsf.gov.in', lat: 19.0170, lng: 72.8170 });
  assert.equal(findClusters([byculla, worli]).length, 0);

  const wakad = lead({ name: 'Lakme Salon', phone_normalized: '+918000000000', locality: 'Wakad' });
  const parel = lead({ name: 'Lakme Salon', phone_normalized: '+918000000000', locality: 'Parel' });
  assert.equal(findClusters([wakad, parel]).length, 0, 'one call-centre number, two salons');
});

test('without coordinates, the same name in the same locality', () => {
  const a = lead({ name: 'Girija Jewellers', locality: 'Baner, Pune' });
  const b = lead({ name: 'Girija Jewellers', locality: 'baner, pune' });
  const c = lead({ name: 'Girija Jewellers', locality: 'Wakad' });
  assert.deepEqual(ids(findClusters([a, b, c])), [['Girija Jewellers', 'Girija Jewellers']]);
});

test('Devanagari names are compared, not collapsed into one key', () => {
  const a = lead({ name: 'साई मोटर्स', locality: 'Wakad' });
  const b = lead({ name: 'संज्योत क्लिनिक', locality: 'Wakad' });
  const c = lead({ name: 'साई मोटर्स', locality: 'Wakad' });
  assert.deepEqual(ids(findClusters([a, b, c])), [['साई मोटर्स', 'साई मोटर्स']]);
});

test('a lead pointing at its Google twin is merged with it', () => {
  const a = lead({ name: 'Ranka Jewellers' });
  const b = lead({ name: 'Ranka Jewellers Laxmi Road', duplicate_of: a.id });
  assert.equal(findClusters([a, b]).length, 1);
  assert.match(findClusters([a, b])[0].why.join(), /same Google Maps listing/);
});

test('the survivor is the record people worked on, then the one we know most about', () => {
  const worked = lead({ status: 'approved', stage: 'in_discussion', activity_count: 3 });
  const rich = lead({ google_place_id: 'ChIJ', review_count: 400, phone_normalized: '+91', verified_at: '2026-01-01', confidence: 95 });
  const bare = lead({});
  assert.ok(survivorRank(worked) > survivorRank(rich));
  assert.ok(survivorRank(rich) > survivorRank(bare));
});

test('the survivor fills its gaps from the others, and counts their branches', () => {
  const survivor = lead({
    name: 'Enrich Salon', phone_normalized: '+919822012345', lat: 18.5204, lng: 73.8567, activity_count: 2,
    maps_url: 'https://www.openstreetmap.org/node/1', last_activity_at: '2026-09-01T00:00:00Z',
  });
  const loser = lead({
    name: 'Enrich Salon', phone_normalized: '+912025531234', review_count: 820, rating: 4.4, website: 'https://enrich.in',
    google_place_id: 'ChIJenrich', maps_url: 'https://www.google.com/maps/place/?q=place_id:ChIJenrich',
    lat: 18.5600, lng: 73.8100, activity_count: 1, last_activity_at: '2026-09-15T00:00:00Z',
  });
  const p = mergePlan(survivor, [loser]);
  assert.equal(p.phone_normalized, undefined, 'a value the survivor has is kept');
  assert.equal(p.review_count, 820);
  assert.equal(p.rating, 4.4);
  assert.equal(p.google_place_id, 'ChIJenrich');
  assert.equal(p.website, 'https://enrich.in');
  assert.equal(p.website_status, null, 'an inherited website is audited again, not assumed');
  assert.match(p.maps_url, /google\.com\/maps\/place/);
  assert.equal(p.locations_count, 2, 'two sites kilometres apart are two locations');
  assert.equal(p.activity_count, 3);
  assert.equal(p.last_activity_at, '2026-09-15T00:00:00.000Z');
});
