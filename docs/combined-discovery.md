# Luna + Gemini discovery

Select **Luna + Gemini** in Discovery. Luna Max and one successful Gemini model search each selected category in parallel. Gemini tries 3.8 Flash, 3.7 Flash, 3.6 Flash, then 3.5 Flash, using medium thinking. It stops on the first supported response rather than running all four models for extra results. Results are merged, then go through existing exclusions, deduplication, audits, geocoding and human review. Existing modes and stored records are preserved. No migration or seed is required.

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
DISCOVERY_LUNA_EFFORT=max
DISCOVERY_GEMINI_MODELS=gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash
DISCOVERY_GEMINI_THINKING=medium
DISCOVERY_GEMINI_TOOL=search
DISCOVERY_MAPS_MCP=true
DISCOVERY_RESULTS_PER_PASS=15
DISCOVERY_MAX_OUTPUT_TOKENS=16000
DISCOVERY_RETRIES=2
```

Use `DISCOVERY_GEMINI_TOOL=maps` for native Maps instead of Google Search. Restart after changing environment values. Explicit existing values override the new defaults: set `DISCOVERY_LUNA_EFFORT=max` and update `DISCOVERY_GEMINI_MODELS` and `DISCOVERY_GEMINI_THINKING` if they are already set. The four default model IDs were listed by the configured key's model-list endpoint on 2026-10-30; availability and tool support may change. No global `LLM_PROVIDER` change is needed; existing AI features retain their configured provider.

## Reliability and limits

- Luna retains its bounded exponential retries and jitter (`DISCOVERY_RETRIES`, default two). Gemini tries each eligible model once on transient failure before moving to the next. A successful, valid empty list stops the chain; missing citations, unsupported candidates or invalid extraction advance to another model. There is no memory-only fallback.
- If the Gemini chain produces no supported response, the first transiently failed model receives at most one final retry after a short jittered delay (at least one second). `DISCOVERY_RETRIES=0` disables this final retry. `Retry-After` is honored; delays over 60 seconds omit the immediate final retry. A successful research response may still require a separate extraction request.
- Overloaded, throttled or timed-out Gemini models enter a process-local cooldown: 60 seconds, doubling on repeated failures up to five minutes, or longer when `Retry-After` requires it. Other categories skip cooling models. A missing model (404) is skipped for five minutes. Successful transport clears cooldown; expiration allows recovery. Process restarts clear this state, and calls already in flight are not cancelled. Authentication and daily-quota errors stop Gemini immediately.
- Both credentials must be configured to select this mode. During a run, a failed provider does not discard the other's results. Warnings identify partial results.
- The UI request limit defaults to 100 and includes retries and model fallback attempts. This bounds provider requests, not the invoice. Tool actions inside requests have their own limit. Cancellation stops subsequent categories; one already in flight can finish.
- Counts are variable, not a guarantee of 500 contacts or exhaustive geographic coverage. Radius membership is explicitly unverified without sourced coordinates.
- Existing records are skipped as duplicates, not overwritten or refreshed.

## Run comparison

Each provider's distinct candidates, valid-format phone counts, requests and estimated cost appear beside overlap and provider-only counts. These are discovery measures, not verified reachable owners or intent to buy. Counts are per category; database ingestion checks duplicates again.

Contacts without field citations are withheld. Web-directory rating counts cannot enter Google review fields. Source provider and evidence are retained for each merged field. Web-only Luna candidates remain subject to the existing identity verification workflow. Selecting this source does not bypass review or send messages.

Reference-price estimates include Luna tokens/cache writes and reported web searches, plus Gemini 3.8/3.6 tokens including thinking and one grounding query per successful request. Flash token rates follow the published 2027-01-01 change. Other Gemini models and Maps MCP charges are unpriced. Actual grounding query counts and invoices can differ; compare matched runs before claiming savings or accuracy improvements.

## Source retention

Retries and paid access do not grant permission to store Google content as a permanent lead database. [Gemini grounding terms](https://ai.google.dev/gemini-api/terms), [Maps Experience Agent Tools terms (section 10)](https://cloud.google.com/maps-platform/terms/maps-service-terms), and [Places policies](https://developers.google.com/maps/documentation/places/web-service/policies) have distinct storage, extraction and display restrictions. The existing ingestion behavior is not a compliance certification; review permissions before deploying it for automated CRM collection. This retry change does not alter source retention or remove existing records.

## Verification

Run `npm test` in `server`, and `npm run build` in `web`. Tests include real route-to-ingestion orchestration with an isolated SQL transport and mocked providers. No production database or sweep is used. For a deployment smoke check, choose one category and one batch, then inspect source evidence, phone validity, exclusions and duplicates before expanding volume.
