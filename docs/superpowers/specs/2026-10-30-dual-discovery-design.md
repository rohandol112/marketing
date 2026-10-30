# Combined discovery

User-approved scope: add an optional Luna + Gemini discovery source on branch `luna-addition`, retain existing modes and all stored records, test and commit without deploying or running a production sweep.

Luna uses Responses web search and optionally the configured Maps MCP; Gemini uses native grounding with a configurable model cascade. Google Search is the combined-mode default after live native Maps responses lacked citations. Both search each selected category. Results keep per-field evidence, remain subject to existing lifecycle/review gates, and are deduplicated before serial ingestion. Missing facts stay unknown. A failed provider must not discard the other's results. Retries use bounded exponential backoff and jitter, respecting retry hints; authentication and daily quota failures do not loop.

Reuse the existing queue, run params, provenance, usage and lead tables. Add a source option, request budget, pass count and run report showing each provider's candidates, supported phone counts, overlap, failures and estimated cost. Grounding billing without query counts is explicitly incomplete; reported cost is an estimate rather than a hard invoice ceiling. No claims of conversion uplift or measured savings without a baseline.

Alternatives considered: switch all discovery to Luna (loses complementary retrieval); a permanent planner/worker agent hierarchy (unnecessary for this change). Selected: a bounded two-provider workflow with existing deterministic ingestion.
