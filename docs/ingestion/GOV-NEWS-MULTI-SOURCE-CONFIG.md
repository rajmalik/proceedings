# Gov-News Multi-Source Config — Firestore-Backed Registry

**Status:** Implemented.
**Depends on:** [`GOV-NEWS-INGESTION-PLAN.md`](GOV-NEWS-INGESTION-PLAN.md) (the original single-source USCIS design, §4 of which already anticipated a config-driven registry — this doc replaces that registry's storage mechanism, not its shape).

> **Why this doc exists.** Explicit request: add a second source
> (`travel.state.gov`), and make the source registry scalable so that
> adding a future source is a **config change, not a code change or a
> deploy** — picked up automatically the next time the scheduled poll runs.
> `travel.state.gov` itself turned out not to be addable this round (§3) —
> this doc covers the framework built to make the *next* addable source
> trivial, which was the larger and more durable part of the request.

---

## 0. Current sources scanned by the recurring job

The Cloud Scheduler job **`gov-news-poll-uscis`** (`0 6 * * *`
America/New_York, `POST /internal/gov-news/poll`, no `source` param —
confirmed directly against the live job's config, `state: ENABLED`) polls
**every source in the Firestore `news_sources` registry that passes both
safety gates** (§5.1: `content_license="public_domain"` AND
`content_type="news"`), read fresh from Firestore at the start of every
run.

**As of 2026-07-26, that is exactly one source:**

| Slug | Display name | Site | Fetch | Registered/enabled |
|---|---|---|---|---|
| `uscis` | USCIS | uscis.gov | RSS | Yes |

**Not scanned by this job — deliberately, not omissions:**

- **`travel.state.gov`** — evaluated (§3), never implemented. No dedicated
  RSS feed exists; the site blocks plain HTTP clients (Cloudflare 403).
  Not registered in `news_sources`.
- **`immihelp.com/experiences/`** — evaluated and ingested, but via a
  **one-time manual seed**, not this job — see
  [`IMMIHELP-SEED-PLAN.md`](IMMIHELP-SEED-PLAN.md) §1. immihelp's Terms of
  Use don't grant a license for automated recurring reproduction, so it is
  **never** registered here and **never** touched by Cloud Scheduler, by
  design — not a gap to close later without a licensing agreement.
- **`reddit.com/r/h1b`** — evaluated
  ([`REDDIT-INGESTION-ALTERNATIVES.md`](REDDIT-INGESTION-ALTERNATIVES.md)).
  Automated access is confirmed blocked by Reddit's bot detection (tested
  from both cloud and residential IPs, both 403); circumventing it was
  explicitly ruled out. Not registered, not pursued further for now.

**This table will go stale — the registry won't.** Sources are added via
Firestore (§2), not code, so this list can change with zero doc update.
Get the ground-truth current list at any time:

```bash
manage_news_sources.py list                 # everything registered, enabled or not, with reasons
```

or, for exactly what the *next* scheduled run will actually poll (the
two-gate-passing subset):

```bash
cd backend && ../.venv/bin/python -c "from dotenv import load_dotenv; load_dotenv(); from news_sources import get_enabled_sources as g; print(list(g()))"
```

## 1. What changed and why

The original registry (`backend/news_sources.py`) was a hardcoded Python
dict, baked into the deployed Docker image. Adding a source meant editing
code and running `gcloud run deploy` — exactly what this request asked to
eliminate.

**New design:** sources live in a **Firestore collection** (`news_sources`,
one document per source, document id = slug), not in code.
`gov_news_poll.py`'s `poll_all()` calls
`news_sources.get_enabled_sources()` **fresh at the start of every run** —
no caching, no restart required. A source added via the new management CLI
(§2) is picked up by the very next poll, scheduled or manual, with zero
code change and zero deploy.

Firestore was chosen over a GCS JSON config file because:
- This project already uses Firestore for exactly this kind of small,
  structured, frequently-read-rarely-written config-like data (user
  profiles, moderation flags), so it's the established idiom here, not a
  new dependency.
- Firestore access here is always server-side (`google-cloud-firestore`,
  ADC/service-account) — Firestore Security Rules only govern client-SDK
  access, so this collection needs no rule changes and is not reachable
  from the website/mobile app in any way.
- Per-source documents mean adding/editing one source is a small, atomic
  write — no read-modify-write race on a shared blob the way a single JSON
  file would have.

## 2. The management CLI — how a source actually gets added

`scripts/curation/manage_news_sources.py`. This is the literal answer to
"only by adding a website URL to config" — a human runs one command, no
code touched:

```bash
manage_news_sources.py add dol \
  --display-name "Department of Labor" \
  --site-url https://www.dol.gov \
  --feed-url https://www.dol.gov/some/rss/feed.xml \
  --content-license public_domain --source-category government

manage_news_sources.py list      # see all sources + their live status
manage_news_sources.py show dol  # full config for one source
manage_news_sources.py disable dol   # stop polling, config preserved
manage_news_sources.py enable dol
manage_news_sources.py remove dol --confirm   # permanent delete
```

**`--content-license` and `--source-category` are required, no default —
deliberately.** This is the safety gate carried over from
[`GOV-NEWS-INGESTION-PLAN.md` §4.2](GOV-NEWS-INGESTION-PLAN.md): a federal
government source is public domain (17 U.S.C. § 105) and safe to store
verbatim; a law-firm or other non-federal source is ordinarily copyrighted
and needs the Reddit-style paraphrase posture (D-017) — which this pipeline
does **not** implement. Making these flags required, with no default,
forces a conscious choice on every `add`, rather than silently defaulting
to "safe" and letting someone add an unvetted source without thinking
about the license question at all.

`news_sources.get_enabled_sources()` enforces this at read time, not just
at add time: a source is excluded from every poll run — logged loudly, not
silently — unless `content_license == "public_domain"` *and* `enabled` is
not `False` *and* every required field is present. A `copyrighted` source
can be added (stored, visible in `list`/`show`) but will never actually be
polled until the paraphrase/review posture that license needs is built —
config alone can't accidentally turn on unsafe automation.

## 3. `travel.state.gov` — full options evaluation

First pass (above, in the original PR) found no RSS feed and a Cloudflare
block, and stopped there per explicit direction. Follow-up request: fully
evaluate *how* this could be ingested, not just confirm the USCIS approach
doesn't transfer. Checked several additional angles directly (browser +
plain HTTP + web search) before writing this up.

