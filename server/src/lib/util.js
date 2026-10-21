import crypto from 'node:crypto';

export const uid = (prefix = '') => prefix + crypto.randomBytes(9).toString('base64url');

export const now = () => new Date().toISOString();

export const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

export function haversineMeters(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat);
  const la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ------------------------------------------------------------------ */
/* Phone numbers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Calling codes for the markets the area picker covers.
 *
 * A national-format number means nothing without one. The old normaliser put a
 * '+' in front of whatever digits it was given, so "020 2563 6999" - a Pune
 * landline - became +2025636999, an Egyptian number, and every tel: and wa.me
 * link built from it dialled the wrong country.
 */
const DIAL_CODES = {
  IN: '91', US: '1', CA: '1', GB: '44', IE: '353', AE: '971', SA: '966', QA: '974', KW: '965',
  BH: '973', OM: '968', SG: '65', MY: '60', TH: '66', ID: '62', PH: '63', VN: '84', LK: '94',
  BD: '880', PK: '92', NP: '977', JP: '81', KR: '82', CN: '86', HK: '852', AU: '61', NZ: '64',
  FR: '33', DE: '49', NL: '31', ES: '34', IT: '39', PT: '351', PL: '48', TR: '90', MX: '52',
  BR: '55', AR: '54', KE: '254', NG: '234', EG: '20', ZA: '27',
};

/** Accepts an ISO country ('IN') or a bare calling code ('91', '+91'). */
export function dialCodeFor(country) {
  if (country === null || country === undefined) return '';
  const s = String(country).trim();
  if (!s) return '';
  if (/^\+?\d{1,4}$/.test(s)) return s.replace(/\D/g, '');
  return DIAL_CODES[s.toUpperCase()] || '';
}

/** Mappers and directories cram several numbers into one field. Take the first. */
export function firstPhone(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const parts = s
    .split(/\s*(?:[;,/|\n]|\bor\b)\s*|\s+(?=\+)/i)
    .map((p) => p.trim())
    .filter((p) => /\d/.test(p));
  if (!parts.length) return null;
  return parts[0].replace(/\s*(?:ext\.?|extn\.?|x)\s*\d{1,5}$/i, '').trim();
}

/**
 * India has one numbering plan worth knowing about here: a 10-digit national
 * number, mobiles starting 6-9, landlines an STD code plus subscriber number.
 * The ranges overlap (Bengaluru's 080 against the 8xxx mobile series), so the
 * way a number was written breaks the tie: "080-2345 6789" groups like a
 * landline, "98220 12345" like a mobile.
 */
