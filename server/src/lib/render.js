/**
 * Template substitution.
 *
 * The model is forbidden from emitting a phone number, email or URL, and the
 * guardrail in gemini.js replaces any it produces with a token. This is where
 * the real values go back in - from the database, never from the model.
 */

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

export function renderTemplate(text, vars = {}) {
  if (typeof text !== 'string') return text;
  return text.replace(TOKEN_RE, (whole, key) => {
    const v = vars[key];
    if (v === undefined || v === null || v === '') return '';
    return String(v);
  }).replace(/[ \t]{2,}/g, ' ').replace(/ +([.,!?])/g, '$1').trim();
}

export function renderDeep(value, vars) {
  if (typeof value === 'string') return renderTemplate(value, vars);
  if (Array.isArray(value)) return value.map((v) => renderDeep(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderDeep(v, vars);
    return out;
  }
  return value;
}

/** The variables available to every generated message. */
export function templateVars({ lead, user, tenant }) {
  return {
    name: lead?.name || '',
    business: lead?.name || '',
    category: lead?.category || '',
    city: lead?.locality || lead?.region || '',
    reviews: lead?.review_count != null ? Number(lead.review_count).toLocaleString() : '',
    rating: lead?.rating != null ? String(lead.rating) : '',
    phone: lead?.phone || '',
    email: lead?.email || '',
    link: lead?.website || lead?.maps_url || '',
    website: lead?.website || '',
    maps: lead?.maps_url || '',
    repName: user?.name || 'our team',
    repEmail: user?.email || '',
    agency: tenant?.name || '',
  };
}

/** Any token we could not fill. Surfaced in the UI so a rep never sends "{{phone}}". */
export function unresolvedTokens(text, vars) {
  if (typeof text !== 'string') return [];
  const out = new Set();
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    const v = vars[m[1]];
    if (v === undefined || v === null || v === '') out.add(m[1]);
  }
  return [...out];
}
