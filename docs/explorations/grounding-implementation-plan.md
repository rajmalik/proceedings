# Implementation plan — extend gov grounding (execution)

Status: **actionable plan** (branch `explore/mcp-server-option`). Executes the gaps from
[`grounding-strategy.md`](grounding-strategy.md) **on top of the existing** master plan
[`../ingestion/GROUNDING-INGESTION-PLAN.md`](../ingestion/GROUNDING-INGESTION-PLAN.md) — do **not**
duplicate that; this sequences concrete, verifiable work items against the code as it is today.

**Architecture reuse (confirmed):** one datastore **DS-1** (`imm-postings-datastore`), gov content
tagged `doc_kind` and retrieved by the gov tier (`assist.py:222` `_GOV_FILTER`). Two proven,
public-domain-gated pollers already feed it — `official_reference_poll.py` (static pages, config
`config/official_reference_sources.default.json`) and `gov_news_poll.py` (RSS, Firestore
`news_sources`). Every gap below is an **extension** of these, not new grounding tech. MCP not required.

> **Where to build:** these are code/config changes → do them on a **feature branch off `main`**
> (`feature/gov-grounding-expansion`), not this exploration branch. This doc is the plan; it links the
> milestones to exact files, tests, deploy, legal checks, and acceptance criteria.

---

## Milestone 1 — Config-only wins (no code): expand `official_reference` + `gov_news`

**Effort: S · Risk: low · reuses proven pipeline.**

### 1a. Add USCIS + DOL static reference pages
Edit `backend/config/official_reference_sources.default.json` (schema: `{url, title, source_system,
author}`; each entry MUST be public-domain US-gov, immigration-relevant, reasonably static). Candidate
additions (fetchability-verify each per `docs/ingestion/USCIS-FORMS-INGESTION-PLAN.md` first — the poll
skips a source that fails to fetch, so a bad entry is non-fatal):
- **USCIS forms/topics not yet covered:** `i-129`, `i-539`, `i-90`, `n-400`, `i-131`, H-1B page,
  `working-in-the-united-states`, `humanitarian`, the **processing-times explainer** page
  (`egov.uscis.gov/processing-times` narrative — see M3 for the live *data*), USCIS **fee** pages.
- **DOL foreign-labor / PERM:** `dol.gov/agencies/eta/foreign-labor` (+ PERM/LCA/prevailing-wage
  subpages). Public domain; verify fetchability (may need the resilient fetch of M3).
- **DHS/OHSS, CBP** entry pages if relevant (P3).

**Tests:** extend `backend/tests/test_official_reference.py` — new config rows load, have required
fields, and `source_system` slugs are stable. **Acceptance:** `poll_all(dry_run=True)` returns
`published`/`skipped` (not `failed`) for each new URL; a live poll indexes them (`doc_kind=
"official_reference"`), and the gov tier answers a question they cover with a citation.

### 1b. Add Federal Register agency-scoped RSS to `gov_news`
Per the master plan, **Federal Register agency feeds are verified and RSS-ready** → add via the
Firestore `news_sources` registry using `scripts/curation/manage_news_sources.py` (no code) — gated by
`content_license="public_domain"` + `content_type="news"` and the immigration-relevance filter. Covers
new **rules/notices** as `doc_kind="gov_news"`.
**Acceptance:** poll picks up a recent USCIS/DHS Federal Register rule; it appears in the gov tier + News tab.

---

## Milestone 2 — Official-API adapters (Phase-2 path): live/current facts

**Effort: M · Risk: medium · new code, but clean official APIs.** Follows master-plan §2.3 (per-source
fetch adapters) + §2.4 (structured→text rendering). Each adapter renders structured JSON → clean text,
then calls the **existing** `posting.publish_official_reference_item(...)` (or a sibling
`publish_*` with a new `doc_kind`).

### 2a. Federal Register API adapter (P2 legal)
- New `backend/federal_register_poll.py` — query the official REST API
  (`federalregister.gov/api/v1`) for immigration-agency documents since last run; render each to text;
  upsert. Consider `doc_kind="federal_register"` (or reuse `official_reference`).
- **Tests:** deterministic fixture (sample API JSON → exact rendered text + doc id). **Acceptance:**
  a known FR document is retrievable via the gov tier with a citation to federalregister.gov.

### 2b. eCFR (Title 8 CFR) adapter (P2 legal)
- Adapter over the official eCFR API (`ecfr.gov/api`) for Title 8; chunk part→section; upsert.
- **Acceptance:** an 8 CFR section is grounded and cited.

