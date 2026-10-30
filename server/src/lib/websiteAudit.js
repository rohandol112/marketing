import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import config from '../config.js';
import { normalizeHost, normalizeUrl, cleanEmail, cleanInstagramHandle, phoneInfo } from './util.js';
import { platformOf } from './classify.js';
import { appsInHtml } from './appPresence.js';

/**
 * Website auditor. Plain HTTP, no headless browser - a real browser buys very
 * little here and costs a container.
 *
 * This is where the DIGITAL GAP score gets its evidence, and it is the one
 * enrichment source that is entirely ours: no quota, no API key, no terms of
 * service to breach. It also lifts the business's own social links, phone and
 * WhatsApp number off their own site, which is first-party evidence.
 *
 * Two kinds of mistake matter here, and the first version made both:
 *
 *   Calling a working site broken. It fetched https://example.com with the www
 *   stripped (plenty of small-business domains only answer on www), with a bot
 *   user agent that firewalls drop, and called every non-200 "broken". 73 of the
 *   174 sites it checked came back broken. A rep who tells an owner their site
 *   is down when it is not has lost the call.
 *
 *   Calling a real site a placeholder. JavaScript-rendered sites have almost no
 *   HTML text, and script source was being counted as content anyway.
 *
 * Everything the auditor concludes is written as a sentence a rep can say, in
 * `signals`, most important first.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 TanzLeadAudit/2.0';
const MAX_HTML = 600000;
const TIMEOUT_MS = 12000;

/** Bumped whenever the audit learns a signal. Scoring only trusts what this version measured. */
export const AUDIT_VERSION = 3;

/* ------------------------------------------------------------------ */
/* Patterns                                                           */
/* ------------------------------------------------------------------ */

