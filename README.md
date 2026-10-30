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

## The hot list: what can close this week

A third number ranks one list and does nothing else. **Deal readiness** (0–100) asks whether a rep
can get the owner on the phone this week and leave with a signed deal:

| | Points | From |
|---|---|---|
| Size | 40 | Category tier, review volume (1,000+ reviews is a busy business), several branches |
| Visible pain | 35 | The digital gap, plus 10 for something urgent they can see today: site down, domain parked, browser security warning, hidden from Google, 100+ reviews and no site, a rating under 4 |
| Reachable owner | 25 | A mobile or WhatsApp number (16), verified facts, owner-run rather than a branch |

Unverified facts (×0.6), an existing agency (×0.5) and a Google Ads tag (×0.85) hold it back.
**Review queue → Close this week** lists everything at 50+ with a dialable number, biggest first,
with the opening line under each name and the package that answers its gaps. It never qualifies
anything - the gates above still decide what reaches a board.

## The app pitch: schools and coaching classes with no app

Schools, colleges, coaching classes (including JEE/NEET/UPSC/MPSC coaching) and preschools run on
WhatsApp groups: notes, test results, fee reminders and circulars all go out there. An app with
the institute's name on it is a sale in itself, so every lead in those categories gets an **app
check**, and **Review queue → App pitch** lists the ones that have none, ranked by deal readiness,
with the line to open with and the **Institute App** package priced next to it.

News channels, newspapers, news agencies and portals (**Media house / news channel**, **News agency
/ digital news portal**) get the same check. Tanz built a news app and newsroom admin for a news
channel; a news house without an app raises the `no_news_app` gap, which only the **Newsroom App**
package answers, so a channel is never priced the school app or the other way round. National and
state media groups (Times, Lokmat, Sakal, ABP, Zee, TV9...) are excluded as chains: their Pune
offices are bureaus. Sweep them with the **News and media (app pitch)** preset.

"You have no app" said to an owner who has one ends the call, so `no_app` is the hardest verdict
to earn. Three looks, cheapest first:

| Look | How | Cost |
|---|---|---|
| Their own site | Play and App Store links, smart banners, app-link meta, deep links, and the `/.well-known/assetlinks.json` and `apple-app-site-association` files a domain publishes for its own apps. WhatsApp, Zoom, Google Classroom, DigiLocker and payment apps are ignored | Free (read off the website audit) |
| The App Store | Apple's public search API. Their app when the seller website is their domain | Free, no key |
| Google Play | No search API exists, so the AI provider's web search, with the searches spelt out. An app counts only if its store id appears in a page the search returned | One web search, ~15-20s |

| Verdict | Means |
|---|---|
| `no_app` | Their site, a Google Play search that actually ran, and the App Store all came back empty |
| `unclear` | A same-name app from another city, a site that says "download our app" and links none, or a course platform (Classplus, Graphy, Teachmint...) that ships apps. A person looks before anyone pitches |
| `has_app` | Linked from their site, vouched for by their domain, or found and cited by the search |
| `white_label` | Theirs, but rented: a Classplus-style package (`co.amy.qsrjk`) or a school ERP app. An upgrade pitch, not a first app |

A failed or lazy search (the model answered without searching an app store) settles nothing: the
lead stays unchecked and the job retries. A rep's "I checked - no app" or "They have an app" in the
lead drawer is final; later checks refresh the evidence but never overwrite it. A confirmed
`no_app` adds 4 points to the digital gap for these categories only, and the drafts are told the
app status, with the same rule: unknown is never "they have no app".

Checks run on their own after a sweep that includes these categories (`APP_CHECK_ON_DISCOVERY`,
capped by `APP_CHECK_MAX_PER_RUN`), queued behind the site audits so they read a fresh one. **Check
for apps** in the App pitch queue does the rest, or a selection. The **Schools and coaching (app
pitch)** preset in Discovery sweeps the five education categories. `/review?queue=apps` opens the
list directly.

## Who is never a prospect

Some businesses score beautifully and will never sign, so they are excluded before scoring, each
with a reason a person can read and overrule in one click (the override sticks):

- **Chain and franchise outlets** - Tanishq, Lakmé, Gold's Gym, Metropolis, Marriott, bank branches.
  Matched within their own industry, so "Aurelia Mansion" (a banquet hall) is not the clothing brand
  and "Kotak Dental" is not the bank. OpenStreetMap's brand tags catch the rest.
- **Government and public bodies** - municipal schools, BMC/PCMC dispensaries, police and railway
  hospitals, anything on a `.gov.in` or `.nic.in` site.
- **Placeholder listings** - "XYZ", "Clinic", nameless map features.
- **Duplicates** and **out-of-area** results (Maps answers "near" generously).

