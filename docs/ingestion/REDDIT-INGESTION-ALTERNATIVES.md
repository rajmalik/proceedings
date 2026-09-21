# Reddit Ingestion — Alternatives & Cost Analysis (API blocked)

**Status:** Evaluation / decision-pending — see §7 for the narrowed-pilot-scope re-evaluation, §8 for the Claude Skill (fetch-reddit/Redlib) evaluation
**Last updated:** 2026-07-25
**Context owner:** see MEMORY.md (D-012, D-022, D-026, D-039)

> **Why this doc exists.** The official Reddit Data API path (PRAW, the project's
> chosen approach in [D-012](../../MEMORY.md)/[D-022](../../MEMORY.md)) is
> **blocked**. As of late-2025 Reddit **disabled self-serve app creation**:
> `reddit.com/prefs/apps` → "create app" now bounces to the **Responsible Builder
> Policy** and all Data API access sits behind a **manual approval process**. A
> non-commercial Data API access ticket was **filed ~2026-05 (one month ago) with
> no response**. This doc captures the alternative ways to get Reddit content
> flowing, with real costs for the paid options, so we can pick a path instead of
> waiting indefinitely.

---

## 1. The two tracks

| | **Track 1 — Unblocked now (no Reddit approval)** | **Track 2 — Paid Reddit content at scale** |
|---|---|---|
| Goal | Keep the product moving today, ToS-clean | Automated, scalable Reddit ingestion |
| Approval needed | None | None (3rd-party) / Yes-but-paid (official) |
| Time to start | Immediate | Hours–days (3rd-party) / weeks (official) |
| Best for | Seeding quality content, building the moat | Volume Reddit coverage once justified |

The recommended posture is **run Track 1 now**, and pick a Track 2 option **only if/when** Reddit volume is worth paying for. They are not mutually exclusive.

---

## 2. Track 1 — Unblocked-now options (no Reddit approval, no/low cost)

These need **zero** Reddit approval and are either free or labor-only. Two of the
three are the project's *own* designed-but-unbuilt work, so they advance the
roadmap rather than being throwaway.

### 1-A. Lean on DS-2 (public website data store) — **recommended primary**
- **What:** The Vertex AI Search *website* data store decided in [D-039](../../MEMORY.md) — Google crawls/indexes public gov + law-firm sites (USCIS, travel.state.gov, dol.gov, …); we run **no** scraper/ingest pipeline.
- **Covers:** A large share of the "answer immigration questions" use case.
- **Approval / ToS:** None — Google-crawled public content. No Reddit dependency.
- **Cost:** Managed Vertex AI Search query pricing only (already in the budget); **no ingestion cost, no always-on node** (consistent with D-016).
- **Status:** Decided, "implementation pending P1." Highest-leverage unblocked work.

### 1-B. First-party app content (`channel="app"`) — **the long-term moat**
- **What:** User-authored postings/experiences via the app, already built ([D-034](../../MEMORY.md)/[D-050](../../MEMORY.md)/[D-051](../../MEMORY.md)).
- **Covers:** The experiential, "same-boat" peer content Reddit was meant to seed — except we **own** it and it's compliant by construction.
- **Approval / ToS:** None — our own users, our own consent flow ([D-038](../../MEMORY.md) PII consent).
- **Cost:** Already in the live backend; marginal.

### 1-C. Human-curated manual ingestion — **stopgap for Reddit specifically**
- **What:** The proven manual-batch path ([D-026](../../MEMORY.md)) that built the current 82-doc corpus — a human selects high-value **public** Reddit threads, the pipeline stores **paraphrases + controlled-vocab tags** (not verbatim dumps, per [D-017](../../MEMORY.md)).
- **Approval / ToS:** Cleanest posture for a legal-domain product (manual reading of public content; no automated collection).
- **Cost:** Labor only. Doesn't scale, but seeds quality immediately.

