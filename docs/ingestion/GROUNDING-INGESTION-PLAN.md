# Grounding-ingestion plan (feature/grounding-ingestion, release 1.3.0)

Add **new ingestion sources for grounding** into the main datastore
**DS-1 = `imm-postings-datastore`**. Two scopes, confirmed:

1. **More gov-agency news** — widen the existing RSS `gov_news` pipeline to more agencies.
2. **Authoritative official data** — Visa Bulletin, USCIS processing times, forms/fees,
   policy text — **into DS-1, per-source** (decision below), via a new publish handler.

> **Decision D-A (locked):** Authoritative data is ingested **into DS-1 per-source**
> (new gov-news-style publish handler + new `doc_kind`), *not* the DS-2 public-reference
> fallback tier. Rationale: first-class in primary grounding + browse, reuses the mature
> `posting.py` publish spine. (DS-2 stays off; revisit only if authoritative volume balloons.)

Everything lands via the single publish spine already in `backend/posting.py`:
`build_canonical → validate → _write_gcs → _import_to_datastore(+_retry) → _write_bigquery`.
**Reuse it; do not reinvent.** Filter on `doc_kind` (not `channel` — `channel` is unindexed).

---

## Phase 1 — More gov-agency news (config-first, near-zero code)

> **Current production baseline (verified 2026-09-19).** USCIS is **already live** — the
> `news_sources` registry has a single enabled source `uscis`
> (`https://www.uscis.gov/news/rss-feed/59144`, since 2026-07-26). BigQuery shows **278 unique
> articles / 335 rows, latest today**, arriving **1–4 new items/day** — i.e. ingestion is genuinely
> **incremental** (content-hash dedup + INCREMENTAL datastore upsert), not full-feed re-pulls. So the
> pipeline is proven end-to-end in prod, and **Phase 1 = add the *other* agencies, NOT re-add USCIS.**
>
> *Known minor issue:* ~17% duplicate rows (an unchanged item occasionally re-inserted with the same
> `content_hash`) exist **only in the BigQuery analytics table** — likely a streaming-buffer timing gap
> in the gov-news delete-before-insert. **No grounding impact** (DS-1 is idempotent by `case_id`).
> Small hardening item: make `_write_bigquery`'s edit-delete robust to the streaming buffer (or
> MERGE-upsert) so the analytics table stays 1-row-per-article.

A polled RSS source is just a Firestore doc in the `news_sources` registry; the existing
`gov_news_poll.poll_all()` (`gov_news_poll.py:238`, route `POST /internal/gov-news/poll`
`api.py:2154`) ingests it with **zero code change** when it is `fetch_method:"rss"` +
`content_type:"news"` + `content_license:"public_domain"`.

**Verified feeds** (researched 2026-09-19; US-gov works are public domain). Add one `news_sources`
doc each (`fetch_method:"rss"`, `content_type:"news"`, `content_license:"public_domain"`,
`channel:"gov_news"`), `enabled:false` until a dev poll confirms it:

| Source | Feed URL | Status | Scope |
|---|---|---|---|
| USCIS — All News | `https://www.uscis.gov/news/rss-feed/59144` | ✅ **ALREADY INGESTING** (registry `uscis`, enabled since 2026-07-26) | Immigration, agency-wide — **baseline, do NOT re-add** |
| USCIS — Forms updates | `https://www.uscis.gov/forms/forms-updates/rss-feed` | ⚠️ found, not fetch-verified | Immigration forms |
| Federal Register — USCIS | `https://www.federalregister.gov/api/v1/documents.rss?conditions[agencies][]=u-s-citizenship-and-immigration-services` | ✅ verified live | USCIS rulemaking, **agency-scoped (cleanest)** |
| Federal Register — other imm agencies | same URL, swap agency slug: `u-s-immigration-and-customs-enforcement`, `u-s-customs-and-border-protection`, `executive-office-for-immigration-review` | pattern verified | Immigration rulemaking, agency-scoped |
| DOL (OFLC) | hub `https://www.dol.gov/rss` (OFLC-specific feed unconfirmed) | ⚠️ **broad** | Labor — **not immigration-scoped → needs relevance filter** |
| CBP newsroom | hub `https://www.cbp.gov/about/rss` | ⚠️ **broad** | Customs/border — **needs relevance filter** |
| DOS / travel.state.gov visa news | — | ❌ **no RSS found** | Move to Phase-2 scraper; Visa Bulletin is HTML anyway |

