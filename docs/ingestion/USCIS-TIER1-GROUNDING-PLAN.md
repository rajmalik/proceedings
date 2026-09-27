# USCIS.gov Tier-1 grounding — Milestone 1.5a (sitemap-scoped curated ingest)

Branch: `feature/grounding-uscis`. Closes the **uscis.gov** grounding loop before other agencies.
Builds on `USCIS-FORMS-INGESTION-PLAN.md` (16 pages already grounded) and `GROUNDING-INGESTION-PLAN.md`.
Registry: reflect changes in `GROUNDING-SOURCES.md` as pages land.

## Decision (settled by prior evidence)

**Tier-1 grounding of uscis.gov = curated `official_reference` ingest into DS-1** (`doc_kind=
official_reference`, gov tier, `source_tier="gov"`). Not the DS-2 website crawl, not live search:
- The 2026-09-20 spike (`USCIS-FORMS-INGESTION-PLAN.md` §"Spike (a) outcome") proved the **Vertex AI
  Search website data store is non-viable for uscis.gov** — effective grounding needs *advanced* site
  search, which requires **domain-ownership verification we cannot get** for uscis.gov; basic indexing
  grounded nothing usable. (This supersedes the generic "Option D — enable DS-2 `.gov` crawl" idea in
  `USCIS-LIVE-SEARCH-EVAL.md` **for uscis.gov specifically**.)
- Live Google Search grounding is ruled out for the authenticated in-app goal (mandatory off-app Search
  chips, redirect citations, 30-day data logging — see the live-search re-eval).
- The forms plan itself names **"option-B (sitemap-scoped ingest)"** as the viable broad path (no domain
  ownership needed). **This milestone is that path.**

## Scope

Extend the proven pipeline to cover uscis.gov **broadly but curated**: the high-value pages + their
sub-trees, chosen by real demand, ingested into DS-1, refreshed efficiently. One agency (uscis.gov) end
to end, with a **framework that carries to the next agencies** unchanged.

---

## 1. How to determine the high-value pages

Candidates come from the **uscis.gov sitemap**; ranking comes from **our own demand + coverage signals**
(not guesswork). A harvest script proposes a ranked list; a human reviews before anything is added.

**Candidate source:** `uscis.gov/sitemap` (HTML index) and `uscis.gov/sitemap.xml` (probe — most .gov
publish XML sitemaps with `<loc>`, `<lastmod>`, `<priority>`). Harvest all uscis.gov URLs + lastmod.

