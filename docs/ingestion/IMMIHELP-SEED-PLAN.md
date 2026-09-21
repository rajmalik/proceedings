# immihelp.com/experiences/ — one-time sample seed

## 1. What this is, and what it deliberately is NOT

The original ask was to add `immihelp.com/experiences/` to the ingestion
framework built in `GOV-NEWS-MULTI-SOURCE-CONFIG.md`: seed the entire
history, then poll incrementally from Cloud Scheduler forever after, with
per-run success/failure metrics in a BigQuery audit log.

That framework isn't a fit here, and it isn't used. immihelp's Terms of Use
(`https://www.immihelp.com/terms-of-use/`) §12 says:

> *"We reserve all of our rights, including but not limited to any and all
> copyrights... The use of our rights and property requires our prior
> written consent... you will have no rights to make any commercial uses of
> our web site or service without our prior written consent."*

The footer confirms: *"Copyright © 1999-2026 immihelp®.com. All rights
reserved."* Unlike USCIS (public-domain federal content, 17 U.S.C. §105 —
`GOV-NEWS-INGESTION-PLAN.md`), there's no license here to automate a
recurring, unbounded ingest of this site's content. This project doesn't
have a licensing agreement with immihelp.

Given that, the agreed scope (see the conversation that produced this doc)
is:

- **A bounded, one-time sample** — `scripts/curation/seed_immihelp.py
  --limit 100` (default 100), run by hand, not on a schedule.
- **Never registered in the Firestore `news_sources` registry, never
  polled by Cloud Scheduler.** No `content_license`/`content_type` gate
  applies because this never goes through `news_sources.get_enabled_sources()`
  at all — the safety mechanism is "this code path doesn't run
  automatically," not a registry flag.
- **No BigQuery per-run audit-log table.** That was scoped for a
  recurring scheduled job; a single manual run doesn't need one. Progress/
  outcome is tracked in a local resumable JSON manifest instead (§4).

What IS carried over from the framework, per the explicit "keep the
backend the same" requirement: `posting.publish_immihelp_posting()` reuses
the exact same tagging/publish pipeline as everything else in this
codebase — `_extract()` (Gemini tagging), `build_canonical()`, `validate()`,
`_write_gcs()`, `_import_to_datastore()`, `_write_bigquery()`. Nothing
about *how a posting gets tagged and published* is different; only *how
candidates are discovered* is new.

## 2. Site structure (what made this tractable)

`immihelp.com/experiences/` is a large, category-organized experience
forum — ~80,000 posts across ~100 topics (Immigration, Visa, Insurance,
USA, Study, India, Other Countries). No RSS feed exists.

Each topic listing page (e.g. `/h1b-h4-visa-experiences/`) embeds a JSON
blob directly in the page's `<script>`:

```js
window.immiObj.posts = {"status":"success","totalPosts":10675,"totalPage":1068,
  "postPerPage":10,"currentPage":1,"posts":[{...}, ...]};
```

That blob already contains each post's full `content` (body text),
`title`, `createdOn` (original ISO timestamp), `permalink`, and category —
so **no per-post detail-page fetch and no headless browser is needed**
(contrast with the `travel.state.gov` evaluation, which would have needed
Playwright). A plain `requests.get()` per topic is enough —
`backend/immihelp_seed.py`'s `_fetch_topic_html()` + `parse_topic_posts()`.

`robots.txt` (`https://www.immihelp.com/robots.txt`) allows `/experiences/`
and sets `crawl-delay: 3` (honored between every request —
`fetch_candidates()`), but explicitly disallows `/api/*`. The site's own
"next page" pagination is a client-side call into that disallowed `/api/`
path, so **this only ever reads page 1** (the ~10 most-recent posts) of
each topic — never page 2+. With ~19 curated topics (§3) that's up to
~190 candidates per run, comfortably enough to fill a 100-item sample
after `validate()`-based filtering.

## 3. Topic curation

`backend/immihelp_seed.py`'s `TOPIC_SLUGS` lists ~19 topics under the
Immigration/Visa sections — Adjustment of Status, Employment/Family-Based
Greencard, I-140, Labor Certification, Citizenship, H1B/H4, L1/L2, Student
Visa, Fiancé Visa, Visitor Visa, Visa Stamping, EAD, etc. Topics under
USA/Insurance/Travel/Student-life (banking, hotels, telecom, university
admissions, ...) are excluded up front — they're consistently off-topic
for this product's tag vocabulary (`tags-cleaned/`) and would just waste
fetch budget on candidates `validate()` will reject anyway (no
visa/status captured).