function classifyIndian(national, written) {
  if (/^1(800|860)\d{6,7}$/.test(national)) {
    return { e164: '+91' + national, type: 'tollfree', valid: true, reason: null };
  }
  if (national.length < 10) {
    return { e164: null, type: 'invalid', valid: false, reason: 'Only ' + national.length + ' digits - the area code is probably missing' };
  }
  if (national.length > 10) {
    return { e164: null, type: 'invalid', valid: false, reason: 'Too many digits for an Indian number' };
  }
  if (!/^[1-9]/.test(national)) {
    return { e164: null, type: 'invalid', valid: false, reason: 'Not a valid Indian number' };
  }

  // The first group of digits after the trunk zero or the country code. A
  // trunk zero followed by a 2-4 digit group is how STD codes are written;
  // after +91 only a 2-digit group is (+91 80 2345 6789). Anything else in the
  // overlapping ranges is called a mobile, because for a small business it
  // almost always is, and a missed WhatsApp costs more than a wasted one.
  const s = String(written);
  const trunk = /^\s*\(?0(?!0)/.test(s);
  const body = trunk
    ? s.replace(/^\s*\(?0/, '')
    : s.replace(/^\s*(?:\+\s*91|0091|91(?=[\s\-.()]))[\s\-.()]*/, '');
  const m = body.match(/^(\d+)\)?[\s\-.]/);
  const group = m ? m[1] : '';
  const landlineShape = trunk ? group.length >= 2 && group.length <= 4 : group.length === 2;

  let type;
  if (/^9/.test(national)) type = 'mobile';
  else if (/^[6-8]/.test(national)) type = landlineShape ? 'landline' : 'mobile';
  else type = 'landline';

  return { e164: '+91' + national, type, valid: true, reason: null };
}

/**
 * Parse a phone number into something dialable.
 *
 * @param raw      whatever the source had, possibly several numbers
 * @param country  ISO code or calling code used for national-format numbers
 * @returns {{ e164: string|null, type: 'mobile'|'landline'|'tollfree'|'unknown'|'invalid'|null, valid: boolean, reason: string|null }}
 */
export function phoneInfo(raw, country) {
  const written = firstPhone(raw);
  if (!written) return { e164: null, type: null, valid: false, reason: 'No number' };

  let digits = written.replace(/\D/g, '');
  if (!digits) return { e164: null, type: 'invalid', valid: false, reason: 'No digits' };

  let international = /^\s*\+/.test(written);
  if (!international && digits.startsWith('00')) {
    international = true;
    digits = digits.slice(2);
  }

  if (!international) {
    const cc = dialCodeFor(country);
    const national = digits.replace(/^0+/, '');
    if (cc === '91') {
      // "91 98220 12345" - the country code typed without the plus.
      if (national.length === 12 && national.startsWith('91')) return classifyIndian(national.slice(2), written);
      return classifyIndian(national, written);
    }
    if (!cc) {
      // Nothing to anchor a national number to. Only trust digits that already
      // carry a country code, which in practice means 11 or more of them.
      if (national.length < 11) return { e164: null, type: 'invalid', valid: false, reason: 'No country code' };
      digits = national;
    } else {
      digits = cc + national;
    }
  }

  if (digits.startsWith('91') && digits.length >= 11 && digits.length <= 13) {
    return classifyIndian(digits.slice(2), written);
  }
  if (digits.length < 8 || digits.length > 15) {
    return { e164: null, type: 'invalid', valid: false, reason: 'Not a valid international number' };
  }
  return { e164: '+' + digits, type: 'unknown', valid: true, reason: null };
}

/** E.164 or null. Pass the lead's country, or a national number cannot be read. */
export function normalizePhone(raw, country = '') {
  return phoneInfo(raw, country).e164;
}

/** The country a lead's national-format number should be read in. */
export function countryFor(lead, fallback = '') {
  return lead && dialCodeFor(lead.country_code) ? lead.country_code : fallback || '';
}

/** The two derived phone columns, from whatever number is on the lead. */
export function phoneFields(phone, country) {
  if (!phone) return { phone_normalized: null, phone_type: null };
  const info = phoneInfo(phone, country);
  return { phone_normalized: info.e164, phone_type: info.valid ? info.type : 'invalid' };
}

/* ------------------------------------------------------------------ */
/* Names                                                              */
/* ------------------------------------------------------------------ */

/**
 * The comparison form of a business name.
 *
 * Keeps letters in every script. The previous version kept only a-z, so every
 * Devanagari name - "साई मोटर्स", "संज्योत क्लिनिक" - normalised to an empty
 * string, they all shared one dedupe key per locality, and every one after the
 * first was silently dropped as a "duplicate".
 */
export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')          // fold Latin accents: lakmé -> lakme
    .replace(/['’‘`]/g, '')                    // gold’s and gold's are one name
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|the|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Words every business in a category shares, so they say nothing about identity. */
const GENERIC_NAME_WORDS = new Set([
  'clinic', 'clinics', 'hospital', 'hospitals', 'centre', 'center', 'store', 'stores', 'shop', 'restaurant',
  'cafe', 'hotel', 'salon', 'studio', 'jewellers', 'jewelers', 'jewellery', 'jewelry', 'dental', 'care',
  'of', 'services', 'service', 'enterprises', 'enterprise', 'india', 'dr', 'doctor', 'multispeciality',
  'multispecialty', 'speciality', 'specialty', 'and', 'by', 'for', 'at', 'in', 'pune', 'mumbai',
]);

function bigrams(s) {
  const out = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    out.set(g, (out.get(g) || 0) + 1);
  }
  return out;
}

function dice(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let overlap = 0;
  for (const [g, n] of A) overlap += Math.min(n, B.get(g) || 0);
  return (2 * overlap) / (a.length - 1 + b.length - 1);
}

/**
 * How likely two names are one business, 0 to 1.
 *
 * Character bigrams catch spelling variants ("Lakme Salon" / "Lakmé Salon"),
 * and token containment catches the long form of a short name ("Lilavati
 * Hospital" / "Lilavati Hospital and Research Centre"). Containment only counts
 * when the shared words are distinctive enough - "Sai" alone matches half of
 * Pune.
 */
export function nameSimilarity(a, b) {
  const A = normalizeName(a);
  const B = normalizeName(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const ca = A.replace(/ /g, '');
  const cb = B.replace(/ /g, '');
  if (ca === cb) return 1;

  const ta = A.split(' ').filter((t) => t.length > 1 && !GENERIC_NAME_WORDS.has(t));
  const tb = B.split(' ').filter((t) => t.length > 1 && !GENERIC_NAME_WORDS.has(t));
  // Compare what is distinctive. Two dental clinics share "dental" and that
  // alone pushed unrelated names past half-similar.
  const da = ta.join('');
  const db = tb.join('');
  const [x, y] = da.length >= 3 && db.length >= 3 ? [da, db] : [ca, cb];
  let d = dice(x, y);
  // A short name that is only the start of a long one ("sai" in "saibaba")
  // shares every bigram it has and still is not the same business.
  const ratio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
  if (ratio < 0.6) d *= Math.sqrt(ratio);
  if (!ta.length || !tb.length) return d;

  const [short, long] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  const shared = short.filter((t) => long.has(t));
  const sharedChars = shared.reduce((n, t) => n + t.length, 0);
  if (shared.length === short.length && sharedChars >= 5) return Math.max(d, 0.88);
  return d;
}

/* ------------------------------------------------------------------ */
/* Other fields                                                       */
/* ------------------------------------------------------------------ */

export function normalizeHost(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:/i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

const TRACKING_PARAM = /^(utm_|fbclid$|gclid$|gbraid$|wbraid$|igshid$|mc_|srsltid$|_ga$|ref$)/i;

/**
 * One canonical form for a website: a scheme, a lowercase host, no tracking
 * parameters, no fragment. Returns null for anything that is not a URL - "N/A",
 * a phone number, a mailto.
 */
export function normalizeUrl(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).trim();
  if (!s || /^(mailto|tel|javascript|whatsapp):/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
  try {
    const u = new URL(s);
    if (!u.hostname.includes('.') || /\s/.test(u.hostname)) return null;
    u.hostname = u.hostname.toLowerCase();
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(k)) u.searchParams.delete(k);
    let out = u.toString();
    if (u.pathname === '/' && !u.search) out = out.replace(/\/$/, '');
    return out;
  } catch {
    return null;
  }
}

/** Trim, collapse whitespace, drop stray separators at the ends. */
export function tidyText(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).replace(/\s+/g, ' ').replace(/^[\s,;.\-]+|[\s,;\-]+$/g, '').trim();
  return t || null;
}

/**
 * "Pune", "pune" and "PUNE" are one place. Mixed case is somebody's deliberate
 * spelling and is left alone.
 */
export function normalizeLocality(s) {
  const t = tidyText(s);
  if (!t) return null;
  if (t === t.toUpperCase() || t === t.toLowerCase()) {
    return t.toLowerCase().replace(/(^|[\s,(\-/])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  }
  return t;
}

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/;

/** A deliverable-looking business address, or null. */
export function cleanEmail(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase().replace(/^mailto:/, '').split('?')[0].trim();
  if (!EMAIL_RE.test(s)) return null;
  // Retina image names ("logo@2x.png") match an email pattern.
  if (/\.(png|jpe?g|gif|webp|svg|css|js|ico)$/.test(s)) return null;
  if (/@(example|domain|yoursite|mysite|yourdomain|email|sentry|sentry-next|wixpress)\./.test(s)) return null;
  if (/^(your|youremail|name|email|user|username|test)@/.test(s)) return null;
  return s;
}

/** Path segments on instagram.com that are pages, not accounts. */
const INSTAGRAM_RESERVED = new Set([
  'p', 'reel', 'reels', 'explore', 'stories', 'tv', 'accounts', 'direct', 'about', 'developer', 'legal',
  'web', 'share', 'sharer', 'tr', 'plugins', 'embed', 'login', 'signup', 'oauth', 'graphql', 'static',
  'privacy', 'terms', 'instagram', 'help', 'press', 'api', 'challenge', 'emails', 'session',
]);

/** A real handle, lowercased, or null. Instagram handles are case-insensitive. */
export function cleanInstagramHandle(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  const m = s.match(/instagram\.com\/([^/?#\s]+)/i);
  if (m) s = m[1];
  s = s.replace(/^@/, '').replace(/[/?#].*$/, '').trim();
  if (!/^[A-Za-z0-9._]{1,30}$/.test(s)) return null;
  if (INSTAGRAM_RESERVED.has(s.toLowerCase())) return null;
  if (/^\.|\.$|\.\./.test(s)) return null;
  return s.toLowerCase();
}

export function addDays(iso, days) {
  const d = new Date(iso || Date.now());
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function daysSince(iso, at = Date.now()) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? Math.floor((at - t) / 86400000) : null;
}

/** jsonb comes back parsed from pg, but a value written by hand may be a string. */
export function asObject(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try {
    const o = JSON.parse(v);
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
