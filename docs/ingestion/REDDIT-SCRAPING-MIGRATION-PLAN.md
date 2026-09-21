# Reddit-Scraping Pipeline: Migration Evaluation & Plan

**Status**: EVALUATION / PLANNING — no code migrated yet. This document assesses
what exists on the stale `reddit-scraping` branch, compares it against the
current live architecture on `main`, and proposes a path forward.

## TL;DR

- The `reddit-scraping` branch has **real, working Reddit-discovery code** —
  but it's wired to the **retired** Firecrawl → self-managed Vertex AI Vector
  Search pipeline (the same lineage archived as [`legacy/`](../../legacy/README.md)
  on `main`), not the current `backend/` + managed Vertex AI Search stack.
- `main`'s canonical posting schema (`backend/posting.py`) is **already
  Reddit-ready** — `subreddit`, `reddit_post_id`, `doc_kind`, `parent_case_id`
  all exist today with empty defaults, and `search_client.py` already has an
  unused `channel:"reddit"` search boost wired in. The gap is a Reddit
  ingestion *path*, not a schema redesign.
- **The real blocker isn't code — it's Reddit API access.** Per
  [`REDDIT-INGESTION-ALTERNATIVES.md`](REDDIT-INGESTION-ALTERNATIVES.md),
  official Data API access was requested ~2026-05 and had no response as of
  2026-06-19. A literal migration of `reddit-scraping`'s code is close to
  moot until this is resolved or an alternative access path is chosen.
- The authoritative target architecture already exists as a **design doc**
  ([`PIPELINE-ARCHITECTURE-WORKFLOW.md`](PIPELINE-ARCHITECTURE-WORKFLOW.md))
  targeting the *current* sink (Vertex AI Search) — it's unbuilt, not
  wrong. This plan proposes building toward that doc, using `reddit-scraping`
  as reference material rather than a code source to lift-and-shift.

## What exists today

| | `reddit-scraping` branch | `main` |
|---|---|---|
| Reddit post discovery | ✅ `orchestrator/agent.py` (`RedditScrapingAgent._discover_reddit_urls`) — hits `old.reddit.com/r/{sub}/{sort}.json` (public JSON, no OAuth) | ❌ none |
| Content scraping | ✅ Firecrawl-based (`scraper/`, `crawler.py`) | ❌ none (Firecrawl retired) |
| Tagging | ✅ Gemini-based (`labeling_agent/agent.py`, retired vocab) | ✅ Gemini-based (`posting.py._extract`, current vocab — different prompt/schema) |
| Storage sink | ❌ self-managed Vertex AI Vector Search (decommissioned, D-039/D-040) | ✅ managed Vertex AI Search (`imm-postings-datastore`) |
| Canonical schema | Old shape, incompatible with current `struct_data` fields | ✅ channel-agnostic, Reddit fields already present |
| Ingestion write path | Custom GCS + Vector Search index calls | ✅ `posting.py._write_gcs` + `_import_to_datastore` (inline sync `documents.import`) |
| Orchestration/scheduling | Manual CLI (`reddit_ingest.py`, checkpoint/resume) | None built (Cloud Scheduler planned per architecture doc, unbuilt) |
| Reddit API access | Uses unauthenticated public JSON endpoint (works for dev/smoke only — see alternatives doc) | N/A |

**Bottom line**: reuse the *idea* of `_discover_reddit_urls` (it's a small,
self-contained, dependency-light function) — everything downstream of
discovery (scraping, tagging, storage) should be built fresh against
`posting.py`'s current patterns, not ported from the old branch.

## Known gaps between `main`'s current code and its own target architecture

These aren't Reddit-specific, but any Reddit ingestion path inherits them:

1. **`posting.py._import_to_datastore`** does inline synchronous
   `documents.import` with `struct_data` embedded directly. The architecture
   doc's event-driven path (GCS finalize → Eventarc → `search-importer` →
   sidecar-mode `documents.import`) is unbuilt. A Reddit path could go either
   way short-term (inline, like today) but should track the eventual
   event-driven design rather than add a second inline-sync integration.
2. **`posting.py._write_bigquery`** uses legacy `insert_rows_json` streaming
   inserts — the architecture doc (§5.1, D-028) explicitly says production
   writes must use the Storage Write API + staged `MERGE`, not this pattern.
   Existing discrepancy, not something to newly introduce for Reddit.