### 1-D. Public JSON / RSS endpoints — **confirmed non-viable in practice, not just policy (2026-07-24)**
- **What:** Unauthenticated `https://www.reddit.com/r/<sub>/new.json`, `/comments/<id>.json` (~10 req/min, returns full structured JSON incl. `score`/comments/ids), or `/r/<sub>/.rss` (no upvotes/comments).
- **Approval / ToS:** ⚠️ **Against Reddit's automated-access ToS at production scale.** [`PREREQUISITES-IAM-INFRASTRUCTURE.md §7`](PREREQUISITES-IAM-INFRASTRUCTURE.md) sanctions it **for local dev and smoke tests only — never production/backfill.**
- **Use:** Build & validate the Scraper → tag → GCS → datastore flow against real post shapes, so swapping to PRAW (or a paid provider) later is a one-line auth change.
- **Cost:** Free.
- **⚠️ Update — tested and confirmed blocked, from BOTH a cloud/datacenter IP
  and a residential home connection.** `www.reddit.com/r/h1b/top.json` and
  `old.reddit.com/r/h1b/top.json` both returned `HTTP 403 Blocked` from a
  developer's own laptop (normal home internet), not just from a sandboxed
  cloud environment. This means the block is **not just IP-reputation
  filtering** — it's consistent with TLS/HTTP fingerprint-based bot
  detection (e.g. Cloudflare/Akamai/PerimeterX-style), which flags
  non-browser HTTP clients (`curl`, Python `urllib`) regardless of network
  origin. **Practical implication: this option no longer works reliably even
  for the "dev/smoke" use it was originally sanctioned for** — the original
  framing assumed a production-scale/volume problem; the real problem is
  more fundamental than that. See
  [`APIFY-SCRAPER-LEGAL-AND-INTEGRATION.md` §2.4](APIFY-SCRAPER-LEGAL-AND-INTEGRATION.md#24-fresh-check-2026-07-23--the-actual-apify-reddit-scraper-actors-own-disclosures)
  for why this is also the underlying reason Apify's Reddit-scraper actor
  needs residential-proxy-rotation infrastructure rather than a plain
  connection — a single request from a single IP, even residential, isn't
  sufficient against this kind of detection. **Do not attempt to defeat this
  detection** (browser-fingerprint spoofing, header mimicry, proxy rotation)
  — that crosses into the same circumvention risk category flagged
  throughout this doc and the Apify legal assessment.

### 1-E. Claude Skill (`fetch-reddit` / Redlib) — **evaluated, rejected** (see §8 for full analysis)
- **What:** A community-built Claude Skill that fetches Reddit content by
  scraping **Redlib**, an unofficial third-party Reddit mirror, solving its
  Anubis anti-bot proof-of-work challenge on every request.
- **Approval / ToS:** ⚠️ **Worse than 1-D, not an alternative to it** — its
  core mechanism is the exact bot-detection circumvention 1-D's update
  above says not to attempt, routed through an unaffiliated third party on
  top of that.
- **Reliability:** No SLA — Redlib instances get blocked "periodically as
  Reddit tightens its crackdown on alternative frontends," by the skill's
  own documentation.
- **Functional fit:** No search, no date/time-range or flair filtering, no
  pagination (~25 posts/call, hot/new/rising/top only) — can't do the
  pipeline's targeted historical retrieval. Also not invocable as headless
  pipeline code — it only runs inside an interactive Claude chat session.
- **Verdict:** Rejected for both recurring pipeline use and one-time/manual
  use. Full writeup: §8.

---

## 3. Track 2 — Paid options (costs)

> Volume basis for the estimates below comes from the project's own figures in
> [`REDDIT-INGESTION-PIPELINE.md §7.6`](REDDIT-INGESTION-PIPELINE.md): **~5,000
> posts/month** at pilot, and an illustrative **~50,000 posts/month** at
> production scale. Pipeline request volume is low (3 subreddits, forward-only;
> ~hundreds–low-thousands of API calls/day).

### 3-A. Official Reddit **Commercial / Enterprise Data API** — compliant, expensive
- **Pricing (published baseline, 2026):** ~**$0.24 per 1,000 API calls** above free allowances; commercial tiers carry **large minimum commitments** — reported around **$12,000/month for up to 50M calls**, with rate-tier variants (~$24k for 200 RPM, ~$60k for 500 RPM) and **enterprise pricing negotiated** individually.
- **At our volume:** Our *usage* would be trivial (~tens of thousands of calls/mo ≈ a few dollars at $0.24/1k) — but the **minimum commitment dwarfs it.** This tier is built for AI-training-scale buyers, **not** a pilot.
- **Compliance:** ✅ The only **fully-licensed, first-party** path. Contractual right to the data; deletion/attribution terms are explicit.
- **Verdict:** Only worth it at large scale or if a license is contractually required. **Disproportionate for the pilot.** ⚠️ Figures conflict across sources ($12k/month vs $12k/year in different write-ups) — **confirm directly with Reddit sales** before relying on any number.

### 3-B. Third-party scraping providers — pragmatic, mid-cost
Marketplace/managed scrapers that handle Reddit for you. **They** operate the
scraping; you consume results via their API/dataset.

| Provider / actor | Unit price | Pilot (5k posts/mo) | Production (50k/mo) | Platform fee |
|---|---|---|---|---|
| **Apify** — `prodiger/reddit-scraper` | $1.15/1k posts (→ $0.28/1k at top tier); ~$0.58/1k comments | ~**$6/mo** | ~**$58/mo** (less at higher tiers) | Free tier (~$5 credit) → Starter ~$39/mo → Scale ~$199/mo |
| **Apify** — `parseforge/reddit-posts-scraper` | $3/1k results | ~$15/mo | ~$150/mo | (as above) |
| **Apify** — `trudax/reddit-scraper` | from $2/1k results | ~$10/mo | ~$100/mo | (as above) |
| **Bright Data** — Web Scraper / Reddit dataset | ~$3/1k page loads; pay-per-success from $0.75/1k; datasets custom-priced | ~$4–15/mo | ~$40–150/mo | No monthly commitment option |

- **All-in pilot estimate (3rd-party):** roughly **$40–$65/month** (Apify Starter sub + ~5k posts usage) — comparable to the pipeline's own ~$25–35/mo compute/LLM budget.
- **Compliance:** ⚠️ **Shifts but does not erase risk.** The provider scrapes Reddit (and assumes that operational risk), but as the **data consumer** you are still using Reddit content obtained outside the official API. Reddit has **sued scrapers** (Anthropic, SerpApi) and blocks aggregators. For a **legal-domain** product, weigh this carefully — it is *not* equivalent to the licensed 3-A path.
- **Verdict:** The **fast + scalable + low-cost** option, with a residual ToS/legal risk that 3-A removes.

### 3-C. Devvit (Reddit Developer Platform) — **rejected, do not pursue**
- Easy/fast approval, free — **but** Devvit apps run on **Reddit's** hosting inside installed subreddit apps, **not** as an external GCP pipeline writing to our GCS/BigQuery. Adopting it means abandoning the GCP architecture. Already rejected in [D-012](../../MEMORY.md)/[D-022](../../MEMORY.md). Listed here only so the option isn't re-litigated.

---

## 4. Side-by-side summary

| Option | Approval | ToS / legal posture | Structured data (upvotes/comments) | Cost @ pilot | Scales? | Time to start |
|---|---|---|---|---|---|---|
| 1-A DS-2 public sites | None | ✅ Clean | n/a (different source) | $0 extra | ✅ | Now (build) |
| 1-B First-party app | None | ✅ Clean (owned) | n/a | ~$0 | ✅ | Built |
| 1-C Manual curation | None | ✅ Cleanest for Reddit | ✅ (human) | Labor | ❌ | Now |
| 1-D Public JSON/RSS | None | ⚠️ Confirmed blocked in practice — see update in §2 | ✅ JSON / ❌ RSS | $0 | ❌ (not prod, and now confirmed not reliably dev either) | ~~Now~~ Blocked |
| 1-E Claude Skill (fetch-reddit/Redlib) | None | ❌ Anti-bot circumvention — worse than 1-D | ✅ (live scrape) | $0 | ❌ Rejected — see §8 | ❌ Rejected |
| 3-A Official commercial API | Yes (paid) | ✅ Licensed | ✅ Full | **~$12k/mo floor** | ✅✅ | Weeks |
| 3-B 3rd-party scraper | None | ⚠️ Residual risk | ✅ Full | **~$40–65/mo** | ✅ | Hours–days |
| 3-C Devvit | Easy | ✅ | ✅ | Free | n/a | — (rejected) |

---

## 5. Recommendation

1. **Now (Track 1):** Build **DS-2 (1-A)** — the highest-value, fully-compliant, already-decided unblocked work — and keep growing **first-party app content (1-B)**. Use **manual curation (1-C)** to seed any must-have Reddit threads. ~~Build the Scraper against public JSON (1-D) in dev so the automated path is ready.~~ **Superseded 2026-07-24: confirmed blocked even from a residential IP — see the 1-D update above. Don't build against it.**
2. **Parallel:** Re-file / escalate the Reddit ticket framed explicitly as **non-commercial / research** (lighter review).
3. **Track 2 decision — only when Reddit volume is justified:**
   - If budget is tight and some residual ToS risk is acceptable → **3-B (Apify/Bright Data), ~$40–65/mo at pilot.**
   - If a **fully-licensed** posture is required (legal-domain caution) and scale/budget justify it → **3-A official commercial API** — but **confirm real pricing with Reddit sales first**; the public baseline implies a minimum commitment far above pilot needs.

**Bottom line:** Reddit is one *channel*, not the product. The schema is channel-agnostic ([D-036](../../MEMORY.md)), so Reddit can be added later with zero rework. Don't let a blocked free API stall the roadmap — Track 1 advances the product today.

---

## 7. Re-evaluation — narrowed pilot scope (2026-07-22)

The original analysis above assumed the full pipeline spec's scope (all
comments >5 upvotes, volume modeled at ~5,000 posts/mo). Re-evaluated against
a **much narrower actual pilot scope**: **2-3 named subreddits only**, and
**top 3 replies per post by upvote count only** (not all qualifying
comments) — plus a fresh check on Reddit's API approval timeline. The
architecture question (can the pipeline write into the current live
datastore) is **not** re-litigated here — already confirmed elsewhere
(`REDDIT-SCRAPING-MIGRATION-PLAN.md`): `posting.py`'s canonical schema
already has `subreddit`/`reddit_post_id`/`doc_kind` fields, and
`search_client.py` has an unused `channel:"reddit"` boost — no schema
changes needed for any access path below.

