import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appsInHtml, packagesFromAssetLinks, appsFromAasa, whiteLabelOf, appNameMatch, judgeStoreSearch, searchedStores,
  decideAppStatus, searchAppStore, appPitchLine, storeIdOf,
} from './appPresence.js';
import { analyzeHtml } from './websiteAudit.js';
import { scoreLead } from './scoring.js';
import { gapTagsFor, recommendPackage } from './deal.js';

/* ---------------- their own site ---------------- */

test('store links on their site are their app; WhatsApp, Classroom and payment links are not', () => {
  const html = `
    <a href="https://play.google.com/store/apps/details?id=com.raoiit.app&amp;hl=en_IN"><img src="/img/google-play-badge.png"></a>
    <a href="https://apps.apple.com/in/app/rao-iit-academy/id1234567890">App Store</a>
    <a href="https://play.google.com/store/apps/details?id=com.whatsapp">Chat with us</a>
    <a href="https://play.google.com/store/apps/details?id=com.google.android.apps.classroom">Classroom</a>
    <a href="https://play.google.com/store/apps/details?id=net.one97.paytm">Pay fees</a>
    <a href="https://apps.apple.com/us/app/zoom-workplace/id546505307">Zoom</a>`;
  const a = appsInHtml(html, 'Rao IIT Academy');
  assert.deepEqual(a.android, ['com.raoiit.app']);
  assert.deepEqual(a.ios, [{ id: '1234567890', slug: 'rao-iit-academy' }]);
  assert.equal(a.mentions, true);
});

test('smart banners, app links meta and android-app alternates count as links', () => {
  const html = `<head>
    <meta name="apple-itunes-app" content="app-id=998877665, app-argument=https://x.in">
    <meta property="al:android:package" content="in.sharpminds.classes">
    <link rel="alternate" href="android-app://in.sharpminds.parent/https/sharpminds.in/">
  </head>`;
  const a = appsInHtml(html);
  assert.deepEqual(a.android.sort(), ['in.sharpminds.classes', 'in.sharpminds.parent']);
  assert.deepEqual(a.ios, [{ id: '998877665', slug: '' }]);
});

test('"download our app" with nothing linked is a mention, not an app', () => {
  const a = appsInHtml('<p>Download our app for daily practice tests!</p>', 'Download our app for daily practice tests!');
  assert.deepEqual(a.android, []);
  assert.equal(a.mentions, true);
  assert.equal(appsInHtml('<p>Admissions open</p>', 'Admissions open').mentions, false);
});

test('platform and deep-link detection does not fire on lookalikes', () => {
  assert.equal(appsInHtml('<script src="https://cdn.graphy.com/x.js"></script>').platform, 'Graphy');
  assert.equal(appsInHtml('<a href="https://bestphotography.com/">studio</a>').platform, null);
  assert.equal(appsInHtml('<a href="https://sharpminds.onelink.me/abc">Get the app</a>').deepLink, true);
  assert.equal(appsInHtml('<a href="https://maps.app.goo.gl/x">Directions</a>').deepLink, false);
});

test('a domain vouching for an app in /.well-known counts; an HTML fallback page does not', () => {
  const links = JSON.stringify([
    { relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'in.sharpminds.classes', sha256_cert_fingerprints: ['AB:CD'] } },
    { relation: ['delegate_permission/common.get_login_creds'], target: { namespace: 'web', site: 'https://sharpminds.in' } },
    { target: { namespace: 'android_app', package_name: 'com.google.android.gms' } },
  ]);
  assert.deepEqual(packagesFromAssetLinks(links), ['in.sharpminds.classes']);
  assert.deepEqual(packagesFromAssetLinks('<!doctype html><html>home</html>'), []);
  assert.deepEqual(appsFromAasa(JSON.stringify({ applinks: { details: [{ appIDs: ['ABCDE12345.in.sharpminds.classes'] }] } })), ['ABCDE12345.in.sharpminds.classes']);
  assert.deepEqual(appsFromAasa('{"applinks":{"apps":[],"details":[]}}'), []);
});

test('Classplus-style package ids and platform developers read as white-label', () => {
  assert.equal(whiteLabelOf('co.amy.qsrjk'), 'Classplus');
  assert.equal(whiteLabelOf('co.diy4.snohd'), 'Classplus');
  assert.equal(whiteLabelOf('com.raoiit.app'), null);
  assert.equal(whiteLabelOf('com.x.y', 'Teachmint Technologies'), 'Teachmint');
  assert.equal(whiteLabelOf('in.entab.campuscare', 'Entab Infotech'), 'Entab');
});

