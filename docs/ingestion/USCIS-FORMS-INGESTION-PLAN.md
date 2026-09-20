# USCIS forms / how-to ingestion into `official_reference`

**Goal.** Ground the common "which form / how do I…" answers (e.g. **AR-11** for a
change of address) on authoritative USCIS pages so the AI Assist answer path
returns a *grounded, cited* answer instead of falling through to labelled model
knowledge. This is the durable fix for the hallucination class we saw ("what
form for change of address with an I-140 filed?" → the grounded tier had only
tangential I-865 news, so it declined and fell through to ungrounded).

This reuses the existing `official_reference` pipeline end to end — no new
ingestion machinery, just new **sources** (now configurable) + a fetch caveat.

## What already exists (reused as-is)

- **Publish path:** `posting.publish_official_reference_item()` — one stable doc
  per URL (`case_id = official-{source_system}-{sha8(url)}`), `doc_kind=
  official_reference`, content-hash dedup (skips unchanged pages), GCS + DS-1 +
  BigQuery. (`docs/ingestion/GROUNDING-INGESTION-PLAN.md` §2.5.)
- **Fetch + poll:** `official_reference_poll.py` — `fetch_page_text()` strips
  chrome and extracts body text; `poll_all()` upserts every registered source,
  logging + skipping any that fail (never fatal).
- **Schedule:** Cloud Scheduler → `POST /internal/official-reference/poll`
  (secret-gated). Weekly job already runs.
- **Relevance filter:** the tagging step drops non-immigration content; a page
  that yields no immigration tags is not force-tagged.
- **Configurable registry (new, this change):**
  `config/official_reference_sources.default.json`, loaded by
  `official_reference_poll.load_sources()` (override via
  `OFFICIAL_REFERENCE_SOURCES_PATH`). Add/remove a source by editing the JSON —
  no code change. Version-controlled so the trust-sensitive set stays auditable.

## USCIS pages — verified + added to the config (2026-09-20)

Fetchability-checked with `official_reference_poll.fetch_page_text` (extracted
word count in parens). The six that extract clean body text are now in
`config/official_reference_sources.default.json` (`source_system: uscis`):

| Purpose | URL | status |
|---|---|---|
| Change of address / AR-11 | `https://www.uscis.gov/ar-11` | ✅ added (515w) |
| Change of address (overview) | `https://www.uscis.gov/addresschange` | ✅ added (1451w) |
| Form I-765 (EAD) | `https://www.uscis.gov/i-765` | ✅ added (3965w) |
| Form I-140 | `https://www.uscis.gov/i-140` | ✅ added (1272w) |
| Form I-485 (AOS) | `https://www.uscis.gov/i-485` | ✅ added (2679w) |
| Form I-130 | `https://www.uscis.gov/i-130` | ✅ added (2982w) |
| Check case processing times | `https://egov.uscis.gov/processing-times/` | ❌ 403 (bot-blocked) — needs an adapter; deferred |

(Extend incrementally; each addition is one JSON entry. Keep it to genuinely
static, authoritative pages — not news, not application flows.)

## Refresh cadence (Cloud Scheduler) — no new job

**Determination: the existing weekly Cloud Scheduler job refreshes these.** There
is already a job `official-reference-poll` (Mondays 07:00 ET) → `POST
/internal/official-reference/poll` → `official_reference_poll.poll_all()`, which
now iterates the **config-driven** source registry (`load_sources()`, re-read on
every run). So adding USCIS to the config means the **same job** keeps uscis.gov
grounded — **no new scheduler job is needed**; USCIS just joins the existing run.

- **Dedup:** `publish_official_reference_item(skip_if_unchanged=True)` — an
  unchanged page is skipped via the content-hash guardrail, so a weekly re-run is
  a cheap no-op; a changed page re-publishes one stable doc per URL.
- **Deploy note:** the config ships **inside the image** (`config/` is COPYed at
  build), so today adding/removing a source needs a backend redeploy for prod to
  see it. Follow-up: a Firestore override (à la `attribute_config`) would make
  source changes **deploy-free** — `load_sources()` already isolates the load
  point for that.