### 7.1 Reddit API approval timeline — fresh check

No published SLA exists (Reddit's own Responsible Builder Policy page
returned HTTP 403 to automated fetch; findings below are from current
third-party trackers of the same 2026 process — see §9 sources):

- Reported waits range from **a couple of days to several weeks to
  indefinite silence** — "a meaningful share of applicants never get a yes."
- **Small/personal/vague project descriptions are the most-rejected
  category** — being under-specified hurts approval odds more than framing
  as commercial does.
- What correlates with better outcomes: a **specific, detailed submission**
  — name the exact subreddits, exact data scope, call-volume estimate,
  explicit "no posting/voting/automation/bot-account" confirmation, and a
  privacy policy link if applicable.
- Approved free-tier apps get ~100 QPM (effectively ~60 QPM sustained) — far
  more than this pilot's volume needs.

**Action**: our filed ticket is a month old with no response. Worth
**re-filing now with the narrowed scope spelled out explicitly** (name the
2-3 subreddits, top-3-comments-by-upvote only, read-only, no bot account) —
zero cost, runs in parallel, no downside. Do not treat it as a plan on its
own timeline; there is no guaranteed response window.

### 7.2 How the narrowed scope changes the Track 2 cost math

| Option | Original verdict (§4) | Re-evaluated at narrowed scope |
|---|---|---|
| **3-A Official commercial API** | Disproportionate (~$12k/mo floor) | **Still disproportionate** — the minimum commitment is flat, not usage-based; shrinking volume doesn't move it |
| **3-B Third-party scraper (Apify)** | ~$40–65/mo at ~5k posts/mo, residual ToS risk | **Cost objection nearly disappears.** 2-3 subreddits + top-3-comments-only is a fraction of the original 5k-post pilot volume — likely a few hundred to low-thousands of post/comment fetches per month. At Apify's per-unit pricing (~$1.15/1k posts, ~$0.58/1k comments) that's **under $5/month, inside the free tier.** The decision is now purely legal/ToS, not cost |
| **1-D Public JSON, unauthenticated** | Dev/smoke only, never production | **Still no**, for a second reason beyond ToS: no documented rate-limit headers, and Reddit "can throttle or block the JSON endpoint for a given client at any time" with "no contact, dashboard, or appeal." Even trivial volume can be silently cut off — a reliability problem independent of how small our footprint is |

