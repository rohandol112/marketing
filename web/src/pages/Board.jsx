import React, { useCallback, useEffect, useState } from 'react';
import api from '../api.js';
import { useApp, useToast } from '../App.jsx';
import LeadDrawer from '../components/LeadDrawer.jsx';

/**
 * The sales board. Only leads that made it all the way through the discovery
 * pipeline appear here - the server will not return anything else, and the
 * database will not even store a stage on an unqualified lead.
 */
export default function Board() {
  const app = useApp();
  const toast = useToast();

  const [board, setBoard] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [hover, setHover] = useState(null);
  const [filters, setFilters] = useState({ assignedTo: '', tier: '', search: '' });
  const [closing, setClosing] = useState(null);

  const load = useCallback(async () => {
    const params = {};
    if (filters.assignedTo) params.assignedTo = filters.assignedTo;
    if (filters.tier) params.tier = filters.tier;
    if (filters.search) params.search = filters.search;
    try {
      setBoard(await api.board(params));
    } catch (e) { toast.error(e); }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const move = async (leadId, toStage, extra = {}) => {
    try {
      await api.moveStage(leadId, { stage: toStage, ...extra });
      await load();
    } catch (e) {
      // The guards are the product working, not an error to bury.
      toast.error(e);
      await load();
    }
  };

  const onDrop = (stage) => (e) => {
    e.preventDefault();
    setHover(null);
    const leadId = e.dataTransfer.getData('text/plain');
    const lead = dragging;
    setDragging(null);
    if (!leadId || !lead || lead.stage === stage) return;

    // These two need information the board cannot guess.
    if (stage === 'failed' || stage === 'success') {
      setClosing({ lead, stage });
      return;
    }
    move(leadId, stage);
  };

  if (!board) return <div className="empty"><span className="spinner" /></div>;

  const empty = board.total === 0;

  return (
    <div className="board-wrap">
      <div className="board-toolbar">
        <input
          type="search"
          placeholder="Search leads"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          style={{ maxWidth: 220 }}
        />
        <select
          value={filters.assignedTo}
          onChange={(e) => setFilters({ ...filters, assignedTo: e.target.value })}
          style={{ maxWidth: 180 }}
        >
          <option value="">Everyone</option>
          <option value="none">Unassigned</option>
          {app.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select
          value={filters.tier}
          onChange={(e) => setFilters({ ...filters, tier: e.target.value })}
          style={{ maxWidth: 130 }}
        >
          <option value="">All tiers</option>
          <option value="A">Tier A</option>
          <option value="B">Tier B</option>
          <option value="C">Tier C</option>
        </select>
        <div className="spacer" />
        <span className="small muted">{board.total} in the pipeline</span>
        <button className="btn sm ghost" onClick={load}>Refresh</button>
      </div>

      {empty ? (
        <div className="empty">
          <h3>Nothing on the board yet</h3>
          <p>
            Leads reach here only after they have been verified, qualified and approved.
            Run a sweep in Discovery, then work the verification and review queues.
          </p>
          <a className="btn primary" href="/discovery">Go to Discovery</a>
        </div>
      ) : (
        <div className="board">
          {app.stages.map((s) => {
            const items = board.columns[s.id] || [];
            return (
              <div
                key={s.id}
                className={'column' + (hover === s.id ? ' drop-target' : '')}
                onDragOver={(e) => { e.preventDefault(); setHover(s.id); }}
                onDragLeave={() => setHover((h) => (h === s.id ? null : h))}
                onDrop={onDrop(s.id)}
              >
                <div className="column-head">
                  <h3>{s.label}</h3>
                  <span className="column-count">{items.length}</span>
                </div>
                <div className="column-body">
                  {items.length === 0 && <div className="column-empty">{s.id === 'todo' ? 'Approve leads to fill this' : 'Nothing here'}</div>}
                  {items.map((lead) => (
                    <LeadCard
                      key={lead.id}
                      lead={lead}
                      onOpen={() => setOpenId(lead.id)}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', lead.id);
                        setDragging(lead);
                      }}
                      onDragEnd={() => { setDragging(null); setHover(null); }}
                      dragging={dragging?.id === lead.id}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {openId && (
        <LeadDrawer leadId={openId} onClose={() => setOpenId(null)} onChanged={load} />
      )}

      {closing && (
        <CloseDialog
          {...closing}
          onCancel={() => setClosing(null)}
          onConfirm={async (extra) => {
            await move(closing.lead.id, closing.stage, extra);
            setClosing(null);
          }}
        />
      )}
    </div>
  );
}

function LeadCard({ lead, onOpen, onDragStart, onDragEnd, dragging }) {
  const overdue = lead.next_due_at && new Date(lead.next_due_at) < new Date();
  return (
    <div
      className={'lead-card' + (dragging ? ' dragging' : '')}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
    >
      <div className="lead-card-top">
        <span className={'score ' + (lead.tier || 'c').toLowerCase()} title="Opportunity score">{lead.score}</span>
        <span className="lead-card-name">{lead.name}</span>
      </div>
      <div className="lead-card-meta">
        <span className="small faint">{lead.category}</span>
        {lead.review_count != null && <span className="small faint">· {lead.review_count} rev</span>}
        <ConfidencePip value={lead.confidence} level={lead.confidenceLevel} />
      </div>
      {lead.gaps?.length > 0 && (
        <div className="lead-card-gaps">
          {lead.gaps.slice(0, 2).map((g, i) => <div className="gap-line" key={i}>{g}</div>)}
        </div>
      )}
      <div className="row small" style={{ marginTop: 7 }}>
        {lead.assignee_name && <span className="faint">{lead.assignee_name}</span>}
        <div className="spacer" />
        {overdue && <span className="overdue">overdue</span>}
        {!overdue && lead.next_due_at && (
          <span className="faint">due {new Date(lead.next_due_at).toLocaleDateString()}</span>
        )}
      </div>
    </div>
  );
}

export function ConfidencePip({ value, level }) {
  if (value == null) return null;
  const cls = level === 'high' ? 'a' : level === 'medium' ? 'b' : 'c';
  return (
    <span className={'badge ' + cls} title={'Data confidence: how much of this record is actually evidenced'}>
      {value}%
    </span>
  );
}

/** Success and failure both demand information the board cannot infer. */
function CloseDialog({ lead, stage, onCancel, onConfirm }) {
  const app = useApp();
  const [lossReason, setLossReason] = useState('');
  const [packageId, setPackageId] = useState(app.packages[0]?.id || '');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);

  const won = stage === 'success';
  const ok = won ? Number(amount) > 0 : Boolean(lossReason);

  const confirm = async () => {
    setBusy(true);
    await onConfirm(
      won
        ? { proposal: { packageId, amount: Number(amount), currency: app.tenant.currency } }
        : { lossReason }
    );
    setBusy(false);
  };

  return (
    <div className="drawer-backdrop" onClick={onCancel} style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div className="card" style={{ width: 440, maxWidth: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <h2>{won ? 'Close ' + lead.name + ' as won' : 'Close ' + lead.name + ' as lost'}</h2>

        {won ? (
          <>
            <div className="field">
              <label>Package sold</label>
              <select value={packageId} onChange={(e) => setPackageId(e.target.value)}>
                {app.packages.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Amount ({app.tenant.currency})</label>
              <input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
            </div>
            <div className="callout info">
              A won deal without an amount makes every revenue number downstream wrong, so it is required.
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label>Why was it lost?</label>
              <select value={lossReason} onChange={(e) => setLossReason(e.target.value)} autoFocus>
                <option value="">Pick a reason</option>
                {app.lossReasons.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
              </select>
            </div>
            {app.lossReasons.find((r) => r.id === lossReason)?.recycle && (
              <div className="callout good">
                This is a timing loss, not a real one. It will come back automatically in{' '}
                {app.lossReasons.find((r) => r.id === lossReason).recycleDays} days.
              </div>
            )}
            {!lossReason && (
              <div className="callout">
                Free text here is how loss analytics dies. Pick the closest reason.
              </div>
            )}
          </>
        )}

        <div className="row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={confirm} disabled={!ok || busy}>
            {busy ? 'Saving...' : won ? 'Mark won' : 'Mark lost'}
          </button>
          <button className="btn ghost" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