/* ---------------- is this app theirs ---------------- */

test('app names match on what makes the name their own, not on "academy" or the city', () => {
  assert.equal(appNameMatch('Pune Academy', 'Kothrud Academy'), 0);
  assert.equal(appNameMatch('Shree Classes', 'Shree Coaching Classes'), 1);
  assert.equal(appNameMatch('Rao IIT Academy - Learning App', 'Rao IIT Academy'), 1);
  assert.equal(appNameMatch('My School App', 'Abhinav Vidyalaya', 'Abhinav Education Society'), 1);
  assert.equal(appNameMatch('Coaching Classes', 'Coaching Classes'), 1);
  assert.equal(appNameMatch('Coaching Classes', 'Classes'), 0);
});

test('a store id the search never returned is a possibility, not their app', () => {
  const lead = { name: 'Sharp Minds Classes', locality: 'Kothrud' };
  const data = {
    apps: [
      { store: 'google_play', title: 'Sharp Minds', developer: 'Sharp Minds Classes', url: 'https://play.google.com/store/apps/details?id=in.sharpminds.classes', kind: 'own', why: 'linked from sharpminds.in' },
      { store: 'google_play', title: 'Sharp Minds Parent', url: 'https://play.google.com/store/apps/details?id=in.sharpminds.parent', kind: 'own' },
      { store: 'google_play', title: 'WhatsApp', url: 'https://play.google.com/store/apps/details?id=com.whatsapp' },
      { store: 'google_play', title: 'Made up', url: 'https://example.com/not-a-store' },
    ],
    same_name_elsewhere: [
      { store: 'google_play', title: 'Sharp Minds Classes', developer: 'Classplus', url: 'https://play.google.com/store/apps/details?id=co.amy.qsrjk', why_unsure: 'Indore, not Pune' },
    ],
  };
  const sources = [
    { uri: 'https://play.google.com/store/apps/details?id=in.sharpminds.classes', title: 'Sharp Minds - Apps on Google Play' },
    { uri: 'https://www.appbrain.com/app/sharp-minds-classes/co.amy.qsrjk', title: 'AppBrain' },
  ];
  const j = judgeStoreSearch(lead, data, sources);
  assert.deepEqual(j.apps.map((a) => a.id), ['in.sharpminds.classes']);
  assert.equal(j.apps[0].platform, null);
  assert.deepEqual(j.possible.map((a) => a.id).sort(), ['co.amy.qsrjk', 'in.sharpminds.parent']);
  assert.match(j.possible.find((p) => p.id === 'in.sharpminds.parent').note, /no result it returned/);
});

test('a search with no queries, or none near an app store, did not look', () => {
  assert.equal(searchedStores({ queries: [], sources: [{ uri: 'https://play.google.com/x' }] }), false);
  assert.equal(searchedStores({ queries: ['"Sharp Minds" site:play.google.com'], sources: [] }), true);
  assert.equal(searchedStores({ queries: ['sharp minds kothrud fees'], sources: [{ uri: 'https://justdial.com/x' }] }), false);
  assert.deepEqual(storeIdOf('https://apps.apple.com/in/app/sharp/id1234567'), { store: 'app_store', id: '1234567', slug: 'sharp' });
});

/* ---------------- the verdict ---------------- */

const searchedNothing = { ran: true, searched: true, apps: [], possible: [] };

test('no app is only said after their site, Google Play and the App Store all came back empty', () => {
  const v = decideAppStatus({ site: { checked: 'read', android: [], ios: [] }, appStore: { ran: true, apps: [], possible: [] }, play: searchedNothing });
  assert.equal(v.status, 'no_app');
  assert.equal(v.summary, 'No app on their website, on Google Play or on the App Store');

  const noSite = decideAppStatus({ site: { checked: 'no_site' }, appStore: { ran: false }, play: searchedNothing });
  assert.equal(noSite.status, 'no_app');
  assert.equal(noSite.summary, 'No app on Google Play');
});

test('a Play search that failed or never searched settles nothing', () => {
  const failed = decideAppStatus({ site: { checked: 'no_site' }, appStore: { ran: true, apps: [], possible: [] }, play: { ran: false, reason: 'the Google Play search failed (Rate limiter busy.)' } });
  assert.equal(failed.status, null);
  assert.match(failed.summary, /Rate limiter busy/);
  const lazy = decideAppStatus({ site: { checked: 'no_site' }, appStore: { ran: true }, play: { ran: true, searched: false, apps: [], possible: [], reason: 'the search never looked at an app store' } });
  assert.equal(lazy.status, null);
});