### 7.3 Legal aspect at narrowed scope

Two distinct risks — narrowing scope only addresses one of them:

- **Copyright/republication risk** — already mitigated regardless of scope
  by this project's existing paraphrase posture ([D-017](../../MEMORY.md)):
  the pipeline stores paraphrases + controlled tags, never verbatim Reddit
  content.
- **ToS-violation-for-unauthorized-scraping risk** — this is about the
  *method* of collection, not volume. Reddit's suits against scrapers
  (Anthropic, SerpApi) were about principle, not scale. Narrowing to 2-3
  subreddits / top-3-comments lowers the **detection profile and probability
  of being targeted**, but does not change the **qualitative legal
  category** if targeted. For a legal-domain product, treat "small-scale via
  3-B" as **lower-risk-in-practice, not risk-free** — get explicit legal
  sign-off before relying on it, rather than treating this as an
  engineering call.

### 7.4 Updated recommendation

1. **Re-file the Reddit API ticket immediately** with the narrowed scope
   spelled out (§7.1) — no downside, runs in parallel with everything else.
2. **While waiting, 3-B (Apify) is now the practical near-term path** — at
   this volume the earlier cost hesitation is gone (~$0–5/mo). Get explicit
   legal sign-off first (§7.3); the residual ToS risk doesn't scale down to
   zero just because volume did.
