import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import { useApp, useToast } from '../App.jsx';
import LeadDrawer from '../components/LeadDrawer.jsx';
import FastVerify from '../components/FastVerify.jsx';
import FilterBar from '../components/FilterBar.jsx';
import { ConfidencePip } from './Board.jsx';

/**
 * Four queues, matching the four things that actually have to happen to a lead
 * between a sweep and a phone call. They were one screen once and it was a mess:
 * "confirm this exists" and "is this worth a rep's day" are different jobs done
 * by different people.
 */
const QUEUES = {
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
    params: { discoveryStatus: 'qualified', status: 'pending_review' },
  },
  rejected: {
    label: 'Rejected',
    blurb: 'Disqualified, or confirmed not to exist.',
    params: { discoveryStatus: 'rejected', includeDisqualified: 'true' },
  },
};

export default function Review() {
  const app = useApp();
  const toast = useToast();

  const [queue, setQueue] = useState('enrich');
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

  // Filtering happens in the database, not in the browser. With hundreds of
  // leads a client-side filter would be filtering whatever slice happened to
  // load, which quietly lies about the counts.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const base = { ...QUEUES[queue].params, limit: 400 };
      const active = Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v != null));

      const [rows, facetData, matching, ...others] = await Promise.all([
        api.listLeads({ ...base, ...active }),
        api.leadFacets(base),
        api.leadCount({ ...base, ...active }),
        ...Object.keys(QUEUES).map((k) => api.listLeads({ ...QUEUES[k].params, limit: 400 })),
      ]);

      setLeads(rows);
      setFacets(facetData);
      setMatchCount(matching.count);
      setTotalInQueue(facetData?.completeness?.total ?? null);
      setSelected(new Set());
      const c = {};
      Object.keys(QUEUES).forEach((k, idx) => { c[k] = others[idx].length; });
      setCounts(c);
    } catch (e) { toast.error(e); }
    finally { setLoading(false); }
  }, [queue, filters]);

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
      ...QUEUES[queue].params,
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
            {queue === 'review' && (
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
            {queue === 'enrich'
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
                <th>Business</th>
                <th>Category</th>
                <th>Known</th>
                <th>Missing</th>
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
                  <td>
                    <div style={{ fontWeight: 540 }}>{l.name}</div>
                    <div className="small faint">{l.locality || l.address}</div>
                  </td>
                  <td className="small">{l.category}</td>
                  <td className="small">
                    <div className="row wrap" style={{ gap: 4 }}>
                      {l.phone && <span className="badge a">phone</span>}
                      {l.website && <span className="badge blue">site</span>}
                      {l.review_count != null && <span className="badge a">{l.review_count} rev</span>}
                      {!l.phone && !l.website && l.review_count == null && <span className="faint">-</span>}
                    </div>
                  </td>
                  <td className="small faint" style={{ maxWidth: 200 }}>
                    {(l.missingData || []).slice(0, 2).join(', ') || '-'}
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
