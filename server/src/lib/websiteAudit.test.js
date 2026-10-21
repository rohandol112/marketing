import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHtml, classifySite, auditWebsite, urlVariants, visibleText } from './websiteAudit.js';

/**
 * The auditor's two jobs: never call a working site broken, and never claim a
 * gap that is not on the page. Every fixture below is the shape of something
 * seen on a real small-business site.
 */

const NOW = new Date('2026-10-01T00:00:00Z');
const page = (body, head = '') =>
  '<!doctype html><html lang="en"><head><title>Ranka Jewellers - Pune</title>' + head + '</head><body>' + body + '</body></html>';
const filler = '<p>' + 'We have served Pune families with hallmarked gold and diamond jewellery for three generations. '.repeat(8) + '</p>';

test('a bare brochure site: every gap is named, nothing is invented', () => {
  const a = analyzeHtml(page('<h1>Ranka Jewellers</h1>' + filler + '<footer>© 2019 Ranka Jewellers</footer>'), { host: 'ranka.in', now: NOW });
  assert.equal(a.v, 2);
  assert.equal(a.tracking.any, false);
  assert.equal(a.conversion.any, false);
  assert.equal(a.socialLinkCount, 0);
  assert.equal(a.copyrightYear, 2019);
  assert.equal(a.metaDescription, null);
  assert.equal(a.mobileFriendly, false);
  assert.equal(a.seo.localSchema, false);
  assert.equal(classifySite(a), 'ok');
  const all = a.signals.join(' | ');
  assert.match(all, /No analytics or ad tracking/);
  assert.match(all, /No way to act on the site/);
  assert.match(all, /Copyright still says 2019/);
  assert.match(all, /not mobile responsive/);
});

test('a well-run site gets credit for what it has', () => {
  const head = '<meta name="viewport" content="width=device-width"><meta content="Hallmarked jewellery in Pune" name="description">'
    + '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ"></script>'
    + "<script>!function(f,b,e,v,n,t,s){};fbq('init', '1234567890');</script>"
    + '<script type="application/ld+json">{"@context":"https://schema.org","@type":"JewelryStore","name":"Ranka"}</script>';
  const body = '<h1>Ranka</h1>' + filler
    + '<a href="https://wa.me/919822012345">WhatsApp us</a><a href="tel:+912025531234">Call</a>'
    + '<form><input type="email" name="email"><textarea name="message"></textarea></form>'
    + '<a href="https://www.instagram.com/rankajewellers/">IG</a><a href="https://www.facebook.com/rankajewellers">FB</a>'
    + '<footer>© 2016 - 2026 Ranka</footer>';
  const a = analyzeHtml(page(body, head), { host: 'ranka.in', country: 'IN', now: NOW });
  assert.equal(a.tracking.ga4, true);
  assert.equal(a.tracking.metaPixel, true);
  assert.equal(a.conversion.whatsapp, true);
  assert.equal(a.conversion.clickToCall, true);
  assert.equal(a.conversion.contactForm, true);
  assert.equal(a.seo.localSchema, true);
  assert.equal(a.metaDescription, 'Hallmarked jewellery in Pune', 'content before name is still read');
  assert.equal(a.copyrightYear, 2026, 'a year range is read by its end');
  assert.equal(a.contact.whatsapp, '+919822012345');
  assert.deepEqual(a.contact.phones, ['+912025531234']);
  assert.equal(a.socials.instagram, 'rankajewellers');
  assert.equal(a.socials.facebook, 'rankajewellers');
  assert.doesNotMatch(a.signals.join(' | '), /No analytics|No way to act|no social accounts/);
});

test('Universal Analytics alone measures nothing, and big-site stacks are recognised', () => {
  const ua = analyzeHtml(page(filler, "<script>ga('create', 'UA-1234567-1', 'auto');</script><script src='https://www.google-analytics.com/analytics.js'></script>"), { now: NOW });
  assert.equal(ua.tracking.universalAnalytics, true);
  assert.equal(ua.tracking.analytics, false);
  assert.match(ua.signals.join(' | '), /Universal Analytics/);

  const adobe = analyzeHtml(page(filler, '<script src="https://assets.adobedtm.com/launch-abc.min.js"></script>'), { now: NOW });
  assert.equal(adobe.tracking.analytics, true, 'Adobe Launch is analytics');
});