**Ranking signals (combine, highest first):**
1. **Demand — our query logs (best signal):** `query.py`'s Firestore Q&A log + AI-Assist **gov-tier
   misses / fallbacks** (questions where DS-1 didn't ground and we fell through). These are the *exact*
   pages whose absence hurts users. Mine top-missed topics → map to uscis pages.
2. **Coverage of our controlled vocab:** `tags-cleaned/` visa/form categories — ensure every tag we can
   assign has its authoritative uscis page grounded (forms, statuses, categories).
3. **Known high-traffic forms/topics** not yet grounded: I-129, I-539, I-90, N-400, I-131, H-1B,
   citizenship/naturalization, humanitarian, working-in-the-US, green-card-eligibility, key **Policy
   Manual** chapters.
4. **Sitemap hints:** `<priority>` / recency of `<lastmod>`.

**Process (curated, auditable):** `scripts/curation/harvest_uscis_sitemap.py` → emits a **ranked
candidate list** (`url, section, lastmod, score, why`) as CSV/JSON for **human review** → fetchability
dry-run each keeper (`scripts/seed_official_reference.py --url … --source-system uscis --title "…"`,
≥ `_MIN_WORDS` real body text) → add survivors to the config. **Never auto-add** (trust/stability over
coverage — the pipeline's stated non-goal).

## 2. Cost

Cheapest durable path — **no per-query grounding fee** (unlike live search) and only-on-change compute:
- **Per new/changed page:** 1 Gemini `_extract()` tagging call (flash, short prompt) + a GCS write + a
  Vertex `documents.import` + a BigQuery row. **Only on change** (content-hash skip), so most weekly runs
  are near-no-ops.
- **Steady state:** a few hundred uscis pages, tagged once then re-tagged only when a page actually
  changes → **Gemini tagging ≈ a few $/month at most**; DS-1 storage for small text docs is **negligible**
  (Vertex AI Search Enterprise edition is already provisioned for DS-1); per-search query cost is
  **unchanged** (we already pay it). Fetch/GCS/BigQuery are negligible.
- **One-time:** initial ingest tags every added page once (bounded by the curated set size).
- **Vs. alternatives:** avoids live-search per-request grounding fees and the enterprise website-search
  complexity that the spike showed doesn't even work for uscis.gov.

*(Firm the numbers once the candidate count is known; assumptions above: Gemini flash tagging, curated
set in the low hundreds, weekly poll.)*

## 3. Flexibility / config framework (carries to the next agencies)

Reuse the **config-driven registry** (`config/official_reference_sources.default.json`, `load_sources()`
re-read each run) — adding uscis pages or a **new agency next phase** is a JSON edit, **no code**
(`source_system` already namespaces agencies). Proposed **backward-compatible** enhancements for scale:
- **Firestore override for the registry** (the forms plan's named follow-up) → **deploy-free** source
  changes (today the JSON ships in the image → needs a redeploy). `load_sources()` already isolates the
  load point.
- **Optional schema fields** (ignored if absent): `category`, `refresh_cadence` (drives §5), and
  per-URL freshness metadata (`etag`/`last_modified`/`lastmod`) for §4.
- **Sitemap-section support:** a config entry may point at a sitemap section; the harvest script expands
  it into explicit, human-reviewed URL entries (scales curation without a live crawler).
- Framework is agency-agnostic: DOL/EOIR/CBP later reuse the same file + poller.

## 4. Efficiency — incremental change detection (don't re-index unchanged pages)

Layered, cheapest-check-first; today's content-hash is the backstop:
1. **Sitemap `<lastmod>` diff** — store last-seen `lastmod` per URL; **fetch only URLs whose lastmod
   advanced**. (Skips the vast static majority before any download.)
2. **HTTP conditional GET** — send `If-None-Match` (ETag) / `If-Modified-Since`; a **304** → skip download
   entirely. Persist `ETag`/`Last-Modified` per URL (BigQuery metadata or the Firestore registry).
3. **Content-hash** (already implemented in `publish_official_reference_item(skip_if_unchanged=True)`) —
   final backstop: a changed body upserts the **same** doc in place; unchanged → no-op. Catches changes
   not reflected in lastmod/ETag.

Result: a changed page is re-tagged/re-indexed exactly once; everything else is a cheap skip.

## 5. Efficiency — crawl cadence (don't poll static pages often)

- **Base:** the existing weekly Cloud Scheduler job `official-reference-poll` (Mon 07:00 ET) already
  refreshes the registry; content-hash makes re-runs cheap. **No new job needed** (uscis joins the run).
- **Enhancements:**
  - **Per-source `refresh_cadence`** in config (default **monthly** for stable form/policy pages;
    **weekly** for volatile ones) — the poller skips a source whose `last_checked` is within its cadence.
  - Combined with **§4 sitemap-lastmod + conditional GET**, static pages are effectively checked rarely
    and re-indexed only on real change.
- **Recommendation:** keep the single weekly job; add per-source `refresh_cadence` (default monthly) +
  the §4 lastmod/ETag gates → efficient by construction, no scheduler sprawl. (News/alerts stay on the
  separate `gov_news` RSS path; volatile data like processing times needs its own adapter — out of this
  milestone.)

---

## Implementation steps
1. **Harvest script** `scripts/curation/harvest_uscis_sitemap.py` — ✅ **built (read-only).** Fetches the
   uscis.gov sitemap index (~20k URLs), excludes already-grounded URLs + chrome/news/archives + archived
   `-<n>` monthly snapshots, ranks by §1 signals (section/form/keyword weights + optional `--demand-file`
   of query-log-miss terms + lastmod recency), and emits a ranked review list (`--format table|csv|json`,
   `--out`). Imports nothing from the backend; touches no GCP resource. First run: ~1,287 candidates ≥
   score 3 (down from ~3,077 before the archived-snapshot filter). **Next: human-review the top N.**
2. **Human review + fetchability dry-run** (seed driver) → select URLs that extract clean body text.
3. **Add verified URLs** to `official_reference_sources.default.json` (`source_system: uscis`), in
   batches by category (forms → green-card/family/work → citizenship/humanitarian → policy-manual).
4. **Efficiency (poller)** — add sitemap-`lastmod` gating + conditional GET (ETag/Last-Modified) +
   per-source `refresh_cadence`; unit tests (deterministic: 304 → skip; changed → upsert; cadence → skip).
5. **Flexibility (optional, recommended)** — Firestore override for the registry (deploy-free adds).
6. **Deploy + verify** — backend redeploy (config in-image until step 5), trigger the poll, verify via
   GCS + BigQuery (no Pub/Sub), smoke previously-ungrounded uscis questions (from the query-log misses)
   → now grounded, cited (raw uscis.gov), `tier=gov`.
7. **Update `GROUNDING-SOURCES.md`** section A as pages land (per the maintenance rule).

## Acceptance (close the uscis.gov loop)
- A curated, human-reviewed set of high-value uscis.gov pages + key sub-trees is grounded in DS-1
  (gov tier), chosen from **real query-log demand** + vocab coverage.
- Previously-ungrounded uscis questions now return **grounded, cited** gov-tier answers.
- Weekly poll runs are **near-no-ops** (only changed pages re-indexed), via lastmod/ETag/content-hash.
- Adding another uscis page — or the next agency — is a **config edit**, no code.

## Sequencing
Batch the curation (forms → green-card/family/work → citizenship/humanitarian → policy-manual key
chapters) until uscis.gov coverage clears the query-log misses; land the §4/§5 efficiency layer alongside
the first batch. **Only then** move to the next agency (DOL/EOIR/CBP) on the same framework.

## Operational model / deployment — cheapest, zero net-new GCP resources

**Nothing new is provisioned.** The whole milestone reuses resources that already run in prod:

| Concern | Reuses (existing) | New resource? |
|---|---|---|
| Compute / where it runs | **`immiguide-api` Cloud Run service**, via the existing internal route `POST /internal/official-reference/poll` (`official_reference_poll.poll_all`) | ❌ none |
| Trigger / schedule | **existing weekly Cloud Scheduler job** `official-reference-poll` (Mon 07:00 ET) — uscis pages just join the run | ❌ none |
| Grounding store | **DS-1** `imm-postings-datastore` (`doc_kind=official_reference`) | ❌ none |
| Sidecar / ingestion | **existing GCS** `gs://imm-postings-ingestion/…` | ❌ none |
| Dedup / freshness metadata | **existing BigQuery** `…postings.postings_metadata` (add etag/lastmod/last_checked columns) **or** existing Firestore | ❌ none (extend, don't add) |
| Source registry | in-image `official_reference_sources.default.json`; optional **existing Firestore** override collection | ❌ none |
| Harvest / ranking | local `scripts/curation/harvest_uscis_sitemap.py` (dev/curation tool, run on demand) | ❌ none |

So: **no new Cloud Run service, no new Cloud Run Job, no new Scheduler job, no new datastore/bucket/DB.**

**Two operational caveats (still no new resources):**
- **Config-in-image → redeploy to add sources.** Today `config/` is COPYed into the image, so adding
  uscis URLs needs a redeploy of the **existing** service (Cloud Build cost negligible). The optional
  **Firestore override** (reuses existing Firestore — new *collection*, not a new *resource*) makes adds
  **deploy-free**; `load_sources()` already isolates the load point.
- **Long synchronous poll vs Cloud Run request timeout.** A large curated set fetched sequentially in one
  HTTP request could approach Cloud Run's request timeout (default 300s). Mitigations, cheapest first,
  **all resource-free**: (1) the §4 lastmod/ETag gating means **steady-state runs skip almost everything**
  (fast); (2) add a `source`/batch param to the route so a big **initial backfill** runs in chunks
  (small code change); (3) raise the service's request timeout (config). A **Cloud Run Job** would fit a
  long batch but is **net-new** — treat as a last resort only if batch runtime becomes a real problem.

**Net:** operationally this is "add config + let the existing weekly job pick it up." The only compute is
weekly, on the existing service, and mostly no-ops after the first backfill (content-hash + lastmod/ETag).

## Deferred — demand-signal ranking (`--demand-file`) — revisit when query volume grows

**Decision (2026-09-27): deferred.** Current AI-Assist query volume is low, so a demand file derived from
real user misses would be too thin to rank the long tail meaningfully. Revisit once there's meaningful
query traffic. Until then, curate the remaining long tail from the controlled tag vocab / known top
topics (heuristic harvester ranking).

**Agreed design for when we build it** (so it's pick-up-ready):
- **Signal = misses only** — read the Firestore Q&A log (`query.save_qa_pair`), filter to
  `is_fallback == True` / `source_tier == "ungrounded"` (the exact gov-tier gaps). Optionally add light
  all-volume weighting later.
- **Question → terms via our controlled vocab** — map free-text questions to `tags-cleaned/` tags +
  form-number regex (e.g. `i-765`, `h-1b`, `opt`, `naturalization`), so terms match the URL slugs the
  harvester scores. (Not raw n-gram frequency.)
- **Privacy** — emit **only aggregated `term,count`** (no raw questions, no user IDs); the demand file
  lives in scratch / gitignored (never committed).
- **Source/infra** — a read-only `scripts/curation/export_query_demand.py` over the existing Firestore
  Q&A collection (no new GCP resource; ADC read). Defaults: last **90 days**, term freq **≥3** (flags).
- **Flow** — `export_query_demand.py` → `demand.csv` → `harvest_uscis_sitemap.py --demand-file` →
  demand-ranked candidate CSV for human review (no auto-add).
- **Trigger to revisit:** meaningful AI-Assist query volume with a usable count of `ungrounded`/fallback
  misses.

## Non-goals (this milestone)
- Processing times (`egov.uscis.gov` — 403/bot-blocked; needs a dedicated adapter — separate).
- Live "search uscis.gov" (the separate chat button / live-search re-eval).
- DS-2 website crawl for uscis.gov (proven non-viable — domain ownership).
- New agencies (next phase, same framework).
