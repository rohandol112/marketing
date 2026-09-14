import React, { useEffect, useState } from 'react';
import api from '../api.js';
import { useApp, useToast } from '../App.jsx';

const TABS = ['Scoring', 'Team', 'Packages', 'Services', 'System'];

export default function Settings() {
  const [tab, setTab] = useState('Scoring');
  return (
    <div className="main">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Weights, team, and what you sell. Changing weights creates a new version and rescores everything.</p>
        </div>
      </div>
      <div className="chip-grid" style={{ marginBottom: 16 }}>
        {TABS.map((t) => (
          <span key={t} className={'chip' + (tab === t ? ' on' : '')} onClick={() => setTab(t)}>{t}</span>
        ))}
      </div>
      {tab === 'Scoring' && <Scoring />}
      {tab === 'Team' && <Team />}
      {tab === 'Packages' && <Packages />}
      {tab === 'Services' && <Services />}
      {tab === 'System' && <System />}
    </div>
  );
}

/* ---------------- scoring weights ---------------- */

function Scoring() {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getScoring().then((r) => { setState(r); setDraft(structuredClone(r.config)); }).catch(toast.error);
  }, []);

  if (!draft) return <div className="empty"><span className="spinner" /></div>;

  const setPath = (path, value) => {
    const next = structuredClone(draft);
    let node = next;
    for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
    node[path[path.length - 1]] = value;
    setDraft(next);
  };

  const save = async () => {
    setBusy(true);
    try {
      const r = await api.saveScoring({ config: draft, rescore: true });
      toast.success('Saved as version ' + r.version + '. Rescoring every lead now.');
      setState(await api.getScoring());
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const Num = ({ path, label, hint }) => (
    <div className="field">
      <label title={hint}>{label}</label>
      <input
        type="number"
        step="0.5"
        value={path.reduce((o, k) => o[k], draft)}
        onChange={(e) => setPath(path, Number(e.target.value))}
      />
    </div>
  );

  return (
    <>
      <div className="callout info" style={{ marginBottom: 14 }}>
        These are starting weights, not truth. After about 30 closed deals, check
        <strong> Analytics → which score component predicts a close</strong> and move the numbers
        that are carrying no signal. That feedback loop is the only thing here a competitor cannot copy.
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h2>Demand — how much real business they already have</h2>
          <Num path={['demand', 'reviewLogCoef']} label="Review coefficient" hint="points = coef * log10(reviews + 1)" />
          <Num path={['demand', 'unknownReviewsPoints']} label="Points when review count is unknown" hint="Keep this at 0. Paying for missing data makes unverified leads look ranked when they are not." />
          <div className="field-row">
            <Num path={['demand', 'ratingBonus', 'min']} label="Rating threshold" />
            <Num path={['demand', 'ratingBonus', 'points']} label="Rating bonus" />
          </div>
          <div className="field-row">
            <Num path={['demand', 'tenureBonus', 'minYears']} label="Years threshold" />
            <Num path={['demand', 'tenureBonus', 'points']} label="Tenure bonus" />
          </div>
          <div className="field-row">
            <Num path={['demand', 'multiLocation', 'min']} label="Locations threshold" />
            <Num path={['demand', 'multiLocation', 'points']} label="Multi-site bonus" />
          </div>
        </div>

        <div className="card">
          <h2>Digital gap — the part you sell</h2>
          <div className="field-row">
            <Num path={['digital', 'noWebsite']} label="No website" />
            <Num path={['digital', 'placeholderSite']} label="Placeholder site" />
          </div>
          <div className="field-row">
            <Num path={['digital', 'noHttps']} label="No HTTPS" />
            <Num path={['digital', 'notMobileFriendly']} label="Not mobile" />
          </div>
          <div className="field-row">
            <Num path={['digital', 'reviewToFollowerRatio', 'min']} label="Review:follower ratio" hint="The killer signal - lots of customers, no audience" />
            <Num path={['digital', 'reviewToFollowerRatio', 'points']} label="Ratio points" />
          </div>
          <div className="field-row">
            <Num path={['digital', 'lowInstagram', 'max']} label="Low IG threshold" />
            <Num path={['digital', 'lowInstagram', 'points']} label="Low IG points" />
          </div>
          <Num path={['digital', 'notRunningAds']} label="Not running ads" />
        </div>

        <div className="card">
          <h2>Affordability — what the category is worth</h2>
          <div className="field-row">
            <Num path={['affordability', 'tierPoints', 'T1']} label="T1 high ticket" />
            <Num path={['affordability', 'tierPoints', 'T2']} label="T2 mid ticket" />
            <Num path={['affordability', 'tierPoints', 'T3']} label="T3 low ticket" />
          </div>
          <Num path={['affordability', 'unknownPoints']} label="Unclassified category" />
        </div>

        <div className="card">
          <h2>Tiers and floors</h2>
          <div className="field-row">
            <Num path={['tiers', 'A']} label="Tier A at" />
            <Num path={['tiers', 'B']} label="Tier B at" />
          </div>
          <Num path={['disqualify', 'minReviews']} label="Minimum reviews to qualify" hint="Below this a business has not proven demand" />
          <div className="divider" />
          <div className="small faint">
            Currently on version {state?.version}. Every save creates a new version, so an old score
            can always be explained by the config that produced it.
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn primary" onClick={save} disabled={busy}>
          {busy ? 'Saving and rescoring...' : 'Save and rescore everything'}
        </button>
        <button className="btn ghost" onClick={() => setDraft(structuredClone(state.defaults))}>
          Reset to defaults
        </button>
      </div>
    </>
  );
}

/* ---------------- team ---------------- */

function Team() {
  const toast = useToast();
  const app = useApp();
  const [users, setUsers] = useState([]);
  const [form, setForm] = useState({ name: '', role: 'rep', openLeadCap: 25 });

  const load = () => api.users().then(setUsers).catch(toast.error);
  useEffect(() => { load(); }, []);

  const add = async () => {
    if (!form.name.trim()) return;
    try {
      await api.saveUser(form);
      setForm({ name: '', role: 'rep', openLeadCap: 25 });
      await load();
      await app.reload();
      toast.success('Added.');
    } catch (e) { toast.error(e); }
  };

  const patch = async (id, body) => {
    try { await api.patchUser(id, body); await load(); await app.reload(); }
    catch (e) { toast.error(e); }
  };

  return (
    <>
      <div className="card">
        <h2>Team</h2>
        <table>
          <thead>
            <tr><th>Name</th><th>Role</th><th className="right">Open leads</th><th className="right">Cap</th><th></th></tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>
                  <select value={u.role} onChange={(e) => patch(u.id, { role: e.target.value })} style={{ maxWidth: 140 }}>
                    <option value="rep">rep</option>
                    <option value="team_lead">team_lead</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td className="right">
                  <span className={u.openLeads >= u.open_lead_cap ? 'overdue' : ''}>{u.openLeads}</span>
                </td>
                <td className="right" style={{ width: 110 }}>
                  <input
                    type="number"
                    defaultValue={u.open_lead_cap}
                    onBlur={(e) => patch(u.id, { openLeadCap: Number(e.target.value) })}
                  />
                </td>
                <td className="right">
                  <button className="btn sm ghost" onClick={() => patch(u.id, { active: !u.active })}>
                    {u.active ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="callout" style={{ marginTop: 12 }}>
          The cap is not bureaucracy. Without it a bulk approve drops 200 leads on one person and
          none of them get worked properly.
        </div>
      </div>

      <div className="card">
        <h3>Add someone</h3>
        <div className="field-row">
          <div className="field">
            <label>Name</label>
            <input type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label>Role</label>
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="rep">rep</option>
              <option value="team_lead">team_lead</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <div className="field">
            <label>Open lead cap</label>
            <input type="number" value={form.openLeadCap} onChange={(e) => setForm({ ...form, openLeadCap: Number(e.target.value) })} />
          </div>
        </div>
        <button className="btn primary" onClick={add}>Add</button>
      </div>
    </>
  );
}

/* ---------------- packages ---------------- */

function Packages() {
  const toast = useToast();
  const app = useApp();
  const [packages, setPackages] = useState([]);

  const load = () => api.packages().then(setPackages).catch(toast.error);
  useEffect(() => { load(); }, []);

  const patch = async (id, body) => {
    try { await api.patchPackage(id, body); await load(); await app.reload(); toast.success('Saved.'); }
    catch (e) { toast.error(e); }
  };

  return (
    <div className="card">
      <h2>Packages</h2>
      <div className="small muted" style={{ marginBottom: 12 }}>
        These go into the AI system prompt verbatim, and the pre-call brief recommends one by id.
        Keep the names and price bands honest - a rep will read the number out loud.
      </div>
      <table>
        <thead>
          <tr><th>Name</th><th>Best for</th><th className="right">From</th><th className="right">To</th><th>Billing</th><th></th></tr>
        </thead>
        <tbody>
          {packages.map((p) => (
            <tr key={p.id}>
              <td>
                <div style={{ fontWeight: 540 }}>{p.name}</div>
                <div className="small faint">{p.tagline}</div>
              </td>
              <td className="small muted" style={{ maxWidth: 220 }}>{p.best_for}</td>
              <td className="right" style={{ width: 120 }}>
                <input type="number" defaultValue={p.price_min} onBlur={(e) => patch(p.id, { priceMin: Number(e.target.value) })} />
              </td>
              <td className="right" style={{ width: 120 }}>
                <input type="number" defaultValue={p.price_max ?? ''} onBlur={(e) => patch(p.id, { priceMax: e.target.value === '' ? null : Number(e.target.value) })} />
              </td>
              <td className="small">{p.billing === 'monthly' ? 'per month' : 'one off'}</td>
              <td className="right">
                <button className="btn sm ghost" onClick={() => patch(p.id, { active: !p.active })}>
                  {p.active ? 'Hide' : 'Show'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------------- services ---------------- */

function Services() {
  const toast = useToast();
  const [data, setData] = useState(null);

  useEffect(() => { api.catalog().then(setData).catch(toast.error); }, []);
  if (!data) return <div className="empty"><span className="spinner" /></div>;

  return (
    <div className="card">
      <h2>Service catalogue</h2>
      <div className="small muted" style={{ marginBottom: 12 }}>
        Taken from the Tanz Corp service profile. The AI can only recommend things on this list,
        and each service is tagged with the gaps it answers, so the pitch matches what was actually found.
      </div>
      {Object.entries(data.grouped).map(([group, rows]) => (
        <div key={group} style={{ marginBottom: 16 }}>
          <h3>{group}</h3>
          <div className="chip-grid">
            {rows.map((r) => (
              <span
                key={r.id}
                className={'chip' + (r.active ? ' on' : '')}
                title={(r.gap_tags || []).length ? 'Answers: ' + r.gap_tags.join(', ') : 'No gap mapping yet'}
                onClick={async () => {
                  try {
                    await fetch('/api/settings/catalog/' + r.id, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ active: !r.active }),
                    });
                    setData(await api.catalog());
                  } catch (e) { toast.error(e); }
                }}
              >
                {r.name}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- system ---------------- */

function System() {
  const app = useApp();
  const toast = useToast();
  const [health, setHealth] = useState(null);
  const [voice, setVoice] = useState(app.tenant.brand_voice || '');

  useEffect(() => { api.health().then(setHealth).catch(toast.error); }, []);

  const saveVoice = async () => {
    try { await api.patchTenant({ brand_voice: voice }); await app.reload(); toast.success('Saved.'); }
    catch (e) { toast.error(e); }
  };

  return (
    <>
      <div className="card">
        <h2>Brand voice</h2>
        <div className="small muted" style={{ marginBottom: 8 }}>
          Goes straight into the AI system prompt. This is the single highest-leverage
          text box in the app - it decides whether the messages sound like you or like an agency template.
        </div>
        <textarea value={voice} onChange={(e) => setVoice(e.target.value)} style={{ minHeight: 110 }} />
        <button className="btn primary sm" style={{ marginTop: 8 }} onClick={saveVoice}>Save</button>
      </div>

      <div className="card">
        <h2>Status</h2>
        {!health ? <span className="spinner" /> : (
          <div className="kv">
            <dt>Database</dt>
            <dd>{health.db.ok ? <span className="badge a">connected</span> : <span className="badge red">{health.db.error}</span>}</dd>

            <dt>Discovery source</dt>
            <dd>
              <span className={'badge ' + (health.discoverySource === 'places' ? 'a' : 'b')}>{health.discoverySource}</span>
              {health.discoverySource === 'gemini' && (
                <div className="small faint" style={{ marginTop: 4 }}>
                  Model recall. Every lead needs a human check before a rep sees it.
                  Add GOOGLE_PLACES_API_KEY for verified discovery.
                </div>
              )}
            </dd>

            <dt>Gemini</dt>
            <dd>
              {health.gemini.configured
                ? <span className="badge a">{health.gemini.modelMain}</span>
                : <span className="badge b">not configured - templates only</span>}
              <div className="small faint" style={{ marginTop: 4 }}>
                {health.gemini.rpmUsed}/{health.gemini.rpmLimit} this minute ·{' '}
                {health.gemini.rpdUsed}/{health.gemini.rpdLimit} today
              </div>
            </dd>

            <dt>PageSpeed</dt>
            <dd>{health.pagespeed.configured ? <span className="badge a">on</span> : <span className="badge">off</span>}</dd>

            <dt>Worker</dt>
            <dd>
              <span className={'badge ' + (health.queue.running ? 'a' : 'red')}>
                {health.queue.running ? 'running' : 'stopped'}
              </span>
              <span className="small faint"> {health.queue.activeJobs} active</span>
            </dd>
          </div>
        )}
      </div>

      <div className="card">
        <h2>Before you go live</h2>
        <div className="small muted">
          <div className="gap-line">Cold WhatsApp through the Business API gets numbers banned. This app only ever builds click-to-chat links a human presses send on - keep it that way.</div>
          <div className="gap-line">Publicly listed business contacts are defensible under DPDP. Scraped personal numbers and bulk auto-dialling are not.</div>
          <div className="gap-line">Google's terms allow caching a place id forever, but every other field must refresh within 30 days. The refresh job handles it - do not disable it.</div>
          <div className="gap-line">Authentication is a stub: a header picks the acting user. Put real sessions in before this leaves your network.</div>
        </div>
      </div>
    </>
  );
}
