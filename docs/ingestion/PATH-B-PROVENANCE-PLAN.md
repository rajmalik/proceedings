# Provenance Plan: Backend Ingestion Path B + Client Platform Capture

**Status**: PLANNING — for review. **No code implemented yet.**
**Context**: [`MANUAL-CURATION-PLAYBOOK.md`](MANUAL-CURATION-PLAYBOOK.md) first
identified the Path A/B gap when the curation scripts in `scripts/curation/`
were built. Every publish since then — `i485-approved`,
`i485-asylum-approved`, `h1b-cos-timeline`, etc. — has gone through Path A,
meaning none of it currently carries accurate provenance. This doc covers
two related gaps: (1) Path B — distinguishing backend-ingested content from
real user submissions, and (2) client platform capture — distinguishing
*which* real client (website, iOS app, Android app) a genuine user
submission came from, since that's currently unrecorded too.

## The problem, confirmed

Investigated what actually gets recorded today: **there is zero distinguishing
signal between a webapp submission, a mobile-app submission, and our backend
curation scripts.** All three call the same `/api/postings` route, which
hardcodes every provenance field regardless of caller:

| Field | Current value (always, regardless of source) |
|---|---|
| `channel` | `"app"` |
| `ingestion_method` | `"user_post"` |
| `source_system` | `"meridianjourney"` |
| `subreddit` / `reddit_post_id` | `""` (empty) |
| `full_url` | `{APP_BASE_URL}/case/{case_id}` (fabricated, not a real Reddit permalink) |
| `posting_date` | `datetime.now()` at publish time — today's date, not the original Reddit post's date |

Every post curated and published this session is sitting in GCS, BigQuery,
and the search index indistinguishable from an organic first-party
submission.

## Field design

No new schema fields — the canonical schema is already channel-agnostic
(`subreddit`/`reddit_post_id` have existed since the original design, per
D-036) and just needs to actually be populated correctly. Two existing
fields' *meanings* get clarified and separated rather than changed:

| Field | Meaning (clarified) | App/webapp/mobile | Backend pipeline (Reddit) |
|---|---|---|---|
| `channel` | Coarse pathway, drives search boost (`search_client.py` already has an unused `channel:"reddit"` boost wired in) | `"app"` | `"reddit"` |
| `ingestion_method` | How the content entered our system | `"user_post"` (unchanged; also `"user_experience"`/`"user_connect_card"` for phase-J, unchanged) | `"manual_curation"` — reserving `"automated_scrape"` and `"official_api"` as future values once those paths exist (Apify / licensed API, per `REDDIT-INGESTION-ALTERNATIVES.md`) |
| `source_system` | Platform-level provenance identity (this is the field's original D-055 design intent — just never applied to non-app content until now) | `"meridianjourney"` | `"reddit"` |
| `subreddit`, `reddit_post_id`, `full_url` | Real source-platform identifiers | empty / app-derived (unchanged) | real subreddit name, real post ID, real `reddit.com` permalink |
| `posting_date` | **The original posting date** — what a reader sees as "posted on" | `now()` (unchanged — for a live submission, posting *is* the ingestion moment, so this is already correct) | the **true original Reddit post date**, not today |
| `ingestion_timestamp` | **When *our* system processed it** — unrelated to when the content was originally authored | `now()` (unchanged) | `now()` (unchanged — this is correctly "when we ingested it," and should stay `now` even for backdated Reddit content) |

`channel` + `ingestion_method` together fully distinguish all three
sources. `source_system` + `subreddit` + `reddit_post_id` + `full_url`
together identify the specific backend source precisely. `posting_date`
(original) vs. `ingestion_timestamp` (ours) are cleanly separated using
fields that already exist today but are currently both hardcoded to `now`.

## Why this needs a new, non-public code path — not new params on `/api/postings`

`/api/postings` is hit by real, unauthenticated end-users (webapp + mobile).
If `channel`, `posting_date`, `source_system`, etc. were exposed as request
parameters there, **any user could claim their post is from Reddit, or
backdate it** — a real integrity problem for a product whose value depends on
grounded, honest content. Path B must be a separate path a normal user
request can never reach, not a new field on the public route.

## Implementation plan (not yet built)

1. **Extend `build_canonical()`** (`backend/posting.py`) with optional
   override parameters — `channel`, `ingestion_method`, `source_system`,
   `subreddit`, `reddit_post_id`, `full_url`, `posting_date`. Each defaults
   to today's hardcoded value, so `/api/postings`'s existing behavior is
   unchanged when it doesn't pass them — this is an additive, backward-
   compatible signature change, not a rewrite.
2. **Add `publish_reddit_posting()`** to `posting.py` — mirrors
   `publish_posting()`'s orchestration (build canonical → `validate()` →
   `_write_gcs()` → `_import_to_datastore()` → `_write_bigquery()`) but
   threads the real Reddit metadata through. **Not wired to any FastAPI
   route** — callable only from a script, per the security reasoning above.
