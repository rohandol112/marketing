import config from '../config.js';
import { cleanInstagramHandle } from './util.js';

/**
 * Instagram numbers through Meta's own Business Discovery API.
 *
 * Follower counts were treated as having no lawful API, so they were either
 * typed in by a rep or guessed at by a search model - and the guesses were off
 * by orders of magnitude. Business Discovery is the sanctioned route: your
 * agency's Instagram business account asks about another public business or
 * creator account, and Meta answers with its followers, post count and recent
 * posts. No scraping, no login cookies, nothing that breaks Meta's terms.
 *
 * Setup, once: a Meta app, your Instagram professional account linked to a
 * Facebook Page, and a long-lived token with instagram_basic and
 * pages_read_engagement. Put the token in META_GRAPH_TOKEN and your account's
 * Instagram user id in INSTAGRAM_BUSINESS_ID.
 *
 * It only sees business and creator accounts. A personal account comes back as
 * not found, which is "unknown", never "no Instagram".
 */

const GRAPH = 'https://graph.facebook.com/';

export function instagramAvailable() {
  return config.instagram.enabled;
}

/** Error codes Meta uses for "no such business account" rather than a failure. */
const NOT_FOUND = new Set([100, 110]);
/** Throttling: try again later rather than recording anything. */
const THROTTLED = new Set([4, 17, 32, 613, 80002]);

/**
 * @returns {Promise<{ found: boolean, reason?: string, username?, name?, followers?, following?,
 *   mediaCount?, lastPostAt?, postsLast30d?, engagementRate?, website?, biography?, checkedAt: string }>}
 */
export async function lookupInstagram(rawHandle, { fetchImpl = fetch, now = new Date() } = {}) {
  const checkedAt = now.toISOString();
  const handle = cleanInstagramHandle(rawHandle);
  if (!handle) return { found: false, reason: 'Not a valid Instagram handle', checkedAt };
  if (!instagramAvailable()) {
    const err = new Error('Instagram lookup is not configured. Set META_GRAPH_TOKEN and INSTAGRAM_BUSINESS_ID.');
    err.retryable = false;
    throw err;
  }

  const fields = 'business_discovery.username(' + handle + '){username,name,biography,website,followers_count,'
    + 'follows_count,media_count,media.limit(12){timestamp,like_count,comments_count,media_type}}';
  const url = GRAPH + config.instagram.version + '/' + encodeURIComponent(config.instagram.businessId)
    + '?fields=' + encodeURIComponent(fields)
    + '&access_token=' + encodeURIComponent(config.instagram.token);

  const res = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  const json = await res.json().catch(() => ({}));

  if (json.error) {
    const code = Number(json.error.code);
    if (THROTTLED.has(code)) {
      const err = new Error('Instagram API rate limit reached - retrying later');
      err.retryable = true;
      throw err;
    }
    if (code === 190) {
      const err = new Error('The Instagram access token has expired or been revoked. Generate a new META_GRAPH_TOKEN.');
      err.retryable = false;
      throw err;
    }
    if (NOT_FOUND.has(code) || res.status === 400) {
      return { found: false, handle, reason: 'Not a public business or creator account', checkedAt };
    }
    const err = new Error('Instagram API error ' + code + ': ' + String(json.error.message || '').slice(0, 160));
    err.retryable = res.status >= 500;
    throw err;
  }

  const bd = json.business_discovery;
  if (!bd) return { found: false, handle, reason: 'No business account by that name', checkedAt };

  const posts = (bd.media && Array.isArray(bd.media.data) ? bd.media.data : [])
    .filter((m) => m && m.timestamp)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  const followers = Number.isFinite(Number(bd.followers_count)) ? Number(bd.followers_count) : null;
  const month = 30 * 86400000;

  // Like counts can be hidden by the account; only posts that show them count.
  const visible = posts.filter((m) => Number.isFinite(m.like_count));
  const engagementRate = followers && visible.length
    ? Math.round((visible.reduce((s, m) => s + m.like_count + (m.comments_count || 0), 0) / visible.length / followers) * 10000) / 10000
    : null;

  return {
    found: true,
    handle,
    username: bd.username || handle,
    name: bd.name || null,
    followers,
    following: Number.isFinite(Number(bd.follows_count)) ? Number(bd.follows_count) : null,
    mediaCount: Number.isFinite(Number(bd.media_count)) ? Number(bd.media_count) : null,
    lastPostAt: posts[0] ? new Date(posts[0].timestamp).toISOString() : null,
    postsLast30d: posts.filter((m) => now.getTime() - Date.parse(m.timestamp) <= month).length,
    engagementRate,
    website: bd.website || null,
    biography: bd.biography ? String(bd.biography).slice(0, 300) : null,
    checkedAt,
  };
}
