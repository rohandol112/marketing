import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHumanCount, parseInstagramSnippet, handleMatchesName } from './util.js';
import { scoreLead, DEFAULT_SCORING_CONFIG } from './scoring.js';
import { urgentIssue, UNCONFIRMED } from './deal.js';
import { leadContext } from './prompts.js';

/**
 * What social numbers are believed, and from where. The failure this guards
 * against is a confident wrong number in a rep's opening line.
 */

test('counts are read the way pages write them', () => {
  assert.equal(parseHumanCount('12.4K'), 12400, '"12.4K" used to come out as 12');
  assert.equal(parseHumanCount('1.2M followers'), 1200000);
  assert.equal(parseHumanCount('1,234'), 1234);
  assert.equal(parseHumanCount('10K+'), 10000);
  assert.equal(parseHumanCount('3.5 lakh'), 350000);
  assert.equal(parseHumanCount('about 2,300'), 2300);
  assert.equal(parseHumanCount('500 members'), 500, 'an "m" inside a word is not a million');
  assert.equal(parseHumanCount(0), 0, 'zero is an answer');
  assert.equal(parseHumanCount('0'), 0);
  assert.equal(parseHumanCount(null), null);
  assert.equal(parseHumanCount('null'), null);
  assert.equal(parseHumanCount('N/A'), null);
  assert.equal(parseHumanCount('lots'), null);
  assert.equal(parseHumanCount(-5), null);
});

test('the Instagram line from Google is read into handle, followers and posts', () => {
  assert.deepEqual(
    parseInstagramSnippet('1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Orion Dental (@orion_dental_specialities)'),
    { handle: 'orion_dental_specialities', followers: 1234, following: 56, posts: 78 }
  );
  assert.deepEqual(
    parseInstagramSnippet('78 posts 12.4K followers 310 following'),
    { handle: null, followers: 12400, following: 310, posts: 78 }
  );
  const fromUrl = parseInstagramSnippet('https://www.instagram.com/perfectsmile_dentalclinic_pune/ 2.1K followers');
  assert.equal(fromUrl.handle, 'perfectsmile_dentalclinic_pune');
  assert.equal(fromUrl.followers, 2100);
  assert.equal(parseInstagramSnippet('Followers: 845').followers, 845);
  assert.equal(parseInstagramSnippet('nothing useful here'), null);
  assert.equal(parseInstagramSnippet(''), null);
});

test('a handle is matched to the business name by its distinctive words', () => {
  assert.equal(handleMatchesName('orion_dental_specialities', 'Orion Dental Specialities'), true);
  assert.equal(handleMatchesName('perfectsmile_dentalclinic_pune', 'Perfect Smile Dental Clinic'), true);
  assert.equal(handleMatchesName('kothari.jewellers', 'Kothari Jewellers'), true);
  assert.equal(handleMatchesName('sabkadentist', 'Sabka Dentist - Karve Statue'), false, 'the chain account is not the branch');
  assert.equal(handleMatchesName('smile_studio_mumbai', 'Perfect Smile Dental Clinic'), false);
  assert.equal(handleMatchesName('osd', 'Orion Dental Specialities'), false, 'initials prove nothing');
  assert.equal(handleMatchesName('xyz', 'साई डेंटल क्लिनिक'), false);
});

const ctx = { now: new Date('2026-10-01T00:00:00Z') };
const lead = {
  name: 'Kothari Jewellers', locality: 'Kothrud', region: 'Pune', category: 'Jewellery store', normalized_category: 'jewellery_store',
  review_count: 550, rating: 4.6, business_status: 'OPERATIONAL',
  website: 'https://kotharijewellers.com', website_status: 'ok', has_https: true, mobile_friendly: true,
};
const labels = (scored) => scored.breakdown.digital.signals.map((s) => s.label);

test('an unknown post count is not "no posts"', () => {
  const unknown = scoreLead({ ...lead, social_audit: { instagram: { found: true, handle: 'kothari', followers: null, mediaCount: null, lastPostAt: null } } }, DEFAULT_SCORING_CONFIG, ctx);
  assert.ok(!labels(unknown).includes('Instagram account with no posts'), 'Number(null) is 0 - it used to flag every unread account');
  const empty = scoreLead({ ...lead, social_audit: { instagram: { found: true, handle: 'kothari', mediaCount: 0 } } }, DEFAULT_SCORING_CONFIG, ctx);
  assert.ok(labels(empty).includes('Instagram account with no posts'));
});

test('a quiet account found by search is flagged for the rep to check, not stated as fact', () => {
  const quiet = { found: true, handle: 'kothari', mediaCount: 30, lastPostAt: new Date(Date.now() - 150 * 86400000).toISOString() };
  const bySearch = urgentIssue({ ...lead, social_audit: { instagram: { ...quiet, source: 'gemini_search_grounding' } } });
  assert.match(bySearch, /Instagram has been silent for 150 days/);
  assert.ok(bySearch.endsWith(UNCONFIRMED));
  const byApi = urgentIssue({ ...lead, social_audit: { instagram: quiet } });
  assert.equal(byApi, 'Their Instagram has been silent for 150 days');

  const prompt = leadContext({ ...lead, score: 60, tier: 'B', social_audit: { instagram: { ...quiet, source: 'gemini_search_grounding' } } });
  assert.match(prompt, /POSSIBLY URGENT, NOT CONFIRMED/);
  assert.doesNotMatch(prompt, /MOST URGENT, VERIFIED/);
  assert.match(prompt, /from a Google search result, not Instagram itself/);
});

test('an address key ignores case, punctuation and the country, and refuses a bare neighbourhood', async () => {
  const { addressKey } = await import('./util.js');
  const a = addressKey('Vijayashree Society, Chaitanya Nagar, Kothrud, Pune, Maharashtra 411038, India');
  assert.equal(a, addressKey('VIJAYASHREE SOCIETY , CHAITANYA NAGAR , KOTHRUD , PUNE , MAHARASHTRA 411038'));
  assert.equal(addressKey('Kothrud, Pune'), null);
  assert.equal(addressKey(null), null);
});