### 3.1 Confirmed facts

- **No RSS feed for "U.S. Visas News."** The only feed on
  `travel.state.gov` (`_res/rss/TAsTWs.xml`) is **Travel Advisories**
  content (per-country warnings), fetched and inspected directly —
  unrelated to visa-process news.
- **The main `state.gov` domain has its own, richer RSS set** (Press
  Releases, Department Press Briefings, Collected Department Releases,
  regional feeds — found via `state.gov/rss-feeds`), but **none specific
  to visa/consular news** either. "Press Releases" is department-wide and
  would need additional relevance-filtering to extract just the
  visa-related subset — noisier and less precise than a dedicated feed,
  and (next point) **also blocked** the same way.
- **Both domains block plain HTTP clients sitewide** — not just the one
  news page. `travel.state.gov` returns an explicit Cloudflare
  `403 Attention Required`. `state.gov` is arguably worse: it returns
  **`200 OK` with a generic "Technical Difficulties" HTML page** for
  *every* path tested, including its own RSS feed URLs and `robots.txt` —
  a silent failure mode, not a clear error code, that any polling script
  would need to explicitly detect (content-type / title sniffing) rather
  than trust the status code.
- **No `robots.txt` file exists on `travel.state.gov` at all** — confirmed
  via a real browser reaching the actual origin (a genuine `404`, "Last
  Updated: December 31, 2024," not a block page). This matters: there is
  no explicit machine-readable "don't crawl this" policy here, unlike
  Reddit's case (explicit ToS language, lawsuits against scrapers, *and*
  its own bot-fingerprint blocking, layered together). What's here is
  generic bot-mitigation (Cloudflare on one domain, a different WAF-style
  block on the other) — evidently a department-wide security posture
  applied uniformly, not a targeted "no bots on this content" signal.
- **A real browser passes both domains' challenges automatically**, in a
  few seconds, with no special handling — used throughout this
  evaluation. This is a JS-capable-client check, not a
  CAPTCHA/human-verification step.
