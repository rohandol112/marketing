import React from 'react';

/** Indian grouping for rupees, plain grouping otherwise. */
export function money(n, currency) {
  if (n == null) return '';
  const inr = currency === 'INR' || !currency;
  return (inr ? '₹' : currency + ' ') + Number(n).toLocaleString(inr ? 'en-IN' : undefined);
}

/**
 * "Can a big deal close here this week" - hover for why, and what holds it back.
 */
export function DealPip({ deal, score }) {
  if (!deal && !score) return <span className="faint">-</span>;
  const band = deal?.band || (score >= 70 ? 'hot' : score >= 50 ? 'warm' : 'cold');
  const cls = band === 'hot' ? 'a' : band === 'warm' ? 'b' : 'c';
  const tip = [...(deal?.reasons || []), ...(deal?.blockers || []).map((b) => 'Held back: ' + b)].join('\n');
  return <span className={'badge ' + cls} title={tip || band}>{deal?.score ?? score}</span>;
}
