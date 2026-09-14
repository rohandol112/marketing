# Tanz LeadOS

Finds local businesses that are strong offline and nearly invisible online, scores that gap
deterministically, and gives a rep something specific to say. Node + Hono + Knex + Postgres on the
back, plain React on the front.

```bash
docker compose up -d                    # postgres on 5433
cd server && npm install && npm run setup && npm run dev
cd web    && npm install && npm run dev # http://localhost:5173
```

---

## The one idea

Offline strength ÷ online presence. A jeweller with 1,240 Google reviews and 24 LinkedIn followers
has already won the hard part — the trust — and left the easy part on the table. That ratio is the
product. Everything else is plumbing around it.

---

## Two numbers, never averaged

| | Answers | Driven by |
|---|---|---|
| **Opportunity** 0–100 | Is this worth selling to? | Demand 40 · Digital gap 30 · Affordability 20 · Trigger 10 |
| **Confidence** 0–100 | Do we actually know that? | Identity 25 · trading 10 · phone 10 · website resolves 10 · address 10 · coords 5 · rating 10 · social 10 · 2nd source 10 |

An opportunity of 92 at 31% confidence is not a good lead — it's a research task. Below 60%
confidence a lead **cannot** be assigned to a rep.

Unknown data scores **zero**. Paying points for a missing review count makes every unverified lead
cluster at the same fake number, which is worse than useless because it looks like a ranking.

## Two state machines, never mixed

```
DISCOVERY                                    SALES
discovered → verifying → verified            todo → in_discussion → follow_up_1
          → qualified → (team lead review)        → follow_up_2 → follow_up_3
          → rejected                              → success / failed
```

A lead has **no sales stage** until a team lead approves it, and Postgres enforces it:

```sql
CHECK (stage IS NULL OR (status = 'approved' AND discovery_status = 'qualified'))
```

---

## Discovery sources

Set `DISCOVERY_SOURCE`. On `auto` it picks Places if a key is set, otherwise **OpenStreetMap** —
real data always beats generated data, so Gemini is never chosen automatically.

| Source | Trust | Notes |
|---|---|---|
| `places` | Authoritative | Google Places API (New). ~$0.035/call at the Enterprise field mask. `rating`, `userRatingCount`, `phone` and `websiteUri` are all Enterprise fields — there is no cheaper mask that still produces a usable lead. `reviews` is never requested. |
| `osm` | **Real, free, default** | OpenStreetMap via Overpass. Businesses a contributor physically surveyed, with coordinates. No key, no quota. ~130 businesses per 3km sweep, roughly 20% carry a phone. No ratings — that's Google's data — so leads land at `verified` and need a review count before they qualify. |
| `gemini` | **Unverified** | Model recall. Lands every lead in `discovered`. No phone is ever produced. Opt in explicitly. |
| `mock` | Synthetic | For working on the UI. |

### Area selection

The search box is the selector and it covers the whole planet — **Nominatim**, OpenStreetMap's
geocoder. Free, no key, and it knows neighbourhoods, not just cities: Kothrud, Bandra West,
Viman Nagar, Koregaon Park, Powai all resolve. You can also paste `18.5590, 73.8077` directly.
Its usage policy is one request per second and the server enforces that.

The chips under the box are saved shortcuts, not the available options. Search anything, then
**Save area** to add it.

### Read this before trusting Gemini discovery

A language model asked to list businesses is recalling training data, not querying a directory.
It **will** invent plausible businesses. The module is built so a hallucination costs a rep five
seconds instead of a phone call to a stranger:

1. **The schema has no phone field.** The model is never given the chance to produce a number
   someone could dial.
2. **Nothing reaches a rep unverified.** A human opens Maps, confirms it exists, and types the
   number in. That's the gate.
3. **No rating or review count.** A fabricated review count would quietly corrupt every ranking.
4. **Any website it returns is independently fetched.** A site that doesn't resolve is evidence
   the business may not exist.

Google Search grounding turns this from recall into retrieval and is tried first on every call.
It currently returns **429 on the free tier** — grounded requests have their own quota that opens
up with billing. When you enable it this upgrades itself with no code change; watch for
`grounded: true` on the run.

---

## Working a queue of 300

A sweep returns hundreds of leads and none of them have review counts, so every
one scores identically and the queue looks like an undifferentiated wall. Two
things make it workable.

**Filters.** Every option carries its own count, computed by the same query the
table runs, so you never pick something that returns nothing - and the counts
tell you where the work is. Sweep area, locality, category, value tier, and
"already known" toggles (has phone / no website / needs reviews). Locality is
normalised, so `Pune`, `pune` and `PUNE` are one option rather than three.
The header reports the true match count, not the size of the page you can see.

The slice that matters is usually **T1 + has phone + no website**: 51 leads out
of 1,766, every one of them callable today with the easiest possible pitch.

**Priority order.** Sorting by opportunity is useless before enrichment. The
verification queue instead orders by what is already known: what the category is
worth (T1 before T3), then whether a phone and website are already on file. The
top of the queue is Lilavati Hospital and Taj Lands End, not an arbitrary
hospital. Stop whenever you have enough - you are never expected to clear it.

**Fast verify.** Opening a drawer per lead is about a minute each and nobody will
do it 300 times. `Verify fast` puts one lead on screen with Maps one click away,
three fields, and Enter for the next - roughly fifteen seconds each.

| Key | Action |
|---|---|
| `Enter` | Verify and next |
| `Alt+M` | Open on Google Maps |
| `Alt+S` | Skip |
| `Alt+X` | Not real |
| `Esc` | Stop |

The review count is the field that matters: it is the entire demand score. Filling
it in typically moves a lead from opportunity 20 to around 60 and confidence from
65% to 95%, which is what takes it from `verified` to `qualified`.