- **No official API.** Searched for a State Department developer
  portal/API — found only **archived** snapshots
  (`2009-2017.state.gov/developer`, `2017-2021.state.gov/developer`) in
  search results. Checked the live URL directly via browser:
  `state.gov/developer` → **"Page not found."** The public API program
  appears to have been discontinued; nothing current exists to check
  against.

### 3.2 Options

**A. Headless browser automation** (e.g. Playwright driving real Chromium,
letting the Cloudflare/WAF challenge resolve the way any real browser's
would — not fingerprint spoofing or header mimicry).
- Legal/access posture is genuinely better here than it first looked, and
  better than the Reddit case: public-domain content, no `robots.txt`
  disallow, and the technique itself (running an actual browser engine) is
  less aggressive than what this project already ruled out for Reddit
  (spoofing signals from a fake client). Still not zero-risk — it's
  automated access to a site with *some* generic bot-mitigation in place —
  but a materially different, lower-risk category than Reddit's case.
- Real engineering cost, though: a new dependency (Playwright + a Chromium
  binary, ~300 MB), a new `fetch_method` adapter (HTML scraping of the
  listing page, not a stable feed contract — page markup can change
  without notice, unlike RSS), and more Cloud Run resources / slower
  per-request time than anything built so far. The once/day cadence and
  low item volume (§3.3) make the *operational* cost tolerable; the
  *engineering* cost (new adapter class, new failure modes to handle) is
  the real ask here.

**B. Manual curation** (mirrors this project's own established pattern —
`scripts/curation/publish_reddit.py` for Reddit, or Path B's reasoning
generally): a human periodically reads the page in a real browser and
publishes via `posting.publish_gov_news_item()` directly (a tiny one-off
script, or even by hand with the CLI plumbing that already exists).
- Zero legal/technical risk — a human reading a public government webpage
  is unambiguously fine, same as reading any public page. Zero new
  engineering: the publish path is already built and tested.
- Doesn't satisfy "fully automatic," but given the update cadence
  observed on this page (roughly a handful of items per month, based on
  the dates visible when this was checked), the manual burden is genuinely
  small — a few minutes, a few times a month.

**C. Wait for / enable DS-2** (this project's own already-decided,
unbuilt, Google-crawled public-website grounding tier, D-039) — would
likely cover `travel.state.gov` content for free once turned on
(`GCP_VERTEX_PUBLIC_ENGINE_ID` is currently unset/off), since Google's own
crawler isn't subject to the same generic bot-mitigation a home-grown
script hits. **Does not substitute for this feature**, though — DS-2 only
feeds the QA/grounding surface ("ask a question"), not a structured
News-tab item with its own reply thread, which is what this pipeline
exists to produce. Worth knowing about as a complementary, zero-scraper
path for the *grounding* use case specifically, not a replacement for
ingestion here.

**D. Official API** — confirmed not to exist (§3.1). Not a live option.

### 3.3 Recommendation

Given the apparently low update volume on this specific page, **Option B
(manual curation) is the pragmatic default** — it can be live essentially
immediately, at zero technical/legal risk, using infrastructure that
already exists. **Option A (headless browser automation)** is a real,
buildable path with a defensible risk posture if full automation for this
specific source is a priority worth the new engineering surface — should
be scoped as its own decision (new adapter type, new dependency,
Cloud Run resourcing) rather than folded into this framework PR.

**No decision made here — flagging both live options for an explicit
choice, not picking one.**

## 4. Adding a new website — full runbook

For any **federal-government source with a real RSS feed for the specific
content wanted** (the one fully-automated shape today — a `forum_posting`
source follows a different, manual-publish path; see §5).

### 4.1 Step 1 — Vet the source directly (never assume it transfers)

Do the same §1/§2-style check `GOV-NEWS-INGESTION-PLAN.md` did for USCIS,
and this doc did for `travel.state.gov` (§3) — every source gets this,
because the answer genuinely varies (USCIS: yes; `travel.state.gov`: no):

1. **Does an RSS feed exist for the *specific* content wanted?** Not just
   "does the site have RSS somewhere" — `travel.state.gov` has one, but for
   unrelated content (§3.1). Find the feed, fetch it directly, and read a
   few real `<item>`s to confirm it's actually the content you want.