test('a same-name app, a mention, or a course platform makes it unclear, never no_app', () => {
  const sameName = decideAppStatus({
    site: { checked: 'no_site' }, appStore: { ran: true },
    play: { ...searchedNothing, possible: [{ store: 'google_play', id: 'co.amy.qsrjk', title: 'Shree Coaching Classes' }] },
  });
  assert.equal(sameName.status, 'unclear');
  assert.match(sameName.summary, /Shree Coaching Classes/);
  assert.equal(decideAppStatus({ site: { checked: 'read', mentions: true }, appStore: { ran: true }, play: searchedNothing }).status, 'unclear');
  assert.equal(decideAppStatus({ site: { checked: 'read', platform: 'Graphy' }, appStore: { ran: true }, play: searchedNothing }).status, 'unclear');
});

test('their own link wins, and a Classplus build is a rented app', () => {
  const own = decideAppStatus({ site: { checked: 'read', android: ['com.raoiit.app'] }, appStore: { ran: true }, play: { ran: false } });
  assert.equal(own.status, 'has_app');
  assert.match(own.summary, /linked from their own site/);
  const rented = decideAppStatus({ site: { checked: 'no_site' }, appStore: { ran: true }, play: { ...searchedNothing, apps: [{ store: 'google_play', id: 'co.diy4.snohd', title: 'Tarange Sir', platform: 'Classplus', via: 'store_search' }] } });
  assert.equal(rented.status, 'white_label');
  assert.match(rented.summary, /Classplus/);
  assert.equal(decideAppStatus({ site: { checked: 'read', assetLinks: ['in.x.app'] }, appStore: {}, play: {} }).status, 'has_app');
  assert.equal(decideAppStatus({ site: { checked: 'read', deepLink: true }, appStore: {}, play: {} }).status, 'has_app');
});

/* ---------------- Apple's search ---------------- */

const fakeFetch = (payload, status = 200) => async () => ({ ok: status === 200, status, json: async () => payload });

test('App Store: their app when the seller site is their domain, a possibility when only the name matches', async () => {
  const lead = { name: 'Sharp Minds Classes', website_host: 'sharpminds.in', country_code: 'IN' };
  const r = await searchAppStore(lead, {
    fetchImpl: fakeFetch({
      results: [
        { trackId: 111, trackName: 'Sharp Minds', sellerName: 'Sharp Minds Edu', sellerUrl: 'https://www.sharpminds.in/', primaryGenreName: 'Education', trackViewUrl: 'https://apps.apple.com/in/app/sharp-minds/id111?uo=4' },
        { trackId: 222, trackName: 'Sharp Minds Classes', sellerName: 'Someone Else', sellerUrl: 'https://other.com', primaryGenreName: 'Education' },
        { trackId: 333, trackName: 'Sharp Minds Classes', primaryGenreName: 'Games' },
        { trackId: 444, trackName: 'Blunt Minds', primaryGenreName: 'Education' },
      ],
    }),
  });
  assert.equal(r.ran, true);
  assert.deepEqual(r.apps.map((a) => a.id), ['111']);
  assert.equal(r.apps[0].url, 'https://apps.apple.com/in/app/sharp-minds/id111');
  assert.deepEqual(r.possible.map((a) => a.id), ['222']);
  assert.equal((await searchAppStore(lead, { fetchImpl: fakeFetch({}, 503) })).ran, false);
});

/* ---------------- the audit, the score and the pitch ---------------- */

test('the website audit reads app links (v3)', () => {
  const a = analyzeHtml('<html><head><title>Sharp Minds</title></head><body><p>' + 'Classes for 8th to 12th. '.repeat(30)
    + '</p><a href="https://play.google.com/store/apps/details?id=in.sharpminds.classes">Get our app</a></body></html>', { host: 'sharpminds.in' });
  assert.equal(a.v, 3);
  assert.deepEqual(a.apps.android, ['in.sharpminds.classes']);
  assert.ok(a.signals.some((s) => /links their own app on Google Play/.test(s)));
});

const school = { name: 'Sharp Minds Classes', normalized_category: 'coaching_institute', review_count: 240, rating: 4.6, website_status: 'none' };