test('script source is not page content, and a script copyright is not the site copyright', () => {
  const body = '<div id="root"></div><script>var copyright = "© 2012"; ' + 'x'.repeat(5000) + '</script>';
  const a = analyzeHtml(page(body), { now: NOW });
  assert.equal(a.copyrightYear, null);
  assert.ok(a.textLength < 50);
  assert.equal(a.spa, true);
  assert.equal(classifySite(a), 'ok', 'a JavaScript-rendered site is not a placeholder');
  assert.equal(visibleText('<p>a</p><style>.x{}</style><script>y()</script><!-- z -->b'), 'a b');
});

test('noindex is caught from the meta tag and the header', () => {
  assert.equal(analyzeHtml(page(filler, '<meta name="robots" content="noindex, nofollow">'), { now: NOW }).seo.noindex, true);
  assert.equal(analyzeHtml(page(filler), { now: NOW, headers: { 'x-robots-tag': 'noindex' } }).seo.noindex, true);
  assert.equal(analyzeHtml(page(filler), { now: NOW }).seo.noindex, false);
});

test('share buttons and reel links are not the business account', () => {
  const body = filler
    + '<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>'
    + '<a href="https://www.instagram.com/reel/Cx123/">Our reel</a>'
    + '<a href="https://twitter.com/intent/tweet?text=x">Tweet</a>'
    + '<a href="https://www.instagram.com/themeauthor/">theme</a>'
    + '<a href="https://www.instagram.com/realbiz/">IG</a><a href="https://instagram.com/realbiz">IG footer</a>';
  const a = analyzeHtml(page(body), { now: NOW });
  assert.equal(a.socials.instagram, 'realbiz', 'most frequent handle wins, reserved paths ignored');
  assert.equal(a.socials.facebook, undefined);
  assert.equal(a.socials.twitter, undefined);
});

test('emails: mailto, Cloudflare-protected and visible, with retina image names ignored', () => {
  // Cloudflare's XOR obfuscation of info@shop.in with key 0x42.
  const encoded = '42' + [...'info@shop.in'].map((ch) => (ch.charCodeAt(0) ^ 0x42).toString(16).padStart(2, '0')).join('');
  const body = filler + '<img src="logo@2x.png"><a href="mailto:Owner@Shop.in">mail</a>'
    + '<span class="__cf_email__" data-cfemail="' + encoded + '">[email protected]</span>';
  const a = analyzeHtml(page(body), { host: 'shop.in', now: NOW });
  assert.deepEqual(a.contact.emails.sort(), ['info@shop.in', 'owner@shop.in']);
  assert.equal(a.email.endsWith('@shop.in'), true);
});

test('outdated technology and agency credits are read off the page', () => {
  const head = '<meta name="generator" content="WordPress 5.2.4"><script src="/js/jquery-1.11.3.min.js"></script>';
  const body = filler + '<marquee>Offers!</marquee><footer>© 2024 Ranka. Designed &amp; Developed by PixelCraft Studios | All rights reserved</footer>';
  const a = analyzeHtml(page(body, head), { now: NOW });
  assert.deepEqual(a.tech.outdated, ['WordPress 5.2', 'jQuery 1.11', '1990s-era markup']);
  assert.equal(a.agencyCredit, 'PixelCraft Studios');

  const builder = analyzeHtml(page(filler + '<footer>Powered by WordPress</footer>'), { now: NOW });
  assert.equal(builder.agencyCredit, null, 'naming the platform is not an agency');
});