2. **Is plain HTTP access viable?** `requests.get()` the feed URL directly.
   If it works, you're most of the way there. If it 403s/blocks, check
   whether a *real browser* passes (Cloudflare-style JS challenges often
   do, automatically, after a few seconds) — that tells you whether this
   is even a same-shape problem as `travel.state.gov`'s, before assuming
   browser automation would be needed.
3. **Check `robots.txt`** (fetched directly, not assumed) — an explicit
   `Disallow` on the feed/content path is a different, harder "no" than
   generic bot-mitigation with no file-based policy at all (the
   distinction that mattered for `travel.state.gov`, §3.1).
4. **Confirm `content_license` independently** — is this a genuine federal
   agency (17 U.S.C. § 105, public domain)? Don't infer it from the domain
   name alone; state-level, quasi-governmental, and federally-adjacent
   entities don't all get the same treatment.
5. **Decide `content_type`** — "news" (official-site updates; the only
   type with an automated publish handler, §5) vs. `forum_posting` (not
   auto-published regardless of what else checks out).
6. **Decide `channel`** — share `"gov_news"` if this source's content and
   trust level are genuinely analogous to USCIS's, or use a distinct value
   if it warrants its own search-boost weighting later (see
   `GOV-NEWS-INGESTION-PLAN.md` §4.2 on why `channel` isn't shared blindly
   across categories).
7. **Note the feed's window size and this source's typical publish
   cadence** — needed for §6's incremental-vs-full-load reasoning below,
   and to catch a source where polling once/day genuinely risks missing
   items (§6.3).

### 4.2 Step 2 — Register it (config only, no code, no deploy)

```bash
manage_news_sources.py add dol \
  --display-name "Department of Labor" \
  --site-url https://www.dol.gov \
  --feed-url https://www.dol.gov/some/rss/feed.xml \
  --content-license public_domain --content-type news --source-category government \
  --disabled   # recommended: verify before this can be picked up live (see 4.3)
```

`--disabled` is optional but recommended for a first-time addition — it
lets you verify (next step) before the source is eligible to be picked up
by a scheduled run you don't control the timing of.

### 4.3 Step 3 — Verify before enabling

```bash
manage_news_sources.py show dol        # confirm the stored config looks right
poll_gov_news.py --source dol --dry-run   # confirms: feed parses, items classify as
                                           # expected (everything "new" on a first run,
                                           # not errors), without publishing anything
```

If the dry-run looks right, do one real (non-dry-run) run manually and
spot-check a few published items directly (GCS `.json`, or
`/api/search?facet=doc_kind:gov_news`) the way USCIS's launch was verified
— confirm `doc_kind`/`channel`/`content_license`-appropriate fields, real
dates, and correct tagging — **before** trusting it to the daily schedule
unattended.

### 4.4 Step 4 — Enable it

```bash
manage_news_sources.py enable dol
```

**No new Cloud Scheduler job needed.** The existing job
(`gov-news-poll-uscis` — the name is now a slight misnomer, a holdover
from when USCIS was the only source; it triggers `POST
/internal/gov-news/poll` with no `source` parameter, which polls *every*
enabled source, confirmed directly against the live job's configured
target) will pick up `dol` on its very next scheduled run. Nothing about
the schedule, the job, or the deployed code needs to change — this is the
entire point of the framework.

A source needing a different `fetch_method` (JSON API, or a site that
needs browser automation) is **not** a config-only addition — `add`
accepts the value but `poll_source()` still only has an adapter for
`"rss"`; anything else is stored and visible but skipped every run with a
clear reason (§2), until adapter code is actually written for that fetch
shape.

## 5. `content_type` — the registry supports two content types, not one