test('no app adds to the digital gap for schools and coaching only, and only once checked', () => {
  const pts = (lead) => (scoreLead(lead).breakdown.digital.signals.find((s) => s.label === 'No app of their own') || {}).points || 0;
  assert.equal(pts({ ...school, app_status: 'no_app' }), 4);
  assert.equal(pts({ ...school, app_status: null }), 0);
  assert.equal(pts({ ...school, app_status: 'unclear' }), 0);
  assert.equal(pts({ ...school, normalized_category: 'restaurant', app_status: 'no_app' }), 0);
});

test('the app list prices the app package, whatever else the lead lacks', () => {
  const lead = { ...school, app_status: 'no_app' };
  assert.ok(gapTagsFor(lead).includes('no_app'));
  const catalog = [
    { name: 'Android Development', gap_tags: ['no_app'] }, { name: 'iOS Development', gap_tags: ['no_app'] },
    { name: 'App Design', gap_tags: ['no_app'] }, { name: 'Custom Website Development', gap_tags: ['no_website'] },
    { name: 'Increase site index', gap_tags: ['no_seo', 'no_website'] }, { name: 'Logo Design', gap_tags: [] },
  ];
  const packages = [
    { name: 'Starter Site', price_min: 15000, includes: ['Custom Website Development', 'Logo Design', 'Increase site index'] },
    { name: 'Institute App', price_min: 120000, price_max: 300000, includes: ['App Design', 'Android Development', 'iOS Development'] },
  ];
  assert.equal(recommendPackage(lead, packages, catalog).name, 'Starter Site');
  assert.equal(recommendPackage(lead, packages, catalog, { only: ['no_app'] }).name, 'Institute App');
  assert.equal(recommendPackage({ ...lead, app_status: 'has_app' }, packages, catalog, { only: ['no_app'] }), null);
});

test('the pitch line exists only for a confirmed no_app', () => {
  assert.equal(appPitchLine({ ...school, app_status: 'no_app' }),
    '240 Google reviews and no app. Notes, test results, attendance and fee reminders in their own app, instead of WhatsApp groups.');
  assert.match(appPitchLine({ ...school, normalized_category: 'exam_coaching', review_count: 12, app_status: 'no_app' }), /^No app of their own\. Test series/);
  assert.equal(appPitchLine({ ...school, app_status: 'unclear' }), null);
});

/* ---------------- news channels and media houses ---------------- */

test('a news house without an app is priced the newsroom product, a school the institute app', () => {
  const catalog = [
    { name: 'Android Development', gap_tags: ['no_app'] }, { name: 'iOS Development', gap_tags: ['no_app'] },
    { name: 'App Design', gap_tags: ['no_app'] }, { name: 'News App and Newsroom Admin', gap_tags: ['no_news_app'] },
  ];
  const packages = [
    { name: 'Institute App', price_min: 120000, includes: ['App Design', 'Android Development', 'iOS Development'] },
    { name: 'Newsroom App', price_min: 150000, includes: ['News App and Newsroom Admin'] },
  ];
  const channel = { name: 'Kothrud Live News', normalized_category: 'media_house', review_count: 320, app_status: 'no_app' };
  const bigSchool = { name: 'Abhinav Vidyalaya', normalized_category: 'private_school', review_count: 900, app_status: 'no_app' };
  assert.deepEqual(gapTagsFor(channel).filter((t) => t.startsWith('no_') && t.includes('app')), ['no_news_app']);
  assert.equal(recommendPackage(channel, packages, catalog, { only: ['no_news_app'] }).name, 'Newsroom App');
  assert.equal(recommendPackage(bigSchool, packages, catalog, { only: ['no_app'] }).name, 'Institute App');
});

test('news houses score the app gap, get a newsroom pitch, and aggregators are not their app', () => {
  const pts = (lead) => (scoreLead(lead).breakdown.digital.signals.find((s) => s.label === 'No app of their own') || {}).points || 0;
  assert.equal(pts({ name: 'Kothrud Live News', normalized_category: 'news_agency', app_status: 'no_app' }), 4);
  assert.match(appPitchLine({ normalized_category: 'media_house', review_count: 320, app_status: 'no_app' }), /^320 Google reviews and no app\. Breaking-news push alerts/);
  const a = appsInHtml('<a href="https://play.google.com/store/apps/details?id=com.eterno">Read us on Dailyhunt</a>'
    + '<a href="https://play.google.com/store/apps/details?id=com.nis.app">Inshorts</a>');
  assert.deepEqual(a.android, []);
  assert.equal(appNameMatch('Pune Live News', 'Kothrud Live News'), 0);
  assert.equal(appNameMatch('Pudhari News - Marathi', 'Pudhari'), 1);
});
