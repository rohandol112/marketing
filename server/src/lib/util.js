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

// E.164-ish normalisation. Keeps a leading +, strips everything else non-digit.
export function normalizePhone(raw, defaultCountryCode = '') {
  if (!raw) return null;
  let s = String(raw).trim();
  const hasPlus = s.startsWith('+');
  s = s.replace(/[^0-9]/g, '');
  if (!s) return null;
  s = s.replace(/^0+/, '');
  if (hasPlus) return '+' + s;
  if (defaultCountryCode) return '+' + String(defaultCountryCode).replace(/[^0-9]/g, '') + s;
  return '+' + s;
}

export function normalizeName(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|the|and)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeHost(url) {
  if (!url) return null;
  try {
    const u = new URL(/^https?:/i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return null;
  }
}

export function addDays(iso, days) {
  const d = new Date(iso || Date.now());
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
