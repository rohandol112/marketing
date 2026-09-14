import { normalizePhone } from './util.js';

/**
 * WhatsApp click-to-chat deeplinks.
 *
 * Deliberately NOT the WhatsApp Business API. WABA requires prior opt-in and
 * pre-approved templates; sending cold outreach through it is the fastest way
 * to get a number banned. A wa.me link opens the rep's own WhatsApp with the
 * message pre-typed - a human still presses send, which is both compliant and
 * the reason the message actually gets read.
 *
 * Move to WABA only after they reply, for the parts of the conversation that
 * are genuinely transactional.
 */

export function waLink(phone, message) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const digits = norm.replace(/\D/g, '');
  if (digits.length < 8) return null;
  const base = 'https://wa.me/' + digits;
  return message ? base + '?text=' + encodeURIComponent(message) : base;
}

/** Search Google's Ad Transparency Centre. There is no commercial ads API, so
 *  this hands the rep a one-click lookup instead of pretending to automate it. */
export function adLibraryLinks(lead) {
  const q = encodeURIComponent(lead.name || '');
  const links = {
    google_ads_transparency: 'https://adstransparency.google.com/?region=anywhere&query=' + q,
    meta_ad_library:
      'https://www.facebook.com/ads/library/?active_status=all&ad_type=all&search_type=keyword_unordered&q=' + q,
  };
  if (lead.website_host) {
    links.site_on_google = 'https://www.google.com/search?q=' + encodeURIComponent('site:' + lead.website_host);
  }
  if (lead.name) {
    links.instagram_search = 'https://www.instagram.com/explore/search/keyword/?q=' + q;
    links.linkedin_search = 'https://www.linkedin.com/search/results/companies/?keywords=' + q;
  }
  return links;
}

export function telLink(phone) {
  const norm = normalizePhone(phone);
  return norm ? 'tel:' + norm : null;
}

export function mailtoLink(email, subject, body) {
  if (!email) return null;
  const params = [];
  if (subject) params.push('subject=' + encodeURIComponent(subject));
  if (body) params.push('body=' + encodeURIComponent(body));
  return 'mailto:' + email + (params.length ? '?' + params.join('&') : '');
}