**Recommended Phase-1 NEW work (USCIS already done):** the **Federal Register agency-scoped feeds**
(USCIS/ICE/CBP/EOIR — clean, low-noise) are the immediate add. **DOL/CBP** newsroom hubs only *after*
the relevance filter (below) is in place. **DOS** has no RSS → defer to Phase 2.

**Work:**
- [ ] Add the verified feeds above via `news_sources.upsert_source()` (`news_sources.py`), `enabled:false`.
- [ ] Enable + trigger `POST /internal/gov-news/poll` (dev) per source → confirm docs land in DS-1
      (`channel="gov_news"`, `doc_kind="gov_news"`), `content_hash` dedup works, thin-description
      fallback fires where needed.

**No new code path** unless a source is non-RSS (then it belongs in Phase 2's adapter work).
Dedup, thin-description fallback, and the two safety gates are already handled.

---

## Immigration-relevance filter (REQUIRED — applies to both phases)

**Gap in the current pipeline:** `gov_news_poll` has **no topic gate** — the only gates are
`content_license == "public_domain"` and `content_type == "news"` (`news_sources.py:56-62`). Every
item from an enabled feed is published; `_extract()` *tags* items but never *drops* off-topic ones.
So a broad agency feed (DOL, CBP, Federal Register general) would leak **non-immigration** content
into the immigration RAG and degrade grounding. The sources are U.S.-gov and immigration-*intended*,
but nothing today guarantees immigration-*only*.

**Fix — a two-layer relevance gate before publish:**
1. **Prefer tightly-scoped feeds** (agency-scoped Federal Register, USCIS newsroom) so there is little
   off-topic content to begin with — the cheapest control.
2. **Add `_is_immigration_relevant(item) -> bool`** applied in `gov_news_poll.poll_source()`
   (`gov_news_poll.py:139`) **before** `posting.publish_gov_news_item()`, for *both* gov-news and
   authoritative sources:
   - **Deterministic pre-filter (free):** keyword/allow-list on title+summary — e.g. `visa`,
     `green card`, `USCIS`, `naturalization`, `asylum`, `H-1B`, `I-\d{3}`, `priority date`,
     `adjustment of status`, `permanent resident`, consulate names. Drop obvious misses.
   - **Optional LLM check (borderline only):** reuse the Gemini client (`_extract`) to classify
     immigration-relevant yes/no; drop on no. Keep it to items that pass step 1 but are ambiguous, to
     bound cost.
   - Per-source override: a `skip_relevance_filter:true` flag on already-immigration-only feeds
     (e.g. the USCIS feeds) to avoid needless LLM calls.
- [ ] Add the filter + a `relevance_gate` counter to the poll summary (dropped vs published).
- [ ] **Test:** fixture with on- and off-topic items from a broad feed → only on-topic items publish.

> This gate is what makes "official U.S.-gov feeds" actually mean "U.S.-immigration content." Enable
> the broad feeds (DOL/CBP) **only after** it's in place.

---

## Phase 2 — Authoritative official data (DS-1, per-source, new doc_kind)

Structured/reference data (Visa Bulletin, processing times, forms/fees, policy text) does **not**
fit the news-article model, so it gets its own kind + handler + adapters.

### 2.1 New content kind + gate
- [ ] Add **`doc_kind = "official_reference"`** — indexable/filterable, distinct from `gov_news`.
- [ ] Add **`content_type = "official_reference"`** to `VALID_CONTENT_TYPES` (`news_sources.py:62`)
      and a matching gate value in `get_enabled_sources()` (`news_sources.py:81`). **Given accuracy
      stakes, gate authoritative sources behind an explicit review flag** (not the open
      auto-publish path used for `news`).

### 2.2 New publish handler
- [ ] `publish_official_reference_item()` in `posting.py`, modeled on `publish_gov_news_item()`
      (`posting.py:1848`): skip `scrub_pii`/`moderation` (official content); run `_extract()` for
      tags; override `canonical["doc_kind"]="official_reference"`;
      `ingestion_method="official_fetch"`, `source_system=<agency slug>`,
      `full_url=<official page>`, `case_id = official-{source_system}-{sha8(url)}` (URL-only → one
      stable doc per page; a changed page upserts in place).

### 2.3 Per-source fetch adapters (non-RSS)
`poll_source()` (`gov_news_poll.py:139`) only has an RSS adapter today ("no adapter yet" otherwise).
Add adapters, one per source. **Confirmed first source (evaluated 2026-09-19):**
- [ ] **ICE SEVIS** — `https://www.ice.gov/sevis` (F/M/J student & exchange visas, SEVP/SEVIS, I-901
      fee, OPT). Authoritative ICE.gov, public domain, immigration-relevant. It's a
      **narrative/landing page (~1.2–1.5k words) → lowest adapter effort** (single-page body fetch à la
      `_fetch_full_article_text`, no table parsing) — a good **minimal first slice** to prove the
      `official_reference` path end-to-end. Also pull its substantive sub-pages (Study in the States,
      SEVIS Help Hub) for depth; carry an explicit **"as of {date}"** note (it has a "What's New"
      banner + rule updates → regulation-currency risk).

Then the highest-value structured sources:
- [ ] **Visa Bulletin** (monthly HTML tables @ travel.state.gov) — parse priority-date tables.
- [ ] **USCIS processing times** — per form/office estimates.
- [ ] **Forms & fees** — USCIS forms/fee schedule.
- [ ] **Policy text** (narrative) — fits the article model directly; lowest adapter effort.

### 2.4 Structured → text rendering (critical)
Grounding a chatbot on a raw table is unreliable. For tabular sources, **render deterministic
factual text docs** with an explicit as-of date, e.g.:
> "As of the {Month Year} Visa Bulletin, the Final Action Date for F2A, {country} is {date}. Source: {url}."
- [ ] Rendered text → DS-1 (via the handler above). Keep the exact structured rows in BigQuery/Firestore
      too if precise lookups are later needed behind a dedicated endpoint.
- [ ] Every rendered doc carries `posting_date`/`last_updated` and an **as-of date in the body**, so
      answers cite "as of {date}" and stale data is visible.

### 2.5 Freshness / supersession
Authoritative data changes on a cadence (Visa Bulletin monthly; processing times rolling; fees on
updates). Wrong/stale official data is worse than none.
- [x] **One stable doc per URL (IMPLEMENTED).** `case_id = official-{source_system}-{sha8(url)}` —
      keyed on the URL only, **not** the date — and the GCS object + BigQuery row are keyed the same
      way (delete-before-insert). So a changed page **upserts the same doc in place**; there are never
      dated versions to orphan, and `as_of_date` is just metadata (defaults to today). Periodic sources
      (e.g. the monthly Visa Bulletin) get one doc *per month naturally* because each month is a
      distinct URL.
- [x] **Dedup guardrail IMPLEMENTED** (`publish_official_reference_item(skip_if_unchanged=True)`): a
      re-run over an unchanged page is a **no-op** — it compares the page's `content_hash` (the same
      `content_hash_for()` fingerprint gov-news uses) against the last-stored hash for
      (source_system, url) and skips before `_extract()`/GCS/datastore/BigQuery. So "same source,
      unchanged content, next run → skipped"; changed content upserts the one stable doc.