### 2c. USCIS Case Status — **function-calling tool** (P1 ops, per-user, live)
- Do **not** pre-index. Add a live tool (agent function-call / a thin backend endpoint) over the
  official **USCIS Case Status API** (`developer.uscis.gov`, **authenticated — OAuth/API key**).
- Store the credential like other secrets (env/Secret Manager); never in the datastore.
- **Acceptance:** asking "status of receipt # …" calls the API live and returns the official status
  (not a grounded doc). Respect the "not legal advice" guardrail.

---

## Milestone 3 — Hard sources (resilient fetch / structured rendering)

**Effort: M–L · Risk: medium-high.** Master-plan §2.3–2.5.

### 3a. Visa Bulletin (P1 ops)
- **Fetchability caveat:** `travel.state.gov` blocks naive fetchers (`scripts/seed_official_reference.py:58`).
  Options: an allowed-UA/headless fetch, or the monthly HTML page parsed to text. Monthly cadence.
- Render the priority-date charts → **text tables** (structured→text is critical for grounding).
  Consider `doc_kind="visa_bulletin"` with `as_of_date` + **supersession** (master-plan §2.5) so only
  the current month is authoritative.
- **Acceptance:** current-month cutoffs are grounded + cited; last month is superseded, not duplicated.

### 3b. Processing times (P1 ops — the biggest authenticity risk)
- Official `egov.uscis.gov/processing-times` is **WAF-blocked to bots, no clean API**. **Decision
  required** (open question): resilient fetch of the official page **vs.** a clearly-labeled unofficial
  aggregator with a freshness caveat. Prefer official; label provenance either way.
- **Acceptance:** processing-time answers cite the source + an `as_of_date`; provenance is explicit.

### 3c. BIA/AAO precedent (P2 legal, heavier) & CBP/OHSS (P3)
- PDF ingest (DOJ EOIR) — larger effort; schedule after the above.

---

## Milestone 4 — Cross-cutting (do alongside, not last)

- **Freshness/monitoring:** Cloud Scheduler cadence per source (Visa Bulletin monthly, processing
  times ~monthly, Federal Register daily, static pages weekly); add a **staleness alert** so "latest"
  is real. Wire the two internal poll routes' scheduled jobs (they exist; confirm/adjust schedules).
- **Legal gate (keep enforcing):** public-domain-only; **text not images** (USCIS licensed images are
  not PD); respect robots.txt/ToS (prefer official APIs; keep `meridianjourney-grounding-bot/1.0` UA;
  rate-limit); **attribute + link** the official source on every grounded answer/article. See
  `docs/ingestion/APIFY-SCRAPER-LEGAL-AND-INTEGRATION.md`.
- **Guardrail:** informational answers with citations only — no legal advice / eligibility calls.
- **Retrieval wiring:** confirm each new `doc_kind` is included in the gov tier filter (`assist.py`
  `_GOV_FILTER`) and, where appropriate, the News tab recency rules (master-plan "retrieval-side wiring").

---

## Explicitly NOT in scope (from the strategy doc)
- **Lawyer/forum content (AILA, Murthy, VisaJourney, Reddit, …):** copyrighted + UGC/PII → **not
  ingested**. Use only for topic-prioritization signal and a possible **licensing** conversation. The
  authenticated corpus stays government-first. (immihelp remains the one bounded community seed.)
- **A new MCP server / new datastore:** unnecessary — DS-1 + the pollers + function-calling suffice.

## Sequencing & sizing
1. **M1 (days):** config-only USCIS/DOL pages + Federal Register RSS — fastest authenticated coverage.
2. **M2a/2b (≈1 wk):** Federal Register + eCFR API adapters (clean, deterministic, testable).
3. **M2c (≈days):** Case Status function-calling (needs the authenticated USCIS API credential).
4. **M3a (≈1 wk):** Visa Bulletin adapter (resilient fetch + supersession).
5. **M3b decision → build:** processing times (resolve official-vs-aggregator first).
6. **M4 continuous:** scheduling, freshness alerts, legal gate, attribution.

## Acceptance for the whole effort
For each priority-#1 fact (visa bulletin, processing times, case status) and the key legal sources
(Federal Register, 8 CFR), a user question is answered from an **authenticated government source**,
**cited + linked**, **current** (within the source's cadence, with `as_of_date`), and **without legal
advice** — delivering the "one-stop shop for the latest authenticated info" goal.

## Open decisions to confirm before building (carried from strategy §7)
- Processing-times source (official resilient fetch vs. labeled aggregator).
- Visa Bulletin fetch method (allowed-UA/headless vs. feed).
- Enable the default-off **DS-2 web crawl** for broad `.gov` fallback, or stay curated-only?
- Refresh cadence + staleness alerting owner.
- Pursue AILA/Murthy **licensing**, or stay government-only?
