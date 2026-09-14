/**
 * API client. One place that knows about headers, error shapes and the acting
 * user, so no component ever calls fetch directly.
 */

let actingUser = localStorage.getItem('actingUserId') || null;

export function setActingUser(id) {
  actingUser = id;
  if (id) localStorage.setItem('actingUserId', id);
  else localStorage.removeItem('actingUserId');
}

export function getActingUser() {
  return actingUser;
}

async function request(path, { method = 'GET', body, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (actingUser) headers['x-user-id'] = actingUser;

  const res = await fetch('/api' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    // fall through - some responses legitimately have no body
  }

  if (!res.ok) {
    const err = new Error(json?.error || 'Request failed (' + res.status + ')');
    err.status = res.status;
    err.details = json?.details;
    throw err;
  }
  return json;
}

export const api = {
  bootstrap: () => request('/meta/bootstrap'),
  health: () => request('/meta/health'),
  usage: () => request('/meta/usage'),
  estimate: (body) => request('/meta/estimate', { method: 'POST', body }),

  searchAreas: (q, signal) => request('/discovery/areas/search?q=' + encodeURIComponent(q) + '&limit=10', { signal }),
  listAreas: () => request('/discovery/areas'),
  saveArea: (body) => request('/discovery/areas', { method: 'POST', body }),
  deleteArea: (id) => request('/discovery/areas/' + id, { method: 'DELETE' }),

  startRun: (body) => request('/discovery/runs', { method: 'POST', body }),
  listRuns: () => request('/discovery/runs'),
  getRun: (id) => request('/discovery/runs/' + id),
  cancelRun: (id) => request('/discovery/runs/' + id + '/cancel', { method: 'POST' }),

  listLeads: (params) => request('/leads?' + new URLSearchParams(params)),
  board: (params) => request('/leads/board?' + new URLSearchParams(params || {})),
  leadFacets: (params) => request('/leads/facets?' + new URLSearchParams(params || {})),
  leadCount: (params) => request('/leads/count?' + new URLSearchParams(params || {})),
  getLead: (id) => request('/leads/' + id),
  patchLead: (id, body) => request('/leads/' + id, { method: 'PATCH', body }),
  moveStage: (id, body) => request('/leads/' + id + '/stage', { method: 'POST', body }),
  reviewLeads: (body) => request('/leads/review', { method: 'POST', body }),
  assignLeads: (body) => request('/leads/assign', { method: 'POST', body }),
  logActivity: (id, body) => request('/leads/' + id + '/activities', { method: 'POST', body }),
  auditLead: (id, psi) => request('/leads/' + id + '/audit' + (psi ? '?pagespeed=true' : ''), { method: 'POST' }),
  markDnc: (id, body) => request('/leads/' + id + '/dnc', { method: 'POST', body }),
  verifyLead: (id, body) => request('/leads/' + id + '/verify', { method: 'POST', body }),

  verifyByResearch: (id) => request('/ai/leads/' + id + '/verify-by-research', { method: 'POST' }),
  research: (id, force) => request('/ai/leads/' + id + '/research' + (force ? '?force=true' : '')),
  brief: (id, force) => request('/ai/leads/' + id + '/brief' + (force ? '?force=true' : '')),
  whatsapp: (id, force) => request('/ai/leads/' + id + '/whatsapp' + (force ? '?force=true' : '')),
  nextStep: (id, force) => request('/ai/leads/' + id + '/next-step' + (force ? '?force=true' : '')),
  extractNote: (id, body) => request('/ai/leads/' + id + '/extract-note', { method: 'POST', body }),
  suggestionAction: (id, body) => request('/ai/suggestions/' + id + '/action', { method: 'POST', body }),
  aiQuality: () => request('/ai/quality'),
  aiStatus: () => request('/ai/status'),

  funnel: () => request('/analytics/funnel'),
  scoreBands: () => request('/analytics/score-bands'),
  weightSignal: () => request('/analytics/weight-signal'),
  lossReasons: () => request('/analytics/loss-reasons'),
  repStats: () => request('/analytics/reps'),
  categoryStats: () => request('/analytics/categories'),
  due: () => request('/analytics/due'),

  getScoring: () => request('/settings/scoring'),
  saveScoring: (body) => request('/settings/scoring', { method: 'POST', body }),
  users: () => request('/settings/users'),
  saveUser: (body) => request('/settings/users', { method: 'POST', body }),
  patchUser: (id, body) => request('/settings/users/' + id, { method: 'PATCH', body }),
  packages: () => request('/settings/packages'),
  patchPackage: (id, body) => request('/settings/packages/' + id, { method: 'PATCH', body }),
  catalog: () => request('/settings/catalog'),
  patchTenant: (body) => request('/settings/tenant', { method: 'PATCH', body }),
};

export default api;
