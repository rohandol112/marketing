import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import { useApp, useToast } from '../App.jsx';
import LeadDrawer from '../components/LeadDrawer.jsx';
import FastVerify from '../components/FastVerify.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { DealPip, money } from '../components/DealPip.jsx';
import { ConfidencePip } from './Board.jsx';

/**
 * Four queues, matching the four things that actually have to happen to a lead
 * between a sweep and a phone call. They were one screen once and it was a mess:
 * "confirm this exists" and "is this worth a rep's day" are different jobs done
 * by different people.
 */
const QUEUES = {
  hot: {
    label: 'Close this week',
    blurb:
      'The deals worth chasing now: a business big enough to pay, a problem they can see today, and a number that ' +
      'reaches the owner. Chains, government bodies and duplicates are already out. Ranked by deal readiness - ' +
      'start at the top, and lead with the line under each name.',
    params: { discoveryStatus: 'qualified,verified', status: 'pending_review', hasPhone: 'true', minDeal: '50', sort: 'deal' },
    verifiable: true,
    approvable: true,
  },
  apps: {
    label: 'App pitch',
    blurb:
      'Schools, colleges, coaching classes and preschools with no app of their own - their site, Google Play and the ' +
      'App Store were all checked, and a same-name app elsewhere keeps a lead out until someone looks. Their students ' +
      'and parents get fees, results and notices over WhatsApp groups; an app with the institute\'s name on it is the pitch.',
    params: { appPitch: 'true', status: 'pending_review', discoveryStatus: 'discovered,verifying,verified,qualified', sort: 'deal' },
    approvable: true,
  },
  enrich: {
    label: 'Needs data',
    blurb:
      'Real businesses from a directory, but missing the numbers that decide whether they are worth calling. ' +
      'The review count is the big one - it is the entire demand score, and without it every lead here scores the same.',
    params: { discoveryStatus: 'verified', sort: 'priority' },
    verifiable: true,
  },
  confirm: {
    label: 'Unconfirmed',
    blurb:
      'Recalled by the model from memory, not read from a directory - some will not exist. ' +
      'Research and verify checks each against live web search: leads that come back with citations are promoted, ' +
      'ones that do not stay here.',
    params: { discoveryStatus: 'discovered,verifying', includeDisqualified: 'true', sort: 'priority' },
    verifiable: true,
  },
  review: {
    label: 'Review queue',
    blurb:
      'Verified, qualified, and waiting on your decision. Approving is the only thing that puts a lead ' +
      'onto a board. Verification alone never does, and assigning does not approve.',
    params: { discoveryStatus: 'qualified', status: 'pending_review', sort: 'deal' },
    approvable: true,
  },
  rejected: {
    label: 'Rejected',
    blurb: 'Disqualified, or confirmed not to exist.',
    params: { discoveryStatus: 'rejected', includeDisqualified: 'true' },
  },
};

/** The app check's verdicts, as the App pitch queue's sub-filters. */
const APP_FILTERS = [
  ['no_app', 'No app'],
  ['unclear', 'Possible app - check'],
  ['unchecked', 'Not checked'],
  ['has_app,white_label', 'Has an app'],
];

/** A queue's params, with the app filter applied in the App pitch queue. */
function queueParams(key, appFilter) {
  const p = QUEUES[key].params;
  return key === 'apps' ? { ...p, appStatus: appFilter } : p;
}

