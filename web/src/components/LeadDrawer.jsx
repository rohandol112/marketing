import React, { useEffect, useState } from 'react';
import api from '../api.js';
import { useApp, useToast } from '../App.jsx';
import ScoreBreakdown from './ScoreBreakdown.jsx';

const TABS = ['Brief', 'Research', 'Message', 'Activity', 'Score', 'Details'];

export default function LeadDrawer({ leadId, onClose, onChanged }) {
  const app = useApp();
  const toast = useToast();
  const [lead, setLead] = useState(null);
  const [tab, setTab] = useState('Brief');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      setLead(await api.getLead(leadId));
    } catch (e) {
      toast.error(e);
      onClose();
    }
  };

  useEffect(() => { load(); }, [leadId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!lead) {
    return (
      <div className="drawer-backdrop" onClick={onClose}>
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="empty"><span className="spinner" /></div>
        </div>
      </div>
    );
  }

  // Not "is it flagged" but "where is it in the discovery pipeline". A lead
  // that has not reached 'qualified' cannot be sold to, whatever it scores.
  const needsWork = lead.discovery_status !== 'qualified';

  const refresh = async () => { await load(); onChanged?.(); };

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div className="row" style={{ marginBottom: 8 }}>
            <h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>{lead.name}</h2>
            <button className="btn ghost sm" onClick={onClose}>Close</button>
          </div>

          {/* Two numbers, never averaged. One says "worth selling to", the
              other says "and we actually know that". */}
          <div className="row" style={{ gap: 18, marginBottom: 8 }}>
            <div>
              <div className="stat-label">Opportunity</div>
              <div className="row" style={{ gap: 6 }}>
                <span className={'score ' + (lead.tier || 'c').toLowerCase()} style={{ fontSize: 15, height: 26 }}>
                  {lead.score}
                </span>
                <span className="small muted">tier {lead.tier}</span>
              </div>
            </div>
            <div>
              <div className="stat-label">Data confidence</div>
              <div className="row" style={{ gap: 6 }}>
                <span className={'score ' + (lead.confidenceLevel === 'high' ? 'a' : lead.confidenceLevel === 'medium' ? 'b' : 'c')}
                      style={{ fontSize: 15, height: 26 }}>
                  {lead.confidence}%
                </span>
                <span className="small muted">{lead.confidenceLevel}</span>
              </div>
            </div>
            <div>
              <div className="stat-label">State</div>
              <span className={'badge ' + (lead.discovery_status === 'qualified' ? 'a' : lead.discovery_status === 'rejected' ? 'red' : 'b')}>
                {lead.discoveryMeta?.label || lead.discovery_status}
              </span>
            </div>
          </div>
          <div className="row wrap small muted">
            <span>{lead.category}</span>
            {lead.locality && <><span>·</span><span>{lead.locality}</span></>}
            {lead.review_count != null && <><span>·</span><span>{lead.review_count} reviews</span></>}
            {lead.rating != null && <span>{lead.rating}★</span>}
            {lead.assignee_name && <><span>·</span><span>{lead.assignee_name}</span></>}
          </div>
          {/* Assignment lives here because a lead leaves the review queue the
              moment it is approved. Without this an unassigned lead on the
              board had no way of ever being given to anybody. */}
          {lead.status === 'approved' && (
            <div className="row" style={{ marginTop: 8 }}>
              <label style={{ margin: 0 }}>Owner</label>
              <select
                value={lead.assigned_to || ''}
                onChange={async (e) => {
                  try {
                    if (e.target.value) {
                      await api.assignLeads({ ids: [lead.id], userId: e.target.value });
                      toast.success('Assigned.');
                    } else {
                      await api.patchLead(lead.id, { assigned_to: null });
                      toast.info('Unassigned.');
                    }
                    await refresh();
                  } catch (err) { toast.error(err); }
                }}
                style={{ width: 'auto', minWidth: 170 }}
              >
                <option value="">Unassigned</option>
                {app.users.filter((u) => u.active !== false).map((u) => (
                  <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                ))}
              </select>
            </div>
          )}

          <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
            {lead.links?.tel && <a className="btn sm" href={lead.links.tel}>Call</a>}
            {lead.links?.whatsapp && <a className="btn sm" href={lead.links.whatsapp} target="_blank" rel="noreferrer">WhatsApp</a>}
            {lead.maps_url && <a className="btn sm ghost" href={lead.maps_url} target="_blank" rel="noreferrer">Maps</a>}
            {lead.website && <a className="btn sm ghost" href={lead.website} target="_blank" rel="noreferrer">Site</a>}
          </div>
        </div>

        {needsWork && <VerifyBanner lead={lead} onDone={refresh} />}
        {lead.suppressed && (
          <div style={{ padding: '10px 18px' }}>
            <div className="callout bad">On the do-not-contact list. Do not call or message this business.</div>
          </div>
        )}

        <div className="drawer-tabs">
          {TABS.map((t) => (
            <button key={t} className={'drawer-tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>{t}</button>
          ))}
        </div>

        <div className="drawer-body">
          {tab === 'Brief' && <BriefTab lead={lead} disabled={needsWork} />}
          {tab === 'Research' && <ResearchTab lead={lead} />}
          {tab === 'Message' && <MessageTab lead={lead} disabled={needsWork} />}
          {tab === 'Activity' && <ActivityTab lead={lead} onChanged={refresh} />}
          {tab === 'Score' && <ScoreBreakdown breakdown={lead.score_breakdown} lead={lead} />}
          {tab === 'Details' && <DetailsTab lead={lead} onChanged={refresh} />}
        </div>
      </div>
    </div>
  );
}