Explicit follow-up request: make sure this framework has room for both
**news updates from official sites** (USCIS, what's live today) and
**postings from forums like Reddit**, not just the former.

### 5.1 Why this is a second, independent gate — not folded into `content_license`

It's tempting to think `content_license` already covers this — Reddit
content is `copyrighted`, so it's already excluded from auto-polling. But
that conflates two different questions:

- `content_license` answers: **is this legally safe to store verbatim?**
- `content_type` answers: **does a publish handler that fits this
  content's risk profile even exist?**

These aren't the same question, and collapsing them would hide a real gap.
`publish_gov_news_item()` — the only automated publish handler that
exists — was built specifically for official/authoritative content: it
skips PII scrubbing and moderation checks (`posting.py`'s
`publish_gov_news_item()` docstring is explicit about this, matching
`publish_reddit_posting()`'s same reasoning), because a USCIS press
release has no PII risk and isn't user-generated. A forum posting is the
opposite on both counts — real PII risk, real moderation need — even
setting the copyright question aside entirely. A hypothetical future forum
source that somehow *was* public-domain licensed (unlikely, but the
registry shouldn't assume it can't exist) would still be wrong to run
through `publish_gov_news_item()`, because that handler was never built to
scrub PII or check moderation on the content it publishes. `content_type`
exists to catch exactly that case — independently of licensing.

### 5.2 What `content_type` does today

Two values, `news` and `forum_posting` (`news_sources.VALID_CONTENT_TYPES`).
`get_enabled_sources()` requires `content_type == "news"` in addition to
`content_license == "public_domain"` — **both** gates, not either. A
source can fail one, the other, or both; any failure excludes it from
automated polling, logged loudly with the specific reason (see the sample
output in §5.3).

`forum_posting` sources are **fully representable and storable** in this
same registry (`manage_news_sources.py add ... --content-type
forum_posting`) — that's the actual point of this field, a single source
of truth across both content types — but are **never auto-published**
through `gov_news_poll.py`. Publishing forum content stays exactly the
existing path it already was: `scripts/curation/publish_reddit.py`, a
human-curated script calling `posting.publish_reddit_posting()` directly.
Registering a subreddit as a `forum_posting` source here doesn't change
how it gets published — it changes where its provenance metadata
(display name, site URL, license, category) is recorded, so it's alongside
`news` sources in one registry instead of living only in a curator's head
or a hardcoded literal somewhere.

### 5.2a Tagging follows `content_type` too — explicitly, not just by construction

Explicit follow-up request: make sure `content_type` actually drives
*tagging*, so a forum/user-posting source is never tagged `news-update` —
that tag specifically means "official policy/news, not a personal status
claim" (§3.4 of `GOV-NEWS-INGESTION-PLAN.md`), which is exactly wrong for
a Reddit-style personal posting.

Before this, the guarantee was **implicit**: `news-update` is applied in
exactly one place in the whole codebase
(`posting.py`'s `publish_gov_news_item()`), and that function is only ever
*called* for a `content_type="news"` source, because
`get_enabled_sources()` already excludes anything else (§5.2 above). True
today, but it relied entirely on an upstream filter — nothing *inside*
`publish_gov_news_item()` itself checked the assumption it was built on.

Made **explicit**: `publish_gov_news_item()` now takes `content_type` as a
parameter (`gov_news_poll.py`'s `poll_source()` passes the resolved
source's actual registry value, not a hardcoded default), and the tagging
decision is a small, pure, unit-tested function
(`posting._gov_news_tags()`, `tests/test_posting_tagging.py` E43-E46):
`news-update` is added when `content_type == "news"`, and — deliberately
fails *closed*, not open — anything else, including an unrecognized value,
gets no `news-update` tag at all. A future change to the dispatch logic (a
bug, a refactor, a new caller) can no longer silently start tagging forum
content as an official news update; the guarantee now holds at the point
of tagging, not only at the point of dispatch.

### 5.3 Example: registering a subreddit

```bash
manage_news_sources.py add reddit-h1b \
  --display-name "r/h1b" --site-url https://www.reddit.com/r/h1b \
  --feed-url "" --fetch-method manual \
  --content-license copyrighted --content-type forum_posting --source-category forum

manage_news_sources.py list
# reddit-h1b  [configured but not automatable  ] r/h1b — forum_posting/copyrighted/forum — (no feed — manual)
```

`--fetch-method manual` signals "no poll mechanism at all" — distinct from
`rss`/`api`/`scrape`, which describe automated-but-not-yet-adapted fetch
shapes. A `manual` source is never expected to gain an adapter; it's
inherently a config-only, human-published entry.

### 5.4 What this does *not* do

This is the schema/registry extension only, per the explicit scope
decision for this round — **no behavior change to Reddit ingestion
itself**. `scripts/curation/publish_reddit.py` does not read from this
registry yet (it still takes subreddit/post details as CLI args, same as
before). Wiring it to pull provenance config from a registered
`forum_posting` source, and/or building automated *discovery* for a forum
that does have a real RSS/API (some do — just not Reddit, per
`REDDIT-INGESTION-ALTERNATIVES.md`) with a human-review queue before
publish (since D-017's paraphrase posture means forum content can never
auto-publish verbatim the way `news` content does) are both real,
separate, bigger decisions — not built here.

## 6. Is ingestion incremental or full-load? — Neither, precisely: full-fetch, incremental-publish

Explicit follow-up request to document this. The honest answer is a
specific hybrid, not a single word — worth being precise about because
"incremental" and "full-load" each get part of it right and part of it
wrong.

### 6.1 The fetch is a full reload of the feed's current window, every run

`_parse_feed()` (`backend/gov_news_poll.py`) has no concept of "since last
run" — RSS itself doesn't support that. Every poll — scheduled or manual —
downloads and parses the **entire feed as it currently exists**. For
USCIS, that's up to 250 items, every single run, whether it's the first
run ever or the 500th. There's no cursor, no `?since=` param, no
`If-Modified-Since` conditional request — the network cost of a poll is
the same on day 1000 as it was on day 1.

### 6.2 The publish is incremental — driven by content_hash, not by the fetch

What happens to those 250 items *after* the fetch is where "incremental"
actually applies. Each item is compared against a `{source_item_id:
content_hash}` map read fresh from BigQuery
(`_existing_hashes()`) and classified:

- **hash matches what's stored** → `unchanged`, skipped entirely — no
  Gemini call, no GCS write, no Discovery Engine import, no BigQuery row.
  This is the steady-state case for the vast majority of the 250 items on
  every run after the first.
- **guid unknown** → `new` → full publish (`publish_gov_news_item()`).
- **guid known, hash differs** → `edited` → full re-publish, upserting the
  same `case_id` (§5.3 of `GOV-NEWS-INGESTION-PLAN.md`).

So the *work done* is incremental (proportional to what actually changed
— typically a handful of items per day for USCIS, per the cadence
observed while building this), even though the *fetch* is not (always the
full current window). This is why the once/day cadence decided earlier is
cheap: one feed download plus one BigQuery query, then near-zero
additional cost for the ~245 unchanged items on a normal day.

### 6.3 What this means for historical depth and coverage — source-dependent, not something the operator controls

- **A source's ingestible history is capped by whatever window its own
  feed currently exposes** — nothing more. USCIS's feed happens to expose
  ~250 items (roughly a year+ of history at its observed cadence,
  confirmed empirically during the initial backfill). A different source
  with a smaller feed window (say, the most recent 20 items only) can
  **never** be backfilled further back than that 20-item window via this
  mechanism, no matter how long the poll job has been running or how
  often it's triggered — there's no way to ask the feed for "item 21."
  This is why §4.1's vetting step includes checking the feed's actual
  window size, not just confirming a feed exists.
- **Once ingested, content is retained even after it ages out of the
  source's feed.** If an item scrolls out of the feed's current window
  (because enough newer items have since pushed it out), the poller
  simply stops seeing it in future fetches — but it was already published,
  and nothing deletes it just because the source stopped listing it. The
  pipeline has no "this fell out of the upstream feed, remove it" logic,
  by design (§5.4 of `GOV-NEWS-INGESTION-PLAN.md` already noted the
  parallel case for a genuinely-removed article — same reasoning: no
  reliable signal to distinguish "aged out of a rolling window" from "the
  agency actually retracted it," so neither triggers automatic deletion).
- **A real, source-dependent risk worth checking per source (§4.1 step
  7):** if a source publishes faster than its feed window can hold between
  two polls, an item could theoretically be published *and* age out of the
  feed window before this pipeline ever sees it — a silent miss, not an
  error. For USCIS at once/day polling against a ~250-item/~1-year window
  and an observed ~2–5 items/week cadence, this is not a practical
  concern — the margin is enormous. It would matter for a hypothetical
  future source with a much smaller window and a much higher publish
  rate; comparing those two numbers is exactly why §4.1 asks for both
  before a source is added, not just "does a feed exist."
