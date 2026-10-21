import test from 'node:test';
import assert from 'node:assert/strict';
import {
  phoneInfo, normalizePhone, firstPhone, dialCodeFor, normalizeName, nameSimilarity, normalizeUrl,
  normalizeLocality, cleanEmail, cleanInstagramHandle, tidyText, phoneFields, countryFor,
} from './util.js';

/**
 * The parsing every write path now goes through. Each case here is a number or
 * a value that was actually in the lead table.
 */

test('a national-format Indian landline is read as Indian, not Egyptian', () => {
  // The old normaliser turned this into +2025636999 and dialled Egypt.
  const r = phoneInfo('020 2563 6999', 'IN');
  assert.equal(r.e164, '+912025636999');
  assert.equal(r.type, 'landline');
  assert.equal(r.valid, true);
});

test('the tenant calling code works as well as an ISO country', () => {
  assert.equal(phoneInfo('98220 12345', '91').e164, '+919822012345');
  assert.equal(phoneInfo('98220 12345', '+91').e164, '+919822012345');
  assert.equal(dialCodeFor('in'), '91');
  assert.equal(dialCodeFor('AE'), '971');
  assert.equal(dialCodeFor(''), '');
});

test('mobiles and landlines are told apart', () => {
  assert.equal(phoneInfo('+91 98220 12345', 'IN').type, 'mobile');
  assert.equal(phoneInfo('098220 12345', 'IN').type, 'mobile');
  assert.equal(phoneInfo('080-2345 6789', 'IN').type, 'landline');       // Bengaluru, trunk zero + STD code
  assert.equal(phoneInfo('+91 80 2345 6789', 'IN').type, 'landline');
  assert.equal(phoneInfo('805-012-3456', 'IN').type, 'mobile');          // no trunk zero: a mobile
  assert.equal(phoneInfo('+91 8050 123 456', 'IN').type, 'mobile');
  assert.equal(phoneInfo('(0612) 223 4567', 'IN').type, 'landline');     // Patna
  assert.equal(phoneInfo('1800 123 4567', 'IN').type, 'tollfree');
});

test('numbers missing digits are invalid, with a reason a rep can act on', () => {
  for (const raw of ['24441454', '020 256369', '985443209']) {
    const r = phoneInfo(raw, 'IN');
    assert.equal(r.valid, false, raw);
    assert.equal(r.e164, null, raw);
    assert.match(r.reason, /area code/);
  }
  assert.equal(phoneInfo('N/A', 'IN').valid, false);
  assert.equal(phoneInfo('', 'IN').e164, null);
});

test('without a country, only numbers that carry one are trusted', () => {
  assert.equal(normalizePhone('9822012345'), null);
  assert.equal(normalizePhone('+91 98220 12345'), '+919822012345');
  assert.equal(normalizePhone('0091 98220 12345'), '+919822012345');
  assert.equal(phoneInfo('+1 (415) 555-0199', 'IN').e164, '+14155550199');
});

test('several numbers in one field: the first one wins', () => {
  assert.equal(firstPhone('+912223778175 +912223635780'), '+912223778175');
  assert.equal(firstPhone('020-2553 1234/35'), '020-2553 1234');
  assert.equal(firstPhone('98220 12345; 98220 54321'), '98220 12345');
  assert.equal(firstPhone('98220 12345 ext 12'), '98220 12345');
  assert.equal(phoneInfo('+912223778175 +912223635780', 'IN').e164, '+912223778175');
});

test('phoneFields marks a number that cannot be dialled as invalid', () => {
  assert.deepEqual(phoneFields('98220 12345', 'IN'), { phone_normalized: '+919822012345', phone_type: 'mobile' });
  assert.deepEqual(phoneFields('24441454', 'IN'), { phone_normalized: null, phone_type: 'invalid' });
  assert.deepEqual(phoneFields(null, 'IN'), { phone_normalized: null, phone_type: null });
  assert.equal(countryFor({ country_code: 'IN' }, '971'), 'IN');
  assert.equal(countryFor({ country_code: 'India' }, '91'), '91');
});

test('names in every script survive normalisation', () => {
  // These all used to normalise to "", share one dedupe key, and vanish.
  assert.equal(normalizeName('साई मोटर्स'), 'साई मोटर्स');
  assert.notEqual(normalizeName('साई मोटर्स'), normalizeName('संज्योत क्लिनिक'));
  assert.equal(normalizeName('Lakmé Salon'), 'lakme salon');
  assert.equal(normalizeName('Gold’s Gym'), normalizeName("Gold's Gym"));
  assert.equal(normalizeName('P. N. Gadgil'), 'p n gadgil');
  assert.equal(normalizeName('The Orchid Pvt. Ltd.'), 'orchid');
});

test('name similarity: spelling variants and long forms match, shared generic words do not', () => {
  assert.equal(nameSimilarity("Gold's Gym", 'Gold’s Gym'), 1);
  assert.ok(nameSimilarity('Lilavati Hospital', 'Lilavati Hospital and Research Centre') >= 0.85);
  assert.ok(nameSimilarity('Cafe Durga', 'Durga Cafe') >= 0.85);
  assert.ok(nameSimilarity('Sai Clinic', 'Sai Baba Hospital') < 0.5, 'one common word is not a match');
  assert.ok(nameSimilarity('Shree Dental', 'Smile Dental Care') < 0.5, 'sharing "dental" is not a match');
  assert.equal(nameSimilarity('', 'Anything'), 0);
});

test('websites get one canonical form, and junk is not a URL', () => {
  assert.equal(normalizeUrl('www.Foo.com/?utm_source=x&id=2#top'), 'https://www.foo.com/?id=2');
  assert.equal(normalizeUrl('http://foo.in/'), 'http://foo.in');
  assert.equal(normalizeUrl('https://foo.in/path?fbclid=abc'), 'https://foo.in/path');
  for (const junk of ['N/A', 'mailto:a@b.com', 'tel:123', 'none', '']) assert.equal(normalizeUrl(junk), null, junk);
});

test('localities collapse to one spelling', () => {
  assert.equal(normalizeLocality('PUNE'), 'Pune');
  assert.equal(normalizeLocality('pune '), 'Pune');
  assert.equal(normalizeLocality('kandivali east, mumbai'), 'Kandivali East, Mumbai');
  assert.equal(normalizeLocality('Baner Road, Baner'), 'Baner Road, Baner');   // deliberate spelling kept
  assert.equal(normalizeLocality('  '), null);
  assert.equal(tidyText('  Pune,  '), 'Pune');
});

test('emails and handles are real or nothing', () => {
  assert.equal(cleanEmail('Info@Foo.com'), 'info@foo.com');
  assert.equal(cleanEmail('mailto:hello@foo.in?subject=x'), 'hello@foo.in');
  assert.equal(cleanEmail('logo@2x.png'), null);
  assert.equal(cleanEmail('your@email.com'), null);
  assert.equal(cleanEmail('not an email'), null);

  // "reel" was stored as a business's handle, lifted from a /reel/ link.
  assert.equal(cleanInstagramHandle('reel'), null);
  assert.equal(cleanInstagramHandle('p'), null);
  assert.equal(cleanInstagramHandle('https://www.instagram.com/Lilavati.Hospital/?hl=en'), 'lilavati.hospital');
  assert.equal(cleanInstagramHandle('@carex.dental'), 'carex.dental');
  assert.equal(cleanInstagramHandle('bad handle!'), null);
});
