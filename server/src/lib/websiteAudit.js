import config from '../config.js';
import { normalizeHost } from './util.js';

/**
 * Website auditor. Plain fetch, no headless browser - a real browser buys very
 * little here and costs a container.
 *
 * This is where the DIGITAL GAP score gets its evidence, and it is the one
 * enrichment source that is entirely ours: no quota, no API key, no terms of
 * service to breach. It also lifts the business's own social links off their
 * own site, which is how ig_handle gets filled without touching Instagram.
 */

const UA = 'Mozilla/5.0 (compatible; DudeAI-LeadAudit/0.1; +https://tanzcorp.example/bot)';

/** Signals that a site exists but nobody ever finished it. */
const PLACEHOLDER_PATTERNS = [
  { re: /info@mysite\.com/i, label: 'Template email address (info@mysite.com)' },
  { re: /(your|email|name)@(example|email|domain|yoursite|mysite)\.(com|net)/i, label: 'Template email address' },
  { re: /123[-.\s]?456[-.\s]?7890/, label: 'Template phone number (123-456-7890)' },
  { re: /555[-.\s]?555[-.\s]?5555/, label: 'Template phone number (555-555-5555)' },
  { re: /\+1\s?\(?800\)?[-.\s]?555/, label: 'Template phone number' },
  { re: /lorem ipsum/i, label: 'Lorem ipsum placeholder copy' },
  { re: /this is a paragraph\.?\s*click here to add your own text/i, label: 'Unedited Wix paragraph block' },
  { re: /i'?m a paragraph\.\s*click here to add your own text/i, label: 'Unedited Wix paragraph block' },
  { re: /welcome to your new (site|website|store)/i, label: 'Untouched site template' },
  { re: /just another wordpress site/i, label: 'Default WordPress tagline' },
  { re: /add your (title|text|content) here/i, label: 'Unfilled template field' },
  { re: /your (business|company|brand) name( here)?/i, label: 'Placeholder business name' },
  { re: /company name here/i, label: 'Placeholder business name' },
  { re: /coming soon/i, label: 'Coming soon page', weak: true },
  { re: /under construction/i, label: 'Under construction page' },
  { re: /this domain is (parked|for sale)/i, label: 'Parked domain', parked: true },
  { re: /future home of something quite cool/i, label: 'Parked domain', parked: true },
  { re: /buy this domain/i, label: 'Domain for sale', parked: true },
  { re: /<h1[^>]*>\s*hello world!?\s*<\/h1>/i, label: 'Default "Hello world" post' },
  { re: /default web (site|page)|apache2 (ubuntu|debian) default page|welcome to nginx/i, label: 'Unconfigured web server', parked: true },
];

/**
 * Businesses routinely list a Facebook page as their website. Fetching it
 * "succeeds" - 200, mobile friendly, HTTPS - and the lead scores as though it
 * has a real site. It does not. This is one of the strongest signals in the
 * whole product: they have an audience somewhere and nothing they own.
 */
const SOCIAL_AS_WEBSITE = /^(www\.)?(facebook|fb|instagram|linkedin|twitter|x|youtube|wa\.me|whatsapp|linktr\.ee|linktree|zomato|swiggy|justdial|indiamart|sulekha|practo)\./i;

const BUILDER_SIGNATURES = [
  { re: /wix\.com|static\.parastorage\.com/i, name: 'Wix' },
  { re: /squarespace|static1\.squarespace\.com/i, name: 'Squarespace' },
  { re: /cdn\.shopify\.com|shopify/i, name: 'Shopify' },
  { re: /wp-content|wp-includes/i, name: 'WordPress' },
  { re: /godaddy|websitebuilder/i, name: 'GoDaddy Website Builder' },
  { re: /webflow\.(com|io)/i, name: 'Webflow' },
  { re: /framerusercontent|framer\.website/i, name: 'Framer' },
  { re: /dukaan|instamojo|mydukaan/i, name: 'Dukaan' },
];

function extractSocials(html, baseHost) {
  const socials = {};
  const grab = (re, key, cleanup) => {
    const m = html.match(re);
    if (m && m[1]) socials[key] = cleanup ? cleanup(m[1]) : m[1];
  };
  grab(/instagram\.com\/([A-Za-z0-9._]{2,40})/i, 'instagram', (h) => h.replace(/\/$/, ''));
  grab(/facebook\.com\/([A-Za-z0-9._-]{2,60})/i, 'facebook');
  grab(/linkedin\.com\/(?:company|in)\/([A-Za-z0-9._-]{2,80})/i, 'linkedin');
  grab(/(?:twitter|x)\.com\/([A-Za-z0-9_]{2,20})/i, 'twitter');
  grab(/youtube\.com\/(?:@|c\/|channel\/|user\/)([A-Za-z0-9._-]{2,60})/i, 'youtube');
  for (const junk of ['sharer', 'share', 'intent', 'plugins', 'tr', 'p']) {
    for (const k of Object.keys(socials)) if (socials[k] === junk) delete socials[k];
  }
  if (baseHost) socials.host = baseHost;
  return socials;
}

function extractEmail(html) {
  const m = html.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  if (!m) return null;
  const bad = /(example|mysite|yoursite|domain|sentry|wixpress|godaddy|squarespace|\.png|\.jpg|\.webp)/i;
  const clean = m.find((e) => !bad.test(e));
  return clean || null;
}

async function tryFetch(url, timeoutMs = 12000) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = res.ok ? (await res.text()).slice(0, 400000) : '';
    return { ok: res.ok, status: res.status, url: res.url, html: text, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, url, html: '', ms: Date.now() - started, error: e.name === 'TimeoutError' ? 'timeout' : e.message };
  }
}