3. **Do not use 1-D (public JSON) for production**, even at this tiny scale
   — keep it strictly to dev/smoke validation, per the original guidance
   (§2, option 1-D) and reinforced by the reliability findings in §7.2.
4. **Keep 1-A/1-C (DS-2, manual curation) running in parallel** — zero-risk
   ways to seed the same 2-3 subreddits' worth of quality content
   immediately, independent of whichever Track 2 decision is made.

---

## 8. Claude Skill route (`fetch-reddit` / Redlib) — evaluated and rejected (2026-07-25)

Explored a specific proposal: use the community `fetch-reddit` Claude Skill
(v2, shared publicly — see §8.4) instead of Apify/PRAW/manual curation.
Downloaded the skill and read its full source (`SKILL.md`, `scripts/fetch.py`,
`references/*.md`) rather than relying on its own description of itself.

### 8.1 How it actually works

Not a Reddit API client. `fetch.py` scrapes **Redlib** — a volunteer-run,
unofficial third-party Reddit mirror — via `requests`/`BeautifulSoup`, and:
1. Solves an **Anubis proof-of-work anti-bot challenge** on every request
   (brute-forces a SHA-256 nonce to pass Redlib's bot detection).
2. Parses the returned HTML (fragile — the skill's own troubleshooting doc
   lists "Redlib changed their HTML structure" as an expected failure mode).
3. Fails over across ~7 hardcoded Redlib instance URLs when one is down,
   blocked, or serving an error page.

### 8.2 Rejected for pipeline use — three independent reasons

1. **Legal/ToS — worse than 1-D, not an alternative to it.** §2 (1-D)
   already concluded that defeating Reddit's bot-fingerprint detection
   (header mimicry, proxy rotation, etc.) "crosses into the same
   circumvention risk category" flagged throughout this doc. This skill's
   core mechanism *is* that circumvention — solving an anti-bot PoW
   challenge, then routing through unaffiliated third-party mirrors that are
   themselves scraping Reddit without authorization.
2. **Reliability — no SLA, by the skill's own documentation.** Its
   troubleshooting doc states Redlib instances get blocked "periodically as
   Reddit tightens its crackdown on alternative frontends," with no owner to
   escalate to.
3. **Functional fit — can't do what the pipeline needs, independent of the
   legal question.** No keyword search, no date/time-range or flair
   filtering, no pagination — capped at ~25 posts per call, sorted only by
   hot/new/rising/top (per the skill's own `references/browsing-live.md`
   "Limitations" section). The pipeline needs targeted historical retrieval
   (e.g., "H-1B RFE approved" threads across months); this can only show
   "what's currently hot right now." It's also not invocable as headless
   pipeline code at all — it's an instruction file for an LLM to follow
   inside an interactive Claude.ai/Desktop chat session with Code Execution
   + Network Egress enabled, so the GCP pipeline has no way to call it
   regardless of the other two objections.

### 8.3 Re-evaluated for one-time (not recurring) ingestion

Two of the three objections above weaken for a single, human-driven,
one-time pull — but the load-bearing one does not:
- **Reliability** becomes moot — a failed attempt can just be retried;
  there's no ongoing-uptime dependency for a single session.
- **No search/pagination** becomes moot *if* the target posts are already
  known (found via normal reddit.com browsing) — `live-post`/`live-share`
  on a specific known ID/URL doesn't hit the `live-browse` limitations.
- **Legal/ToS does not shrink with volume.** Same reasoning already applied
  to Apify at narrowed scope in §7.3: *"this is about the method of
  collection, not volume... narrowing scope lowers the detection profile...
  but does not change the qualitative legal category."* Invoking the
  anti-bot-circumvention mechanism once is still that mechanism — lower
  exposure, not a different category.

**Verdict:** since a human still has to open/identify each post as
curation-worthy in the first place under the existing manual-curation
workflow (1-C), the marginal convenience this skill adds over just reading
the post in the browser tab already open is small, while it's the only path
of the two that raises the ToS question at all. **Recommendation: do not use
it, even for one-time ingestion** — keep doing 1-C exactly as today (read
directly on reddit.com, paraphrase into the curation script).

### 8.4 Reference

- Source: [r/claudexplorers — "v2 of my fetch-reddit skill for sharing all things..."](https://www.reddit.com/r/claudexplorers/comments/1rnuxch/v2_of_my_fetchreddit_skill_for_sharing_all_things/)
  (page itself not fetchable via WebFetch — evaluated directly from the
  downloaded skill source instead: `SKILL.md`, `scripts/fetch.py`,
  `references/troubleshooting.md`, `references/browsing-live.md`)

---

## 9. References
- [REDDIT-INGESTION-PIPELINE.md](REDDIT-INGESTION-PIPELINE.md) — pipeline spec, §3.5/§7.6 (Reddit access + cost)
- [PREREQUISITES-IAM-INFRASTRUCTURE.md §7](PREREQUISITES-IAM-INFRASTRUCTURE.md) — Reddit access runbook + dev-only public-JSON sanction
- [REDDIT-SCRAPING-MIGRATION-PLAN.md](REDDIT-SCRAPING-MIGRATION-PLAN.md) — confirms current schema/pipeline can ingest Reddit content into the live datastore with no redesign
- MEMORY.md — D-012 (PRAW/Devvit), D-022 (approval critical-path), D-026 (manual batch), D-016/D-039 (managed sinks, DS-2), D-017 (paraphrase posture), D-036 (channel-agnostic schema)
- External pricing/policy (retrieved 2026-06-19):
  - Reddit commercial API pricing — [techloy](https://www.techloy.com/reddit-api-pricing-in-2026-complete-guide-for-developers-and-businesses/), [PainOnSocial](https://painonsocial.com/blog/how-much-does-reddit-api-cost)
  - Reddit API vs Apify (cost/throughput/compliance) — [redditapis.com](https://www.redditapis.com/blogs/reddit-api-pricing-vs-apify)
  - Apify Reddit scrapers — [prodiger](https://apify.com/prodiger/reddit-scraper), [parseforge](https://apify.com/parseforge/reddit-posts-scraper), [trudax](https://apify.com/trudax/reddit-scraper)
  - Bright Data pricing — [Bright Data web scraping APIs](https://brightdata.com/blog/web-data/best-web-scraping-apis)
  - Self-serve API shutdown — [RedditorShop](https://redditorshop.com/blog/the-end-of-the-self-serve-reddit-api-why-you-can-t-create-an-api-key-in-2026), [Responsible Builder Policy](https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy)
- Fresh 2026 API-approval-timeline check (retrieved 2026-07-22):
  - [How to Get a Reddit API Key in 2026 (Step-by-Step + Approval Fix)](https://www.redditapis.com/blogs/how-to-get-reddit-api-key-2026)
  - [Reddit Data API 2026: Lockdown, Approval, Rate Limits](https://www.redditapis.com/blogs/reddit-data-api-2026)