/* ---------------- verification gate ---------------- */

function VerifyBanner({ lead, onDone }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ phone: '', review_count: '', rating: '', ig_followers: '', years_in_business: '', website: '' });
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const verify = async () => {
    setBusy(true);
    try {
      const payload = { exists: true };
      for (const [k, v] of Object.entries(form)) if (v !== '') payload[k] = ['phone', 'website'].includes(k) ? v : Number(v);
      const j = await api.verifyLead(lead.id, payload);
      toast.success('Verified. Score is now ' + j.score.score + ' (tier ' + j.score.tier + ').');
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      await api.verifyLead(lead.id, { exists: false });
      toast.info('Marked as not real.');
      onDone();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: '12px 18px', background: 'var(--panel)', borderBottom: '1px solid var(--line)' }}>
      {lead.discovery_status === 'rejected' ? (
        <div className="callout bad">
          <strong>Rejected.</strong> {lead.disqualify_reason}
        </div>
      ) : lead.discovery_status === 'discovered' ? (
        <div className="callout bad">
          <strong>Existence not confirmed.</strong> This business was suggested by the model from memory,
          not read from a directory. It may not exist. Open Maps, confirm it is real, and copy the
          phone number across before anyone calls it.
        </div>
      ) : (
        <div className="callout">
          <strong>Real, but not ready.</strong> {lead.disqualify_reason || 'Needs more evidence before a rep can work it.'}
        </div>
      )}

      {lead.missingData?.length > 0 && (
        <div className="row wrap small" style={{ marginTop: 8, gap: 6 }}>
          <span className="faint">Still missing:</span>
          {lead.missingData.map((m, i) => <span key={i} className="badge">{m}</span>)}
        </div>
      )}

      {!open ? (
        <div className="row" style={{ marginTop: 10 }}>
          <a className="btn sm primary" href={lead.maps_url} target="_blank" rel="noreferrer" onClick={() => setOpen(true)}>
            Check on Maps
          </a>
          <button className="btn sm" onClick={() => setOpen(true)}>Enter details</button>
          <div className="spacer" />
          <button className="btn sm danger" onClick={reject} disabled={busy}>Not real</button>
        </div>
      ) : (
        <div style={{ marginTop: 10 }}>
          <div className="field-row">
            <div className="field">
              <label>Phone (required)</label>
              <input type="text" placeholder="+91 20 1234 5678" value={form.phone} onChange={set('phone')} />
            </div>
            <div className="field">
              <label>Website</label>
              <input type="text" placeholder="optional" value={form.website} onChange={set('website')} />
            </div>
          </div>
          <div className="field-row">
            <div className="field"><label>Reviews</label><input type="number" value={form.review_count} onChange={set('review_count')} /></div>
            <div className="field"><label>Rating</label><input type="number" step="0.1" value={form.rating} onChange={set('rating')} /></div>
            <div className="field"><label>IG followers</label><input type="number" value={form.ig_followers} onChange={set('ig_followers')} /></div>
            <div className="field"><label>Years</label><input type="number" value={form.years_in_business} onChange={set('years_in_business')} /></div>
          </div>
          <div className="row">
            <button className="btn primary sm" onClick={verify} disabled={busy || !form.phone}>
              {busy ? 'Saving...' : 'Verify and rescore'}
            </button>
            <button className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
            <div className="spacer" />
            <button className="btn sm danger" onClick={reject} disabled={busy}>Not real</button>
          </div>
          <div className="small faint" style={{ marginTop: 6 }}>
            Reviews and rating drive most of the score. Filling them in is what turns a C into an A.
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- AI feedback control ---------------- */

function Feedback({ suggestionId, onDone }) {
  const toast = useToast();
  const [done, setDone] = useState(null);

  const act = async (action) => {
    try {
      await api.suggestionAction(suggestionId, { action });
      setDone(action);
      onDone?.(action);
    } catch (e) { toast.error(e); }
  };

  if (done) return <span className="small faint">Logged as {done}. Thanks - this is what tunes the prompts.</span>;

  return (
    <div className="row">
      <span className="small faint">Was this useful?</span>
      <button className="btn sm" onClick={() => act('accepted')}>Used it</button>
      <button className="btn sm" onClick={() => act('edited')}>Edited it</button>
      <button className="btn sm ghost" onClick={() => act('rejected')}>Useless</button>
    </div>
  );
}

function AiMeta({ res }) {
  return (
    <div className="row small faint" style={{ marginBottom: 10 }}>
      {res.fallback ? (
        <span className="badge b" title={res.reason || ''}>Template fallback</span>
      ) : (
        <span className="badge blue">{res.model}</span>
      )}
      {res.cached && <span className="badge">cached</span>}
      {res.latencyMs != null && <span>{(res.latencyMs / 1000).toFixed(1)}s</span>}
    </div>
  );
}

/* ---------------- tabs ---------------- */

function BriefTab({ lead, disabled }) {
  const toast = useToast();
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async (force) => {
    setLoading(true);
    try { setRes(await api.brief(lead.id, force)); }
    catch (e) { toast.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(false); }, [lead.id]);

  if (loading) return <div className="empty"><span className="spinner" /> <span className="muted">Reading the lead</span></div>;
  if (!res) return null;
  const o = res.output;

  return (
    <div>
      <AiMeta res={res} />
      {disabled && <div className="callout bad" style={{ marginBottom: 12 }}>Verify this business before using any of this.</div>}

      <div className="card">
        <h3>The one-liner</h3>
        <div style={{ fontSize: 14 }}>{o.headline}</div>
      </div>

      <div className="card">
        <h3>What to sell them</h3>
        {(o.gaps || []).map((g, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            <div style={{ fontWeight: 560 }}>{g.gap}</div>
            <div className="small muted">{g.why_it_matters}</div>
            <span className="badge blue" style={{ marginTop: 4 }}>{g.service}</span>
          </div>
        ))}
        <div className="divider" />
        <div className="kv">
          <dt>Recommended</dt>
          <dd>{lead.packageName || o.recommended_package_id} · <strong>{o.price_band}</strong></dd>
        </div>
      </div>

      <div className="card">
        <h3>Opener</h3>
        <div className="msg-box">{o.opener}</div>
        <div className="row small muted" style={{ marginTop: 8 }}>
          <span>Ask for: {o.decision_maker}</span><span>·</span>
          <span>{o.best_channel}</span><span>·</span><span>{o.best_time}</span>
        </div>
      </div>

      <div className="card">
        <h3>Expect this objection</h3>
        <div style={{ fontWeight: 540, marginBottom: 4 }}>"{o.objection_to_expect}"</div>
        <div className="small muted">{o.objection_response}</div>
        {o.do_not_say && <div className="callout bad" style={{ marginTop: 10 }}>{o.do_not_say}</div>}
      </div>

      <div className="row" style={{ marginTop: 12 }}>
        <Feedback suggestionId={res.id} />
        <div className="spacer" />
        <button className="btn sm ghost" onClick={() => load(true)}>Regenerate</button>
      </div>
    </div>
  );
}

/**
 * What the web actually says about this business, with citations.
 *
 * Shown separately from the brief because it is evidence rather than advice - a
 * rep about to repeat a claim on a call should be able to click through to
 * where it came from.
 */
function ResearchTab({ lead }) {
  const toast = useToast();
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async (force) => {
    setLoading(true);
    try { setRes(await api.research(lead.id, force)); }
    catch (e) { toast.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(false); }, [lead.id]);

  if (loading) return <div className="empty"><span className="spinner" /> <span className="muted">Searching the web</span></div>;
  if (!res) return null;

  const o = res.output || {};
  const dp = o.digital_presence || {};

  return (
    <div>
      <div className="row small faint" style={{ marginBottom: 10 }}>
        {res.grounded
          ? <span className="badge a">grounded in {res.sources?.length || 0} sources</span>
          : <span className="badge b" title={res.reason || ''}>not grounded</span>}
        {res.cached && <span className="badge">cached</span>}
        {o.confidence && <span className="badge">{o.confidence} confidence</span>}
        {res.latencyMs != null && <span>{(res.latencyMs / 1000).toFixed(1)}s</span>}
      </div>

      {!res.grounded && (
        <div className="callout bad" style={{ marginBottom: 12 }}>
          Search grounding is unavailable, so nothing here was verified against the web.
          {res.reason ? ' ' + res.reason : ''}
        </div>
      )}

      {o.summary && (
        <div className="card"><h3>What they actually are</h3><div>{o.summary}</div></div>
      )}

      {(o.size_signals || []).length > 0 && (
        <div className="card">
          <h3>Scale</h3>
          {o.size_signals.map((x, i) => <div className="gap-line" key={i}>{x}</div>)}
        </div>
      )}

      {(dp.website || dp.instagram || dp.facebook) && (
        <div className="card">
          <h3>Digital presence found</h3>
          <div className="kv small">
            {dp.website && <><dt>Website</dt><dd><a href={dp.website} target="_blank" rel="noreferrer">{dp.website}</a></dd></>}
            {dp.instagram && (
              <>
                <dt>Instagram</dt>
                <dd>
                  <a href={'https://instagram.com/' + String(dp.instagram).replace('@', '')} target="_blank" rel="noreferrer">
                    {dp.instagram}
                  </a>
                  {dp.followers_estimate ? ' · about ' + dp.followers_estimate + ' followers' : ''}
                </dd>
              </>
            )}
            {dp.facebook && <><dt>Facebook</dt><dd>{dp.facebook}</dd></>}
          </div>
          {dp.website && lead.website_status === 'unknown' && (
            <button
              className="btn sm primary"
              style={{ marginTop: 10 }}
              onClick={async () => {
                try {
                  await api.patchLead(lead.id, { website: dp.website });
                  toast.success('Website saved and rescored.');
                } catch (e) { toast.error(e); }
              }}
            >
              Save this as their website
            </button>
          )}
        </div>
      )}

      {(o.services || []).length > 0 && (
        <div className="card">
          <h3>What they sell</h3>
          <div className="chip-grid">
            {o.services.map((x, i) => <span className="chip" key={i}>{x}</span>)}
          </div>
        </div>
      )}

      {(o.recent || []).length > 0 && (
        <div className="card">
          <h3>Recent</h3>
          {o.recent.map((x, i) => <div className="gap-line" key={i}>{x}</div>)}
        </div>
      )}

      {o.buying_trigger && (
        <div className="callout good"><strong>Why now:</strong> {o.buying_trigger}</div>
      )}

      {(res.sources || []).length > 0 && (
        <div className="card">
          <h3>Sources</h3>
          {res.sources.map((s, i) => (
            <div key={i} className="small">
              <a href={s.uri} target="_blank" rel="noreferrer">{s.title}</a>
            </div>
          ))}
          {(res.queries || []).length > 0 && (
            <div className="small faint" style={{ marginTop: 8 }}>
              Searched: {res.queries.join(' · ')}
            </div>
          )}
        </div>
      )}

      <button className="btn sm ghost" onClick={() => load(true)}>Re-research</button>
    </div>
  );
}

function MessageTab({ lead, disabled }) {
  const toast = useToast();
  const [res, setRes] = useState(null);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');

  const load = async (force) => {
    setLoading(true);
    try {
      const r = await api.whatsapp(lead.id, force);
      setRes(r);
      setText(r.output.message || '');
    } catch (e) { toast.error(e); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(false); }, [lead.id]);

  if (loading) return <div className="empty"><span className="spinner" /> <span className="muted">Writing</span></div>;
  if (!res) return null;

  const edited = text !== res.output.message;
  const link = lead.phone ? 'https://wa.me/' + lead.phone.replace(/\D/g, '') + '?text=' + encodeURIComponent(text) : null;

  return (
    <div>
      <AiMeta res={res} />

      {!res.canSend && <div className="callout bad" style={{ marginBottom: 12 }}>{res.blockedReason}</div>}
      {disabled && <div className="callout bad" style={{ marginBottom: 12 }}>Verify this business before messaging.</div>}

      <div className="card">
        <h3>First message</h3>
        <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ minHeight: 120 }} />
        <div className="row" style={{ marginTop: 8 }}>
          <a
            className={'btn primary sm' + (link && !disabled ? '' : ' disabled')}
            href={link || undefined}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              if (!link || disabled) { e.preventDefault(); return; }
              api.suggestionAction(res.id, { action: edited ? 'edited' : 'accepted', editedText: edited ? text : null }).catch(() => {});
            }}
            style={!link || disabled ? { opacity: 0.4, pointerEvents: 'none' } : undefined}
          >
            Open in WhatsApp
          </a>
          <button className="btn sm ghost" onClick={() => load(true)}>Rewrite</button>
          {edited && <span className="small faint">edited</span>}
        </div>
        <div className="small faint" style={{ marginTop: 8 }}>
          This opens your own WhatsApp with the text ready. You press send - no automated sending, which is what keeps the number safe.
        </div>
      </div>

      <div className="card">
        <h3>If they do not reply (3 days)</h3>
        <div className="msg-box">{res.output.follow_up_if_no_reply}</div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Why this angle</h3>
        <div className="small muted">{res.output.why_this_angle}</div>
      </div>

      <div style={{ marginTop: 12 }}><Feedback suggestionId={res.id} /></div>
    </div>
  );
}

