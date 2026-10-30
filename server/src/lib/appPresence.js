import { normalizeName, normalizeHost } from './util.js';

/**
 * Does this business publish a mobile app of its own?
 *
 * Asked of schools, colleges, coaching classes, preschools and news houses,
 * where "no app" is the pitch: students and parents get notes, fees, results
 * and circulars over WhatsApp groups; readers get a channel's news through
 * someone else's app. Telling an owner "you have no app" when they have one
 * ends the call, so no_app is the hardest status to earn:
 *
 *   has_app      an app that is theirs: linked from their own site, tied to
 *                their domain, or found on a store page by a search that cited it
 *   white_label  theirs, but a build on a rented platform (Classplus-style
 *                package ids, a school ERP, Teachmint, Graphy...) - an upgrade
 *                pitch, not a first app
 *   unclear      something app-shaped that cannot be tied to them: a same-name
 *                app from another city, a site that says "download our app"
 *                and links none. A person looks before anyone pitches.
 *   no_app       their site, a Google Play search that ran, and Apple's own
 *                search all came back empty
 *
 * Anything short of that leaves the lead unchecked (NULL), never no_app.
 *
 * Everything here is pure except searchAppStore, which takes a fetch.
 */

export const APP_STATUSES = ['has_app', 'white_label', 'unclear', 'no_app'];

export const APP_STATUS_LABELS = {
  has_app: 'Has an app',
  white_label: 'On a rented app platform',
  unclear: 'Possible app - check',
  no_app: 'No app',
};

