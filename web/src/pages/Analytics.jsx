import React, { useEffect, useState } from 'react';
import api from '../api.js';
import { useApp, useToast } from '../App.jsx';

export default function Analytics() {
  const app = useApp();
  const toast = useToast();
  const [data, setData] = useState(null);

  useEffect(() => {
    Promise.all([
      api.funnel(), api.scoreBands(), api.weightSignal(), api.lossReasons(),
      api.repStats(), api.categoryStats(), api.aiQuality(), api.usage(), api.due(),
    ])
      .then(([funnel, bands, weights, losses, reps, cats, quality, usage, due]) =>
        setData({ funnel, bands, weights, losses, reps, cats, quality, usage, due }))
      .catch((e) => toast.error(e));
  }, []);

  if (!data) return <div className="main"><div className="empty"><span className="spinner" /></div></div>;

  const { funnel, bands, weights, losses, reps, cats, quality, usage, due } = data;
  const money = (n) => app.tenant.currency + ' ' + Number(n || 0).toLocaleString('en-IN');
  const totalRevenue = bands.bands.reduce((a, b) => a + b.revenue, 0);
  const totalWon = bands.bands.reduce((a, b) => a + b.won, 0);

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p>
            The only question that matters here is whether the score predicts a close.
            If it does not, the weights are decoration and need retuning.
          </p>
        </div>
      </div>

      <div className="grid cols-4" style={{ marginBottom: 16 }}>
        <div className="stat">
          <div className="stat-label">In the pipeline</div>
          <div className="stat-value">{funnel.total}</div>
          <div className="stat-note">{funnel.byStatus.pending_review || 0} awaiting review</div>
        </div>
        <div className="stat">
          <div className="stat-label">Won</div>
          <div className="stat-value">{totalWon}</div>
          <div className="stat-note">{money(totalRevenue)} booked</div>
        </div>
        <div className="stat">
          <div className="stat-label">Overdue</div>
          <div className="stat-value" style={{ color: due.length ? 'var(--red)' : undefined }}>{due.length}</div>
          <div className="stat-note">past their next action date</div>
        </div>
        <div className="stat">
          <div className="stat-label">API spend, 30 days</div>
          <div className="stat-value">
            ${usage.last30Days.reduce((a, b) => a + b.costUsd, 0).toFixed(2)}
          </div>
          <div className="stat-note">
            {usage.last30Days.map((u) => u.provider + ' ' + u.units).join(' · ') || 'nothing yet'}
          </div>
        </div>
      </div>

      {/* ---------------- the whole point ---------------- */}
      <div className="card">
        <h2>Conversion by score band</h2>
        <div className={'callout ' + (/NOT/.test(bands.verdict) ? 'bad' : /predictive/.test(bands.verdict) ? 'good' : '')} style={{ marginBottom: 12 }}>
          {bands.verdict}
        </div>
        <div className="table-wrap" style={{ maxHeight: 'none' }}>
          <table>
            <thead>
              <tr>
                <th>Band</th><th className="right">Leads</th><th className="right">Closed</th>
                <th className="right">Won</th><th className="right">Win rate</th>
                <th className="right">Avg deal</th><th className="right">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {bands.bands.map((b) => (
                <tr key={b.band}>
                  <td><strong>{b.band}</strong></td>
                  <td className="right">{b.leads}</td>
                  <td className="right">{b.closed}</td>
                  <td className="right">{b.won}</td>
                  <td className="right">
                    {b.winRate == null ? <span className="faint">-</span> : (
                      <div className="row" style={{ justifyContent: 'flex-end' }}>
                        <div className="bar-track" style={{ width: 60 }}>
                          <div className="bar-fill" style={{ width: b.winRate + '%' }} />
                        </div>
                        <span>{b.winRate}%</span>
                      </div>
                    )}
                  </td>
                  <td className="right">{b.avgDealSize ? money(b.avgDealSize) : <span className="faint">-</span>}</td>
                  <td className="right">{b.revenue ? money(b.revenue) : <span className="faint">-</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Which score component predicts a close</h2>
          <div className="small muted" style={{ marginBottom: 10 }}>{weights.note}</div>
          {weights.totalClosed < 10 ? (
            <div className="callout">
              Only {weights.totalClosed} closed deals so far. This needs roughly 30 before it says anything.
            </div>
          ) : (
            weights.components.map((c) => (
              <div key={c.component} style={{ marginBottom: 10 }}>
                <div className="row">
                  <strong style={{ textTransform: 'capitalize' }}>{c.component}</strong>
                  <div className="spacer" />
                  <span className="small">won {c.avgWon} vs lost {c.avgLost}</span>
                  <span className={'badge ' + (c.lift > 2 ? 'a' : c.lift < -2 ? 'red' : 'c')}>
                    {c.lift > 0 ? '+' : ''}{c.lift}
                  </span>
                </div>
                <div className="small faint">{c.recommendation}</div>
              </div>
            ))
          )}
        </div>

        <div className="card">
          <h2>Funnel</h2>
          {funnel.stages.map((s) => (
            <div className="bar-row" key={s.stage}>
              <span className="bar-label">{s.label}</span>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{
                    width: s.pct + '%',
                    background: s.stage === 'success' ? 'var(--green)' : s.stage === 'failed' ? 'var(--red)' : 'var(--accent)',
                  }}
                />
              </div>
              <span className="bar-val">{s.count} ({s.pct}%)</span>
            </div>
          ))}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Why deals are lost</h2>
          {losses.total === 0 ? (
            <div className="small faint">Nothing lost yet.</div>
          ) : (
            losses.reasons.map((r) => (
              <div className="bar-row" key={r.id}>
                <span className="bar-label">{r.label}</span>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: r.pct + '%', background: r.recyclable ? 'var(--amber)' : 'var(--red)' }} />
                </div>
                <span className="bar-val">{r.count}</span>
              </div>
            ))
          )}
          {losses.reasons.some((r) => r.recyclable) && (
            <div className="callout good" style={{ marginTop: 10 }}>
              Amber reasons are timing, not rejection. Those leads come back automatically on a date.
            </div>
          )}
        </div>

        <div className="card">
          <h2>Is the AI actually useful</h2>
          <div className="small muted" style={{ marginBottom: 10 }}>
            Accept rate per prompt. Under 40% means that prompt is broken, not that the reps are lazy.
          </div>
          {quality.length === 0 ? (
            <div className="small faint">
              No feedback logged yet. The accept / edit / reject buttons in the lead drawer feed this.
            </div>
          ) : (
            quality.map((q) => (
              <div className="row" key={q.kind + q.stage} style={{ padding: '5px 0', borderBottom: '1px solid var(--line-soft)' }}>
                <span style={{ flex: 1 }}>{q.kind}{q.stage ? ' @ ' + q.stage : ''}</span>
                <span className="small faint">{q.total} rated</span>
                <span className={'badge ' + (q.verdict === 'ok' ? 'a' : q.verdict.startsWith('BROKEN') ? 'red' : 'c')}>
                  {q.acceptRate == null ? '-' : q.acceptRate + '%'}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Reps</h2>
          <table>
            <thead>
              <tr><th>Name</th><th className="right">Open</th><th className="right">Won</th><th className="right">Win rate</th><th className="right">Revenue</th></tr>
            </thead>
            <tbody>
              {reps.length === 0 && <tr><td colSpan={5} className="faint small">Nothing assigned yet.</td></tr>}
              {reps.map((r) => (
                <tr key={r.id}>
                  <td>{r.name} {r.atCapacity && <span className="badge red">at cap</span>}</td>
                  <td className="right">{r.open}/{r.cap}</td>
                  <td className="right">{r.won}</td>
                  <td className="right">{r.winRate == null ? '-' : r.winRate + '%'}</td>
                  <td className="right">{money(r.revenue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <h2>Categories</h2>
          <div className="table-wrap" style={{ maxHeight: 300 }}>
            <table>
              <thead>
                <tr><th>Category</th><th className="right">Leads</th><th className="right">Avg score</th><th className="right">Win rate</th><th className="right">Revenue</th></tr>
              </thead>
              <tbody>
                {cats.length === 0 && <tr><td colSpan={5} className="faint small">No approved leads yet.</td></tr>}
                {cats.slice(0, 15).map((c) => (
                  <tr key={c.category}>
                    <td className="small">{c.category.replace(/_/g, ' ')}</td>
                    <td className="right">{c.leads}</td>
                    <td className="right">{c.avgScore}</td>
                    <td className="right">{c.winRate == null ? '-' : c.winRate + '%'}</td>
                    <td className="right">{money(c.revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {due.length > 0 && (
        <div className="card">
          <h2>Overdue right now</h2>
          <table>
            <thead><tr><th>Business</th><th>Stage</th><th>Owner</th><th className="right">Due</th></tr></thead>
            <tbody>
              {due.slice(0, 20).map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td className="small">{d.stage}</td>
                  <td className="small">{d.assignee || <span className="faint">unassigned</span>}</td>
                  <td className="right small overdue">{new Date(d.next_due_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