/** Signals that a site exists but nobody ever finished it, or it has died. */
const PLACEHOLDER_PATTERNS = [
  { re: /info@mysite\.com/i, label: 'Template email address (info@mysite.com)', on: 'raw' },
  { re: /(your|email|name)@(example|email|domain|yoursite|mysite)\.(com|net)/i, label: 'Template email address', on: 'raw' },
  { re: /123[-.\s]?456[-.\s]?7890/, label: 'Template phone number (123-456-7890)', on: 'text' },
  { re: /555[-.\s]?555[-.\s]?5555/, label: 'Template phone number (555-555-5555)', on: 'text' },
  { re: /\+1\s?\(?800\)?[-.\s]?555/, label: 'Template phone number', on: 'text' },
  { re: /lorem ipsum|dolor sit amet/i, label: 'Lorem ipsum placeholder copy', on: 'text' },
  { re: /this is a paragraph\.?\s*click here to add your own text/i, label: 'Unedited Wix paragraph block', on: 'text' },
  { re: /i'?m a paragraph\.\s*click here to add your own text/i, label: 'Unedited Wix paragraph block', on: 'text' },
  { re: /welcome to your new (site|website|store)/i, label: 'Untouched site template', on: 'text' },
  { re: /just another wordpress site/i, label: 'Default WordPress tagline', on: 'raw' },
  { re: /add your (title|text|content) here/i, label: 'Unfilled template field', on: 'text' },
  { re: /your (business|company|brand) name here|company name here/i, label: 'Placeholder business name', on: 'text' },
  { re: /coming soon|launching soon/i, label: 'Coming soon page', on: 'text', weak: true },
  { re: />\s*sample page\s*</i, label: 'Default WordPress "Sample Page" still published', on: 'raw', weak: true },
  { re: /under construction/i, label: 'Under construction page', on: 'text' },
  { re: /under maintenance|maintenance mode|we'?ll be back (soon|shortly)/i, label: 'Site is in maintenance mode', on: 'text' },
  { re: /<h1[^>]*>\s*hello world!?\s*<\/h1>/i, label: 'Default "Hello world" post', on: 'raw' },
  { re: /<title>\s*index of \//i, label: 'Server shows a bare file listing instead of a site', on: 'raw' },
  { re: /this domain (name )?(is parked|is for sale|may be for sale)|buy this domain|domain (is )?for sale/i, label: 'Parked domain - for sale', on: 'text', parked: true },
  { re: /future home of something quite cool/i, label: 'Parked domain', on: 'text', parked: true },
  { re: /sedoparking|parkingcrew|bodis\.com|hugedomains|afternic|dan\.com\/buy|above\.com\/marketplace/i, label: 'Parked domain', on: 'raw', parked: true },
  { re: /account (has been )?suspended|this account has been suspended/i, label: 'Hosting account suspended - the site is offline', on: 'text', parked: true },
  { re: /apache2 (ubuntu|debian) default page|welcome to nginx|<title>\s*it works!?\s*<\/title>|iis windows server|default web (site|page)|there is no website configured at this address/i, label: 'Unconfigured web server - no site installed', on: 'raw', parked: true },
];

/** Hosts a dead or unsold domain gets redirected to. */
const PARKING_HOSTS = /(^|\.)(sedoparking\.com|sedo\.com|parkingcrew\.net|bodis\.com|dan\.com|afternic\.com|hugedomains\.com|above\.com|domainmarket\.com|parklogic\.com|undeveloped\.com|expireddomains\.com|expireddomains\.net)$/;

const BUILDER_SIGNATURES = [
  { re: /static\.wixstatic\.com|static\.parastorage\.com/i, name: 'Wix' },
  { re: /static1\.squarespace\.com|squarespace-cdn/i, name: 'Squarespace' },
  { re: /cdn\.shopify\.com|shopify\.theme/i, name: 'Shopify' },
  { re: /\/wp-content\/|\/wp-includes\//i, name: 'WordPress' },
  { re: /img1\.wsimg\.com|godaddy website builder/i, name: 'GoDaddy Website Builder' },
  { re: /assets\.website-files\.com|webflow\.(com|io)\/(js|css)/i, name: 'Webflow' },
  { re: /framerusercontent|framer\.website/i, name: 'Framer' },
  { re: /mydukaan|dukaan\.app/i, name: 'Dukaan' },
  { re: /zohositescontent|sites\.zoho/i, name: 'Zoho Sites' },
  { re: /sites\.google\.com|gstatic\.com\/atari/i, name: 'Google Sites' },
  { re: /editmysite\.com|weebly\.com/i, name: 'Weebly' },
  { re: /jimcdn\.com|jimdo/i, name: 'Jimdo' },
  { re: /zyrosite|userapp\.zyrosite/i, name: 'Hostinger Website Builder' },
  { re: /strikingly/i, name: 'Strikingly' },
  { re: /blogger\.com\/static|blogspot\.com/i, name: 'Blogger' },
  { re: /instamojo/i, name: 'Instamojo' },
  { re: /\/_next\/static|__NEXT_DATA__/i, name: 'Next.js' },
  { re: /\/_nuxt\/|__NUXT__/i, name: 'Nuxt' },
  { re: /ng-version=/i, name: 'Angular' },
  { re: /\/media\/jui\/|joomla!/i, name: 'Joomla' },
  { re: /\/sites\/default\/files|drupal-settings-json/i, name: 'Drupal' },
];

/** Builders whose templates are responsive whatever the stylesheet looks like. */
const RESPONSIVE_BUILDERS = new Set([
  'Wix', 'Squarespace', 'Shopify', 'Webflow', 'Framer', 'Dukaan', 'Zoho Sites', 'Google Sites',
  'Weebly', 'Jimdo', 'Hostinger Website Builder', 'Strikingly', 'GoDaddy Website Builder', 'Next.js', 'Nuxt',
]);

const LOCAL_SCHEMA = /LocalBusiness|Store|Restaurant|Hotel|Resort|Dentist|Physician|MedicalClinic|MedicalBusiness|Hospital|Clinic|Salon|Spa|RealEstate|AutoDealer|AutomotiveBusiness|Attorney|LegalService|School|EducationalOrganization|FoodEstablishment|LodgingBusiness|ProfessionalService|HomeAndConstructionBusiness|HealthAndBeautyBusiness|ExerciseGym|SportsActivityLocation|JewelryStore|Optician|EventVenue|Bakery|CafeOrCoffeeShop|TravelAgency/;

const BOOKING_RAW = /calendly\.com|practo\.com\/[^"']*(widget|book)|simplybook|setmore|bookings\.zoho|zoho\.com\/bookings|acuityscheduling|youcanbook\.me|eazydiner|dineout|opentable|tablein|appointy|squareup\.com\/appointments|vagaro|fresha\.com|zenoti/i;
const BOOKING_TEXT = /\b(book (an |your |a )?(appointment|consultation|table|now|online|visit|demo|session|test drive)|schedule (a |an |your )?(appointment|call|visit|consultation|test drive)|reserve (a |your )?table|request (a |an )?(appointment|callback|call back|quote)|get (a )?(free )?quote)\b/i;
const CHAT_RAW = /embed\.tawk\.to|client\.crisp\.chat|widget\.intercom\.io|js\.intercomcdn|wchat\.freshchat|freshchat\.com|static\.zdassets\.com|zopim|code\.tidio|js\.driftt|js\.hs-scripts\.com|livechatinc|olark|chatra\.io|jivosite|smartsupp|wati\.io|interakt|gallabox|aisensy|botpress|chatbase|landbot/i;
const ECOM_RAW = /cdn\.shopify\.com|woocommerce|add[-_ ]to[-_ ]cart|checkout\.razorpay\.com|razorpay|payumoney|payu\.in|cashfree|instamojo|js\.stripe\.com|paypal\.com\/sdk|ccavenue/i;
const FORM_PLUGINS = /wpcf7|contact-form-7|wpforms|gform_wrapper|gravityforms|ninja-forms|elementor-form|hs-form|hbspt\.forms|forms\.zohopublic|typeform\.com|tally\.so|jotform|docs\.google\.com\/forms|forms\.gle|formspree|getform\.io|data-netlify/i;

/** "Website by ..." credits that only name the platform. */
const BUILDER_CREDIT = /^(wordpress|wix|shopify|squarespace|godaddy|blogger|weebly|hostinger|zyro|zoho|google|jimdo|webflow|framer|elementor|astra|oceanwp|generatepress|woocommerce|dukaan|strikingly|duda|site123|webnode|odoo|hubspot|the |our |us\b|me\b|love\b|passion|heart)/i;

const SOCIAL_KEYS = ['instagram', 'facebook', 'linkedin', 'twitter', 'youtube'];
const FACEBOOK_RESERVED = new Set([
  'sharer', 'sharer.php', 'share', 'share.php', 'dialog', 'plugins', 'tr', 'login', 'login.php', 'groups',
  'events', 'hashtag', 'watch', 'photo', 'photo.php', 'permalink.php', 'story.php', 'help', 'policies',
  'privacy', 'business', 'ads', 'marketplace', 'gaming', 'home.php', 'pg', 'l.php', 'v2.0', 'v3.0',
]);
const TWITTER_RESERVED = new Set(['share', 'intent', 'home', 'hashtag', 'i', 'search', 'widgets', 'login', 'signup', 'privacy', 'tos']);

const BOT_WALL = /cf-chl|challenge-platform|just a moment\.\.\.|attention required|captcha|access denied|sucuri|incapsula|imperva|akamai|ddos-guard|are you a robot|verify you are human|bot protection|request blocked|security check/i;

/* ------------------------------------------------------------------ */
/* HTML helpers                                                       */
/* ------------------------------------------------------------------ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘' };

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return ' '; }
}

/** What a visitor actually reads: no scripts, styles, comments or markup. */
export function visibleText(html) {
  return decodeEntities(
    String(html || '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

function parseAttrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

function metaTags(html) {
  return [...String(html).matchAll(/<meta\b[^>]*>/gi)].map((m) => parseAttrs(m[0]));
}

function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = '';
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
  } catch {
    return '';
  }
}

function safeDecodeUri(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function extractSocials(html) {
  const counts = Object.fromEntries(SOCIAL_KEYS.map((k) => [k, new Map()]));
  const re = /https?:\/\/(?:[a-z0-9-]+\.)?(instagram\.com|instagr\.am|facebook\.com|fb\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com)\/[^\s"'<>)\\]+/gi;

  for (const m of String(html).matchAll(re)) {
    let u;
    try { u = new URL(m[0].replace(/&amp;/g, '&')); } catch { continue; }
    const host = u.hostname.toLowerCase();
    const seg = u.pathname.split('/').filter(Boolean);
    let key = null;
    let val = null;

    if (/instagram\.com$|instagr\.am$/.test(host)) {
      key = 'instagram';
      val = cleanInstagramHandle(seg[0]);
    } else if (/facebook\.com$|fb\.com$/.test(host)) {
      key = 'facebook';
      if (seg[0] === 'pages' && seg[1]) val = seg[1];
      else if (seg[0] === 'profile.php' && u.searchParams.get('id')) val = 'profile.php?id=' + u.searchParams.get('id');
      else if (seg[0] && !FACEBOOK_RESERVED.has(seg[0].toLowerCase()) && /^[A-Za-z0-9.\-_]{2,80}$/.test(seg[0])) val = seg[0];
    } else if (/linkedin\.com$/.test(host)) {
      key = 'linkedin';
      if (['company', 'in', 'school', 'showcase'].includes(seg[0]) && seg[1]) val = seg[0] + '/' + seg[1];
    } else if (/twitter\.com$|(^|\.)x\.com$/.test(host)) {
      key = 'twitter';
      if (seg[0] && !TWITTER_RESERVED.has(seg[0].toLowerCase()) && /^[A-Za-z0-9_]{1,15}$/.test(seg[0])) val = seg[0];
    } else if (/youtube\.com$/.test(host)) {
      key = 'youtube';
      if (seg[0] && seg[0].startsWith('@')) val = seg[0];
      else if (['channel', 'c', 'user'].includes(seg[0]) && seg[1]) val = seg[0] + '/' + seg[1];
    }
    if (key && val) counts[key].set(val, (counts[key].get(val) || 0) + 1);
  }

  // A theme author's Instagram appears once; the business's own appears in the
  // header and the footer. Most frequent wins.
  const out = {};
  for (const k of SOCIAL_KEYS) {
    const best = [...counts[k].entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) out[k] = best[0];
  }
  return out;
}

function extractEmails(html, host) {
  const found = new Set();
  const add = (e) => { const c = cleanEmail(e); if (c) found.add(c); };
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) add(safeDecodeUri(m[1]));
  // Cloudflare hides addresses from scrapers; the encoding is a one-byte XOR.
  for (const m of html.matchAll(/data-cfemail=["']([0-9a-f]+)["']/gi)) add(decodeCfEmail(m[1]));
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const e of m[1].matchAll(/"email"\s*:\s*"([^"]+)"/gi)) add(e[1]);
  }
  for (const m of visibleText(html).matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) add(m[0]);

  const own = (e) => (host && e.endsWith('@' + host) ? 1 : 0);
  return [...found].sort((a, b) => own(b) - own(a)).slice(0, 5);
}

function extractPhones(html, country) {
  const tel = [];
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) {
    const p = phoneInfo(safeDecodeUri(m[1]), country);
    if (p.valid && !tel.includes(p.e164)) tel.push(p.e164);
  }
  const wa = [];
  const waRe = /(?:wa\.me\/|api\.whatsapp\.com\/send\/?\?(?:[^"'#<>]*?&(?:amp;)?)?phone=|web\.whatsapp\.com\/send\?(?:[^"'#<>]*?&(?:amp;)?)?phone=|whatsapp:\/\/send\?(?:[^"'#<>]*?&(?:amp;)?)?phone=)(?:%2B|\+)?(\d{8,15})/gi;
  for (const m of html.matchAll(waRe)) {
    const p = phoneInfo('+' + m[1], country);
    if (p.valid && !wa.includes(p.e164)) wa.push(p.e164);
  }
  return { tel: tel.slice(0, 5), whatsapp: wa.slice(0, 3) };
}

function schemaTypes(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let json;
    try { json = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n['@type']) [].concat(n['@type']).forEach((t) => out.add(String(t)));
      if (n['@graph']) walk(n['@graph']);
    };
    walk(json);
  }
  for (const m of html.matchAll(/itemtype=["']https?:\/\/schema\.org\/(\w+)/gi)) out.add(m[1]);
  return [...out].slice(0, 20);
}

function hasContactForm(html) {
  for (const m of html.matchAll(/<form\b[\s\S]*?<\/form>/gi)) {
    const f = m[0];
    const searchOnly = /role=["']search|type=["']?search\b/i.test(f) && !/<textarea\b/i.test(f);
    if (searchOnly) continue;
    if (/<textarea\b/i.test(f) || /type=["']?(email|tel)\b/i.test(f) || /name=["']?[^"'>]*(phone|mobile|email|message|enquiry|inquiry)/i.test(f)) {
      return true;
    }
  }
  return FORM_PLUGINS.test(html);
}

function agencyCredit(html) {
  const footer = (html.match(/<footer\b[\s\S]*?<\/footer>/i) || [])[0] || html.slice(-20000);
  const text = visibleText(footer);
  const m = text.match(
    /\b(?:designed|developed|created|crafted|built|made|maintained|managed|powered|website|site|web design(?:ed)?)\s+(?:(?:&|and|with)\s+)?(?:[\w❤♥]+\s+){0,3}?by\s*:?\s*([A-Za-z0-9][\w .&'-]{1,48})/i
  );
  if (!m) return null;
  const name = m[1]
    .replace(/\b(all rights reserved|copyright|privacy|terms|powered)\b.*$/i, '')
    .replace(/[\s.|,-]+$/, '')
    .trim();
  if (!name || name.length < 2 || BUILDER_CREDIT.test(name)) return null;
  return name.slice(0, 48);
}

function copyrightYear(text, thisYear) {
  let best = null;
  for (const m of text.matchAll(/(?:copyright|©|\(c\))\s*(?:[^0-9]{0,30}?)((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi)) {
    const y = Number(m[2] || m[1]);
    if (y >= 1995 && y <= thisYear + 1 && (!best || y > best)) best = y;
  }
  return best;
}

function lastPublished(html, metas) {
  const candidates = [];
  for (const k of ['article:modified_time', 'article:published_time', 'og:updated_time']) {
    const m = metas.find((x) => (x.property || '').toLowerCase() === k);
    if (m?.content) candidates.push(m.content);
  }
  for (const m of html.matchAll(/<time[^>]+datetime=["']([^"']+)["']/gi)) candidates.push(m[1]);
  for (const m of html.matchAll(/"date(Modified|Published)"\s*:\s*"([^"]+)"/g)) candidates.push(m[2]);
  const times = candidates.map((c) => Date.parse(c)).filter((t) => Number.isFinite(t) && t < Date.now() + 86400000);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/* ------------------------------------------------------------------ */
/* Analysis: pure, testable, no network                               */
/* ------------------------------------------------------------------ */

/**
 * Everything that can be read off one page of HTML.
 *
 * @param html
 * @param ctx  { host, country, now, headers }  country reads national-format numbers
 */
export function analyzeHtml(html, { host = null, country = '', now = new Date(), headers = {} } = {}) {
  const raw = String(html || '');
  const text = visibleText(raw);
  const metas = metaTags(raw.slice(0, 300000));
  const metaBy = (attr, val) => metas.find((m) => (m[attr] || '').toLowerCase() === val);
  const thisYear = now.getFullYear();

  const findings = [];
  const say = (weight, line) => findings.push({ weight, line });

  const audit = { v: AUDIT_VERSION };

  /* ---- title, description, indexing ---- */
  const titleMatch = raw.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i);
  audit.title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() || null : null;
  const desc = metaBy('name', 'description');
  audit.metaDescription = desc && desc.content && desc.content.trim() ? desc.content.trim().slice(0, 300) : null;

  const robots = [metaBy('name', 'robots')?.content, metaBy('name', 'googlebot')?.content, headers['x-robots-tag']]
    .filter(Boolean).join(',').toLowerCase();
  const types = schemaTypes(raw);
  const seo = {
    noindex: /noindex/.test(robots),
    genericTitle: !audit.title || /^(home|home page|homepage|index|untitled|welcome|my (site|website)|website)$/i.test(audit.title)
      || (host != null && audit.title.toLowerCase().replace(/^www\./, '') === host),
    h1Count: (raw.match(/<h1\b/gi) || []).length,
    canonical: /<link[^>]+rel=["']?canonical/i.test(raw),
    openGraph: Boolean(metaBy('property', 'og:title') || metaBy('property', 'og:image')),
    favicon: /<link[^>]+rel=["'][^"']*icon/i.test(raw),
    lang: (raw.match(/<html[^>]*\blang=["']?([a-zA-Z-]+)/i) || [])[1] || null,
    schemaTypes: types,
    localSchema: types.some((t) => LOCAL_SCHEMA.test(t)),
  };
  audit.seo = seo;
  if (seo.noindex) say(95, 'The site tells Google not to index it - it cannot appear in search at all');
  if (!audit.metaDescription) say(30, 'No meta description - Google has nothing to show under their name');
  if (seo.genericTitle) say(25, audit.title ? 'Page title is just "' + audit.title + '"' : 'No page title at all');
  if (!seo.localSchema) say(12, 'No local business schema - Google cannot read their address, hours or category from the site');
  if (!seo.h1Count) say(8, 'No main heading on the homepage');

  /* ---- mobile ---- */
  const viewport = Boolean(metaBy('name', 'viewport'));
  audit.mobileFriendly = viewport;
  if (!viewport) say(60, 'No viewport tag - the site is not mobile responsive');

  /* ---- what it is built with ---- */
  const tech = { builder: null, generator: metaBy('name', 'generator')?.content || null, outdated: [] };
  for (const b of BUILDER_SIGNATURES) {
    if (b.re.test(raw)) { tech.builder = b.name; break; }
  }
  const wp = String(tech.generator || '').match(/wordpress\s+(\d+)\.(\d+)/i);
  if (wp && Number(wp[1]) < 6) tech.outdated.push('WordPress ' + wp[1] + '.' + wp[2]);
  const jq = raw.match(/jquery[.-]?(\d)\.(\d+)(?:\.\d+)?(?:\.min)?\.js|jquery(?:\.min)?\.js\?ver=(\d)\.(\d+)/i);
  const jqMajor = jq ? Number(jq[1] || jq[3]) : null;
  if (jqMajor !== null && jqMajor < 3) tech.outdated.push('jQuery ' + (jq[1] || jq[3]) + '.' + (jq[2] || jq[4]));
  if (/\.swf\b|application\/x-shockwave-flash/i.test(raw)) tech.outdated.push('Flash');
  if (/<(marquee|font|center|frameset|frame)\b/i.test(raw)) tech.outdated.push('1990s-era markup');
  if ((raw.match(/<table[^>]*\b(width=["']?\d{3,4}|bgcolor=)/gi) || []).length >= 2) tech.outdated.push('fixed-width table layout');
  audit.builder = tech.builder;
  audit.tech = tech;
  if (tech.outdated.length) say(45, 'Built on outdated technology: ' + tech.outdated.join(', '));

  /* ---- tracking: can they measure anything ---- */
  const tracking = {
    ga4: /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i.test(raw),
    universalAnalytics: /google-analytics\.com\/(analytics|ga|urchin)\.js|gtag\(\s*['"]config['"]\s*,\s*['"]UA-|['"]UA-\d{4,10}-\d{1,3}['"]/i.test(raw),
    gtm: /googletagmanager\.com\/gtm\.js|['"]GTM-[A-Z0-9]{4,9}['"]|ns\.html\?id=GTM-/i.test(raw),
    googleAds: /googleadservices\.com\/pagead\/conversion|gtag\(\s*['"]config['"]\s*,\s*['"]AW-|gtag\/js\?id=AW-/i.test(raw),
    metaPixel: /connect\.facebook\.net\/[a-zA-Z_]+\/fbevents\.js|fbq\(\s*['"]init['"]/i.test(raw),
    linkedinInsight: /snap\.licdn\.com|_linkedin_partner_id/i.test(raw),
    tiktokPixel: /analytics\.tiktok\.com|ttq\.load\(/i.test(raw),
    hotjar: /static\.hotjar\.com/i.test(raw),
    clarity: /clarity\.ms\/tag/i.test(raw),
    // Enterprise stacks load analytics through their own tag managers. Missing
    // these told a Four Seasons it had no analytics.
    otherAnalytics: /assets\.adobedtm\.com|\/AppMeasurement|omtrdc\.net|tags\.tiqcdn\.com|utag\.js|cdn\.segment\.com|matomo\.js|piwik\.js|_paq\.push|cdn\.mxpnl\.com|heapanalytics|plausible\.io\/js|cdn\.usefathom|mc\.yandex\.ru|pagesense|js\.hs-analytics\.net|js\.hs-scripts\.com|google-analytics\.com\/g\/collect/i.test(raw),
  };
  // Universal Analytics stopped processing data in 2023-24, so on its own it
  // measures nothing.
  tracking.analytics = tracking.ga4 || tracking.gtm || tracking.clarity || tracking.hotjar || tracking.otherAnalytics;
  tracking.adTracking = tracking.googleAds || tracking.metaPixel || tracking.linkedinInsight || tracking.tiktokPixel;
  tracking.any = tracking.analytics || tracking.adTracking || tracking.universalAnalytics;
  audit.tracking = tracking;
  if (!tracking.any) {
    say(70, 'No analytics or ad tracking installed - they cannot see where a single customer comes from');
  } else if (tracking.universalAnalytics && !tracking.analytics && !tracking.adTracking) {
    say(65, 'Still on Universal Analytics, which Google switched off - nothing is being measured');
  } else if (!tracking.adTracking) {
    say(20, 'No Meta pixel or Google Ads tag - site visitors cannot be retargeted');
  }
  if (tracking.googleAds || tracking.metaPixel) {
    say(4, 'Ad tracking is installed (' + [tracking.googleAds && 'Google Ads', tracking.metaPixel && 'Meta pixel'].filter(Boolean).join(', ') + ') - they may already pay for ads');
  }

  /* ---- conversion: can a visitor act ---- */
  const phones = extractPhones(raw, country);
  const conversion = {
    whatsapp: phones.whatsapp.length > 0 || /wa\.me\/|api\.whatsapp\.com\/send/i.test(raw),
    clickToCall: phones.tel.length > 0 || /href\s*=\s*["']tel:/i.test(raw),
    contactForm: hasContactForm(raw),
    booking: BOOKING_RAW.test(raw) || BOOKING_TEXT.test(text),
    liveChat: CHAT_RAW.test(raw),
    ecommerce: ECOM_RAW.test(raw),
  };
  conversion.any = Object.values(conversion).some(Boolean);
  audit.conversion = conversion;
  if (!conversion.any) {
    say(75, 'No way to act on the site - no enquiry form, WhatsApp button, click-to-call or booking');
  } else if (!conversion.whatsapp && !conversion.liveChat) {
    say(22, 'No WhatsApp or chat button - every enquiry has to be a phone call');
  }

  /* ---- what they publish about themselves ---- */
  const emails = extractEmails(raw, host);
  audit.contact = { phones: phones.tel, whatsapp: phones.whatsapp[0] || null, emails };
  audit.email = emails[0] || null;

  audit.socials = extractSocials(raw);
  audit.socialLinkCount = SOCIAL_KEYS.filter((k) => audit.socials[k]).length;
  if (audit.socialLinkCount === 0) say(55, 'Site links to no social accounts at all');

  /* ---- apps: the store links, smart banners and deep links on the page (v3) ---- */
  audit.apps = appsInHtml(raw, text);
  if (audit.apps.android.length || audit.apps.ios.length) {
    say(5, 'The site links their own app on ' + [audit.apps.android.length && 'Google Play', audit.apps.ios.length && 'the App Store'].filter(Boolean).join(' and '));
  }

  /* ---- freshness ---- */
  audit.copyrightYear = copyrightYear(text, thisYear);
  const yearsInText = [...text.matchAll(/\b(20[0-4]\d)\b/g)].map((m) => Number(m[1])).filter((y) => y <= thisYear);
  audit.freshness = {
    copyrightYear: audit.copyrightYear,
    latestYearMentioned: yearsInText.length ? Math.max(...yearsInText) : null,
    lastPublished: lastPublished(raw, metas),
  };
  if (audit.copyrightYear && thisYear - audit.copyrightYear >= 2) {
    say(50, 'Copyright still says ' + audit.copyrightYear + ' - nobody has touched the site in years');
  }

  /* ---- content ---- */
  audit.textLength = text.length;
  const images = (raw.match(/<img\b/gi) || []).length;
  const imagesWithoutAlt = (raw.match(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi) || []).length;
  audit.spa = text.length < 400 &&
    /<div[^>]+id=["'](root|app|__next|__nuxt|svelte)["'][^>]*>\s*<\/div>|__NEXT_DATA__|window\.__NUXT__|ng-version=|data-reactroot/i.test(raw);
  audit.content = {
    words: text ? text.split(' ').length : 0,
    images,
    imagesWithoutAlt,
    scripts: (raw.match(/<script\b/gi) || []).length,
    stylesheets: (raw.match(/<link[^>]+rel=["']?stylesheet/gi) || []).length,
    htmlBytes: raw.length,
  };
  if (audit.spa) {
    say(10, 'Content only appears after JavaScript runs - search engines may see an empty page');
  } else if (text.length < 400) {
    say(40, 'Almost no content on the page');
  }
  if (images >= 5 && imagesWithoutAlt / images > 0.5) say(6, 'Most images have no alt text');

  /* ---- business signals the site gives away ---- */
  audit.agencyCredit = agencyCredit(raw);
  if (audit.agencyCredit) say(15, 'Footer credits a web developer: ' + audit.agencyCredit);
  audit.hiringMarketing =
    /\b(careers?|we'?re hiring|join (our|the) team|job openings?|vacanc(y|ies))\b/i.test(text) &&
    /(digital|social media|seo|performance|online) market|marketing (executive|manager|intern|associate|head)|social media (executive|manager)/i.test(text);
  audit.newOpening = /grand opening|newly opened|now open|opening soon|new (branch|outlet|clinic|showroom|store|centre|center) (at|in|now|opening)/i.test(text);
  audit.franchise = /franchise (enquir|inquir|opportunit|partner)|become a franchisee?|own a franchise/i.test(text);
  audit.multiLocation = /\bour (branches|outlets|stores|centres|centers|clinics|locations|showrooms)\b|store locator|find a (store|branch|clinic|centre|center)|\b\d{1,3}\+? (branches|outlets|stores|centres|centers|clinics|locations|showrooms)\b/i.test(text);
  audit.closedNotice = /permanently closed|we have (closed|shut)|closed down|ceased operations|no longer (operating|in business)/i.test(text);
  if (audit.hiringMarketing) say(35, 'They are hiring for marketing - they have already decided they have a problem');
  if (audit.newOpening) say(30, 'The site announces a new opening');
  if (audit.closedNotice) say(90, 'The site says the business has closed');

  /* ---- unfinished or dead ---- */
  let parked = false;
  let placeholderHits = 0;
  const hits = [];
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.re.test(p.on === 'text' ? text + ' ' + (audit.title || '') : raw)) {
      hits.push(p.label);
      if (p.parked) parked = true;
      if (!p.weak) placeholderHits++;
    }
  }
  for (const h of hits) say(parked ? 100 : 85, h);
  audit.parked = parked;
  audit.placeholderHits = placeholderHits;

  audit.signals = findings.sort((a, b) => b.weight - a.weight).map((f) => f.line);
  return audit;
}

/** ok, placeholder or parked, from an analysis. */
export function classifySite(audit) {
  if (audit.parked) return 'parked';
  if (audit.placeholderHits > 0) return 'placeholder';
  if (!audit.spa && audit.textLength < 120) return 'placeholder';
  return 'ok';
}

/* ------------------------------------------------------------------ */
/* Fetching                                                           */
/* ------------------------------------------------------------------ */

/** Certificate problems a visitor's browser shows as a full-page warning. */
const TLS_VISIBLE = new Set([
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_NOT_YET_VALID', 'CERT_REVOKED',
]);
/** Missing intermediate certificates: Node refuses, browsers quietly cope. */
const TLS_CHAIN = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_GET_ISSUER_CERT']);

function errorCodeOf(e) {
  if (!e) return null;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return 'TIMEOUT';
  return e.cause?.code || e.code || e.cause?.cause?.code || null;
}

async function tryFetch(url, fetchImpl, timeoutMs = TIMEOUT_MS) {
  const started = Date.now();
  try {
    const res = await fetchImpl(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const contentType = String(res.headers?.get?.('content-type') || '');
    let html = '';
    if (!contentType || /text|html|xml/i.test(contentType)) {
      html = (await res.text()).slice(0, MAX_HTML);
    } else {
      await res.body?.cancel?.().catch?.(() => {});
    }
    return {
      ok: res.ok,
      status: res.status,
      url: res.url || url,
      html,
      contentType,
      headers: { 'x-robots-tag': res.headers?.get?.('x-robots-tag') || null, server: res.headers?.get?.('server') || null },
      ms: Date.now() - started,
    };
  } catch (e) {
    const code = errorCodeOf(e);
    return { ok: false, status: 0, url, html: '', ms: Date.now() - started, error: code || e.message, errorCode: code };
  }
}

/**
 * A GET that ignores certificate errors, used only to find out whether a site
 * with a bad certificate is otherwise up. fetch() cannot be told to do that
 * without a separate dependency.
 */
export function insecureGet(url, { timeoutMs = TIMEOUT_MS, redirects = 4 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve({ ok: false, status: 0, url, html: '', error: 'bad url' }); return; }
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request(u, {
      method: 'GET',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*', 'Accept-Encoding': 'gzip, deflate, br' },
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        res.resume();
        finish(insecureGet(new URL(res.headers.location, u).toString(), { timeoutMs, redirects: redirects - 1 }));
        return;
      }
      const enc = String(res.headers['content-encoding'] || '').toLowerCase();
      const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip())
        : enc === 'deflate' ? res.pipe(zlib.createInflate())
          : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
            : res;
      const chunks = [];
      let size = 0;
      const done = () => finish({
        ok: status >= 200 && status < 300,
        status,
        url: u.toString(),
        html: Buffer.concat(chunks).toString('utf8').slice(0, MAX_HTML),
        contentType: String(res.headers['content-type'] || ''),
        headers: { 'x-robots-tag': res.headers['x-robots-tag'] || null, server: res.headers.server || null },
      });
      stream.on('data', (c) => {
        size += c.length;
        if (size <= MAX_HTML) chunks.push(c);
        else { stream.destroy(); req.destroy(); done(); }
      });
      stream.on('end', done);
      stream.on('error', done);
    });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', (e) => finish({ ok: false, status: 0, url, html: '', error: e.code || e.message, errorCode: e.code || null }));
    req.end();
  });
}

function isBotWall(r) {
  if (!r || !r.status) return false;
  const head = String(r.html || '').slice(0, 30000);
  if ([401, 403, 429, 503].includes(r.status) && (BOT_WALL.test(head) || /cloudflare|akamai|sucuri|imperva/i.test(r.headers?.server || ''))) {
    return true;
  }
  if (r.status !== 200) return false;
  // Challenge pages served with a 200: Cloudflare's interstitial, and the
  // JavaScript cookie check free hosts like InfinityFree put in front of
  // every site, which reads as an empty page to anything that is not a browser.
  if (head.length < 30000 && /<title>\s*just a moment\.\.\.\s*<\/title>|cf-chl-bypass|challenge-platform/i.test(head)) return true;
  return head.length < 5000 && /slowAES\.decrypt|document\.cookie\s*=\s*"__test=/.test(head);
}

/** Which wall it was, for the rep. */
function botWallKind(r) {
  return /slowAES\.decrypt|__test=/.test(String(r.html || '').slice(0, 5000)) ? 'free_host_challenge' : 'bot_wall';
}

/** The URL as stored, then with and without www, then over plain http. */
export function urlVariants(rawUrl) {
  const norm = normalizeUrl(rawUrl);
  if (!norm) return [];
  const u = new URL(norm);
  const bare = u.hostname.replace(/^www\./, '');
  const path = u.pathname === '/' ? '' : u.pathname + u.search;
  const list = [norm];
  const add = (v) => { if (!list.includes(v)) list.push(v); };
  for (const scheme of ['https', 'http']) {
    for (const host of [bare, 'www.' + bare]) add(scheme + '://' + host + path);
  }
  if (path) for (const host of [bare, 'www.' + bare]) add('https://' + host);
  return list;
}

/**
 * Try every reasonable way of reaching the site, and keep the evidence.
 *
 * @returns {{ ok, status, url, html, contentType, headers, attempts, tls, protectedBy, failure }}
 */
export async function fetchSite(rawUrl, { fetchImpl = fetch, insecure = insecureGet } = {}) {
  const attempts = [];
  let tls = null;
  let best = null;
  // A host that hangs would otherwise cost every variant its full timeout.
  const deadline = Date.now() + 30000;

  for (const url of urlVariants(rawUrl)) {
    if (Date.now() > deadline) break;
    const r = await tryFetch(url, fetchImpl);
    attempts.push({ url, status: r.status, error: r.error || null, ms: r.ms });

    if (isBotWall(r)) return { ...r, attempts, tls, protectedBy: botWallKind(r) };
    if (r.ok) return { ...r, attempts, tls };

    if (url.startsWith('https:') && (TLS_VISIBLE.has(r.errorCode) || TLS_CHAIN.has(r.errorCode))) {
      const ir = await insecure(url);
      attempts.push({ url, status: ir.status, error: ir.error || null, insecure: true });
      tls = { valid: false, error: r.errorCode, customerVisible: TLS_VISIBLE.has(r.errorCode) };
      if (isBotWall(ir)) return { ...ir, attempts, tls, protectedBy: botWallKind(ir) };
      if (ir.ok) return { ...ir, attempts, tls, viaInsecure: true };
    }

    // An HTTP answer beats a network error as the thing to report.
    if (!best || (r.status && !best.status)) best = r;
  }

  const codes = attempts.map((a) => a.error).filter(Boolean);
  let failure;
  if (best?.status) {
    failure = best.status === 404 || best.status === 410
      ? 'The homepage returns ' + best.status + ' - the site is gone'
      : best.status >= 500
        ? 'The server errors (HTTP ' + best.status + ')'
        : 'The site refuses visitors (HTTP ' + best.status + ')';
  } else if (codes.length && codes.every((c) => c === 'ENOTFOUND')) {
    failure = 'The domain does not resolve - expired or never set up';
  } else if (codes.some((c) => c === 'TIMEOUT')) {
    failure = 'Did not respond within ' + Math.round(TIMEOUT_MS / 1000) + ' seconds';
  } else {
    failure = 'Could not connect (' + (codes[0] || 'no response') + ')';
  }
  return { ...(best || { ok: false, status: 0, html: '' }), ok: false, attempts, tls, failure };
}

/* ------------------------------------------------------------------ */
/* Responsive CSS                                                     */
/* ------------------------------------------------------------------ */

/**
 * A viewport tag is a promise, not a layout. Check the stylesheets actually
 * respond to screen width - at most two of them, same host, size-capped.
 *
 * @returns true, false, or null when it could not be told
 */
async function responsiveCss(html, pageUrl, builder, fetchImpl) {
  if (builder && RESPONSIVE_BUILDERS.has(builder)) return true;
  if (/<style[^>]*>[\s\S]*?@media[^{]*\((max|min)-width/i.test(html)) return true;
  if (/<link[^>]+media=["'][^"']*(max|min)-width/i.test(html)) return true;
  if (/bootstrap(\.min)?\.(css|js)|tailwind|foundation(\.min)?\.css|bulma|elementor/i.test(html)) return true;

  let base;
  try { base = new URL(pageUrl); } catch { return null; }
  const hrefs = [...html.matchAll(/<link[^>]+rel=["']?stylesheet["']?[^>]*>/gi)]
    .map((m) => parseAttrs(m[0]).href)
    .filter(Boolean)
    .map((h) => { try { return new URL(h, base); } catch { return null; } })
    .filter((u) => u && u.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, ''))
    .slice(0, 2);
  if (!hrefs.length) return null;

  let checked = 0;
  for (const u of hrefs) {
    try {
      const res = await fetchImpl(u.toString(), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const css = (await res.text()).slice(0, 400000);
      checked++;
      if (/@media[^{]*\((max|min)-width/i.test(css)) return true;
    } catch { /* unreadable stylesheet tells us nothing */ }
  }
  return checked ? false : null;
}

/* ------------------------------------------------------------------ */
/* The audit                                                          */
/* ------------------------------------------------------------------ */

/**
 * @param rawUrl
 * @param opts { country, fetchImpl, insecure, now, checkCss }
 * @returns {{ website_status, has_https, mobile_friendly, website_audit, email?, ig_handle?, phone?, whatsapp? }}
 */
export async function auditWebsite(rawUrl, { country = '', fetchImpl = fetch, insecure = insecureGet, now = new Date(), checkCss = true } = {}) {
  const checkedAt = now.toISOString();
  const url = normalizeUrl(rawUrl);

  if (!url) {
    return {
      website_status: rawUrl ? 'unknown' : 'none',
      has_https: null,
      mobile_friendly: null,
      website_audit: { v: AUDIT_VERSION, checkedAt, reason: rawUrl ? 'Not a usable URL: ' + String(rawUrl).slice(0, 80) : 'No website on record' },
    };
  }

  const host = normalizeHost(url);
  const platform = platformOf(url);
  if (platform) {
    return {
      website_status: 'social_only',
      has_https: true,
      mobile_friendly: null,
      website_audit: socialOnlyAudit(url, platform, checkedAt),
    };
  }

  const site = await fetchSite(url, { fetchImpl, insecure });
  const audit = {
    v: AUDIT_VERSION,
    checkedAt,
    finalUrl: site.url || url,
    status: site.status,
    responseMs: site.ms ?? null,
    attempts: site.attempts,
    tls: site.tls || null,
    signals: [],
    socials: {},
  };

  if (site.protectedBy) {
    audit.protected = site.protectedBy;
    if (site.protectedBy === 'free_host_challenge') {
      audit.freeHosting = true;
      audit.signals.push('The site is on free hosting behind a JavaScript check - open it yourself before saying anything about its content');
    } else {
      audit.signals.push('The site blocks automated checks - open it yourself before saying anything about it');
    }
    if (site.tls && site.tls.customerVisible) {
      audit.signals.unshift('The SSL certificate is invalid (' + site.tls.error + ') - browsers show visitors a security warning');
    }
    return {
      website_status: 'protected',
      has_https: /^https:/i.test(site.url || url) && !(site.tls && site.tls.customerVisible),
      mobile_friendly: null,
      website_audit: audit,
    };
  }

  if (!site.ok) {
    audit.error = site.failure;
    audit.signals.push(site.failure);
    return { website_status: 'broken', has_https: null, mobile_friendly: null, website_audit: audit };
  }

  // Redirected somewhere they do not own: a social page, or a domain parking lot.
  const finalHost = normalizeHost(site.url);
  const finalPlatform = finalHost && finalHost !== host ? platformOf(finalHost) : null;
  if (finalPlatform) {
    return {
      website_status: 'social_only',
      has_https: true,
      mobile_friendly: null,
      website_audit: socialOnlyAudit(site.url, finalPlatform, checkedAt, url),
    };
  }
  if (finalHost && PARKING_HOSTS.test(finalHost)) {
    audit.parked = true;
    audit.signals.push('The domain redirects to a parking page - it is for sale or expired');
    return { website_status: 'parked', has_https: null, mobile_friendly: null, website_audit: audit };
  }
  if (site.contentType && !/html|xml|text/i.test(site.contentType)) {
    audit.placeholderReason = 'Their website link opens a ' + (/pdf/i.test(site.contentType) ? 'PDF' : 'file') + ', not a website';
    audit.signals.push(audit.placeholderReason);
    audit.placeholderHits = 1;
    return { website_status: 'placeholder', has_https: /^https:/i.test(site.url), mobile_friendly: false, website_audit: audit };
  }

  const analysis = analyzeHtml(site.html, { host, country, now, headers: site.headers || {} });
  Object.assign(audit, analysis, {
    checkedAt,
    finalUrl: site.url,
    status: site.status,
    responseMs: site.ms ?? null,
    attempts: site.attempts,
    tls: site.tls || null,
  });

  const hasHttps = /^https:/i.test(site.url) && !(site.tls && site.tls.customerVisible);
  const lead = [];
  if (site.tls && site.tls.customerVisible) {
    lead.push('The SSL certificate is invalid (' + site.tls.error + ') - browsers show visitors a security warning');
  } else if (!/^https:/i.test(site.url)) {
    lead.push('No HTTPS - browsers mark the site "Not secure"');
  }
  if (site.ms != null && site.ms > 6000) lead.push('The homepage took ' + (site.ms / 1000).toFixed(1) + 's to respond');

  let mobileFriendly = analysis.mobileFriendly;
  if (checkCss && mobileFriendly) {
    const responsive = await responsiveCss(site.html, site.url, analysis.builder, fetchImpl);
    audit.responsiveCss = responsive;
    if (responsive === false) {
      mobileFriendly = false;
      lead.push('Has a viewport tag but no responsive CSS - the layout is fixed width on a phone');
    }
  }
  audit.mobileFriendly = mobileFriendly;
  audit.signals = [...lead, ...analysis.signals];

  return {
    website_status: classifySite(analysis),
    has_https: hasHttps,
    mobile_friendly: mobileFriendly,
    website_audit: audit,
    email: analysis.email || undefined,
    ig_handle: analysis.socials.instagram || undefined,
    phone: analysis.contact.phones[0] || undefined,
    whatsapp: analysis.contact.whatsapp || undefined,
  };
}

function socialOnlyAudit(url, platform, checkedAt, listedAs = null) {
  const label = platform.kind === 'google'
    ? 'a Google Business Profile link (Google shut those sites down in 2024)'
    : 'a ' + platform.label + ' page';
  return {
    v: AUDIT_VERSION,
    checkedAt,
    finalUrl: url,
    listedAs: listedAs || undefined,
    socialOnlyHost: platform.host,
    platformKind: platform.kind,
    signals: ['Their "website" is ' + label + ' - they own no site of their own'],
    socials: {},
  };
}

/* ------------------------------------------------------------------ */
/* PageSpeed                                                          */
/* ------------------------------------------------------------------ */

/**
 * Google's own mobile audit: performance, SEO and best practices in one call.
 * Free, rate limited, slow (10-30s). Returns null when unavailable.
 */
export async function pageSpeedReport(url, { fetchImpl = fetch } = {}) {
  if (!config.pagespeed.enabled || !url) return null;
  try {
    const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    api.searchParams.set('url', url);
    api.searchParams.set('strategy', 'mobile');
    for (const c of ['performance', 'seo', 'best-practices']) api.searchParams.append('category', c);
    api.searchParams.set('key', config.pagespeed.apiKey);

    const res = await fetchImpl(api, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) return null;
    const json = await res.json();
    const cats = json?.lighthouseResult?.categories || {};
    const audits = json?.lighthouseResult?.audits || {};
    const pct = (c) => (c?.score == null ? null : Math.round(c.score * 100));
    const report = {
      performance: pct(cats.performance),
      seo: pct(cats.seo),
      bestPractices: pct(cats['best-practices']),
      lcpMs: audits['largest-contentful-paint']?.numericValue != null ? Math.round(audits['largest-contentful-paint'].numericValue) : null,
      cls: audits['cumulative-layout-shift']?.numericValue ?? null,
      crawlable: audits['is-crawlable']?.score == null ? null : audits['is-crawlable'].score === 1,
    };
    return report.performance == null && report.seo == null ? null : report;
  } catch {
    return null;
  }
}

/** Kept for callers that only want the performance number. */
export async function pageSpeedMobile(url) {
  const r = await pageSpeedReport(url);
  return r ? r.performance : null;
}

export { PLACEHOLDER_PATTERNS };
