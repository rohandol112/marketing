import React from 'react';

/**
 * Filters for a queue of several hundred leads.
 *
 * Every option carries its own count, taken from the same query the table runs,
 * so you never pick a filter that turns out to return nothing. The counts also
 * do a second job: they tell you where the work actually is. "218 of 1,766 have
 * a phone" is the number that decides where a rep should start.
 */
export default function FilterBar({ facets, value, onChange, resultCount, totalCount, shownCount }) {
  const f = value;
  const set = (patch) => onChange({ ...f, ...patch });

  const toggleIn = (key, v) => {
    const cur = f[key] ? f[key].split(',') : [];
    const next = cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v];
    set({ [key]: next.join(',') });
  };

  const has = (key, v) => (f[key] ? f[key].split(',').includes(v) : false);

  const activeCount = Object.entries(f).filter(([k, v]) => v && k !== 'search').length +
    (f.search ? 1 : 0);

  const c = facets?.completeness;

  return (
    <div className="card" style={{ marginBottom: 14, padding: 12 }}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 10 }}>
        <input
          type="search"
          placeholder="Search name or address"
          value={f.search || ''}
          onChange={(e) => set({ search: e.target.value })}
          style={{ maxWidth: 220 }}
        />

        <select
          value={f.runId || ''}
          onChange={(e) => set({ runId: e.target.value })}
          style={{ maxWidth: 210 }}
          title="Which sweep these came from"
        >
          <option value="">All sweeps</option>
          {(facets?.areas || []).map((a) => (
            <option key={a.value} value={a.value}>{a.label} ({a.count})</option>
          ))}
        </select>

        <select
          value={f.locality || ''}
          onChange={(e) => set({ locality: e.target.value })}
          style={{ maxWidth: 210 }}
          title="Neighbourhood as recorded on the listing"
        >
          <option value="">All localities</option>
          {(facets?.localities || []).map((l) => (
            <option key={l.value} value={l.value}>{l.label} ({l.count})</option>
          ))}
        </select>

        <select
          value={f.category || ''}
          onChange={(e) => set({ category: e.target.value })}
          style={{ maxWidth: 230 }}
        >
          <option value="">All categories</option>
          {(facets?.categories || []).map((cat) => (
            <option key={cat.value} value={cat.value}>
              {cat.tier ? cat.tier + ' · ' : ''}{cat.label} ({cat.count})
            </option>
          ))}
        </select>

        <div className="spacer" />

        <span className="small muted">
          {resultCount != null && (
            <>
              <strong>{resultCount.toLocaleString()}</strong> match
              {totalCount != null && resultCount !== totalCount && (
                <span className="faint"> of {totalCount.toLocaleString()}</span>
              )}
              {/* the table is paged, so say so rather than implying you can see them all */}
              {shownCount != null && shownCount < resultCount && (
                <span className="faint"> · showing {shownCount}</span>
              )}
            </>
          )}
        </span>

        {activeCount > 0 && (
          <button
            className="btn sm ghost"
            onClick={() => onChange({})}
            title="Clear every filter"
          >
            Clear {activeCount}
          </button>
        )}
      </div>

      <div className="row wrap" style={{ gap: 6 }}>
        <span className="small faint" style={{ marginRight: 2 }}>Value</span>
        {(facets?.tiers || []).map((t) => (
          <span
            key={t.value}
            className={'chip' + (has('valueTier', t.value) ? ' on' : '')}
            onClick={() => toggleIn('valueTier', t.value)}
            title={
              t.value === 'T1' ? 'High ticket - a single close pays for the month'
                : t.value === 'T2' ? 'Mid ticket - retainer territory'
                  : 'Low ticket - only worth it in volume'
            }
          >
            {t.value} <span className="faint">{t.count}</span>
          </span>
        ))}

        <span style={{ width: 12 }} />
        <span className="small faint" style={{ marginRight: 2 }}>Already known</span>

        <span
          className={'chip' + (f.hasPhone === 'true' ? ' on' : '')}
          onClick={() => set({ hasPhone: f.hasPhone === 'true' ? '' : 'true' })}
          title="A number is already on file - these are the fastest to turn into calls"
        >
          Has phone {c && <span className="faint">{c.withPhone}</span>}
        </span>

        <span
          className={'chip' + (f.hasWebsite === 'true' ? ' on' : '')}
          onClick={() => set({ hasWebsite: f.hasWebsite === 'true' ? '' : 'true' })}
        >
          Has website {c && <span className="faint">{c.withWebsite}</span>}
        </span>

        <span
          className={'chip' + (f.hasWebsite === 'false' ? ' on' : '')}
          onClick={() => set({ hasWebsite: f.hasWebsite === 'false' ? '' : 'false' })}
          title="No website at all - the single easiest thing to sell"
        >
          No website {c && <span className="faint">{c.total - c.withWebsite}</span>}
        </span>

        <span
          className={'chip' + (f.hasReviews === 'false' ? ' on' : '')}
          onClick={() => set({ hasReviews: f.hasReviews === 'false' ? '' : 'false' })}
          title="Missing the review count, which is the entire demand score"
        >
          Needs reviews {c && <span className="faint">{c.total - c.withReviews}</span>}
        </span>

        <span
          className={'chip' + (f.hasReviews === 'true' ? ' on' : '')}
          onClick={() => set({ hasReviews: f.hasReviews === 'true' ? '' : 'true' })}
        >
          Enriched {c && <span className="faint">{c.withReviews}</span>}
        </span>
      </div>
    </div>
  );
}