3. **New script** (Python, not bash+curl like the current
   `scripts/curation/*.sh` — needs direct access to `posting.py` internals
   and real GCP credentials, same pattern as running
   `backend/tests/test_posting_tagging.py` locally with ADC). Reads a
   curated post + its reviewed tags + the real subreddit/`reddit_post_id`/
   date — which `scripts/curation/reddit-export.py` already captures when
   it's usable, or which a manual curator supplies by hand otherwise — and
   calls `publish_reddit_posting()` directly.

## Open questions

**Backfill (Path B)**: everything published so far this session currently
has `channel="app"`, `ingestion_method="user_post"`, and today's date as
`posting_date` — all incorrect once Path B exists. Two options, **not
decided yet**:
- **Backfill**: delete + republish each via Path B with correct provenance.
- **Leave as-is**: only apply Path B going forward; treat already-published
  content as a known, accepted inaccuracy from before this fix existed.

**Scope of `client_platform` (device capture)**, also **not decided yet**:
- Should mobile-web (a phone's browser hitting the website) be distinguished
  from desktop-web, or is `"web"` as one value sufficient? Doing so would
  need User-Agent sniffing server-side rather than a value the client just
  states outright, a meaningfully different (and less reliable) mechanism
  than `Platform.OS` on mobile — recommend starting with flat `"web"` and
  only adding this if there's a real reason to need it.
- Is OS/platform type (`web`/`ios`/`android`) sufficient, or is richer
  device metadata wanted now too (app version, OS version, device model)?
  The request as given ("kind of mobile device (iOS/Android) etc.") is
  satisfied by the 3-value enum above; richer metadata is a bigger, separate
  scope (more fields, more client-side plumbing) that should be an explicit
  ask, not assumed in.
- Should `client_platform` become a **required** field once both clients
  are updated to send it (rejecting publishes that omit it), or stay
  permanently optional/best-effort? Recommend optional indefinitely — it's
  an analytics field, and hard-requiring it risks breaking publishes if a
  client update ever lags a backend deploy.

## Client platform (device type) capture

**Confirmed**: zero platform information is captured anywhere today, for
either client. `channel="app"` doesn't even distinguish website from mobile
app, let alone iOS from Android within mobile — `/api/postings`'s route
handler doesn't read any header or field that would tell them apart.

### Field design

One new field, `client_platform`, values `"web"` | `"ios"` | `"android"` |
`""` (empty for backend-ingested content — there's no device involved when
a human curator publishes Reddit content, so this stays blank for
`channel="reddit"` postings, same as `subreddit`/`reddit_post_id` already
default to blank for `channel="app"` postings today).

This is deliberately a **separate field from `channel`**, not folded into
it — `channel` is documented as "the controlled pathway token the search
boost/filters key on" (a small, coarse enum meaningful for search
relevance). Device type isn't a search-relevance signal; it's an analytics/
provenance dimension. Mixing them would blow up `channel`'s enum with
values that don't belong in a search boost.

### Why this can go through the public API (unlike `channel`/`posting_date`)

Path B's fields above need a non-public code path because a user lying
about them is a **content-integrity** problem — claiming fake Reddit
provenance or backdating a post misleads readers about the content itself.
A user's device type has no such stakes: at worst, someone spoofs `"ios"`
on Android, which pollutes analytics but never misrepresents the *content*.
So `client_platform` can simply be a new optional field on the existing
`PostingCreateRequest` (`backend/api.py`) and threaded through
`build_canonical()` as a normal parameter — no separate script, no new
non-public function needed for this one.

### How each client determines its own value

- **Mobile** (`mobile/src/screens/PostScreen.tsx`): `Platform` from
  `react-native` is **already imported** in this exact file (currently only
  used for a `KeyboardAvoidingView` behavior tweak) — send `Platform.OS`
  (`"ios"` | `"android"`) with the publish request. No new dependency.