- **Constraint:** no Pub/Sub — verify a run via GCS + BigQuery.

## The one real risk: fetchability

USCIS pages are often JS-rendered and/or bot-protected; a plain `requests.get`
may return a near-empty shell or a 403 (the seed script already notes
travel.state.gov blocks simple fetchers). Because of that:

1. **Verify each candidate first** with the seed driver in dry-run:
   `python scripts/seed_official_reference.py --url <URL> --source-system uscis --title "…"`.
   Confirm it extracts ≥ `_MIN_WORDS` of real body text (not nav/boilerplate).
2. **If a page doesn't extract cleanly**, options (in order of preference):
   - a slightly richer fetch (browser-like User-Agent — already set; add
     `Accept-Language`, follow redirects) — cheap, try first;
   - a **dedicated adapter** per domain (e.g. render with a headless browser, or
     target a specific content container) — only for pages worth the effort;
   - **skip it** — the poll already logs + skips a thin/blocked source, so a bad
     URL in the config is safe (it just never publishes).
3. Only add a URL to the **active** config once it extracts real content.

## Rollout

1. Land the configurable-registry change (done).
2. For each candidate: dry-run the seed driver; keep the ones that extract well.
3. Add the verified URLs to `config/official_reference_sources.default.json`.
4. Trigger the poll once (Cloud Scheduler `run` or the internal route) and verify
   in GCS + BigQuery (per the standing "monitor GCS + BigQuery" convention).
5. Smoke: ask the AI Assist the form question again — it should now answer from a
   grounded `official_reference` doc with a citation (tier=gov), not fall through
   to ungrounded.

## Spike (a) outcome — website data store NOT viable for uscis.gov (2026-09-20)

Ran the option-(a) spike (`scripts/spike_public_website_datastore.py`): a Vertex
AI Search **website data store** scoped to five USCIS areas (processing-times,
adjustment-of-status, EAD, priority-dates, family). Findings:

- Website search is an **ENTERPRISE-edition** feature (a STANDARD engine 400s
  with *"Cannot use enterprise edition features"*). Fixed the engine to
  enterprise.
- Even on enterprise, search + answer returned **0 chunks / fallback**, and the
  target sites never left `INDEXING_STATUS_UNSPECIFIED` (~30 min). Effective
  grounding needs **advanced site search** (crawl-based indexing), which requires
  **verifying domain ownership** in Search Console — **impossible for uscis.gov**
  (we don't own it). Basic (unverified) indexing didn't ground anything usable.

**Conclusion:** the website-data-store path is **blocked** for uscis.gov. Spike
resources were torn down.

**Pivot (implemented):** ground the specific area pages through the proven DS-1
`official_reference` pipeline (same one that grounds AR-11). Fetchability-checked
2026-09-20 — added to the config:

| Area | URL | status |
|---|---|---|
| Adjustment of status | `…/adjustment-of-status` | ✅ added (1312w) |
| EAD | `…/employment-authorization-document` | ✅ added (1098w) |
| Priority dates | `…/visa-availability-and-priority-dates` | ✅ added (1564w) |
| Family | `https://www.uscis.gov/family` | ✅ added (163w) |
| Processing times | `https://egov.uscis.gov/processing-times` | ❌ 403 (bot-blocked) — needs a dedicated adapter; deferred |

So 4 of the 5 areas are grounded via DS-1 (curated, our Cloud Scheduler refresh).
The egov processing-times page (and any broader open-ended coverage) remains the
**option-B (sitemap-scoped ingest)** territory if/when wanted — that's the viable
broad path since it needs no domain ownership.

## Non-goals / notes

- Not a general web crawler; only a curated, auditable set of authoritative
  pages. Trust and stability over coverage.
- Not live search — this pre-ingests pages. Open-ended "search uscis.gov live"
  remains the separate chat button ("Search on USCIS.gov").
- Per the standing constraint: **no Pub/Sub** — monitor via GCS + BigQuery.