## 4. Field mapping, and what's deliberately dropped

| immihelp field | → | our field | notes |
|---|---|---|---|
| `id` | → | `source_item_id` | stable dedup key; also feeds the deterministic `case_id` hash, same scheme as gov-news |
| `title` | → | `title` | verbatim |
| `content` (HTML) | → | `description` | tags stripped via BeautifulSoup, `scrub_pii()`'d before anything else touches it |
| `createdOn` (e.g. `2026-03-15T10:30:00.000-04:00`) | → | `posting_date` | **the original event_date requirement** — the date portion is taken as-is from the source's own recorded local time, never converted through UTC (which could shift the date) |
| `permalink` | → | `full_url` | resolved against `https://www.immihelp.com`, the real citable original |
| *(fixed)* | → | `channel` / `source_system` | both hardcoded `"immihelp"` per the explicit request |
| *(fixed)* | → | `ingestion_method` | `"automated_scrape"` — `PATH-B-PROVENANCE-PLAN.md`'s pre-reserved value for exactly this shape (automated tagging, scraped not RSS/API) |
| *(fixed)* | → | `content_type` (internal, not stored) | always `"forum_posting"`, passed through `posting._gov_news_tags()` so the deterministic `news-update` tag (meaning "official policy/news," not a personal experience) can never apply — same explicit-not-implicit guarantee as `GOV-NEWS-MULTI-SOURCE-CONFIG.md` §5.2a |

**Deliberately dropped, never stored:**

- **`username` / `postedBy` / `createdBy`** — immihelp's own listing JSON
  includes the real forum username of the poster. There's no consent to
  attribute a real, identifiable person's handle on this commercial
  product. `author_handle` is left to `build_canonical()`'s synthetic
  default (`eager-comet-2857`-style) — the same choice already made for
  Reddit and gov-news content.
- **`ipAddress`** — immihelp's own public listing payload includes the
  submitter's IP address for every post. This is dropped at the parser
  level (`immihelp_seed.parse_topic_posts()`) and never reaches
  `posting.py` at all.

Unlike `publish_reddit_posting()` (which treats already-public,
human-curator-reviewed Reddit content as pre-vetted and skips PII/
moderation checks), `publish_immihelp_posting()` **does** run
`scrub_pii()` and `moderation.check_text()` — there's no per-item human
review step here (tagging is fully automated), and real immihelp postings
have been observed with pasted emails/personal details (e.g. a scraped
sample containing `vapwis01@gmail.com` pasted directly into a post body).

## 5. What makes the sample "publishable"