export default function Review() {
  const app = useApp();
  const toast = useToast();

  // /review?queue=apps opens straight on a queue, so a list can be linked to a rep.
  const [queue, setQueue] = useState(() => {
    const wanted = new URLSearchParams(window.location.search).get('queue');
    return wanted && QUEUES[wanted] ? wanted : 'hot';
  });
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [openId, setOpenId] = useState(null);
  const [assignTo, setAssignTo] = useState('');
  const [counts, setCounts] = useState({});
  const [fastQueue, setFastQueue] = useState(null);
  const [filters, setFilters] = useState({});
  const [facets, setFacets] = useState(null);
  const [totalInQueue, setTotalInQueue] = useState(null);
  const [matchCount, setMatchCount] = useState(null);
  const [appFilter, setAppFilter] = useState('no_app');
  const [appSummary, setAppSummary] = useState(null);

  // Filtering happens in the database, not in the browser. With hundreds of
  // leads a client-side filter would be filtering whatever slice happened to
  // load, which quietly lies about the counts.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const base = { ...queueParams(queue, appFilter), limit: 400 };
      const active = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v != null));

      // Counted, not listed: the badges used to be the length of a 400-row
      // page, so a queue of 1,900 said 400.
      const [rows, facetData, matching, ...others] = await Promise.all([
        api.listLeads({ ...base, ...active }),
        api.leadFacets(base),
        api.leadCount({ ...base, ...active }),
        ...Object.keys(QUEUES).map((k) => api.leadCount(queueParams(k, 'no_app'))),
      ]);
      if (queue === 'apps') api.appSummary().then(setAppSummary).catch(() => {});

      setLeads(rows);
      setFacets(facetData);
      setMatchCount(matching.count);
      setTotalInQueue(facetData?.completeness?.total ?? null);
      setSelected(new Set());
      const c = {};
      Object.keys(QUEUES).forEach((k, idx) => { c[k] = others[idx].count; });
      setCounts(c);
    } catch (e) { toast.error(e); }
    finally { setLoading(false); }
  }, [queue, filters, appFilter]);

  useEffect(() => { load(); }, [load]);

  // Switching queue resets filters - a locality that made sense in one queue
  // usually returns nothing in another.
  useEffect(() => { setFilters({}); }, [queue]);

  const visible = leads;

  const toggle = (id) => setSelected((s) => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  const allSelected = visible.length > 0 && visible.every((l) => selected.has(l.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(visible.map((l) => l.id)));

  const act = async (decision) => {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      const r = await api.reviewLeads({ ids, decision, assignTo: assignTo || undefined });
      toast.success(r.updated + ' lead(s) ' + decision + '.');
      await load();
    } catch (e) { toast.error(e); }
  };

  /**
   * Approve, then spread across the team. Two steps on purpose: assignment no
   * longer approves anything, so the approval decision stays explicit even when
   * a team lead does both in one click.
   */
  const approveAndAutoAssign = async () => {
    const ids = [...selected];
    if (!ids.length) return;
    try {
      await api.reviewLeads({ ids, decision: 'approved' });
      const r = await api.assignLeads({ ids, auto: true });
      toast.success('Approved ' + ids.length + ', assigned ' + r.assigned.length + ' round-robin.');
      if (r.skipped.length) toast.info(r.skipped.length + ' unassigned: ' + r.skipped[0].reason);
      await load();
    } catch (e) { toast.error(e); }
  };

  /**
   * Exports exactly what the filters currently select, not the page you can
   * see - the server shares one filter implementation across list, count and
   * export, so the file matches the header count.
   */
  const exportCsv = () => {
    const params = new URLSearchParams({
      ...queueParams(queue, appFilter),
      ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v != null)),
      limit: '50000',
    });
    window.open('/api/leads/export.csv?' + params.toString(), '_blank');
    toast.info('Exporting ' + (matchCount ?? '') + ' leads.');
  };

  /**
   * Check recalled leads against live web search, one at a time so progress is
   * visible. Confirms existence and pulls in websites and follower counts the
   * search turns up.
   */
  const [researching, setResearching] = useState(null);
  const researchVerify = async () => {
    const list = (selected.size ? visible.filter((l) => selected.has(l.id)) : visible).slice(0, 40);
    if (!list.length) return;
    let confirmed = 0;
    for (let i = 0; i < list.length; i++) {
      setResearching({ i: i + 1, total: list.length, name: list[i].name });
      try {
        const r = await api.verifyByResearch(list[i].id);
        if (r.confirmed) confirmed++;
      } catch { /* keep going - one bad lead should not stop the batch */ }
    }
    setResearching(null);
    toast.success(confirmed + ' of ' + list.length + ' confirmed against live search.');
    await load();
  };

  const startFastVerify = (subset) => {
    const list = subset && subset.length ? subset : visible;
    if (!list.length) return toast.info('Nothing to verify here.');
    setFastQueue(list);
  };

  /**
   * Google reviews, rating, phone and trading status for directory leads, from
   * a Maps lookup each. Runs in the background; the selection, or the most
   * valuable leads still missing a review count.
   */
  const [lookingUp, setLookingUp] = useState(false);
  const lookUpOnMaps = async () => {
    setLookingUp(true);
    try {
      const ids = selected.size ? [...selected] : undefined;
      const r = await api.enrichMapsBulk({ ids, limit: ids ? ids.length : 150 });
      toast.success(r.queued ? r.queued + ' Maps lookups queued. Refresh in a few minutes.' : r.note);
    } catch (e) { toast.error(e); } finally { setLookingUp(false); }
  };

  const [enrichingSocial, setEnrichingSocial] = useState(false);
  const enrichSocial = async () => {
    setEnrichingSocial(true);
    try {
      const ids = selected.size ? [...selected] : undefined;
      const r = await api.enrichSocialBulk({ ids, limit: ids ? ids.length : 100 });
      toast.success(r.queued ? r.queued + ' social searches queued. Refresh in a few minutes.' : r.note || 'Nothing to enrich.');
    } catch (e) { toast.error(e); } finally { setEnrichingSocial(false); }
  };

  /**
   * Check schools and coaching classes for an app: the selection, or the best
   * unchecked ones. A free look at their site and the App Store, plus one
   * billed Google Play search each, in the background.
   */
  const [checkingApps, setCheckingApps] = useState(false);
  const checkApps = async () => {
    setCheckingApps(true);
    try {
      const ids = selected.size ? [...selected] : undefined;
      const r = await api.appCheckBulk({ ids, limit: ids ? ids.length : 100 });
      toast.success(r.queued ? r.queued + ' app checks queued - about 15 seconds each. Refresh in a few minutes.' : r.note);
      api.appSummary().then(setAppSummary).catch(() => {});
    } catch (e) { toast.error(e); } finally { setCheckingApps(false); }
  };

  const q = QUEUES[queue];
  const selectedLeads = visible.filter((l) => selected.has(l.id));

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <h1>{q.label}</h1>
          <p>{q.blurb}</p>
        </div>
        <div className="page-head-actions">
          {app.modes.mapsLookup && ['hot', 'enrich', 'review'].includes(queue) && (
            <button className="btn" onClick={lookUpOnMaps} disabled={lookingUp} title="Review count, rating, phone and trading status from Google Maps">
              {lookingUp ? 'Queuing...' : 'Look up Google reviews' + (selected.size ? ' (' + selected.size + ')' : '')}
            </button>
          )}
          {app.modes.socialLookup && ['hot', 'enrich', 'review'].includes(queue) && (
            <button
              className="btn"
              onClick={enrichSocial}
              disabled={enrichingSocial}
              title={app.modes.socialMethod === 'meta_graph_api'
                ? "Followers, posts and last post from Instagram's own API"
                : 'Instagram handle and Facebook/LinkedIn pages via Google search - follower counts are rarely in search results'}
            >
              {enrichingSocial ? 'Queuing...' : 'Find social presence' + (selected.size ? ' (' + selected.size + ')' : '')}
            </button>
          )}
          {queue === 'apps' && app.modes.appCheck && (
            <button className="btn" onClick={checkApps} disabled={checkingApps} title="Their site, the App Store, and a cited Google Play search">
              {checkingApps ? 'Queuing...' : selected.size ? 'Check ' + selected.size + ' for an app'
                : 'Check for apps' + (appSummary?.counts?.unchecked ? ' (' + appSummary.counts.unchecked + ' unchecked)' : '')}
            </button>
          )}
          {queue === 'confirm' && visible.length > 0 && (
            <button className="btn" onClick={researchVerify} disabled={!!researching}>
              {researching
                ? 'Researching ' + researching.i + '/' + researching.total + '...'
                : 'Research and verify' + (selected.size ? ' ' + selected.size : '')}
            </button>
          )}
          {q.verifiable && visible.length > 0 && (
            <button className="btn primary" onClick={() => startFastVerify(selectedLeads)}>
              Verify {selected.size > 0 ? selected.size + ' selected' : 'these'} fast
            </button>
          )}
          <button className="btn sm" onClick={exportCsv} disabled={!matchCount}>
            Export CSV{matchCount ? ' (' + matchCount.toLocaleString() + ')' : ''}
          </button>
          <button className="btn sm ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      <div className="row wrap" style={{ marginBottom: 14, gap: 6 }}>
        {Object.entries(QUEUES).map(([k, v]) => (
          <span key={k} className={'chip' + (queue === k ? ' on' : '')} onClick={() => setQueue(k)}>
            {v.label}
            {counts[k] != null && <span className="badge" style={{ padding: '0 6px' }}>{counts[k]}</span>}
          </span>
        ))}
      </div>

      {queue === 'apps' && (
        <div className="row wrap" style={{ marginBottom: 14, gap: 6 }}>
          {APP_FILTERS.map(([value, label]) => {
            const n = appSummary?.counts
              ? value.split(',').reduce((sum, s) => sum + (appSummary.counts[s] || 0), 0)
              : null;
            return (
              <span key={value} className={'chip' + (appFilter === value ? ' on' : '')} onClick={() => setAppFilter(value)}>
                {label}
                {n != null && <span className="badge" style={{ padding: '0 6px' }}>{n}</span>}
              </span>
            );
          })}
          {appSummary?.queued > 0 && <span className="small muted" style={{ alignSelf: 'center' }}>{appSummary.queued} checks running</span>}
          {app.modes.appCheck === false && (
            <span className="small" style={{ alignSelf: 'center', color: 'var(--red)' }}>
              The Google Play search needs OPENAI_API_KEY (or a working GEMINI_API_KEY) - app checks are off.
            </span>
          )}
        </div>
      )}

      <FilterBar
        facets={facets}
        value={filters}
        onChange={setFilters}
        resultCount={matchCount}
        totalCount={totalInQueue}
        shownCount={leads.length}
      />

      {q.verifiable && visible.length > 30 && (
        <div className="callout info" style={{ marginBottom: 14 }}>
          <strong>{visible.length} leads here.</strong> Do not open them one at a time - use
          <strong> Verify fast</strong> above. One lead on screen, Maps one click away, three fields,
          Enter for the next. Roughly fifteen seconds each. They are ordered by what the category is
          worth and whether a phone number is already known, so the valuable ones come first and you
          can stop whenever you have enough.
        </div>
      )}

      {selected.size > 0 && (
        <div className="card" style={{ marginBottom: 14, padding: 12 }}>
          <div className="row wrap">
            <strong>{selected.size} selected</strong>
            <div className="spacer" />
            {q.approvable && (
              <>
                <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} style={{ maxWidth: 180 }}>
                  <option value="">Approve without assigning</option>
                  {app.users.filter((u) => u.role === 'rep').map((u) => (
                    <option key={u.id} value={u.id}>Assign to {u.name}</option>
                  ))}
                </select>
                <button className="btn primary sm" onClick={() => act('approved')}>
                  {assignTo ? 'Approve and assign' : 'Approve'}
                </button>
                <button className="btn sm" onClick={approveAndAutoAssign}>Approve and spread</button>
              </>
            )}
            {q.verifiable && (
              <button className="btn sm" onClick={() => startFastVerify(selectedLeads)}>Verify these</button>
            )}
            <button className="btn sm" onClick={() => act('hold')}>Hold</button>
            <button
              className="btn sm"
              onClick={() => {
                const ids = [...selected].join(',');
                window.open('/api/leads/export.csv?ids=' + ids + '&includeDisqualified=true&limit=50000', '_blank');
              }}
            >
              Export {selected.size}
            </button>
            <button className="btn sm danger" onClick={() => act('rejected')}>
              Reject {selected.size}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty"><span className="spinner" /></div>
      ) : visible.length === 0 ? (
        <div className="empty">
          <h3>Nothing here</h3>
          <p>
            {queue === 'apps'
              ? (appFilter === 'no_app'
                ? 'No school or coaching class has been confirmed app-less yet. Sweep "Schools and coaching (app pitch)" in Discovery, or press Check for apps - each lead is checked on its site, Google Play and the App Store.'
                : 'Nothing in this group.')
              : queue === 'hot'
              ? 'Nothing ready to close yet. Look up Google reviews for the "Needs data" queue, or sweep a high-value category - leads land here once they have a phone, real demand and a visible gap.'
              : queue === 'enrich'
              ? 'No leads waiting on data. Run a sweep in Discovery.'
              : queue === 'confirm'
                ? 'Nothing unconfirmed. This only fills up if you run AI discovery.'
                : queue === 'review'
                  ? 'Nothing qualified is waiting. Work the "Needs data" queue to push leads through.'
                  : 'Nothing rejected yet.'}
          </p>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} style={{ width: 'auto' }} />
                </th>
                <th style={{ width: 50 }} title="What this category is worth to an agency">Value</th>
                <th style={{ width: 55 }} title="Is this worth selling to">Opp</th>
                <th style={{ width: 60 }} title="How much of this record is evidenced">Conf</th>
                <th style={{ width: 60 }} title="Can a big deal close this week: size, visible pain, and a reachable owner">Deal</th>
                <th>Business</th>
                <th>Category</th>
                <th>Known</th>
                <th>{q.approvable ? 'Pitch' : 'Missing'}</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((l) => (
                <tr key={l.id} className={selected.has(l.id) ? 'selected' : ''}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(l.id)}
                      onChange={() => toggle(l.id)}
                      style={{ width: 'auto' }}
                    />
                  </td>
                  <td>
                    {l.valueTier && (
                      <span className={'badge ' + (l.valueTier === 'T1' ? 'a' : l.valueTier === 'T2' ? 'b' : 'c')}>
                        {l.valueTier}
                      </span>
                    )}
                  </td>
                  <td><span className={'score ' + (l.tier || 'c').toLowerCase()}>{l.score}</span></td>
                  <td><ConfidencePip value={l.confidence} level={l.confidenceLevel} /></td>
                  <td><DealPip deal={l.deal} score={l.deal_score} /></td>
                  <td>
                    <div style={{ fontWeight: 540 }}>{l.name}</div>
                    <div className="small faint">{l.locality || l.address}</div>
                    {l.exclusionLabel && <div className="small" style={{ color: 'var(--red)' }}>{l.exclusionLabel}</div>}
                  </td>
                  <td className="small">{l.category}</td>
                  <td className="small">
                    <div className="row wrap" style={{ gap: 4 }}>
                      {l.phone_type === 'mobile' && <span className="badge a" title="Takes WhatsApp">mobile</span>}
                      {l.phone_normalized && l.phone_type !== 'mobile' && <span className="badge a">phone</span>}
                      {l.phone && !l.phone_normalized && <span className="badge red" title="Cannot be dialled as stored">bad phone</span>}
                      {l.website && <span className="badge blue">site</span>}
                      {l.review_count != null && <span className="badge a">{l.review_count} rev</span>}
                      {!l.phone && !l.website && l.review_count == null && <span className="faint">-</span>}
                    </div>
                  </td>
                  <td className="small" style={{ maxWidth: 240 }}>
                    {queue === 'apps' ? (
                      <AppPitchCell app={l.app} />
                    ) : q.approvable ? (
                      <>
                        {l.pitch ? <div>{l.pitch}</div> : <div className="faint">{(l.deal?.reasons || [])[0] || '-'}</div>}
                        {l.package && (
                          <div className="faint">
                            {l.package.name} · {money(l.package.priceMin, l.package.currency)}
                            {l.package.priceMax ? '–' + money(l.package.priceMax) : '+'}
                            {l.package.billing === 'monthly' ? '/mo' : ''}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="faint">{(l.missingData || []).slice(0, 2).join(', ') || '-'}</span>
                    )}
                  </td>
                  <td className="right">
                    <button className="btn sm" onClick={() => setOpenId(l.id)}>Open</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openId && <LeadDrawer leadId={openId} onClose={() => setOpenId(null)} onChanged={load} />}

      {fastQueue && (
        <FastVerify
          queue={fastQueue}
          onClose={() => { setFastQueue(null); load(); }}
          onProgress={() => {}}
        />
      )}
    </div>
  );
}

/** The App pitch queue's pitch column: the line to open with, or what still needs a look. */
function AppPitchCell({ app }) {
  if (!app) return <span className="faint">Not checked yet</span>;
  const link = (app.possible || [])[0] || (app.apps || [])[0];
  return (
    <>
      <div>{app.line || app.summary || app.label}</div>
      {app.line && app.summary && <div className="faint">{app.summary}</div>}
      {!app.line && link?.url && (
        <a className="small" href={link.url} target="_blank" rel="noreferrer">{(link.title || link.id) + ' - open it'}</a>
      )}
      {app.package && (
        <div className="faint">
          {app.package.name} · {money(app.package.priceMin, app.package.currency)}
          {app.package.priceMax ? '–' + money(app.package.priceMax) : '+'}
        </div>
      )}
    </>
  );
}