const PKG = '[A-Za-z][\\w]*(?:\\.[A-Za-z0-9_]+)+';
const PLAY_LINK = new RegExp('play\\.google\\.com/store/apps/details\\?(?:[^"\'<>\\s#]*?&(?:amp;)?)?id=(' + PKG + ')', 'gi');
const MARKET_LINK = new RegExp('market://details\\?id=(' + PKG + ')', 'gi');
const ANDROID_ALTERNATE = new RegExp('android-app://(' + PKG + ')', 'gi');
const APP_STORE_LINK = /(?:apps|itunes)\.apple\.com\/(?:[a-z]{2}\/)?app\/(?:([^"'<>\s/?#]+)\/)?id(\d{6,12})/gi;
const PLAY_DEVELOPER = /play\.google\.com\/store\/apps\/(?:dev|developer)\?id=/i;
/** Branch, AppsFlyer and Firebase links only exist to open an app. */
const DEEP_LINK = /https?:\/\/[a-z0-9-]+\.(?:app\.link|onelink\.me|page\.link)\b/i;
const STORE_BADGE = /(google[-_ ]?play[-_ ]?badge|get[-_ ]?it[-_ ]?on[-_ ]?google[-_ ]?play|app[-_ ]?store[-_ ]?badge|download[-_ ]?on[-_ ]?the[-_ ]?app[-_ ]?store|playstore\.(png|svg|webp)|appstore\.(png|svg|webp))/i;
const APP_MENTION = /\b(download (our|the) (mobile )?app|get (it|our app|the app) on (google play|the play store|the app store)|available on (the )?(google play|play store|app store)|download on the app store|our (mobile )?app is (now )?(available|live)|install (our|the) app)\b/i;

/**
 * Apps a school, coaching or news site links that are not theirs: messaging,
 * meetings, payments, government services, generic classroom tools, news
 * aggregators (Dailyhunt is com.eterno, Inshorts com.nis.app). A school that
 * tells parents to install Google Classroom still has no app of its own.
 */
const THIRD_PARTY_PACKAGE = /^(com\.(whatsapp|google|android|facebook|instagram|microsoft|skype|linkedin|twitter|snapchat|truecaller|phonepe|amazon|flipkart|cisco|dreamplug|mobikwik_new|freecharge|duolingo|sbi|axis|csam|snapwork|msf|digilocker|zhiliaoapp|telegram|discord|adobe|dropbox|spotify|netflix|eterno|nis)|us\.zoom|net\.one97|in\.org\.npci|in\.gov|in\.amazon|nic\.|gov\.|org\.telegram|org\.khanacademy|org\.wordpress)(\.|$)/i;
const THIRD_PARTY_SLUG = /whatsapp|zoom|google|microsoft|teams|paytm|phonepe|digilocker|umang|bhim|youtube|instagram|facebook|telegram|webex|truecaller|dailyhunt|inshorts/i;

/**
 * Platforms that rent an institute a branded app. A site built on one of them
 * usually comes with an app, even when the page links none.
 */
const PLATFORMS = [
  { name: 'Classplus', re: /(?<![a-z0-9-])(classplus(app)?\.co|classplusapp\.com)\b/i },
  { name: 'Teachmint', re: /(?<![a-z0-9-])teachmint\.(com|institute)\b/i },
  { name: 'Graphy', re: /(?<![a-z0-9-])graphy\.com\b|graphycdn/i },
  { name: 'Spayee', re: /(?<![a-z0-9-])spayee\.com\b/i },
  { name: 'Learnyst', re: /(?<![a-z0-9-])learnyst\.com\b/i },
  { name: 'Edmingle', re: /(?<![a-z0-9-])edmingle\.com\b/i },
  { name: 'Testpress', re: /(?<![a-z0-9-])testpress\.in\b/i },
  { name: 'Appx', re: /(?<![a-z0-9-])appx\.co\.in\b/i },
];

/** Classplus publishes institute apps as co.<word>.<five letters>: co.amy.qsrjk, co.diy4.snohd. */
const CLASSPLUS_PACKAGE = /^co\.[a-z0-9]+\.[a-z]{5}$/;
const PLATFORM_DEVELOPER = /\b(classplus|teachmint|graphy|spayee|learnyst|edmingle|testpress|appx|campuscare|entab|myclassboard|fedena|skolaro|nextgen|edunext|schoolpad|teachoo|edvin)\b/i;

const unique = (list) => [...new Set(list.filter(Boolean))];

export function isThirdPartyApp({ id = '', slug = '' } = {}) {
  return THIRD_PARTY_PACKAGE.test(id) || (slug && THIRD_PARTY_SLUG.test(slug));
}

/** The white-label platform behind a package id or a developer name, if any. */
export function whiteLabelOf(id, developer = '') {
  if (CLASSPLUS_PACKAGE.test(String(id || ''))) return 'Classplus';
  const m = String(developer || '').match(PLATFORM_DEVELOPER);
  return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

/* ------------------------------------------------------------------ */
/* Their own website                                                  */
/* ------------------------------------------------------------------ */

function metaContent(raw, key) {
  for (const m of raw.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/\b(?:name|property)\s*=\s*["']([^"']+)["']/i);
    if (!name || name[1].toLowerCase() !== key) continue;
    const content = tag.match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    if (content) return content[1];
  }
  return null;
}

/**
 * What one page of their site says about apps.
 *
 * @param html  the raw page
 * @param text  what a visitor reads on it (websiteAudit.visibleText)
 * @returns {{ android: string[], ios: {id, slug}[], developerPage: boolean, deepLink: boolean,
 *            mentions: boolean, platform: string|null }}
 */
export function appsInHtml(html, text = '') {
  const raw = String(html || '').replace(/&amp;/g, '&');
  const android = [];
  for (const re of [PLAY_LINK, MARKET_LINK, ANDROID_ALTERNATE]) {
    for (const m of raw.matchAll(re)) android.push(m[1]);
  }
  for (const key of ['google-play-app', 'al:android:package']) {
    const v = metaContent(raw, key);
    const id = v && (v.match(new RegExp('(' + PKG + ')')) || [])[1];
    if (id) android.push(id);
  }

  const ios = [];
  for (const m of raw.matchAll(APP_STORE_LINK)) ios.push({ id: m[2], slug: m[1] || '' });
  for (const key of ['apple-itunes-app', 'al:ios:app_store_id']) {
    const v = metaContent(raw, key);
    const id = v && (v.match(/(\d{6,12})/) || [])[1];
    if (id) ios.push({ id, slug: '' });
  }

  const ownAndroid = unique(android).filter((id) => !isThirdPartyApp({ id }));
  const seenIos = new Set();
  const ownIos = ios.filter((a) => !isThirdPartyApp(a) && !seenIos.has(a.id) && seenIos.add(a.id));
  const platform = (PLATFORMS.find((p) => p.re.test(raw)) || {}).name || null;

  return {
    android: ownAndroid.slice(0, 5),
    ios: ownIos.slice(0, 5),
    developerPage: PLAY_DEVELOPER.test(raw),
    deepLink: DEEP_LINK.test(raw),
    mentions: APP_MENTION.test(String(text || '')) || STORE_BADGE.test(raw),
    platform,
  };
}

/** Android packages a domain vouches for in /.well-known/assetlinks.json. */
export function packagesFromAssetLinks(body) {
  let j;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return []; }
  if (!Array.isArray(j)) return [];
  return unique(j.map((s) => s && s.target && s.target.namespace === 'android_app' && s.target.package_name)
    .filter((id) => typeof id === 'string' && new RegExp('^' + PKG + '$').test(id) && !isThirdPartyApp({ id })));
}

/** iOS app ids (TEAMID.bundle.id) a domain vouches for in apple-app-site-association. */
export function appsFromAasa(body) {
  let j;
  try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return []; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return [];
  const ids = [];
  for (const d of (j.applinks && j.applinks.details) || []) {
    if (d && typeof d.appID === 'string') ids.push(d.appID);
    if (d && Array.isArray(d.appIDs)) ids.push(...d.appIDs.filter((x) => typeof x === 'string'));
  }
  for (const section of ['webcredentials', 'appclips']) {
    const apps = j[section] && j[section].apps;
    if (Array.isArray(apps)) ids.push(...apps.filter((x) => typeof x === 'string'));
  }
  return unique(ids.filter((x) => /^[A-Z0-9]{10}\.[\w.-]+$/.test(x))).slice(0, 5);
}

/* ------------------------------------------------------------------ */
/* Is this app theirs?                                                */
/* ------------------------------------------------------------------ */

/**
 * Words that say what an institute is, not which one. "Kothrud Academy" and
 * "Pune Academy" share only "academy", and the general matcher in util.js -
 * which treats the city as generic - called them 88% the same.
 */
const INSTITUTE_WORDS = new Set([
  'classes', 'class', 'coaching', 'tutorials', 'tutorial', 'tuition', 'tuitions', 'academy', 'institute',
  'institution', 'school', 'schools', 'college', 'junior', 'senior', 'high', 'higher', 'secondary', 'primary',
  'pre', 'preschool', 'playschool', 'play', 'kids', 'kindergarten', 'daycare', 'education', 'educational',
  'learning', 'learn', 'study', 'studies', 'centre', 'center', 'international', 'english', 'medium', 'public',
  'convent', 'vidyalaya', 'mahavidyalaya', 'prashala', 'shala', 'the', 'of', 'and', 'for', 'by', 'app',
  'official', 'online', 'live', 'pvt', 'ltd', 'private', 'limited', 'llp', 'trust', 'society', 'pune', 'mumbai',
  // what a news house is, not which one
  'news', 'tv', 'channel', 'media', 'digital', 'daily', 'network', 'broadcast', 'broadcasting', 'newspaper',
  'times', 'express', 'today', 'samachar', 'khabar', 'varta', 'patrika', 'dainik', 'marathi', 'hindi',
]);

function distinctive(name) {
  return normalizeName(String(name || '').split(/\s[-–—|:]\s/)[0])
    .split(' ')
    .filter((t) => t.length > 1 && !INSTITUTE_WORDS.has(t));
}

/**
 * How much of what makes the institute's name its own is in the app's title
 * (or its developer's name), 0 to 1. Every distinctive word must be there for 1.
 */
export function appNameMatch(appTitle, leadName, developer = '') {
  const want = distinctive(leadName);
  const have = [...distinctive(appTitle), ...distinctive(developer)];
  if (!want.length || !have.length) {
    // Nothing distinctive on one side ("Coaching Classes"): only an exact name will do.
    return normalizeName(appTitle) === normalizeName(leadName) ? 1 : 0;
  }
  const joined = have.join('');
  const found = want.filter((t) => have.includes(t) || joined.includes(t));
  return found.length / want.length;
}

/* ------------------------------------------------------------------ */
/* Apple's own search                                                 */
/* ------------------------------------------------------------------ */

const APP_STORE_GENRES = new Set(['Education', 'Business', 'Productivity', 'Reference', 'Utilities', 'Lifestyle', 'Books']);

/**
 * Apple's public iTunes Search API: free, no key, the App Store's own data.
 * Their app when its seller website is their domain; a same-name app is only
 * ever a possibility.
 *
 * @returns {{ ran: boolean, error?: string, apps: object[], possible: object[] }}
 */
export async function searchAppStore(lead, { fetchImpl = fetch, country = 'in' } = {}) {
  const term = String(lead.name || '').split(/\s[-–—|]\s/)[0].trim();
  if (!term) return { ran: false, error: 'No name to search for', apps: [], possible: [] };
  const url = 'https://itunes.apple.com/search?' + new URLSearchParams({
    term, country: String(lead.country_code || country).toLowerCase(), entity: 'software', limit: '15',
  });
  let json;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return { ran: false, error: 'App Store search answered HTTP ' + res.status, apps: [], possible: [] };
    json = await res.json();
  } catch (e) {
    return { ran: false, error: 'App Store search failed: ' + (e.name === 'TimeoutError' ? 'timed out' : e.message), apps: [], possible: [] };
  }

  const host = lead.website_host || normalizeHost(lead.website);
  const apps = [];
  const possible = [];
  for (const r of (json && json.results) || []) {
    if (!r || !r.trackId || !APP_STORE_GENRES.has(r.primaryGenreName)) continue;
    const app = {
      store: 'app_store', id: String(r.trackId), title: r.trackName || null, developer: r.sellerName || r.artistName || null,
      url: r.trackViewUrl ? String(r.trackViewUrl).split('?')[0] : 'https://apps.apple.com/app/id' + r.trackId,
    };
    const sellerHost = normalizeHost(r.sellerUrl);
    if (host && sellerHost && sellerHost === host) {
      apps.push({ ...app, via: 'app_store_api', why: 'The App Store lists ' + host + ' as its seller website' });
    } else if (appNameMatch(app.title, lead.name, app.developer) === 1) {
      possible.push({ ...app, via: 'app_store_api', note: 'Same name on the App Store - check it is them and not a namesake' });
    }
  }
  return { ran: true, apps: apps.slice(0, 3), possible: possible.slice(0, 3) };
}

/* ------------------------------------------------------------------ */
/* Google Play, through a cited web search                            */
/* ------------------------------------------------------------------ */

/** The store id in a Play or App Store URL. */
export function storeIdOf(url) {
  const s = String(url || '');
  const play = s.match(new RegExp('play\\.google\\.com/store/apps/details\\?(?:[^"\'<>\\s#]*?&)?id=(' + PKG + ')', 'i'));
  if (play) return { store: 'google_play', id: play[1] };
  const ios = s.match(/apps\.apple\.com\/(?:[a-z]{2}\/)?app\/(?:([^/?#]+)\/)?id(\d{6,12})/i);
  if (ios) return { store: 'app_store', id: ios[2], slug: ios[1] || '' };
  return null;
}

/** Did the search actually look at app stores, rather than answer from memory? */
export function searchedStores(r) {
  const hay = [...(r.queries || []), ...(r.sources || []).map((s) => (s.uri || '') + ' ' + (s.title || ''))].join(' ');
  return (r.queries || []).length > 0 && /play\.google|google play|play store|apps\.apple|app store|\bapps?\b|apk/i.test(hay);
}

/**
 * Turn the model's answer into apps we can stand behind.
 *
 * An app is only theirs when the model tied it to them AND its store id shows
 * up in a page the search actually returned - a package id the model typed
 * without a source is a guess. Everything else app-shaped is a possibility.
 */
export function judgeStoreSearch(lead, data, sources = []) {
  const cited = (sources || []).map((s) => ((s.uri || '') + ' ' + (s.title || '')).toLowerCase()).join(' \n ');
  const apps = [];
  const possible = [];
  const seen = new Set();

  const take = (entry, theirs) => {
    if (!entry || typeof entry !== 'object') return;
    const sid = storeIdOf(entry.url);
    if (!sid || isThirdPartyApp(sid)) return;
    const key = sid.store + ':' + sid.id.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const app = {
      store: sid.store,
      id: sid.id,
      title: typeof entry.title === 'string' ? entry.title.slice(0, 120) : null,
      developer: typeof entry.developer === 'string' ? entry.developer.slice(0, 120) : null,
      url: sid.store === 'google_play'
        ? 'https://play.google.com/store/apps/details?id=' + sid.id
        : 'https://apps.apple.com/app/id' + sid.id,
      via: 'store_search',
    };
    const evidenced = cited.includes(sid.id.toLowerCase());
    if (theirs && evidenced) {
      const platform = entry.kind === 'platform' ? whiteLabelOf(sid.id, app.developer) || 'a platform' : whiteLabelOf(sid.id, app.developer);
      apps.push({ ...app, platform, why: typeof entry.why === 'string' ? entry.why.slice(0, 200) : null });
    } else {
      possible.push({
        ...app,
        note: theirs
          ? 'The search named it as theirs but no result it returned shows this listing - open it before relying on it'
          : (typeof entry.why_unsure === 'string' && entry.why_unsure.slice(0, 160)) || 'Same name, could not be tied to this business',
      });
    }
  };

  for (const a of Array.isArray(data && data.apps) ? data.apps : []) take(a, true);
  for (const a of Array.isArray(data && data.same_name_elsewhere) ? data.same_name_elsewhere : []) take(a, false);
  return { apps: apps.slice(0, 4), possible: possible.slice(0, 4) };
}

/* ------------------------------------------------------------------ */
/* The verdict                                                        */
/* ------------------------------------------------------------------ */

const STORE_NAME = { google_play: 'Google Play', app_store: 'the App Store' };

/**
 * @param site      { checked: 'read'|'no_site'|'unreachable', android, ios, deepLink, mentions, platform,
 *                    assetLinks, aasa, developerPage }
 * @param appStore  searchAppStore() result
 * @param play      { ran, searched, apps, possible, reason }
 * @returns {{ status: string|null, summary: string, apps: object[], possible: object[], platform: string|null }}
 */
export function decideAppStatus({ site = {}, appStore = {}, play = {} }) {
  const apps = [];
  const possible = [];

  // Their own site and domain: the strongest evidence there is.
  for (const id of site.android || []) {
    apps.push({ store: 'google_play', id, url: 'https://play.google.com/store/apps/details?id=' + id, via: 'website', platform: whiteLabelOf(id) });
  }
  for (const id of site.assetLinks || []) {
    if (apps.some((a) => a.id === id)) continue;
    apps.push({ store: 'google_play', id, url: 'https://play.google.com/store/apps/details?id=' + id, via: 'assetlinks', platform: whiteLabelOf(id) });
  }
  for (const a of site.ios || []) {
    apps.push({ store: 'app_store', id: a.id, title: a.slug ? a.slug.replace(/-/g, ' ') : null, url: 'https://apps.apple.com/app/id' + a.id, via: 'website', platform: null });
  }
  if (site.aasa && site.aasa.length && !(site.ios || []).length) {
    apps.push({ store: 'app_store', id: site.aasa[0], url: null, via: 'apple_app_site_association', platform: null });
  }

  for (const a of [...(appStore.apps || []), ...(play.apps || [])]) {
    if (!apps.some((x) => x.store === a.store && x.id === a.id)) apps.push(a);
  }
  for (const a of [...(play.possible || []), ...(appStore.possible || [])]) {
    if (!apps.some((x) => x.store === a.store && x.id === a.id) && !possible.some((x) => x.store === a.store && x.id === a.id)) {
      possible.push(a);
    }
  }

  const platform = apps.map((a) => a.platform).find(Boolean) || site.platform || null;

  if (apps.length) {
    const first = apps[0];
    const what = (first.title ? '"' + first.title + '"' : first.id) + ' on ' + (STORE_NAME[first.store] || 'an app store');
    const how = first.via === 'website' ? ', linked from their own site'
      : first.via === 'assetlinks' ? ', which their domain vouches for'
        : first.via === 'apple_app_site_association' ? ' (their domain is tied to an iOS app)'
          : first.via === 'app_store_api' ? ', with their website as the seller' : '';
    const white = apps.every((a) => a.platform);
    return {
      status: white ? 'white_label' : 'has_app',
      summary: (white ? 'Rented app (' + platform + '): ' : 'Has an app: ') + what + how,
      apps, possible, platform,
    };
  }

  if (site.deepLink || site.developerPage) {
    return { status: 'has_app', summary: 'Their site links into an app (store developer page or app deep link)', apps, possible, platform };
  }

  const reasons = [];
  if (possible.length) {
    const p = possible[0];
    reasons.push('A same-name app is on ' + (STORE_NAME[p.store] || 'an app store') + (p.title ? ' ("' + p.title + '")' : '') + ' - check it is not theirs');
  }
  if (site.mentions) reasons.push('Their site talks about an app but links none - check before pitching');
  if (site.platform) reasons.push('Their courses run on ' + site.platform + ', which can ship a branded app - check the Play Store');
  if (reasons.length) return { status: 'unclear', summary: reasons[0], apps, possible, platform };

  // Nothing found anywhere. Only a Play search that actually ran can say so:
  // Android is nearly every phone their students carry.
  if (!play.ran || !play.searched) {
    return {
      status: null,
      summary: 'Not settled: ' + (play.reason || 'the Google Play search did not run'),
      apps, possible, platform,
    };
  }
  const where = [
    site.checked === 'read' ? 'on their website' : null,
    'on Google Play',
    appStore.ran ? 'on the App Store' : null,
  ].filter(Boolean);
  return {
    status: 'no_app',
    summary: 'No app ' + where.join(', ').replace(/, ([^,]*)$/, ' or $1')
      + (site.checked === 'unreachable' ? ' (their site could not be read)' : ''),
    apps, possible, platform,
  };
}

/* ------------------------------------------------------------------ */
/* What to say                                                        */
/* ------------------------------------------------------------------ */

const ANGLE = {
  exam_coaching: 'Test series, recorded lectures and doubt-solving in their own app, instead of PDFs in WhatsApp groups',
  coaching_institute: 'Notes, test results, attendance and fee reminders in their own app, instead of WhatsApp groups',
  private_school: 'Homework, circulars, attendance, results and fees in one school app parents actually open',
  college: 'Admissions, notices, timetables and results in an app with their name on it',
  preschool: 'Daily photos and updates for parents, fees and admissions in their own app',
  driving_school: 'Lesson booking, slot reminders and test prep in their own app',
  media_house: 'Breaking-news push alerts in their own app, and a newsroom admin where reporters file and editors publish from one place',
  news_agency: 'Their own news app with push alerts, and an admin panel to publish stories, videos and e-paper in one place',
};

/** The opening for a lead the check found without an app, or null. */
export function appPitchLine(lead) {
  if (lead.app_status !== 'no_app') return null;
  const angle = ANGLE[lead.normalized_category] || 'Their customers have nothing of theirs to install';
  const reviews = lead.review_count != null ? Number(lead.review_count) : null;
  const scale = reviews && reviews >= 50 ? reviews.toLocaleString('en-IN') + ' Google reviews and no app. ' : 'No app of their own. ';
  return scale + angle + '.';
}