test('placeholders and parked domains are recognised; a real thin page is not called parked', () => {
  const lorem = analyzeHtml(page('<h1>Welcome</h1><p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>' + filler), { now: NOW });
  assert.equal(classifySite(lorem), 'placeholder');

  const parked = analyzeHtml(page('<h1>This domain is for sale</h1><p>Buy this domain today.</p>'), { now: NOW });
  assert.equal(classifySite(parked), 'parked');

  const suspended = analyzeHtml('<html><head><title>Account Suspended</title></head><body>This account has been suspended.</body></html>', { now: NOW });
  assert.equal(classifySite(suspended), 'parked');

  const blank = analyzeHtml(page('<p>Call us</p>'), { now: NOW });
  assert.equal(classifySite(blank), 'placeholder');

  const comingSoonMenu = analyzeHtml(page(filler + '<nav>New collection coming soon</nav>'), { now: NOW });
  assert.equal(classifySite(comingSoonMenu), 'ok', '"coming soon" in a menu is not a coming-soon page');
});

test('URL variants cover www, bare and plain http, in that order', () => {
  assert.deepEqual(urlVariants('ranka.in'), [
    'https://ranka.in', 'https://www.ranka.in', 'http://ranka.in', 'http://www.ranka.in',
  ]);
  assert.equal(urlVariants('https://www.ranka.in/branches')[0], 'https://www.ranka.in/branches');
  assert.ok(urlVariants('https://www.ranka.in/branches').includes('https://ranka.in'), 'falls back to the homepage');
});

/* ---------------- fetching, against a fake network ---------------- */

function fakeFetch(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    const r = routes[String(url)];
    if (!r) throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (r.error) throw Object.assign(new TypeError('fetch failed'), { cause: { code: r.error } });
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      url: r.url || String(url),
      headers: new Headers({ 'content-type': r.type || 'text/html; charset=utf-8', ...(r.headers || {}) }),
      text: async () => r.body || '',
      body: null,
    };
  };
  fn.calls = calls;
  return fn;
}

const goodPage = page('<h1>Ranka</h1>' + filler, '<meta name="viewport" content="width=device-width"><style>@media (max-width:600px){h1{font-size:1em}}</style>');

test('an apex domain that does not resolve is tried again on www', async () => {
  const fetchImpl = fakeFetch({ 'https://www.ranka.in': { status: 200, body: goodPage } });
  const r = await auditWebsite('ranka.in', { fetchImpl, now: NOW });
  assert.equal(r.website_status, 'ok');
  assert.equal(r.has_https, true);
  assert.equal(r.mobile_friendly, true);
  assert.deepEqual(fetchImpl.calls.slice(0, 2), ['https://ranka.in', 'https://www.ranka.in']);
});

test('a firewall that blocks bots is "protected", never "broken"', async () => {
  const fetchImpl = fakeFetch({
    'https://ranka.in': { status: 403, body: '<title>Attention Required! | Cloudflare</title>', headers: { server: 'cloudflare' } },
  });
  const r = await auditWebsite('https://ranka.in', { fetchImpl, now: NOW });
  assert.equal(r.website_status, 'protected');
  assert.match(r.website_audit.signals[0], /blocks automated checks/);
});

test('free hosting behind a JavaScript cookie check is protected too', async () => {
  const fetchImpl = fakeFetch({
    'https://ranka.in': { status: 200, body: '<html><body><script src="/aes.js"></script><script>slowAES.decrypt(c,2,a,b);document.cookie="__test="+x;</script></body></html>' },
  });
  const r = await auditWebsite('https://ranka.in', { fetchImpl, now: NOW });
  assert.equal(r.website_status, 'protected');
  assert.equal(r.website_audit.freeHosting, true);
});

test('a dead domain is broken, with the reason in words', async () => {
  const r = await auditWebsite('https://deadclinic.in', { fetchImpl: fakeFetch({}), now: NOW });
  assert.equal(r.website_status, 'broken');
  assert.match(r.website_audit.error, /does not resolve/);

  const server = await auditWebsite('https://errors.in', {
    fetchImpl: fakeFetch({ 'https://errors.in': { status: 500 }, 'https://www.errors.in': { status: 500 }, 'http://errors.in': { status: 500 }, 'http://www.errors.in': { status: 500 } }),
    now: NOW,
  });
  assert.equal(server.website_status, 'broken');
  assert.match(server.website_audit.error, /HTTP 500/);
});