A lead a rep is already working is never pulled off their board by a rule change: it stays, and the
concern travels with it as a warning.

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
| `maps` | Looked up, not recalled | Google Maps through Gemini's Maps grounding: rating, review count, phone, website and place id for real listings. Picked automatically when a Gemini key is set and Places is not. Needs a working Google AI Studio key - checked with Google at boot. |
| `osm` | **Real, free, default** | OpenStreetMap via Overpass. Businesses a contributor physically surveyed, with coordinates. No key, no quota. ~130 businesses per 3km sweep, roughly 20% carry a phone. No ratings — that's Google's data — so leads land at `verified` and need a review count before they qualify. |
| `gemini` | **Unverified** | Model recall. Lands every lead in `discovered`. No phone is ever produced. Opt in explicitly. |
| `mock` | Synthetic | For working on the UI. |

OpenStreetMap tags are broad - `healthcare=clinic` is every clinic in the city - so each result is
sorted into the right category from its name and specialist tags. A general clinic found while
sweeping "cosmetic surgery" is a polyclinic, and is left out if you did not ask for polyclinics.

### How fast a Maps sweep is, and why

Each category is a few differently-worded Maps searches ("jewellery store", "independent or
family-run jewellery store", "well established jewellery store"), and they now run side by side,
two categories at a time, under one limiter for every Maps call (`MAPS_CONCURRENCY`,
`DISCOVERY_CATEGORY_CONCURRENCY`). On gemini-3.x flash the calls run at `minimal` thinking
(`MAPS_THINKING_LEVEL`): at the default level one call took 45-70s and 6-8k thought tokens; at
minimal it takes about 17s with none, and the businesses both settings found carried identical
ratings, review counts, phones and place ids. A real 3-category sweep of Kothrud took 57s and found
125 businesses; the same sweep run one search at a time used to take around ten minutes.

The server log follows every sweep - a line per category with what it found, added and skipped, and
a summary at the end - and the worker reports what it got through every 30 seconds. A key Google
refuses, a missing model or the day's quota running out stops the sweep at once with Google's own
reason, instead of being swallowed category by category. The key is also checked at boot, and a
refused one shows on the source card, in Settings and in the log.

Maps hands back a listing id in one of three shapes - a place id, a feature id (`0x…:0x…`) or a
bare CID - and every lead gets a link that opens its listing directly. The same name at the same
street address is treated as one shop even when two searches return it under two ids.

Maps answers carry an address but no coordinates. A lead is placed on the map only when OpenStreetMap
finds the building or the business itself under its own name; a street or a suburb is an area, not a
location, and an address it cannot read stays unplaced. (The geocoder used to fall back to the area
picker's offline list, which put every unreadable address on Aundh - and the out-of-area check then
excluded real Kothrud clinics as 5.7 km away. Cleanup repairs leads that were hit.)

### Google Maps lookup

Directory leads have no review count, which is the whole demand score. After an OpenStreetMap
sweep each new lead is looked up on Google Maps (T1 first, capped by `MAPS_ENRICH_MAX_PER_RUN`) for
its reviews, rating, phone, website, place id and trading status. The answer is graded: a clear
match is written with its provenance, a near-match is offered to a person as one-click candidates,
anything else is ignored. **Look up Google reviews** in the review queue does the same for existing
leads. Google-sourced fields are looked up again after 30 days, which is what Google's terms ask.

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

## The website audit

Plain HTTP, no headless browser. It tries the URL as stored, then with and without `www`, then over
plain http - many small-business domains only answer on one of them - and tells three failures apart:
**broken** (domain expired, server error, 404), **protected** (a firewall or free-host check blocks
automated visits: never called broken, never claimed about), and **parked** (for sale, suspended
hosting, an unconfigured server). On a live site it reads:

- **Measurement** - Google Analytics 4, Tag Manager, Meta pixel, Google Ads tag, dead Universal Analytics
- **Ways to enquire** - WhatsApp button, click-to-call, form, booking, live chat, shop
- **Search basics** - `noindex`, meta description, local business schema, share previews
- **Health** - SSL certificate validity, mobile viewport *and* responsive CSS, outdated tech (Flash,
  jQuery 1.x, WordPress 5, 1990s markup), copyright year, thin content (script text is not content)
- **Contacts on their own site** - phone and WhatsApp numbers (written to the lead when it has none),
  emails including Cloudflare-hidden ones, the real social handles (share buttons and reel links ignored)
- **Who built it** - "Designed by …" footer credits

With `PAGESPEED_API_KEY`, Google's own mobile performance and SEO scores and load time come with it.

## Instagram and the rest of social

Instagram numbers come from Instagram's own **Business Discovery API** - followers, post count, last
post and engagement for any public business or creator account, looked up through your agency's
Instagram business account. No scraping. Set `META_GRAPH_TOKEN` (a long-lived token with
`instagram_basic` and `pages_read_engagement`) and `INSTAGRAM_BUSINESS_ID`. A count is written only
when the account demonstrably belongs to the business (its handle is on their site, it links back to
their site, or it carries their name); otherwise it is a candidate a person accepts. A personal
account reads as unknown, never as "no Instagram".

Without a Meta token, **Find social presence** searches Google (grounded, on `LLM_MODEL_SEARCH`) for
the Instagram handle and the Facebook and LinkedIn pages. What it is trusted with was measured: a
model that did not actually search still answered, with a confident handle and an invented "last
post" date, and across a dozen real searches no follower count came back at all. So:

- nothing is written unless the search ran (it gets two tries), and the result says when it did not;
- a handle is written when it reads as the business's name, otherwise it waits as a candidate;
- follower counts and post dates need a cited Instagram page *and* an account known to be theirs
  (handle off their own site, entered by a person, or confirmed by Meta); otherwise candidates;
- a dormant account found this way is flagged for the rep to check before saying it to the owner.

Search runs by itself only for tier A and B leads after their site audit, once a fortnight at most;
the bulk button queues the rest, best prospects first, never twice.

The dependable route to the numbers without Meta is a person: the lead's **Details → Social media**
card has a **Find on Google** link, and pasting the line Google shows under the profile
(`1,234 Followers, 56 Following, 78 Posts - … (@handle)`) saves handle, followers and posts as the
rep's own, with an optional last-post date. Ten seconds a lead.

LinkedIn followers and "are they running ads" still have no API for this. They stay **fields in the
rep's ten-minute audit**. Anything a human types beats anything fetched, and the score updates on save.

## Data cleanup

`services/maintenance.js` keeps the table worth trusting. It runs on its own every
`MAINTENANCE_INTERVAL_HOURS` (first run a minute after boot), and from **Settings → System → Data
cleanup** or the command line:

```bash
npm run cleanup               # preview: the full report, nothing written
npm run cleanup -- --apply    # do it
```

| Step | What it does |
|---|---|
| Normalise | Phones read in the right country (`020 2563 6999` is `+912025636999`, not Egypt) and typed mobile/landline/invalid; websites, emails, Instagram handles and localities cleaned; dedupe keys rebuilt for every script; coordinates that came off the area picker's offline list (where the old geocoder put every address it could not read) removed, with the "out of area" exclusions they caused |
| Reclassify | Directory leads filed under the wrong category moved to the right one |
| Exclude | Chains, government bodies and placeholder listings marked, with reasons |
| Merge | The same business entered twice becomes one: activities, AI history and proposals move to the survivor, which inherits every field it was missing. Never two pipeline leads |
| Housekeep | Finished jobs (7 days), failed jobs (30), usage rows (400), AI drafts nobody acted on (45 - accepted, edited and rejected ones are the eval set and are kept), empty sweeps, stuck sweeps, rejected leads nobody worked (60), stale candidates, raw do-not-contact numbers |
| Rescore | Everything, then `VACUUM (ANALYZE)` |

Merged and purged leads leave their keys in `lead_suppressions`, so the next sweep cannot quietly
bring them back, and every run's full report is kept in `maintenance_runs`. A second run straight
after the first changes nothing.

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
4. Paste `.env.example` into the env editor and fill in the keys. The app boots and seeds itself
   with an empty file, but set one LLM key: with none, `activeProvider()` falls back to Ollama at
   `127.0.0.1:11434`, which is not in this image, and every AI call fails. `LLM_PROVIDER=gemini`
   with a blank `GEMINI_API_KEY` is the honest way to get mock AI. Discovery needs no key —
   without one it uses OSM or mock per `DISCOVERY_SOURCE`.
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
  migrations/          init · rls · confidence_and_lifecycle · external_id · … · lead_quality
  seeds/01_tanz.js     62 services from the service profile deck, 6 packages
  scripts/cleanup.js   the data cleanup, from the command line
  src/lib/             scoring · confidence · deal · classify · categories(75) · places · osm
                       mapsDiscovery · instagram · geminiDiscovery · llm · prompts · websiteAudit
                       appPresence
                       queue · wa · geo(nominatim) · util
  src/services/        discovery · enrichment · appCheck · maintenance · lifecycle · leads · ai
  src/routes/          meta · discovery · leads · ai · analytics · settings
web/src/pages/         Board · Review · Discovery · Analytics · Settings
```

`npm test` in `server/` runs 197 tests: scoring and confidence, including hand-labelled fixtures
(Narenkumar, Mauli Garden, Tangent) that must always rank tier A - if a weight change breaks them,
the weight change is wrong until closed-won data proves otherwise - plus phone parsing, exclusions,
category sorting, the website auditor against a fake network, the Maps and Instagram lookups, the
hot-list ranking and the merge rules.

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
