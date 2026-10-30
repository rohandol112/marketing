# Luna + Gemini discovery

Select **Luna + Gemini** in Discovery. Both providers search each selected category. Results are merged, then go through existing exclusions, deduplication, audits, geocoding and human review. Existing modes and stored records are preserved. No migration or seed is required.

## Deployment environment

Set these on the deployed container, or in `server/.env` locally:

```dotenv
OPENAI_API_KEY=<existing OpenAI key>
GEMINI_API_KEY=<existing Gemini key>
MAPS_MCP_API_KEY=<Maps key that passed the connection check>
```

`X-Goog-Api-Key` is accepted as a legacy alias for `MAPS_MCP_API_KEY`. Do not put secret values in committed files. Gemini uses native Google Search grounding by default; Luna uses web search and optionally Maps MCP for missing details. Native Maps grounding is selectable, but live tests returned no citations, so those candidates were correctly withheld.

Optional controls, with defaults:

```dotenv
# Omit this to keep your current default; the UI still offers combined mode.
DISCOVERY_SOURCE=combined
DISCOVERY_LUNA_MODEL=gpt-6-luna
DISCOVERY_LUNA_EFFORT=medium
DISCOVERY_GEMINI_MODELS=gemini-3.8-flash,gemini-3.6-flash,gemini-3.5-flash-lite
DISCOVERY_GEMINI_THINKING=low
DISCOVERY_GEMINI_TOOL=search
DISCOVERY_MAPS_MCP=true
DISCOVERY_RESULTS_PER_PASS=15
DISCOVERY_MAX_OUTPUT_TOKENS=16000
DISCOVERY_RETRIES=2
```

Use `DISCOVERY_GEMINI_TOOL=maps` for native Maps instead of Google Search. Restart after changing environment values. No global `LLM_PROVIDER` change is needed; existing AI features retain their configured provider.

## Reliability and limits

- Transient failures receive at most two retries with exponential delays and jitter, capped at 60 seconds. Authentication errors do not loop. Gemini cascades after exhausted transient retries, a retired model, or missing grounding citations. There is no memory-only fallback.
- Both credentials must be configured to select this mode. During a run, a failed provider does not discard the other's results. Warnings identify partial results.
- The UI request limit defaults to 100 and includes retries and model fallback attempts. This bounds provider requests, not the invoice. Tool actions inside requests have their own limit. Cancellation stops subsequent categories; one already in flight can finish.
- Counts are variable, not a guarantee of 500 contacts or exhaustive geographic coverage. Radius membership is explicitly unverified without sourced coordinates.
- Existing records are skipped as duplicates, not overwritten or refreshed.

## Run comparison

Each provider's distinct candidates, valid-format phone counts, requests and estimated cost appear beside overlap and provider-only counts. These are discovery measures, not verified reachable owners or intent to buy. Counts are per category; database ingestion checks duplicates again.

Contacts without field citations are withheld. Web-directory rating counts cannot enter Google review fields. Source provider and evidence are retained for each merged field. Web-only Luna candidates remain subject to the existing identity verification workflow. Selecting this source does not bypass review or send messages.

Reference-price estimates include Luna tokens/cache writes and reported web searches, plus Gemini 3.8/3.6 tokens including thinking and one grounding query per successful request. Flash token rates follow the published 2027-01-01 change. Other Gemini models and Maps MCP charges are unpriced. Actual grounding query counts and invoices can differ; compare matched runs before claiming savings or accuracy improvements.

## Verification

Run `npm test` in `server`, and `npm run build` in `web`. Tests include real route-to-ingestion orchestration with an isolated SQL transport and mocked providers. No production database or sweep is used. For a deployment smoke check, choose one category and one batch, then inspect source evidence, phone validity, exclusions and duplicates before expanding volume.
