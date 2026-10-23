import test from 'node:test';
import assert from 'node:assert/strict';
import { locateBusiness, isOfflinePoint } from './geo.js';

/**
 * Placing a business on the map. A wrong point is worse than none: it sets the
 * distance a rep sees and decides whether the lead is excluded as out of area.
 */

const clinic = {
  name: 'Orion Dental Specialities',
  address: 'Suvidha Hariprasad, 103, Chatrapati Rajaram Maharaj Path, Mayur Colony, Kothrud, Pune, Maharashtra 411038, India',
  locality: 'Kothrud',
  region: 'Pune',
  countryCode: 'IN',
};

const row = (label, rank, lat = 18.5, lng = 73.8) => ({ label, rank, lat, lng, kind: rank >= 28 ? 'amenity' : 'suburb', source: 'openstreetmap' });

test('a building-level match on the address is a location', async () => {
  const hit = await locateBusiness(clinic, { search: async () => [row('103, Chatrapati Rajaram Maharaj Path', 30, 18.5061, 73.8104)] });
  assert.deepEqual([hit.lat, hit.lng, hit.byName], [18.5061, 73.8104, false]);
});

test('a suburb or a street is an area, not a location', async () => {
  const calls = [];
  const hit = await locateBusiness(clinic, {
    search: async (q) => { calls.push(q); return [row('Kothrud', 20), row('Karve Road', 26)]; },
  });
  assert.equal(hit, null);
  assert.equal(calls.length, 2, 'the address, then the business by name');
});

test('found by name only when the name is the business, not a namesake', async () => {
  let n = 0;
  const search = async () => (++n === 1 ? [] : [row('Orion Dental Specialities', 30, 18.507, 73.809)]);
  const hit = await locateBusiness(clinic, { search });
  assert.equal(hit.byName, true);

  let m = 0;
  const other = await locateBusiness(clinic, { search: async () => (++m === 1 ? [] : [row('Smile Dental Studio', 30)]) });
  assert.equal(other, null);
});

test('a geocoder outage is no location, never a guess', async () => {
  const hit = await locateBusiness(clinic, { search: async () => { throw new Error('Nominatim 503'); } });
  assert.equal(hit, null);
});

test('points from the offline area list are recognised', () => {
  assert.equal(isOfflinePoint(18.559, 73.8077), true, 'Aundh - where unreadable addresses used to land');
  assert.equal(isOfflinePoint('18.5590', '73.8077'), true);
  assert.equal(isOfflinePoint(18.5061, 73.8104), false);
  assert.equal(isOfflinePoint(null, null), false);
});
