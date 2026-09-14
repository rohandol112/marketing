import React, { useCallback, useEffect, useRef, useState } from 'react';
import api from '../api.js';
import { useToast } from '../App.jsx';

/**
 * Bulk verification, built for speed.
 *
 * The drawer is fine for working one lead you care about. It is hopeless for
 * the 300 sitting in the queue after a sweep - open, read, type, close, repeat
 * is about a minute each and nobody will ever do it.
 *
 * This is the other mode: one lead on screen, the Maps tab already open next to
 * it, three fields, and Enter to move on. Roughly fifteen seconds a lead, and
 * hands never leave the keyboard.
 *
 * The review count is the field that matters. It is the whole demand score, and
 * until it is filled in every lead in the queue scores identically - which is
 * why the queue looks like an undifferentiated wall in the first place.
 */
export default function FastVerify({ queue, onClose, onProgress }) {
  const toast = useToast();
  const [i, setI] = useState(0);
  const [form, setForm] = useState({ review_count: '', rating: '', phone: '', ig_followers: '', website: '' });
  const [noWebsite, setNoWebsite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState({ verified: 0, rejected: 0, skipped: 0 });
  const [mapsOpened, setMapsOpened] = useState(false);
  const firstField = useRef(null);

  const lead = queue[i];

  const reset = useCallback((l) => {
    setForm({
      review_count: l?.review_count ?? '',
      rating: l?.rating ?? '',
      phone: l?.phone ?? '',
      ig_followers: l?.ig_followers ?? '',
      website: l?.website ?? '',
    });
    setNoWebsite(l?.website_status === 'none');
    setMapsOpened(false);
    setTimeout(() => firstField.current?.focus(), 30);
  }, []);

  useEffect(() => { reset(lead); }, [lead?.id]);

  const advance = useCallback(() => {
    if (i + 1 >= queue.length) {
      toast.success('Queue finished.');
      onClose();
    } else {
      setI((n) => n + 1);
    }
  }, [i, queue.length, onClose]);

  const mapsUrl =
    lead &&
    'https://www.google.com/maps/search/' +
      encodeURIComponent([lead.name, lead.locality, lead.address].filter(Boolean).slice(0, 2).join(' '));

  const save = async () => {
    if (!lead || busy) return;
    if (!form.phone) {
      toast.error('A phone number is required - without one there is nothing for a rep to call.');
      return;
    }
    setBusy(true);
    try {
      const payload = { exists: true, phone: form.phone };
      if (form.review_count !== '') payload.review_count = Number(form.review_count);
      if (form.rating !== '') payload.rating = Number(form.rating);
      if (form.ig_followers !== '') payload.ig_followers = Number(form.ig_followers);
      // Confirming there is no website is real information, and distinct from
      // nobody having looked. Send it explicitly.
      if (form.website !== '') payload.website = form.website;
      else if (noWebsite) payload.website_status = 'none';

      const r = await api.verifyLead(lead.id, payload);
      setDone((d) => ({ ...d, verified: d.verified + 1 }));
      onProgress?.();
      if (r.score.discovery_status === 'qualified') {
        toast.success(lead.name + ' qualified at ' + r.score.score + '.');
      }
      advance();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (!lead || busy) return;
    setBusy(true);
    try {
      await api.verifyLead(lead.id, { exists: false });
      setDone((d) => ({ ...d, rejected: d.rejected + 1 }));
      onProgress?.();
      advance();
    } catch (e) { toast.error(e); } finally { setBusy(false); }
  };

  const skip = () => {
    setDone((d) => ({ ...d, skipped: d.skipped + 1 }));
    advance();
  };

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key === 'Enter') { e.preventDefault(); save(); return; }
      // Alt-modified so they cannot fire while typing a business name.
      if (e.altKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); reject(); }
      if (e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); skip(); }
      if (e.altKey && (e.key === 'm' || e.key === 'M')) {
        e.preventDefault();
        window.open(mapsUrl, '_blank', 'noopener');
        setMapsOpened(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [lead?.id, form, busy, mapsUrl]);

  if (!lead) return null;

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  const pct = Math.round((i / queue.length) * 100);
  const touched = done.verified + done.rejected + done.skipped;

  return (
    <div className="drawer-backdrop" style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div className="card" style={{ width: 620, maxWidth: '94vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 10 }}>
          <strong>Verifying</strong>
          <span className="small faint">{i + 1} of {queue.length}</span>
          <div className="spacer" />
          <span className="badge a">{done.verified} verified</span>
          {done.rejected > 0 && <span className="badge red">{done.rejected} not real</span>}
          {done.skipped > 0 && <span className="badge">{done.skipped} skipped</span>}
          <button className="btn ghost sm" onClick={onClose}>Done (Esc)</button>
        </div>

        <div className="progress" style={{ marginBottom: 14 }}><span style={{ width: pct + '%' }} /></div>

        <div className="row" style={{ marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{lead.name}</h2>
          {lead.valueTier && (
            <span className={'badge ' + (lead.valueTier === 'T1' ? 'a' : lead.valueTier === 'T2' ? 'b' : 'c')}
                  title="What this category is typically worth to an agency">
              {lead.valueTier}
            </span>
          )}
        </div>
        <div className="small muted" style={{ marginBottom: 12 }}>
          {[lead.category, lead.locality, lead.address].filter(Boolean).join(' · ')}
        </div>

        {lead.website_status === 'unknown' && (
          <div className="callout" style={{ marginBottom: 12 }}>
            Nobody has checked whether this business has a website. It is not scored as a gap until
            somebody does - a missing record is not the same as a missing website.
          </div>
        )}

        <a
          className={'btn block ' + (mapsOpened ? '' : 'primary')}
          href={mapsUrl}
          target="_blank"
          rel="noreferrer"
          onClick={() => setMapsOpened(true)}
          style={{ marginBottom: 14, textDecoration: 'none', textAlign: 'center' }}
        >
          {mapsOpened ? 'Maps opened - reopen' : 'Open on Google Maps'} <span className="faint">(Alt+M)</span>
        </a>

        <div className="field-row">
          <div className="field">
            <label>Reviews <span className="faint">— the number that matters</span></label>
            <input
              ref={firstField}
              type="number"
              value={form.review_count}
              onChange={set('review_count')}
              placeholder="e.g. 380"
            />
          </div>
          <div className="field">
            <label>Rating</label>
            <input type="number" step="0.1" value={form.rating} onChange={set('rating')} placeholder="4.4" />
          </div>
        </div>

        <div className="field">
          <label>Phone <span className="faint">— required</span></label>
          <input type="text" value={form.phone} onChange={set('phone')} placeholder="+91 20 1234 5678" />
        </div>

        {/* The review-to-follower ratio is the whole thesis of the product and
            there is no legal API for follower counts, so this is where it comes
            from. When the auditor already found their handle on their own site,
            it is one click away. */}
        <div className="field">
          <label>
            Instagram followers
            {lead.ig_handle ? (
              <>
                {' '}—{' '}
                <a
                  href={'https://instagram.com/' + lead.ig_handle}
                  target="_blank"
                  rel="noreferrer"
                >
                  open @{lead.ig_handle}
                </a>
              </>
            ) : (
              <>
                {' '}—{' '}
                <a
                  href={'https://www.google.com/search?q=' + encodeURIComponent(lead.name + ' ' + (lead.locality || '') + ' instagram')}
                  target="_blank"
                  rel="noreferrer"
                >
                  find their account
                </a>
              </>
            )}
          </label>
          <input
            type="number"
            value={form.ig_followers}
            onChange={set('ig_followers')}
            placeholder={lead.review_count ? 'compare against ' + lead.review_count + ' reviews' : 'optional'}
          />
        </div>

        {/* OpenStreetMap records a website for about 8% of businesses, so most
            leads arrive with this genuinely unknown rather than absent. */}
        <div className="field">
          <label>
            Website
            {' '}—{' '}
            <a
              href={'https://www.google.com/search?q=' + encodeURIComponent(lead.name + ' ' + (lead.locality || '') + ' official site')}
              target="_blank"
              rel="noreferrer"
            >
              search for it
            </a>
          </label>
          <input
            type="text"
            value={form.website}
            onChange={(e) => { setForm({ ...form, website: e.target.value }); setNoWebsite(false); }}
            placeholder={lead.website_status === 'unknown' ? 'not checked yet' : 'https://...'}
            disabled={noWebsite}
          />
          <label className="row small faint" style={{ marginTop: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={noWebsite}
              onChange={(e) => { setNoWebsite(e.target.checked); if (e.target.checked) setForm({ ...form, website: '' }); }}
              style={{ width: 'auto' }}
            />
            I checked - they genuinely have no website
          </label>
        </div>

        <div className="row">
          <button className="btn primary" onClick={save} disabled={busy || !form.phone}>
            {busy ? 'Saving...' : 'Verify and next'} <span style={{ opacity: 0.7 }}>(Enter)</span>
          </button>
          <button className="btn" onClick={skip} disabled={busy}>Skip <span className="faint">(Alt+S)</span></button>
          <div className="spacer" />
          <button className="btn danger" onClick={reject} disabled={busy}>
            Not real <span className="faint">(Alt+X)</span>
          </button>
        </div>

        <div className="callout info" style={{ marginTop: 14 }}>
          Reviews drive the demand score. Reviews <em>divided by</em> followers is the signal that
          finds the best deals - lots of real customers, almost no audience. Filling in both is what
          separates a good lead from an average one.
        </div>

        {touched > 0 && i + 1 >= queue.length && (
          <div className="callout good" style={{ marginTop: 10 }}>
            That is the end of this batch. Load more from the queue to keep going.
          </div>
        )}
      </div>
    </div>
  );
}