/**
 * @returns {{website_status, has_https, mobile_friendly, website_audit, email?, ig_handle?}}
 */
export async function auditWebsite(rawUrl) {
  if (!rawUrl) {
    return {
      website_status: 'none',
      has_https: null,
      mobile_friendly: null,
      website_audit: { checkedAt: new Date().toISOString(), reason: 'no website on record' },
    };
  }

  const host = normalizeHost(rawUrl);

  if (host && SOCIAL_AS_WEBSITE.test(host)) {
    return {
      website_status: 'social_only',
      has_https: true,
      mobile_friendly: null,
      website_audit: {
        checkedAt: new Date().toISOString(),
        finalUrl: rawUrl,
        socialOnlyHost: host,
        signals: ['Their "website" is a ' + host.split('.')[0] + ' page - they own no site of their own'],
        socials: {},
      },
    };
  }

  const httpsUrl = 'https://' + host;
  let res = await tryFetch(httpsUrl);
  let hasHttps = res.ok;

  if (!res.ok) {
    const httpRes = await tryFetch('http://' + host);
    if (httpRes.ok) {
      res = httpRes;
      hasHttps = false;
    }
  }

  const audit = {
    checkedAt: new Date().toISOString(),
    finalUrl: res.url,
    status: res.status,
    responseMs: res.ms,
    hasHttps,
    signals: [],
    builder: null,
    socials: {},
  };

  if (!res.ok) {
    audit.error = res.error || ('HTTP ' + res.status);
    audit.signals.push('Site did not respond (' + audit.error + ')');
    return {
      website_status: 'broken',
      has_https: hasHttps,
      mobile_friendly: null,
      website_audit: audit,
    };
  }

  const html = res.html;
  const lower = html.toLowerCase();

  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,200}?)<\/title>/i);
  audit.title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : null;

  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{0,300})/i);
  audit.metaDescription = descMatch ? descMatch[1].trim() : null;
  if (!audit.metaDescription) audit.signals.push('No meta description (SEO basics missing)');

  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  audit.mobileFriendly = viewport;
  if (!viewport) audit.signals.push('No viewport tag - the site is not mobile responsive');

  for (const b of BUILDER_SIGNATURES) {
    if (b.re.test(html)) { audit.builder = b.name; break; }
  }

  let parked = false;
  let placeholderHits = 0;
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.re.test(html)) {
      audit.signals.push(p.label);
      if (p.parked) parked = true;
      if (!p.weak) placeholderHits++;
    }
  }

  audit.socials = extractSocials(html, host);
  audit.socialLinkCount = ['instagram', 'facebook', 'linkedin', 'twitter', 'youtube']
    .filter((k) => audit.socials[k]).length;
  if (audit.socialLinkCount === 0) {
    audit.signals.push('Site links to no social accounts at all');
  }
  const email = extractEmail(html);
  if (email) audit.email = email;

  const yearMatch = html.match(/(?:copyright|&copy;|©)\s*(?:\d{4}\s*[-–]\s*)?(20\d{2})/i);
  if (yearMatch) {
    const y = Number(yearMatch[1]);
    audit.copyrightYear = y;
    const thisYear = new Date().getFullYear();
    if (thisYear - y >= 2) audit.signals.push('Copyright still says ' + y + ' - site has not been touched in years');
  }

  audit.textLength = lower.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if (audit.textLength < 400) audit.signals.push('Almost no content on the page');

  const status = parked
    ? 'parked'
    : placeholderHits > 0 || audit.textLength < 250
      ? 'placeholder'
      : 'ok';

  return {
    website_status: status,
    has_https: hasHttps,
    mobile_friendly: viewport,
    website_audit: audit,
    email: email || undefined,
    ig_handle: audit.socials.instagram || undefined,
  };
}

/** Optional: real mobile performance number. Free API, still rate limited. */
export async function pageSpeedMobile(url) {
  if (!config.pagespeed.enabled || !url) return null;
  try {
    const api = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    api.searchParams.set('url', url);
    api.searchParams.set('strategy', 'mobile');
    api.searchParams.set('category', 'performance');
    api.searchParams.set('key', config.pagespeed.apiKey);

    const res = await fetch(api, { signal: AbortSignal.timeout(45000) });
    if (!res.ok) return null;
    const json = await res.json();
    const score = json?.lighthouseResult?.categories?.performance?.score;
    return score == null ? null : Math.round(score * 100);
  } catch {
    return null;
  }
}

export { PLACEHOLDER_PATTERNS };