- **Website** (`website/src/app/post/page.tsx`): always `"web"` — a static
  value, no runtime detection needed.

### Mobile rollout timeline reality

Landing the mobile code change (`apiService.ts`/`PostScreen.tsx` sending
`Platform.OS`) is **not** the same as mobile users actually sending
`client_platform`. Unlike the backend and website — both Cloud Run, live the
moment a deploy is approved — mobile has to clear a full
**EAS Build → App Store / Play Store review → user update** cycle before any
installed device runs the new code, and none of those steps are instant or
guaranteed:
- App Store/Play Store review is typically days, not minutes.
- Store review can reject a build, adding another round trip.
- Even once approved, updates are not force-installed — a real cohort of
  users stays on old binaries indefinitely (auto-update disabled, app
  rarely opened, etc.).

At the time of this plan, the mobile app is still at **v1.0.0 with no
release since [PR #35](https://github.com/krishmalikk/proceedings/pull/35)**
— so this specific change doesn't reach a single real device until whenever
the next mobile release is actually cut and approved, a step that is
separate from and later than this PR merging.

**Current status**: backend and website are being deployed together now.
The **mobile v1.0.0 build in the stores still does not send
`client_platform`** — the code change is merged but not yet in a released
build — so mobile-originated postings will show `client_platform: ""` until
the next mobile release ships this. This is expected and intentional, not a
bug: backend/website did not need to wait on mobile, per the no-hard-
dependency reasoning above (`PostingCreateRequest` has no `extra="forbid"`
and the field defaults to `""`, so old and new clients interoperate with any
backend version in either direction). The next mobile release is what
actually turns this field on for mobile traffic.

Practical consequence: **`client_platform` should be expected to arrive at
`""` (empty) for a meaningful share of mobile-originated postings
indefinitely**, not just during a short rollout window — every user who
never updates past the pre-this-change build contributes to that
indefinitely, the same way any mobile feature's adoption has a long tail.
This isn't a bug to fix later; it's a structural property of mobile
distribution that this feature (and any future mobile-only field) has to be
designed to tolerate. It's part of why `client_platform` is optional/
best-effort rather than required (see the "required?" open question above)
— and it means "done" for this feature, on the mobile side specifically,
means "shipped in the next mobile release," not "every mobile posting has
this field populated."

### Backend changes

1. `PostingCreateRequest` (`backend/api.py`): new optional field
   `client_platform: str = ""`.
2. Server-side validation: check against the allowlist
   (`{"web", "ios", "android"}`); anything else (garbage, typos, a future
   client sending something unexpected) stores as `""` rather than erroring
   — this is a soft analytics field, not something that should ever block a
   publish.
3. `build_canonical()`: new `client_platform: str = ""` parameter, added to
   the canonical dict alongside the Path B fields.
4. `_BQ_SCHEMA_FIELDS`: add `("client_platform", "STRING")`.
5. `publish_reddit_posting()` (Path B, above): simply never passes this
   parameter — it defaults to `""`, correctly representing "no client
   device involved."

## Testing plan (once implementation is approved)

Same pattern as the last four fixes in this repo (`timeline`, visa-backfill,
`family-based-immigration`, cross-bucket-duplicate): unit tests against
`build_canonical()`'s new optional parameters directly (no network needed),
confirming (a) omitting the new params reproduces today's exact behavior
byte-for-byte, (b) passing them produces the correct overridden values, and
(c) `validate()` still behaves correctly against Reddit-shaped canonical
docs. A live smoke-test publish + cleanup (mirroring test group G) once
merged and deployed. `client_platform`'s allowlist-clamping behavior
(garbage values → `""`, not an error) needs its own explicit test case
given it's the one new field with public-API-facing input validation.

## Non-goals for this plan

- Does not change anything about the legal/access-method questions already
  covered in `REDDIT-INGESTION-ALTERNATIVES.md` and
  `APIFY-SCRAPER-LEGAL-AND-INTEGRATION.md` — this is purely about correctly
  recording provenance for whatever content legitimately gets published,
  regardless of how it was sourced.
- Does not add authentication/authorization infrastructure — "non-public"
  here means "not reachable via any HTTP route a normal user's browser or
  app can hit," achieved simply by not exposing it as an API endpoint, not
  by adding a new auth layer.
