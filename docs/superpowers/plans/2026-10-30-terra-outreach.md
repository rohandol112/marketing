# Terra research and combined outreach

**Goal:** GPT-6.1 Terra Low generates brief, opener and follow-up in one call; GPT-6.1 Terra Medium researches with web search. GPT-6 Luna Max and the Gemini cascade remain discovery providers.

**Architecture:** Add an OpenAI Responses transport to the existing provider adapter. Reuse existing schema validation, contact scrubbing, fallbacks, suggestion records and research cache. Both outreach endpoints share one generation with process-local in-flight deduplication and separate feedback IDs. No new dependencies or database migration.

**User direction:** Implement directly; exact IDs are gpt-6-luna and gpt-6.1-terra. Light means low reasoning effort. Existing explicit environment settings are preserved and deployment overrides documented.

**Later direction:** No further subagents. Gemini is a fallback, not five parallel discovery calls: try 3.8, 3.7, 3.6, 3.5, 3.5 Lite, then one delayed top-down retry cascade for transient failures; retain exponential cooldown for later categories.

## Work

- [x] Add failing tests for Terra Low JSON, Terra Medium web research, missing search evidence, incomplete/refused responses, credential-safe errors, and schema conversion.
- [x] Implement OpenAI provider/model/effort routing, source extraction, limiter and health metadata. Keep Gemini Maps model/key routing independent of the drafting provider.
- [x] Add failing service test for brief/message sharing one call, simultaneous requests, cached research, separate feedback IDs, provider usage accounting and model-aware cache invalidation.
- [x] Implement combined outreach prompt and shared generation. Preserve existing response shapes, old rows and manual feedback.
- [x] Update provider labels/provenance and deployment templates/docs; discovery remains on Luna Max plus the Gemini fallback chain, with the later retry refinement requested above.
- [x] Run server suite, web build and review. Delivery: commit on luna-addition; no push or production sweeps/writes/outreach.

## Verification focus

- Never treat a response without actual search execution/source metadata as researched facts.
- Reject partial/refused model output before schema parsing.
- Strict JSON schemas must represent optional fields as nullable required fields.
- Existing Gemini/Groq/Ollama/OpenRouter selections must retain their behavior.
- Old cached Gemini drafts must not disguise the new Terra routing; keep historical rows.
- One generation counts as one usage event even though two suggestion rows support independent feedback.
- Failed generations must not be reused as successful cached research/outreach.

## Verification ledger

- New transport and service tests failed on the missing routing/shared generation, then passed after implementation.
- Initial isolated live research returned HTTP 400: web search cannot use JSON mode. Removed JSON mode from research, retained prompt-based JSON plus executed-search/source checks, and pinned the restriction with a regression assertion.
- Thin-evidence live drafting exposed the old requirement for two gaps and a non-empty package ID. Briefs now permit zero evidenced gaps and a null package ID, with a regression test. No invented gaps are required to satisfy the schema.
- Corrected live smoke: combined Terra Low outreach succeeded in 6,756 ms (1,326 input, 429 output tokens); Terra Medium research succeeded in 7,576 ms (12,611 input, 75 output tokens, one executed web search, 12 source URLs). No CRM records were created.
- Gemini tests now verify a delayed top-down second cascade, bounded to one repeat, plus exponential cooldown and Retry-After. The user requested no further subagents; final changes were reviewed inline.
- Final verification: 176 server tests passed, zero failures; web production build succeeded. No dependencies or migration added; old suggestion rows and feedback are preserved.