- [x] **Scheduled poll BUILT** — `official_reference_poll.py` (`SOURCES` registry + `poll_all`) and the
      internal route `POST /internal/official-reference/poll` (same `_require_internal` secret as
      gov-news). Verified working on a candidate Cloud Run revision (both docs returned, secret-gated).
- [ ] **Remaining (post-merge, post-prod-deploy): create the Cloud Scheduler job.** The route only
      serves once this code is merged (PR) and deployed to the **prod serving revision** — today prod
      is pinned to an older `candidate` revision, so the route 404s on the live URL until then. After
      it's live in prod, create the weekly job (mirrors `gov-news-poll-uscis`):
      ```bash
      SECRET=$(gcloud scheduler jobs describe gov-news-poll-uscis --location us-central1 \
        --format="value(httpTarget.headers.X-Internal-Poll-Secret)")
      gcloud scheduler jobs create http official-reference-poll --location us-central1 \
        --schedule="0 7 * * 1" --time-zone="America/New_York" --http-method=POST \
        --uri="https://immiguide-api-971592620882.us-central1.run.app/internal/official-reference/poll" \
        --headers="X-Internal-Poll-Secret=$SECRET"
      ```
      Weekly is ample (reference pages change rarely; unchanged runs are no-ops via the content-hash
      guardrail). Then `gcloud scheduler jobs run official-reference-poll` once to seed, and confirm the
      docs in DS-1/BigQuery.

