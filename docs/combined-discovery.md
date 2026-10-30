# Luna + Gemini discovery

Select **Luna + Gemini** in Discovery. Luna (high effort) and one successful Gemini model search each selected category in parallel. Gemini tries 3.8 Flash, 3.7 Flash, 3.6 Flash, 3.5 Flash, then 3.5 Flash Lite, using medium thinking where supported. It stops on the first supported response rather than running all five models for extra results. Results are merged, then go through existing exclusions, deduplication, audits, geocoding and human review. Existing modes and stored records are preserved. No migration or seed is required.

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
DISCOVERY_COMBINED_PASSES=1
DISCOVERY_REQUESTS_PER_MINUTE=600
DISCOVERY_COMBINED_CONCURRENCY=8
DISCOVERY_PROVIDER_TIMEOUT_MS=180000
DISCOVERY_LUNA_MODEL=gpt-6-luna
DISCOVERY_LUNA_EFFORT=high
DISCOVERY_GEMINI_MODELS=gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite
DISCOVERY_GEMINI_THINKING=medium
DISCOVERY_GEMINI_TOOL=search
DISCOVERY_MAPS_MCP=true
DISCOVERY_RESULTS_PER_PASS=25
DISCOVERY_MAX_OUTPUT_TOKENS=16000
DISCOVERY_RETRIES=2
```

Use `DISCOVERY_GEMINI_TOOL=maps` for native Maps instead of Google Search. Restart after changing environment values. Explicit existing values override the new defaults: set `DISCOVERY_LUNA_EFFORT=high` and update `DISCOVERY_GEMINI_MODELS` and `DISCOVERY_GEMINI_THINKING` if they are already set. The five default model IDs were listed by the configured key's model-list endpoint on 2026-10-30; availability and tool support may change. Discovery is independent of `LLM_PROVIDER`; configure drafts and research separately below.

## Terra drafts and research

Use the existing OpenAI key for these routes too:

```dotenv
LLM_PROVIDER=openai
LLM_MODEL_MAIN=gpt-6.1-terra
LLM_MODEL_FAST=gpt-6.1-terra
LLM_MODEL_SEARCH=gpt-6.1-terra
LLM_REASONING_EFFORT=low
LLM_RESEARCH_EFFORT=medium
```

"Light" maps to the API value `low`. Briefs, messages, call-note extraction and next-step suggestions use Terra Low without search tools. Business research, verification and social research use Terra Medium with OpenAI web search. A response without executed search and source evidence is not accepted as researched facts. Google Maps/legacy Gemini discovery retain a separate Gemini model, so Terra is never sent to a Google endpoint.

Opening either the brief or WhatsApp view now generates both the pre-call brief and WhatsApp opener/follow-up in one Terra Low request, after research if needed. The existing two endpoint response shapes and separate feedback IDs are preserved. Both views reuse the saved result; concurrent requests in one server process share the in-flight generation. Research retains its separate 30-day cache. Regenerating drafts reuses research when still current. Failed research/drafts are not reused as successful cached results. Historical suggestions are retained; model/effort changes create new cache keys instead of deleting rows.

For a new lead with no cached research, expect one Terra Medium research request plus one Terra Low outreach request. Subsequent unchanged views use the application cache and make no model request. Research may perform multiple billable search actions. Prompt-cache hits are provider-dependent; cached read/write token usage is recorded when reported, not assumed. One combined generation logs one usage event while saving two suggestion rows for independent feedback.

Optional ceilings are `LLM_MAX_OUTPUT_TOKENS=8192` for routine generation and `LLM_RESEARCH_MAX_OUTPUT_TOKENS=16000` for research; these include reasoning tokens. Existing explicit Gemini/Groq/Ollama/OpenRouter selections remain supported; when changing providers, change the model names to match. Restart after environment changes. No new API key, migration, seed or data deletion is required.

## Reliability and limits

- **Luna effort: use `high`, not `max`.** Measured on 2026-10-31 with the production discovery request (coaching classes, Kothrud, 16,000 output tokens): `max` reasoned for 15,715 tokens over 147 seconds and stopped `incomplete` without an answer, on every category of every sweep; `high` answered in 60 seconds with 16 businesses and 3,025 reasoning tokens; `medium` in 43 seconds with 11. If Luna runs out of output budget while reasoning, the call is retried once at the next lower effort, and that effort is used for the rest of the process (the warning names the setting to change). The wasted call is still billed and counted.

- Combined discovery defaults to one pass per provider per category: one Luna discovery request and one Gemini discovery pass. Set `DISCOVERY_COMBINED_PASSES=1` for this default; the Discovery dropdown can explicitly select more. The server uses the same default when a request omits `maxPages`. Other discovery sources retain `PLACES_MAX_PAGES`. Existing saved runs retain their explicit pass count. Extraction, tool actions and failure retries can add requests beyond those two discovery passes.
- Each pass asks for up to 25 candidates by default (`DISCOVERY_RESULTS_PER_PASS=25`), so the default pair targets up to 50 before overlap, evidence checks and existing-record deduplication. This is a prompt target, not guaranteed unique contacts. Providers may return fewer; raising the target can increase tokens and tool activity without increasing the number of discovery passes.

- Luna retains its bounded exponential retries and jitter (`DISCOVERY_RETRIES`, default two). Gemini tries each eligible model once on transient failure before moving to the next. A successful, valid empty list stops the chain; missing citations, unsupported candidates or invalid extraction advance to another model. There is no memory-only fallback.
- If the Gemini chain produces no supported response, it waits briefly (at least one second, with jitter) and retries the transiently failed models once, in the same strongest-to-weakest order. Success ends the second pass; there is no third pass. `DISCOVERY_RETRIES=0` disables this delayed retry cascade. `Retry-After` is honored per model; delays over 60 seconds exclude that model from the immediate second pass. A successful research response may still require a separate extraction request.
- Overloaded, throttled or timed-out Gemini models enter a process-local cooldown: 60 seconds, doubling on repeated failures up to five minutes, or longer when `Retry-After` requires it. Other categories skip cooling models. A missing model (404) is skipped for five minutes. Successful transport clears cooldown; expiration allows recovery. Process restarts clear this state, and calls already in flight are not cancelled. Authentication and daily-quota errors stop Gemini immediately.
- Both credentials must be configured to select this mode. During a run, a failed provider does not discard the other's results. Warnings identify partial results.
- The UI request limit defaults to 0 (no request cutoff). A positive limit stops *new categories* once reached; categories already running finish their follow-up calls (Gemini extraction, retries), so a run can end a few requests over the limit and never throws away a search it already paid for. It does not bound the invoice. Combined mode runs `DISCOVERY_COMBINED_CONCURRENCY` categories side by side (default 8); each runs both providers in parallel. Separate rolling-minute limiters permit at most 600 direct OpenAI discovery request starts and 600 direct Gemini discovery request starts per server process. Retries, extraction and thinking-compatibility retries count against their respective provider budgets. `DISCOVERY_REQUESTS_PER_MINUTE` can lower this ceiling; values over 600 are clamped. Requests queue before their network timeout starts. The limiter does not cover provider-internal search/MCP tool actions, separate research/drafting endpoints, TPM, or other server replicas. Existing saved runs keep any explicit request limit. Tool actions inside requests remain bounded. Cancellation stops new categories; already-running calls may finish.
- Request counts update as calls start; found/new/duplicate and token counts update as categories finish. Progress writes are serialized so older updates cannot overwrite newer progress. Each category still merges both providers before ingestion.
- Discovery provider timeouts default to 180 seconds, configured by `DISCOVERY_PROVIDER_TIMEOUT_MS` independently of drafting timeout. Luna timeouts are not automatically retried through repeated full waiting periods; retryable HTTP/network failures retain bounded retries. Timeout, invalid JSON and network errors are distinguished from HTTP authentication errors without exposing upstream response bodies or credentials.
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
