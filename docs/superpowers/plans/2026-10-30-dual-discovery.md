# Combined Discovery Implementation Plan

**Goal:** Add opt-in combined Luna/Gemini discovery without resetting data.
**Architecture:** Two bounded adapters feed a merger, then the existing ingestion and enrichment path. Existing modes keep their behavior.
**Tech Stack:** Node fetch, node:test, Hono, React, existing Postgres queue.
**Spec:** ../specs/2026-10-30-dual-discovery-design.md

## Global constraints
- No database reset, deployment, production sweep or outreach.
- Keep secrets out of responses, logs, tests and commits.
- Retain existing discovery defaults; configure combined mode explicitly.

## Review focus
- One provider fails while the other returns useful evidence.
- Repeated contacts and different branches must not overwrite existing records.
- Incomplete output and missing citations must not become trusted contacts.
- Retries, model fallback and tool calls must be bounded and counted.
- Spending estimates must identify unknown grounding costs.

## Tasks
- [x] Write and run failing tests for retries, evidence validation, merge and partial results.
- [x] Implement provider adapters, configuration and combined discovery report.
- [x] Wire route validation, ingestion, lifecycle provenance and discovery UI.
- [x] Run unit/integration checks and frontend build; smoke-test adapters in isolation.
- [x] Review diff, document deployment env, and commit the branch.

## Implementation rulings
- Native Gemini Maps returned no citations in live checks; combined discovery defaults to native Google Search grounding. It researches in plain text before extracting JSON. `DISCOVERY_GEMINI_TOOL=maps` retains native Maps as an explicit option. Existing Maps mode defaults are unchanged.
- Exact observed source URLs authorize fields; a cited hostname alone cannot authorize arbitrary pages. Ambiguous same-name Maps branches are withheld rather than assigned the first place ID.
- Request count is bounded; invoice spend is estimated, with missing tool prices identified in the UI and documentation. No monetary ceiling is claimed.
- Reviewer findings on branch identity, field evidence and merged provenance were reproduced and fixed with regression tests.
- Verification: 160 server tests passed; frontend production build passed; local fixture UI showed the comparison report. An isolated live adapter check produced Luna 2 + Gemini 3 distinct sourced contacts with phones. This is not a production sweep or a conversion benchmark.