"100 postings which has enough valid tags and is publishable" is enforced
by reusing `validate()` exactly as-is — no separate quality heuristic was
built. A candidate is skipped (not force-published) if `_extract()`
can't produce a `current_visa_or_greencard_category` / `visa_applying_for`
tag, or any other `validate()` rule fails. Many immihelp "experiences" are
short employer/recruiter reviews with no visa/status content (e.g. *"Very
responsive and helpful recruiting team..."*) — these fail `validate()`
naturally and are skipped, which is the intended filter.

## 6. Runbook

```bash
# 1. Preview candidates without tagging/publishing anything (network-only, no GCP writes):
cd backend && ../.venv/bin/python ../scripts/curation/seed_immihelp.py --dry-run

# 2. Run the real (bounded, default 100) sample seed:
cd backend && ../.venv/bin/python ../scripts/curation/seed_immihelp.py --limit 100

# 3. Verify what actually landed (see §9 — this is what caught the §8 bug):
cd backend && ../.venv/bin/python ../scripts/curation/verify_immihelp_seed.py --all
```

Resumable: every publish/skip is written immediately to
`scripts/curation/immihelp-seed-manifest.json`. A re-run skips any
`source_item_id` already present under `published` or `skipped`, so an
interrupted run can simply be re-invoked with the same flags. `--force`
ignores the manifest and re-attempts everything.

This is a manual, human-invoked script — not registered anywhere Cloud
Scheduler or `news_sources.py` would find it. Running it again in the
future (e.g. to top up the sample) is a deliberate, one-off human action
each time, not an automated recurrence.

## 7. If a licensing agreement with immihelp is ever reached

Nothing about `posting.publish_immihelp_posting()` or
`backend/immihelp_seed.py` would need to change structurally to become an
automated, recurring source — only the *governance* layer would: register
it in the Firestore `news_sources` registry (`content_license` reflecting
whatever the agreement actually grants, `content_type="forum_posting"`,
`fetch_method` would need a new `"scrape"` adapter since there's no RSS),
and add a `content_hash`-based incremental-classify step in a
`gov_news_poll.py`-style poller so re-running doesn't republish unchanged
posts. That's future work, contingent on a real agreement — not attempted
here.

## 8. Completed run log

The bounded sample seed has been run for real, once, against production.

**Discovery pass:** 196 candidates fetched across the 19 curated topics
(page 1 of each, per §2/§3).

**First pass:** `seed_immihelp.py --limit 100` → **published=100,
skipped=88, failed=0**. Tag quality spot-checked and looked accurate
(`h1b-petition`, `PERM`, `RFE`, `N-400`, `family-based-immigration`, etc.).

**Bug found during post-hoc verification** (`verify_immihelp_seed.py`,
written specifically to spot-check a completed run against the live
datastore — see §9): `news-update` is a real, LLM-selectable vocabulary
entry (`tags-cleaned/1.10-common-misc.csv`: *"Official government-agency
news/policy update (not a personal visa/status claim)"*), so `_extract()`
can choose it on its own for content that genuinely reads like
policy/news — independent of the caller's `content_type`. The original
`posting._gov_news_tags()` only ever **added** `news-update` for
`content_type=="news"`; for anything else it deduped but never **stripped**
an instance the model had already chosen, which is backwards from the
documented "can never be applied" guarantee.

This affected exactly 2 of the 100 published items — both genuinely
policy/news-shaped immihelp forum posts, not personal experiences:

- *"US visa fees going up for Indians in 2026- New Visa Integrity Fee"*
  (`immihelp-immihelp-2025-08-23-23c9ece5`) — still had a real personal
  visa/status tag underneath once `news-update` was stripped, so it
  correctly **remains published** after being deleted and republished
  with the fixed code.
- *"Introduction of the 540-Day Automatic Extension Rule for EAD"*
  (`immihelp-immihelp-2025-03-11-8cb8e60b`) — a pure policy announcement
  with no personal visa/status claim at all. Once `news-update` was
  correctly stripped, it failed `validate()`'s visa-required rule (the
  same rule `news-update` exists to bypass — §5) — i.e. it should never
  have been published in the first place, and the tag leak was the only
  reason it had slipped through. **Deleted, not republished**, and moved
  from `published` to `skipped` in the manifest.

**Fix:** `posting._gov_news_tags()` now explicitly strips `news-update`
for any `content_type != "news"`, not just avoids re-adding it — see the
function's docstring and `tests/test_posting_tagging.py` E45a/E45b.

**Final corrected state:** `published=99, skipped=89, failed=0`.
`verify_immihelp_seed.py --all` confirms all 99 live documents are clean
(correct `channel`/`source_system`/`ingestion_method`/`posting_date`, no
`news-update`, real `author_handle` present).

**Known residual, self-resolving:** both corrections' original (bad) rows
in `postings.postings_metadata` (BigQuery) couldn't be `DELETE`d
immediately — they were still inside BigQuery's streaming-buffer window
(`_write_bigquery()`'s `delete_existing` guard: `ingestion_timestamp <
NOW() - 90 MINUTE`) at correction time. This is a stray analytics-only
duplicate, not a live-serving issue (Discovery Engine + GCS were already
corrected) — any query following this codebase's established
latest-by-`ingestion_timestamp`-per-`case_id` dedup convention (the same
pattern `gov_news_poll.py`'s `_existing_hashes()` uses) already reads the
corrected row. Re-running the same `DELETE ... WHERE case_id = @case_id
AND ingestion_timestamp < NOW() - 90 MINUTE` for
`immihelp-immihelp-2025-08-23-23c9ece5` and
`immihelp-immihelp-2025-03-11-8cb8e60b` any time after the buffer window
passes will clean up the stray rows if that's ever worth doing.

## 9. Verifying a completed run

`scripts/curation/verify_immihelp_seed.py` re-fetches a sample (or
`--all`) of a manifest's published `case_id`s directly from the live
Discovery Engine datastore and confirms `channel`/`source_system`/
`ingestion_method`/`posting_date` match what was intended, `news-update`
never leaked in, and `author_handle` is present. This is what caught §8's
bug — run it after any future re-run of `seed_immihelp.py`, not just once:

```bash
cd backend && ../.venv/bin/python ../scripts/curation/verify_immihelp_seed.py --all
```
