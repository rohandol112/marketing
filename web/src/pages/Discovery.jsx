import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api.js';
import { useApp, useToast } from '../App.jsx';

const TIER_LABEL = { T1: 'High ticket', T2: 'Mid ticket', T3: 'Low ticket' };

export default function Discovery() {
  const app = useApp();
  const toast = useToast();
  const navigate = useNavigate();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searchSource, setSearchSource] = useState(null);
  const [searching, setSearching] = useState(false);
  const [area, setArea] = useState(null);
  const [radiusKm, setRadiusKm] = useState(5);
  const [selected, setSelected] = useState(new Set(app.presets.balanced.ids));
  const [minReviews, setMinReviews] = useState(0);
  const [maxPages, setMaxPages] = useState(app.modes.maxPages || 3);
  const [source, setSource] = useState(app.modes.discoverySource);
  const [estimate, setEstimate] = useState(null);
  const [starting, setStarting] = useState(false);
  const [runs, setRuns] = useState([]);
  const [activeRun, setActiveRun] = useState(null);

  const abortRef = useRef(null);

  /* ------------- area search ------------- */

  useEffect(() => {
    if (query.trim().length < 2) { setResults([]); return; }
    const t = setTimeout(async () => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setSearching(true);
      try {
        const r = await api.searchAreas(query.trim(), ctrl.signal);
        setResults(r.results || []);
        setSearchSource(r.source);
        if (r.warning) toast.info(r.warning);
      } catch (e) {
        if (e.name !== 'AbortError') toast.error(e);
      } finally {
        setSearching(false);
      }
    }, 700);
    return () => clearTimeout(t);
  }, [query]);

  /* ------------- estimate ------------- */

  useEffect(() => {
    const ids = [...selected];
    if (!ids.length) { setEstimate(null); return; }
    api.estimate({ categories: ids, maxPages }).then(setEstimate).catch(() => {});
  }, [selected, maxPages]);

  /* ------------- runs ------------- */

  const loadRuns = () => api.listRuns().then(setRuns).catch(() => {});
  useEffect(() => { loadRuns(); }, []);

  // Poll only while something is actually in flight.
  useEffect(() => {
    if (!activeRun || ['done', 'failed', 'cancelled'].includes(activeRun.status)) return;
    const t = setInterval(async () => {
      try {
        const r = await api.getRun(activeRun.id);
        setActiveRun(r);
        if (['done', 'failed', 'cancelled'].includes(r.status)) {
          loadRuns();
          if (r.status === 'done') {
            toast.success(r.new_count + ' new leads found. ' + r.dupe_count + ' were already in the system.');
          } else if (r.status === 'failed') {
            toast.error('Sweep failed: ' + r.error);
          }
        }
      } catch { /* keep polling */ }
    }, 1500);
    return () => clearInterval(t);
  }, [activeRun]);

  /* ------------- categories ------------- */

  const byGroup = useMemo(() => {
    const g = {};
    for (const c of app.categories) (g[c.group] ||= []).push(c);
    return g;
  }, [app.categories]);

  const toggle = (id) => {
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const toggleGroup = (group) => {
    const ids = byGroup[group].map((c) => c.id);
    const allOn = ids.every((id) => selected.has(id));
    setSelected((s) => {
      const n = new Set(s);
      ids.forEach((id) => (allOn ? n.delete(id) : n.add(id)));
      return n;
    });
  };

  const applyPreset = (key) => setSelected(new Set(app.presets[key].ids));

  /* ------------- start ------------- */

  const start = async () => {
    if (!area) return toast.error('Pick an area first.');
    if (!selected.size) return toast.error('Pick at least one category.');
    setStarting(true);
    try {
      const { run } = await api.startRun({
        areaLabel: area.label,
        lat: area.lat,
        lng: area.lng,
        radiusM: Math.round(radiusKm * 1000),
        regionCode: area.countryCode || undefined,
        categories: [...selected],
        minReviews: Number(minReviews) || 0,
        maxPages,
        source,
      });
      setActiveRun(run);
      loadRuns();
      toast.success('Sweep started across ' + selected.size + ' categories.');
    } catch (e) {
      toast.error(e);
    } finally {
      setStarting(false);
    }
  };

  const saveArea = async () => {
    if (!area) return;
    try {
      await api.saveArea({
        label: area.label,
        lat: area.lat,
        lng: area.lng,
        radiusM: Math.round(radiusKm * 1000),
        countryCode: area.countryCode,
        regionCode: area.countryCode,
      });
      await app.reload();
      toast.success('Area saved.');
    } catch (e) { toast.error(e); }
  };

  const progressPct = activeRun?.progress
    ? Math.round(((activeRun.progress.done || 0) / (activeRun.progress.total || 1)) * 100)
    : 0;

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <h1>Discovery</h1>
          <p>
            Pick anywhere on earth, pick what you sell into, and sweep it. Businesses come back scored
            and sitting in the review queue - nothing reaches a rep until a human approves it.
          </p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h2>Where should the businesses come from?</h2>
        <div className="grid cols-3" style={{ marginTop: 4 }}>
          {(app.discoverySources || []).map((src) => (
            <div
              key={src.id}
              className="lead-card"
              onClick={() => src.available && setSource(src.id)}
              style={{
                cursor: src.available ? 'pointer' : 'not-allowed',
                opacity: src.available ? 1 : 0.45,
                borderColor: source === src.id ? 'var(--accent)' : undefined,
                background: source === src.id ? 'rgba(76,141,255,0.07)' : undefined,
              }}
            >
              <div className="row" style={{ marginBottom: 4 }}>
                <input
                  type="radio"
                  checked={source === src.id}
                  onChange={() => src.available && setSource(src.id)}
                  disabled={!src.available}
                  style={{ width: 'auto' }}
                />
                <strong style={{ fontSize: 13 }}>{src.label}</strong>
                {src.recommended && src.available && <span className="badge a">recommended</span>}
                {!src.available && <span className="badge">no key</span>}
              </div>
              <div className="small muted">{src.note}</div>
              <div className="small faint" style={{ marginTop: 6 }}>{src.caveat}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid cols-2">
        {/* ---------------- area ---------------- */}
        <div className="card">
          <h2>1. Area</h2>

          <div className="field">
            <label>Search any neighbourhood, suburb or city on earth</label>
            <input
              type="search"
              placeholder="Kothrud, Bandra West, Viman Nagar, Powai, Koregaon Park..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <div className="small faint" style={{ marginTop: 4 }}>
              Type any locality name, or paste coordinates like{' '}
              <code className="mono">18.5590, 73.8077</code>.
            </div>
          </div>

          {searching && <div className="small muted"><span className="spinner" /> searching</div>}
          {!searching && query.trim().length >= 2 && results.length === 0 && (
            <div className="small faint">
              Nothing found. Try adding the city, e.g. "Kothrud Pune".
            </div>
          )}

          {results.length > 0 && (
            <div style={{ maxHeight: 190, overflowY: 'auto', marginBottom: 12 }}>
              {results.map((r, i) => (
                <div
                  key={i}
                  className="lead-card"
                  style={{ marginBottom: 5 }}
                  onClick={() => { setArea(r); setResults([]); setQuery(r.label); }}
                >
                  <div className="row">
                    <span className="lead-card-name">{r.label}</span>
                    {r.kind && <span className="badge">{String(r.kind).replace(/_/g, ' ')}</span>}
                  </div>
                  <div className="small faint">
                    {r.address || [r.locality, r.region, r.countryCode].filter(Boolean).join(', ')}
                  </div>
                  <div className="small faint mono">{r.lat.toFixed(4)}, {r.lng.toFixed(4)}</div>
                </div>
              ))}
            </div>
          )}

          {app.areas.length > 0 && (
            <div className="field">
              <label>Or jump to a saved area</label>
              <div className="chip-grid">
                {app.areas.map((a) => (
                  <span
                    key={a.id}
                    className={'chip' + (area?.label === a.label ? ' on' : '')}
                    onClick={() => {
                      setArea({ label: a.label, lat: Number(a.lat), lng: Number(a.lng), countryCode: a.country_code });
                      setRadiusKm(a.radius_m / 1000);
                      setQuery(a.label);
                    }}
                  >
                    {a.label}
                  </span>
                ))}
              </div>
              <div className="small faint" style={{ marginTop: 6 }}>
                Shortcuts only. Search above for anywhere else, then "Save area" to add it here.
              </div>
            </div>
          )}

          {area && (
            <>
              <div className="divider" />
              <div className="row" style={{ marginBottom: 10 }}>
                <div>
                  <div style={{ fontWeight: 570 }}>{area.label}</div>
                  <div className="small faint mono">{area.lat.toFixed(5)}, {area.lng.toFixed(5)}</div>
                </div>
                <div className="spacer" />
                <button className="btn sm ghost" onClick={saveArea}>Save area</button>
              </div>

              <div className="field">
                <label>Radius: {radiusKm} km {radiusKm >= 25 && <span className="faint">(wide - expect noise)</span>}</label>
                <input
                  type="range" min="0.5" max="50" step="0.5"
                  value={radiusKm}
                  onChange={(e) => setRadiusKm(Number(e.target.value))}
                  style={{ padding: 0 }}
                />
              </div>

              <div className="field-row">
                <div className="field">
                  <label title="Businesses below this never enter the queue">Minimum reviews</label>
                  <input type="number" min="0" value={minReviews} onChange={(e) => setMinReviews(e.target.value)} />
                </div>
                <div className="field">
                  <label title="20 results per page, 3 is the API ceiling">Pages per category</label>
                  <select value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value))}>
                    <option value={1}>1 (20 results)</option>
                    <option value={2}>2 (40 results)</option>
                    <option value={3}>3 (60 results, the API max)</option>
                  </select>
                </div>
              </div>
            </>
          )}
        </div>

        {/* ---------------- categories ---------------- */}
        <div className="card">
          <h2>2. What do you sell into?</h2>

          <div className="chip-grid" style={{ marginBottom: 12 }}>
            {Object.entries(app.presets).map(([key, p]) => (
              <span key={key} className="chip" onClick={() => applyPreset(key)} title={p.note || ''}>
                {p.label}
              </span>
            ))}
            <span className="chip" onClick={() => setSelected(new Set())}>Clear</span>
          </div>

          <div style={{ maxHeight: 340, overflowY: 'auto', paddingRight: 4 }}>
            {Object.entries(byGroup).map(([group, cats]) => {
              const on = cats.filter((c) => selected.has(c.id)).length;
              return (
                <div key={group} style={{ marginBottom: 12 }}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <strong className="small">{group}</strong>
                    <span className="small faint">{on}/{cats.length}</span>
                    <div className="spacer" />
                    <button className="btn sm ghost" onClick={() => toggleGroup(group)}>
                      {on === cats.length ? 'none' : 'all'}
                    </button>
                  </div>
                  <div className="chip-grid">
                    {cats.map((c) => (
                      <span
                        key={c.id}
                        className={'chip' + (selected.has(c.id) ? ' on' : '')}
                        onClick={() => toggle(c.id)}
                        title={TIER_LABEL[c.tier] + ' - query: "' + c.q + '"'}
                      >
                        {c.label}
                        <span className={'badge ' + (c.tier === 'T1' ? 'a' : c.tier === 'T2' ? 'b' : 'c')} style={{ padding: '0 5px' }}>
                          {c.tier}
                        </span>
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ---------------- go ---------------- */}
      <div className="card" style={{ marginTop: 14 }}>
        <div className="row wrap" style={{ gap: 20 }}>
          <div>
            <div className="stat-label">Categories</div>
            <div className="stat-value">{selected.size}</div>
          </div>
          <div>
            <div className="stat-label">API calls</div>
            <div className="stat-value">{estimate?.calls ?? 0}</div>
          </div>
          <div>
            <div className="stat-label">Up to</div>
            <div className="stat-value">{estimate?.maxResults ?? 0}</div>
            <div className="stat-note">businesses before dedupe</div>
          </div>
          <div>
            <div className="stat-label">Estimated cost</div>
            <div className="stat-value">
              {source === 'places' ? '$' + (estimate?.costUsd ?? 0).toFixed(2) : source === 'gemini' ? 'Tokens' : 'Free'}
            </div>
            <div className="stat-note">
              {source === 'places' ? estimate?.tier + ' tier'
                : source === 'gemini' ? 'about 650 tokens per category'
                : 'no key, no quota'}
            </div>
          </div>
          <div className="spacer" />
          <button className="btn primary" disabled={!area || !selected.size || starting} onClick={start}>
            {starting ? 'Starting...' : 'Start sweep'}
          </button>
        </div>

        {activeRun && !['done', 'failed', 'cancelled'].includes(activeRun.status) && (
          <>
            <div className="divider" />
            <div className="row" style={{ marginBottom: 6 }}>
              <span className="spinner" />
              <span className="small">
                {activeRun.progress?.currentCategory
                  ? 'Sweeping ' + activeRun.progress.currentCategory.replace(/_/g, ' ')
                  : 'Queued'}
              </span>
              <div className="spacer" />
              <span className="small muted">{activeRun.progress?.done || 0} / {activeRun.progress?.total || 0}</span>
              <button className="btn sm ghost" onClick={() => api.cancelRun(activeRun.id).then(loadRuns)}>Cancel</button>
            </div>
            <div className="progress"><span style={{ width: progressPct + '%' }} /></div>
          </>
        )}

        {activeRun?.status === 'done' && (
          <>
            <div className="divider" />
            <div className="row wrap">
              <span className="badge a">{activeRun.new_count} new</span>
              <span className="badge">{activeRun.dupe_count} duplicates skipped</span>
              <span className="badge">{activeRun.found_count} seen</span>
              {Number(activeRun.cost_usd) > 0 && (
                <span className="badge">${Number(activeRun.cost_usd).toFixed(2)} spent</span>
              )}
              {(activeRun.tokens_in || activeRun.tokens_out) && (
                <span className="badge">
                  {(((activeRun.tokens_in || 0) + (activeRun.tokens_out || 0)) / 1000).toFixed(1)}k tokens
                </span>
              )}
              <div className="spacer" />
              <button className="btn primary sm" onClick={() => navigate('/review')}>Open review queue</button>
            </div>
            {activeRun.error && <div className="callout bad" style={{ marginTop: 10 }}>{activeRun.error}</div>}
          </>
        )}
      </div>

      {/* ---------------- history ---------------- */}
      {runs.length > 0 && (
        <div className="card" style={{ marginTop: 14 }}>
          <h2>Recent sweeps</h2>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table>
              <thead>
                <tr>
                  <th>Area</th><th>Source</th><th className="right">Cats</th><th>Status</th>
                  <th className="right">Found</th><th className="right">New</th><th className="right">Dupes</th>
                  <th className="right">Calls</th>
                  <th className="right" title="Prompt and completion tokens. Only a model-backed sweep spends any.">Tokens</th>
                  <th className="right">Cost</th><th>When</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} style={{ cursor: 'pointer' }} onClick={() => setActiveRun(r)}>
                    <td>
                      {r.area_label}
                      <div className="small faint">{(r.radius_m / 1000).toFixed(1)} km</div>
                    </td>
                    <td>
                      <span className={'badge ' + (String(r.source).startsWith('gemini') ? 'b' : 'blue')}>
                        {String(r.source).replace('_', ' ')}
                      </span>
                      {r.llm_model && <div className="small faint">{r.llm_model}</div>}
                    </td>
                    <td className="right">{(r.categories || []).length}</td>
                    <td>
                      <span className={'badge ' + (r.status === 'done' ? 'a' : r.status === 'failed' ? 'red' : 'b')}>
                        {r.status}
                      </span>
                    </td>
                    <td className="right faint">{r.found_count}</td>
                    <td className="right">{r.new_count}</td>
                    <td className="right faint">{r.dupe_count}</td>
                    <td className="right">{r.api_calls}</td>
                    <td className="right">
                      {/* Only a model-backed sweep spends tokens; OSM and Places spend none. */}
                      {r.tokens_in || r.tokens_out ? (
                        <span title={'prompt ' + (r.tokens_in || 0) + ' / completion ' + (r.tokens_out || 0)}>
                          {(((r.tokens_in || 0) + (r.tokens_out || 0)) / 1000).toFixed(1)}k
                        </span>
                      ) : (
                        <span className="faint">-</span>
                      )}
                    </td>
                    <td className="right">
                      {Number(r.cost_usd) > 0 ? '$' + Number(r.cost_usd).toFixed(2) : <span className="faint">free</span>}
                    </td>
                    <td className="small faint">{new Date(r.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {(() => {
            const t = runs.reduce(
              (a, r) => ({
                calls: a.calls + (r.api_calls || 0),
                tin: a.tin + (r.tokens_in || 0),
                tout: a.tout + (r.tokens_out || 0),
                usd: a.usd + Number(r.cost_usd || 0),
                found: a.found + (r.found_count || 0),
                nw: a.nw + (r.new_count || 0),
              }),
              { calls: 0, tin: 0, tout: 0, usd: 0, found: 0, nw: 0 }
            );
            return (
              <div className="row wrap small muted" style={{ marginTop: 10, gap: 16 }}>
                <span><strong>{runs.length}</strong> sweeps</span>
                <span><strong>{t.found.toLocaleString()}</strong> found · <strong>{t.nw.toLocaleString()}</strong> new</span>
                <span><strong>{t.calls}</strong> API calls</span>
                <span>
                  tokens <strong>{t.tin.toLocaleString()}</strong> in / <strong>{t.tout.toLocaleString()}</strong> out
                </span>
                <span>spend <strong>{t.usd > 0 ? '$' + t.usd.toFixed(2) : '$0.00'}</strong></span>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
