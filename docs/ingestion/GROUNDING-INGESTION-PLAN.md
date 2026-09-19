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

A polled RSS source is just a Firestore doc in the `news_sources` registry; the existing
`gov_news_poll.poll_all()` (`gov_news_poll.py:238`, route `POST /internal/gov-news/poll`
`api.py:2154`) ingests it with **zero code change** when it is `fetch_method:"rss"` +
`content_type:"news"` + `content_license:"public_domain"`.

**Work:**
- [ ] Add a seed/registry step (mirror `news_sources.upsert_source()` `news_sources.py`) for new
      agency feeds. Candidates (verify each exposes a real RSS feed; US-gov works are public domain):
      USCIS newsroom, DOS / travel.state.gov visa news, DOL (OFLC), CBP, Federal Register
      (immigration docket). One `news_sources` doc each: `display_name, site_url, fetch_method:"rss",
      feed_url, source_category, content_license:"public_domain", content_type:"news", channel:"gov_news"`.
- [ ] Confirm each feed URL + license before enabling (`enabled:false` until verified).
- [ ] Trigger `POST /internal/gov-news/poll` (dev) → confirm docs land in DS-1
      (`channel="gov_news"`, `doc_kind="gov_news"`), dedup by `content_hash` works, thin-description
      fallback fires where needed.

**No new code path** unless a source is non-RSS (then it belongs in Phase 2's adapter work).
Dedup, thin-description fallback, and the two safety gates are already handled.

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
      `full_url=<official page>`, deterministic `case_id` (stable-id scheme).

### 2.3 Per-source fetch adapters (non-RSS)
`poll_source()` (`gov_news_poll.py:139`) only has an RSS adapter today ("no adapter yet" otherwise).
Add adapters, one per source, starting highest-value:
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
- [ ] Deterministic `case_id` per (source, period) so a new period **upserts/supersedes** cleanly
      (INCREMENTAL import is idempotent by `case_id`).
- [ ] Record fetch cadence per source; re-poll on schedule (Cloud Scheduler, same as gov-news).

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
  (new period supersedes old by `case_id`).

## Guardrails & constraints (this is a legal-advice-sensitive product)
- Authoritative docs are **factual statements with an as-of date + official-source citation** — the
  existing `query.py` guardrails (no eligibility determinations / legal advice) still apply.
- **No Pub/Sub** (established constraint) — monitor ingestion via **GCS + BigQuery** only.
- `channel` stays a fixed controlled token; the new dimension is `doc_kind`.

## Sequencing
1. **Phase 1** (fast win, low risk) — add + verify gov-agency RSS feeds.
2. **Phase 2, source-by-source** — start with **Visa Bulletin** (highest value, well-structured),
   then processing times, forms/fees, policy text.

## Open decisions (confirm before Phase 2 build)
- Exact Phase-1 feed list (which agencies) + verified RSS URLs.
- Phase-2 source order (proposed: Visa Bulletin → processing times → forms/fees → policy text).
- Auto-poll vs. review-gated publish for authoritative sources (recommend **review-gated**).
- Re-poll cadence per source.

## Related specs
`docs/ingestion/GOV-NEWS-INGESTION-PLAN.md` · `GOV-NEWS-MULTI-SOURCE-CONFIG.md` ·
`PATH-B-PROVENANCE-PLAN.md` · `IMMIHELP-SEED-PLAN.md` — extend these; don't duplicate.