---

## Where the AI is, and isn't

**Never AI:** finding businesses, phone numbers, scoring, deduping, qualifying.

**AI:** pre-call brief, WhatsApp opener, call-note → structured data, next-step suggestion.

The model **never emits a phone, email or URL**. `stripContactInfo()` replaces any it produces with
`{{phone}}`/`{{email}}`/`{{link}}`, and real values are substituted from the database afterwards.

Every response is schema-validated → one retry → static template fallback. A malformed suggestion is
never shown. Suggestions are generated **lazily when a rep opens a lead**, cached on
`(lead, stage, last activity, score, website state)`.

`gemini-3.6-flash` needs `thinkingConfig: { thinkingLevel: 'low' }` — `thinkingBudget: 0` is a 400 on
3.x, and without it you pay ~570 thought tokens and 5.5s per call instead of 2.6s.

### Accept / edit / reject

Every suggestion logs what the rep did with it. That is the eval dataset *and* the number you show
another agency when you sell this. Under 40% accept rate at any stage means that prompt is broken —
Analytics tells you which one.

---

## The guards (they are the product)

- No forward stage move without a logged activity
- No stage skipping
- Won deals need a proposal with an amount; lost deals need a reason from an enum
- Timing losses auto-recycle to a date instead of dying
- Per-rep open-lead cap, enforced on assign and auto-assign
- Dedupe on normalised phone, else name + locality

---

## What has no API, by design

Instagram/LinkedIn follower counts and "are they running ads" have no legal API, and Meta's Ad
Library is scoped to political ads — commercial ads in India are UI-only. These are **fields in the
rep's ten-minute audit**, not blockers in the pipeline. The drawer gives one-click search links and
a form. Anything a human types beats anything fetched, and the score updates on save.

---

## Before you go live

1. **Cold WhatsApp via the Business API gets numbers banned.** This only ever builds `wa.me`
   click-to-chat links a human presses send on. Keep it that way; move to WABA after they reply.
2. **DPDP + TRAI DND.** Publicly listed business contacts are defensible; scraped personal numbers
   and bulk auto-dialling are not. `field_provenance` is per-field, and there's a DNC table.
3. **Google's 30-day cache limit is a term, not a suggestion.** `place_id` forever, everything else
   refreshed within 30 days. `POST /api/leads/refresh-stale`.
4. **Auth is a stub** — an `x-user-id` header picks the acting user. Fine behind a VPN; replace
   `middleware/context.js` before this touches the internet.
5. **RLS is defence in depth, not the boundary.** The policy allows access when `app.tenant_id` is
   unset so migrations and the worker keep working. Every repository query filters on `tenant_id` —
   that's the real guarantee. Before tenant #2: connect as a non-owner role, route everything through
   `withTenant()`, drop the `IS NULL` escape.

---

## Deploying (one container, one env)

`Dockerfile` at the repo root builds everything into a single image: the Vite build, the API,
and Postgres. Coolify only needs the repo and one env file.

1. New resource -> Application -> your repo, build pack **Dockerfile**.
2. Port **8787**.
3. Add a **persistent volume** at `/var/lib/postgresql/data`. Without it, a redeploy starts an
   empty database.
4. Paste `.env.example` into the env editor and fill in the keys. Nothing in it is required —
   an empty file boots, seeds itself, and runs discovery and AI in mock mode.
5. Deploy. First boot runs `initdb`, the migrations and the seed; later boots run migrations only.

Set `APP_PASSWORD` before the URL is public. `middleware/context.js` is still a stub — one shared
HTTP login is a lock on the door, not a permission model.

`POSTGRES_PASSWORD` is baked into the cluster on the very first boot and ignored after that, so
change it before deploying, not later.

**Bring your own Postgres** — set `DATABASE_URL` (or `PGHOST`) and the embedded server never
starts, no volume needed:

```
DATABASE_URL=postgres://user:pass@db.internal:5432/dudeai
```

Same image runs locally:

```bash
docker build -t dudeai .
docker run -p 8787:8787 -v dudeai_pg:/var/lib/postgresql/data --env-file .env dudeai
```

`docker-compose.yml` is for development only — bare Postgres for `npm run dev` on the host.

---

## Layout

```
server/
  migrations/          init · rls · confidence_and_lifecycle · external_id
  seeds/01_tanz.js     62 services from the service profile deck, 6 packages
  src/lib/             scoring · confidence · categories(71) · places · osm · geminiDiscovery
                       gemini · prompts · websiteAudit · queue · wa · geo(nominatim)
  src/services/        discovery · lifecycle · leads · ai
  src/routes/          meta · discovery · leads · ai · analytics · settings
web/src/pages/         Board · Review · Discovery · Analytics · Settings
```

`npm test` in `server/` runs 18 tests over scoring and confidence, including hand-labelled fixtures
(Narenkumar, Mauli Garden, Tangent) that must always rank tier A. If a weight change breaks them,
the weight change is wrong until closed-won data proves otherwise.

---

## Build order from here

- **Now** — get a Places key. It is the single biggest quality jump available: real review counts,
  trading status, and confidence stops capping out around 55%. Until then OSM plus a 30-second
  Maps check per lead does the job.
- **Week 2** — work the verification queue on one pincode. Watch accept rates.
- **Week 3** — website auditor over everything, dedupe pass, 30-day refresh cron.
- **Week 4** — after ~30 closes, read Analytics → *which score component predicts a close*, retune,
  save (it versions and rescores). That loop is the only thing here a competitor cannot copy.

Resist until v2: auto-sending WhatsApp, IG/LinkedIn scrapers, LLM-based scoring, email sequences,
a mobile app. Each eats a week and none change whether a rep closes Narenkumar Jewellers.