function ActivityTab({ lead, onChanged }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [type, setType] = useState('call');
  const [busy, setBusy] = useState(false);
  const [extracted, setExtracted] = useState(null);

  const submit = async (withAi) => {
    if (!note.trim()) return;
    setBusy(true);
    try {
      if (withAi) {
        const r = await api.extractNote(lead.id, { note, type });
        setExtracted(r.output);
        toast.success('Logged and structured.');
      } else {
        await api.logActivity(lead.id, { type, body: note });
        toast.success('Logged.');
      }
      setNote('');
      onChanged();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  return (
    <div>
      <div className="card">
        <h3>Log what happened</h3>
        <div className="field-row" style={{ marginBottom: 8 }}>
          <select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 150 }}>
            {['call', 'whatsapp', 'email', 'meeting', 'visit', 'note'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <textarea
          placeholder="Spoke to the owner. Said they get most work by referral but lose younger customers who search online. Budget is tight..."
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary sm" onClick={() => submit(true)} disabled={busy || !note.trim()}>
            {busy ? 'Working...' : 'Log and extract'}
          </button>
          <button className="btn sm" onClick={() => submit(false)} disabled={busy || !note.trim()}>Log only</button>
        </div>
        <div className="small faint" style={{ marginTop: 6 }}>
          Extract pulls out objections, budget signal and the next date so you never re-read a note.
        </div>
      </div>

      {extracted && (
        <div className="card">
          <h3>Extracted</h3>
          <div className="row wrap" style={{ marginBottom: 8 }}>
            <span className="badge blue">{extracted.budget_signal}</span>
            <span className="badge purple">{extracted.buying_signal}</span>
            <span className={'badge ' + (extracted.sentiment === 'positive' ? 'a' : extracted.sentiment === 'negative' ? 'red' : '')}>{extracted.sentiment}</span>
            <span className="badge">{extracted.outcome}</span>
          </div>
          {(extracted.objections || []).length > 0 && (
            <>
              <div className="small muted" style={{ marginBottom: 4 }}>Objections</div>
              {extracted.objections.map((o, i) => <div key={i} className="gap-line">{o}</div>)}
            </>
          )}
          <div className="divider" />
          <div className="small"><strong>Next:</strong> {extracted.next_step} <span className="faint">(in {extracted.next_due_in_days} days)</span></div>
        </div>
      )}

      <div className="card">
        <h3>History</h3>
        {!lead.activities?.length && <div className="small faint">Nothing logged yet.</div>}
        {(lead.activities || []).map((a) => (
          <div key={a.id} style={{ paddingBottom: 10, marginBottom: 10, borderBottom: '1px solid var(--line-soft)' }}>
            <div className="row small">
              <span className="badge">{a.type}</span>
              {a.outcome && <span className="badge blue">{a.outcome}</span>}
              <div className="spacer" />
              <span className="faint">{new Date(a.occurred_at).toLocaleString()}</span>
            </div>
            {a.body && <div style={{ marginTop: 6, fontSize: 13 }}>{a.body}</div>}
          </div>
        ))}
      </div>

      {lead.history?.length > 0 && (
        <div className="card">
          <h3>Stage changes</h3>
          {lead.history.map((h) => (
            <div key={h.id} className="row small" style={{ padding: '3px 0' }}>
              <span className="faint">{h.from_stage || 'new'}</span>
              <span className="faint">→</span>
              <span>{h.to_stage}</span>
              <div className="spacer" />
              <span className="faint">{new Date(h.at).toLocaleDateString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DetailsTab({ lead, onChanged }) {
  const toast = useToast();
  const [form, setForm] = useState({
    phone: lead.phone || '', email: lead.email || '', website: lead.website || '',
    ig_handle: lead.ig_handle || '', ig_followers: lead.ig_followers ?? '',
    li_followers: lead.li_followers ?? '', review_count: lead.review_count ?? '',
    rating: lead.rating ?? '', years_in_business: lead.years_in_business ?? '',
    locations_count: lead.locations_count ?? '',
    runs_ads: lead.runs_ads === null || lead.runs_ads === undefined ? '' : String(lead.runs_ads),
    agency_managed: lead.agency_managed === null || lead.agency_managed === undefined ? '' : String(lead.agency_managed),
  });
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const save = async () => {
    setBusy(true);
    try {
      const patch = {};
      for (const [k, v] of Object.entries(form)) {
        if (v === '') { patch[k] = null; continue; }
        if (['ig_followers', 'li_followers', 'review_count', 'years_in_business', 'locations_count'].includes(k)) patch[k] = Number(v);
        else if (['runs_ads', 'agency_managed'].includes(k)) patch[k] = v === 'true';
        else if (k === 'rating') patch[k] = Number(v);
        else patch[k] = v;
      }
      await api.patchLead(lead.id, patch);
      toast.success('Saved and rescored.');
      onChanged();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const links = lead.links || {};

  return (
    <div>
      <div className="callout info" style={{ marginBottom: 12 }}>
        Instagram and LinkedIn follower counts have no legal API, and Google's ad library does not cover
        commercial ads. These are the ten-minute audit a rep does before calling. Anything you type here
        beats anything fetched, and the score updates the moment you save.
      </div>

      <div className="card">
        <h3>Open these, then fill in below</h3>
        <div className="row wrap">
          {links.instagram_search && <a className="btn sm" href={links.instagram_search} target="_blank" rel="noreferrer">Instagram</a>}
          {links.linkedin_search && <a className="btn sm" href={links.linkedin_search} target="_blank" rel="noreferrer">LinkedIn</a>}
          {links.meta_ad_library && <a className="btn sm" href={links.meta_ad_library} target="_blank" rel="noreferrer">Meta ads</a>}
          {links.google_ads_transparency && <a className="btn sm" href={links.google_ads_transparency} target="_blank" rel="noreferrer">Google ads</a>}
          {lead.maps_url && <a className="btn sm" href={lead.maps_url} target="_blank" rel="noreferrer">Maps</a>}
        </div>
      </div>

      <div className="card">
        <div className="field-row">
          <div className="field"><label>Phone</label><input type="text" value={form.phone} onChange={set('phone')} /></div>
          <div className="field"><label>Email</label><input type="text" value={form.email} onChange={set('email')} /></div>
        </div>
        <div className="field"><label>Website</label><input type="text" value={form.website} onChange={set('website')} /></div>
        <div className="field-row">
          <div className="field"><label>Reviews</label><input type="number" value={form.review_count} onChange={set('review_count')} /></div>
          <div className="field"><label>Rating</label><input type="number" step="0.1" value={form.rating} onChange={set('rating')} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>IG handle</label><input type="text" value={form.ig_handle} onChange={set('ig_handle')} /></div>
          <div className="field"><label>IG followers</label><input type="number" value={form.ig_followers} onChange={set('ig_followers')} /></div>
          <div className="field"><label>LinkedIn followers</label><input type="number" value={form.li_followers} onChange={set('li_followers')} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Years in business</label><input type="number" value={form.years_in_business} onChange={set('years_in_business')} /></div>
          <div className="field"><label>Locations</label><input type="number" value={form.locations_count} onChange={set('locations_count')} /></div>
        </div>
        <div className="field-row">
          <div className="field">
            <label>Running ads?</label>
            <select value={form.runs_ads} onChange={set('runs_ads')}>
              <option value="">Not checked</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          </div>
          <div className="field">
            <label>Already has an agency?</label>
            <select value={form.agency_managed} onChange={set('agency_managed')}>
              <option value="">Not checked</option><option value="true">Yes</option><option value="false">No</option>
            </select>
          </div>
        </div>
        <button className="btn primary" onClick={save} disabled={busy}>{busy ? 'Saving...' : 'Save and rescore'}</button>
      </div>

      {lead.website_audit && (
        <div className="card">
          <h3>Website audit</h3>
          <div className="kv small">
            <dt>Status</dt><dd>{lead.website_status}</dd>
            {lead.website_audit.builder && <><dt>Built with</dt><dd>{lead.website_audit.builder}</dd></>}
            <dt>HTTPS</dt><dd>{lead.has_https === null ? 'unknown' : lead.has_https ? 'yes' : 'no'}</dd>
            <dt>Mobile ready</dt><dd>{lead.mobile_friendly === null ? 'unknown' : lead.mobile_friendly ? 'yes' : 'no'}</dd>
            {lead.psi_mobile != null && <><dt>Mobile PageSpeed</dt><dd>{lead.psi_mobile}</dd></>}
          </div>
          {(lead.website_audit.signals || []).length > 0 && (
            <>
              <div className="divider" />
              {lead.website_audit.signals.map((s, i) => <div key={i} className="gap-line">{s}</div>)}
            </>
          )}
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => api.auditLead(lead.id, true).then(onChanged)}>
            Re-audit with PageSpeed
          </button>
        </div>
      )}

      {lead.source_url && (
        <div className="card">
          <h3>Where this came from</h3>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, color: 'var(--text-dim)' }}>
            {JSON.stringify(lead.source_url, null, 1)}
          </pre>
          <div className="small faint" style={{ marginTop: 8 }}>
            Kept per field. This is the paper trail if anyone ever asks where a contact detail came from.
          </div>
        </div>
      )}
    </div>
  );
}