test('a domain that redirects to Facebook or a parking page owns no site', async () => {
  const toFb = await auditWebsite('https://ranka.in', {
    fetchImpl: fakeFetch({ 'https://ranka.in': { status: 200, url: 'https://www.facebook.com/rankajewellers', body: '<html></html>' } }),
    now: NOW,
  });
  assert.equal(toFb.website_status, 'social_only');

  const parked = await auditWebsite('https://ranka.in', {
    fetchImpl: fakeFetch({ 'https://ranka.in': { status: 200, url: 'https://expireddomains.com/domain/ranka.in', body: '<html></html>' } }),
    now: NOW,
  });
  assert.equal(parked.website_status, 'parked');
});

test('platform links are classified without a network call', async () => {
  const fetchImpl = fakeFetch({});
  const r = await auditWebsite('https://chinmay-nursing-home.business.site/', { fetchImpl, now: NOW });
  assert.equal(r.website_status, 'social_only');
  assert.equal(r.website_audit.platformKind, 'google');
  assert.equal(fetchImpl.calls.length, 0);
});

test('a link to a PDF is not a website', async () => {
  const r = await auditWebsite('http://nb.example.in/list.pdf', {
    fetchImpl: fakeFetch({ 'http://nb.example.in/list.pdf': { status: 200, type: 'application/pdf' } }),
    now: NOW,
  });
  assert.equal(r.website_status, 'placeholder');
  assert.match(r.website_audit.signals[0], /PDF/);
});

test('an expired certificate is found, and the site is still read', async () => {
  const fetchImpl = fakeFetch({ 'https://ranka.in': { error: 'CERT_HAS_EXPIRED' } });
  const insecure = async (url) => ({ ok: true, status: 200, url, html: goodPage, contentType: 'text/html', headers: {} });
  const r = await auditWebsite('https://ranka.in', { fetchImpl, insecure, now: NOW });
  assert.equal(r.website_status, 'ok');
  assert.equal(r.has_https, false, 'visitors see a warning, so it does not count as HTTPS');
  assert.equal(r.website_audit.tls.customerVisible, true);
  assert.match(r.website_audit.signals[0], /SSL certificate is invalid/);
});

test('a missing intermediate certificate is not a visitor-facing problem', async () => {
  const fetchImpl = fakeFetch({ 'https://ranka.in': { error: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
  const insecure = async (url) => ({ ok: true, status: 200, url, html: goodPage, contentType: 'text/html', headers: {} });
  const r = await auditWebsite('https://ranka.in', { fetchImpl, insecure, now: NOW });
  assert.equal(r.has_https, true);
  assert.equal(r.website_audit.tls.customerVisible, false);
});

test('a viewport tag with fixed-width CSS is not mobile friendly', async () => {
  const html = page('<h1>Ranka</h1>' + filler, '<meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/style.css">');
  const fetchImpl = fakeFetch({
    'https://ranka.in': { status: 200, body: html },
    'https://ranka.in/style.css': { status: 200, type: 'text/css', body: 'body{width:960px}' },
  });
  const r = await auditWebsite('https://ranka.in', { fetchImpl, now: NOW });
  assert.equal(r.mobile_friendly, false);
  assert.equal(r.website_audit.responsiveCss, false);
  assert.match(r.website_audit.signals.join(' | '), /no responsive CSS/);
});

test('phones and WhatsApp numbers on their own site are returned for the lead', async () => {
  const html = page(filler + '<a href="tel:020-2553 1234">Call</a><a href="https://api.whatsapp.com/send?phone=919822012345&text=hi">WA</a>');
  const r = await auditWebsite('https://ranka.in', { fetchImpl: fakeFetch({ 'https://ranka.in': { status: 200, body: html } }), country: 'IN', now: NOW, checkCss: false });
  assert.equal(r.phone, '+912025531234');
  assert.equal(r.whatsapp, '+919822012345');
});
