import React from 'react';

const COLORS = {
  demand: '#35c88a',
  digital: '#f0b429',
  affordability: '#4c8dff',
  trigger: '#a175f5',
};

const BLURB = {
  demand: 'How much real, proven business they already have. Log-scaled, because 1,000 reviews is not ten times better than 100.',
  digital: 'The gap between that and their online presence. This is the part you sell.',
  affordability: 'What a business in this category is typically worth to a full-service agency.',
  trigger: 'Why now rather than next quarter.',
};

/**
 * The score has to be arguable. A rep who cannot see why a lead is a 78 will
 * not trust the ranking, and a team lead cannot retune weights they cannot see.
 */
export default function ScoreBreakdown({ breakdown, lead }) {
  if (!breakdown || !breakdown.demand) {
    return <div className="empty"><p>No score breakdown stored for this lead yet.</p></div>;
  }

  const parts = ['demand', 'digital', 'affordability', 'trigger'];
  const total = breakdown.total ?? lead?.score ?? 0;

  return (
    <div>
      <div className="card">
        <div className="row">
          <span className={'score ' + (breakdown.tier || 'c').toLowerCase()} style={{ fontSize: 18, height: 34, minWidth: 48 }}>
            {total}
          </span>
          <div>
            <div style={{ fontWeight: 570 }}>Tier {breakdown.tier}</div>
            <div className="small muted">
              {breakdown.tier === 'A' ? 'Call this week' : breakdown.tier === 'B' ? 'Worth a call' : 'Only in volume'}
            </div>
          </div>
        </div>

        <div className="score-bar">
          {parts.map((p) => (
            <span
              key={p}
              style={{ width: (breakdown[p]?.points || 0) + '%', background: COLORS[p] }}
              title={p + ': ' + (breakdown[p]?.points || 0)}
            />
          ))}
        </div>

        <div className="row wrap small">
          {parts.map((p) => (
            <span key={p} className="row" style={{ gap: 5 }}>
              <span style={{ width: 8, height: 8, borderRadius: 2, background: COLORS[p], display: 'inline-block' }} />
              <span className="muted">{breakdown[p]?.label}</span>
              <strong>{breakdown[p]?.points}</strong>
              <span className="faint">/ {breakdown[p]?.max}</span>
            </span>
          ))}
        </div>
      </div>

      {lead?.disqualified && (
        <div className="callout bad" style={{ marginBottom: 14 }}>
          <strong>Disqualified.</strong> {lead.disqualify_reason}
        </div>
      )}

      {parts.map((p) => {
        const b = breakdown[p];
        if (!b) return null;
        return (
          <div className="card" key={p}>
            <div className="row" style={{ marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>{b.label}</h3>
              <div className="spacer" />
              <strong style={{ color: COLORS[p] }}>{b.points}</strong>
              <span className="faint small">/ {b.max}</span>
            </div>
            <div className="small faint" style={{ marginBottom: 8 }}>{BLURB[p]}</div>

            {b.signals.length === 0 && <div className="small faint">Nothing scored here.</div>}
            {b.signals.map((s, i) => (
              <div className="signal" key={i}>
                <span className={'signal-pts ' + (s.points > 0 ? 'signal-pos' : 'faint')}>
                  {s.points > 0 ? '+' : ''}{s.points}
                </span>
                <span style={{ flex: 1 }}>
                  {s.label}
                  {s.detail && <div className="signal-detail">{s.detail}</div>}
                </span>
              </div>
            ))}
          </div>
        );
      })}

      <div className="small faint">
        Scored with config v{breakdown.configVersion} on {new Date(breakdown.scoredAt).toLocaleString()}.
        Weights live in Settings and every change creates a new version, so an old score can always be explained.
      </div>
    </div>
  );
}