3. **No quarantine path exists in code.** `posting.py.validate()` just raises
   `ValueError` on a vocab/schema miss. The designed quarantine →
   Label Studio → `tag_proposals` loop ([`TAG-LIFECYCLE.md`](TAG-LIFECYCLE.md))
   is unbuilt. Reddit content is exactly the case this loop exists for —
   unpredictable, out-of-vocab phrasing — so this is probably the single
   highest-leverage piece of net-new infrastructure this migration needs.
4. **PII scrubbing** — `posting.py.publish_posting()` calls `profile.scrub_pii()`
   for user-submitted content. The architecture doc treats Reddit content as
   public and explicitly skips DLP/PII-guard for it — worth confirming that
   decision still holds before shipping (Reddit posts can still contain
   emails/phone numbers pasted by the author).

## Recommended phased plan

### Phase 0 — Unblock access (prerequisite, not engineering)
Resolve or bypass the Reddit Data API access blocker per
[`REDDIT-INGESTION-ALTERNATIVES.md`](REDDIT-INGESTION-ALTERNATIVES.md)'s
"Track 1" options: follow up on the pending API request, or make an explicit
call to proceed with public-JSON-endpoint access for a dev/smoke-scale pilot
only (per that doc, not sanctioned for production volume). **Nothing below
should start production ingestion until this is a deliberate decision, not a
default.**

### Phase 1 — Pilot discovery + manual review (smoke scale)
- Port `_discover_reddit_urls` logic (or rewrite it — it's ~30 lines) into a
  standalone script under `backend/` scoped to the 3 pilot subreddits from
  the architecture doc (`r/h1b`, `r/USVisas`, `r/usvisascheduling`).
- Reuse `posting.py`'s existing `_extract`/tagging machinery and
  `build_canonical`/`validate` — construct `case_id = reddit-<date>-<subreddit>-<post_id>`
  per the dedup design, populate `channel="reddit"`, `subreddit`,
  `reddit_post_id`, real `full_url` (not `APP_BASE_URL`-derived).
- Do **not** store the Reddit author handle in canonical JSON, per the
  original pipeline doc's explicit privacy requirement.
- Run manually (no Cloud Scheduler yet), forward-only, small volume — validate
  that tagged output passes `validate()` at a reasonable rate before building
  any automation around it.

### Phase 2 — Quarantine loop + automation
- Build the quarantine path: failed `validate()` → GCS `_quarantine/` prefix +
  `_errors.txt`, reviewed in Label Studio, feeding `tag_proposals` per
  `TAG-LIFECYCLE.md`. Do this before scaling volume — Reddit phrasing will
  hit the closed vocabulary far more than user-submitted postings do.
- Add Cloud Scheduler cadence (10-15 min per the original spec) once the
  quarantine loop is proven, plus BigQuery-based dedup/watermarking
  (`reddit_post_id` lookup) to avoid reprocessing.
- Decide the comments question (original spec: top-level comments >5 upvotes,
  ingested as `case_id` + `__c_<comment_id>` — worth revisiting scope before
  building).

### Phase 3 — Expand + align with target architecture
- Backfill (posts ≥50 upvotes, last 3 months) once pilot subreddits are
  stable.
- Migrate the inline-sync `documents.import` + `insert_rows_json` patterns
  (shared with the existing app-posting path, not Reddit-specific) toward the
  event-driven / Storage-Write-API design, if/when that broader migration
  happens — don't build a second, divergent integration just for Reddit.

## Non-goals (for this plan)

- Rewriting or reviving any code from `reddit-scraping`'s Firecrawl-based
  scraper (`scraper/`, `crawler.py`) — Firecrawl is retired; use direct
  `old.reddit.com/.json` discovery + a lightweight fetch, not a full crawl
  service.
- Multi-platform crawling (Twitter/Quora) — out of scope per the original
  spec too.
- Solving the Storage-Write-API/event-driven-import discrepancies as part of
  this work — those are pre-existing gaps in the current app-posting path;
  fixing them is a separate, broader piece of work.

## Open questions for a human decision before Phase 1 starts

1. Is Phase 0 (API access) resolved, or are we deliberately choosing the
   public-JSON dev/smoke path knowing its production-volume limitations?
2. Does the "no PII scrub for Reddit content" decision in the architecture
   doc still hold, given Reddit posts can contain pasted personal info?
3. Who reviews the Label Studio quarantine queue once Phase 2 starts — is
   there existing reviewer capacity, or does this need to be staffed?
