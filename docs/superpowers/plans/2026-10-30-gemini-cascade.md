# Gemini discovery cascade implementation plan

**Goal:** Keep Luna and Gemini discovery coupled while failing over quickly when a Gemini model is overloaded.

**Architecture:** Retain parallel provider discovery and deterministic merging. Use an in-process, per-model cooldown around the existing Gemini research/extraction operation; no database migration, dependencies, or changes to other AI features.

**Scope:** User requested implementation directly. Defaults: Luna Medium; Gemini Medium with 3.8 Flash, 3.7 Flash, 3.6 Flash, then 3.5 Flash. All four IDs were returned by the configured key's model-list endpoint on 2026-10-30.

## Task 1: Bounded cascade and recovery

- [x] Add failing tests for ordered failover, one final retry, cooldown expiry/backoff, Retry-After, fatal auth/quota errors, and successful empty output.
- [x] Implement a small cascade helper with injectable clock/sleep for deterministic tests.
- [x] Route Gemini research plus extraction through this helper. Transport failures fall through immediately; success stops the chain. Missing citations remain withheld.
- [x] Keep request accounting/limits and Luna failure isolation intact; test real adapter wiring with mocked transport.

## Task 2: Configuration and delivery

- [x] Update defaults and both environment templates; preserve explicit existing environment overrides.
- [x] Document cooldown behavior, bounded retry, estimation limits, Google storage restrictions, and deployment variables.
- [x] Run server tests and inspect the patch for secrets, unwanted live side effects, and unrelated changes.
- Delivery: commit on the existing luna-addition branch; do not push or run production sweeps.

## Reliability decisions

- Each eligible model is attempted once before a single final retry of the first transiently failed model. DISCOVERY_RETRIES=0 disables that final retry; Luna retains its existing retry setting.
- Transient failures cool the model for 60 seconds, doubling on repeated failures to at most five minutes. A 404 is skipped for five minutes. Successful transport clears its cooldown.
- Honor Retry-After; if it requires more than 60 seconds, omit the immediate final retry. Cooldowns are process-local and do not cancel already-running calls.
- A valid zero-result response is success; invalid/uncited output advances the chain without being reimported as factual data.
- Auth and daily-quota failures stop the Gemini provider. Luna may still complete.
- Google content storage restrictions are unchanged by retries or model choice; this patch is not a grant of retention rights.

## Verification ledger

- Helper tests initially failed because the new module did not exist; seven passed after implementation.
- Adapter regression reproduced repeated calls to the overloaded model before the fix, then passed with immediate failover and cross-category cooldown.
- Retry-After transport test failed before header propagation, then passed after the fix.
- Full server suite: 169 tests passed, zero failures. Providers and SQL transport are mocked in adapter/ingestion checks; no live app data was created.
- Model-list API: all four configured model IDs returned HTTP 200 inventory; no new generation-quality benchmark was run.
- Fresh read-only review: no concrete correctness or regression findings. Diff whitespace check passed. Credential files remain ignored.
- No frontend changes, dependencies, migrations, or modifications to the ordinary research/brief/message model routes.