> **Decision D-B (2026-09-19):** `ice.gov/sevis` stays on the **`official_reference`** path, NOT
> `gov_news` — it is evergreen student-visa *reference*, not time-bound *news*, so it is deliberately
> **not** shown in the News tab and **not** tagged `news-update`. (If ICE *news* is wanted later, the
> true USCIS-equivalent is ICE's own feed `ice.gov/rss/ice-breaking-news` as a `gov_news` source —
> but that's enforcement news, off-topic for applicants, and needs the relevance filter.)

---

## Retrieval-side wiring (both phases)

- [ ] Add the new `doc_kind`(s) to browse/News filters (`api.py:1786`). **`official_reference` is
      evergreen — do NOT apply the gov_news 7-day free-text carve-out** (`api.py:1823-1824`); it should
      be searchable always.
- [ ] Surface any new card fields in `_card_from_struct()` (`search_client.py:258`).
- [ ] (Optional) authority boost for `official_reference` via `_boost_spec()` (`search_client.py:83`) —
      on the `doc_kind`/retrievable field, never `channel`.

## Reuse map (do NOT duplicate)
`build_canonical` (`posting.py:1296`) · `content_hash_for` (`posting.py:1287`) · `_write_gcs`
(`posting.py:1473`) · `_import_to_datastore`+`_retry` (`posting.py:1515`/`1498`) · `_write_bigquery`
(`posting.py:1640`) · `_extract`/`suggest_tags` · `validate` (`posting.py:1199`) · `delete_content`
(`posting.py:2150`) · `news_sources` registry + `gov_news_poll` framework.

## Tests
- **Phase 1:** extend `test_news_sources.py` (new registry rows pass the gates); integration: poll picks
  up a `test-*` source and it lands in DS-1; cleanup.
- **Phase 2:** deterministic adapter unit tests (sample Visa-Bulletin/processing-times fixture → exact
  rendered text) · a publish test for `publish_official_reference_item()` (mirror
  `test_posting_tagging.py` group E/G) · a grounding e2e (mirror `test_grounding_e2e.py`) proving an
  authoritative doc is retrieved **and cited**, with synthetic-doc cleanup · a **freshness** test
  (re-ingesting a changed page upserts the one URL-keyed `case_id` in place).

## Guardrails & constraints (this is a legal-advice-sensitive product)
- Authoritative docs are **factual statements with an as-of date + official-source citation** — the
  existing `query.py` guardrails (no eligibility determinations / legal advice) still apply.
- **No Pub/Sub** (established constraint) — monitor ingestion via **GCS + BigQuery** only.
- `channel` stays a fixed controlled token; the new dimension is `doc_kind`.

## Sequencing
1. **Phase 1** (fast win, low risk) — add + verify gov-agency RSS feeds.
2. **Phase 2, source-by-source** — prove the `official_reference` path with the **ICE SEVIS** narrative
   page (smallest slice, no parsing), then the highest-value structured source **Visa Bulletin**, then
   processing times, forms/fees, policy text.

## Open decisions (confirm before Phase 2 build)
- Phase-1 feeds: USCIS + Federal Register (agency-scoped) are **verified** and ready; decide whether
  to include DOL/CBP (broad — only after the relevance filter) and confirm the USCIS Forms feed.
- Phase-2 source order (proposed: Visa Bulletin → processing times → forms/fees → policy text).
- Auto-poll vs. review-gated publish for authoritative sources (recommend **review-gated**).
- Re-poll cadence per source.

## Related specs
`docs/ingestion/GOV-NEWS-INGESTION-PLAN.md` · `GOV-NEWS-MULTI-SOURCE-CONFIG.md` ·
`PATH-B-PROVENANCE-PLAN.md` · `IMMIHELP-SEED-PLAN.md` — extend these; don't duplicate.
