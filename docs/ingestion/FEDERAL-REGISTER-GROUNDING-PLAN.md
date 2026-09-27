# Federal Register grounding — plan

**Branch:** `feature/grounding-federalregister` (off `feature/gov-grounding-expansion`).
**Status:** PLAN — no code, no Firestore write, no deploy yet.
**Goal:** ground the assistant on the **latest official US-immigration rules and notices** (final rules,
proposed rules, TPS designations and terminations, fee notices) from the Federal Register, and only those.
Ingest each document **once**. Never re-process unchanged content.
**Registry:** `GROUNDING-SOURCES.md` section B, "Federal Register — immigration rules/notices".

All numbers below were measured live against `federalregister.gov/api/v1` on **2026-09-27**.

---

## 1. Why the Federal Register (recap)

- It is the **official daily journal of the US Government**, published by the National Archives (OFR/GPO).
  A rule legally takes effect through its publication here.
- Documents are **public domain** (17 USC §105) and there is an open JSON API with no key. We send a
  polite user agent (`meridianjourney-grounding-bot/1.0`) and attribute plus link every document.
- It fills the **"latest" gap**: USCIS pages describe the current process, while the Federal Register
  records *what changed and when it takes effect*.

## 2. What the measurements showed

| Candidate selector (last 12 months) | Docs | Immigration precision | Verdict |
|---|---|---|---|
| USCIS agency RSS, raw | 43 in feed | **1/43** (42 are paperwork notices) | ❌ ruled out |
| Agency filter USCIS+ICE+EOIR+**CBP**, all types | 277 | low (CBP = customs, trade, gauger labs) | ❌ drop CBP |
| **Topics** `aliens,immigration,passports-visas,citizenship-naturalization` | 64 | ~55%: also Medicaid, AML, stablecoin, FLSA | ❌ too loose |
| **CFR Title 8** (Aliens & Nationality), any agency | 49 | **~90%**, mostly rules and proposed rules | ✅ rules selector |
| 20 CFR 655 / 656 (DOL: LCA, H-2, PERM), 24 months | 12 / 1 | high | ✅ add |
| 22 CFR 41 / 42 (State: NIV/IV visas), 24 months | 3 / 4 | high | ✅ add |
| Notices from USCIS+ICE+EOIR, **excluding PRA/Privacy/meeting** by `action`+title, 24 months | 168 → **~38** | **~100%**: TPS, parole, fees, EAD, civics test | ✅ notices selector |

Two facts drive the design:
1. **Rules and notices need different selectors.** Rules carry `cfr_references` (8 CFR, and so on), so
   they are precisely selectable, and the big ones are filed under **DHS (the parent agency)**, not USCIS.
   Notices (TPS, parole terminations, fee adjustments) carry **no CFR reference**; the only reliable
   handle is the issuing immigration agency.
2. **The noise is Paperwork Reduction Act notices.** Their `action` field is literally
   `"30-Day notice."` / `"60-Day notice."`, and the title often names the form or the collection.
   One regex over `action + title` removes them.

## 3. Method evaluation — which is most efficient

| Option | Precision | Freshness | Cost per run | New infra | Effort | Decision |
|---|---|---|---|---|---|---|
| A. Raw agency RSS → existing `gov_news` RSS path | ❌ ~2% | daily | 1 req | none | none | **Rejected** (would pollute the gov tier: PRA "I-765" notices outrank the real I-765 page) |
| B. RSS + title filter | medium (misses DHS-parent rules; ICE/EOIR RSS empty) | daily | 3–4 req | none | low | Rejected (structurally misses the major rules) |
| **C. FR JSON API, two server-side selectors + exclusion + ID dedup** | **~95%** | daily (day-of) | **2 API req + 1 BQ query**; full text fetched **only for new docs** | **none** | medium (one adapter) | ✅ **Recommended** |
| D. Public Inspection API (pre-publication, the day before) | same as C | T−1 day | +1 req | none | low add-on | Phase 2 (docs are unofficial until published; may change) |
| E. eCFR Title 8 (consolidated regulatory text) | 100% | as amended | large | new doc_kind | high | Separate project (the "what the law says now" tier; see §10) |
| F. govinfo bulk XML | 100% | daily | large, parse XML | none | high | Rejected (C gives the same data, already filtered) |

**Why C is the most efficient:**
- **Filtering happens on the server.** The API returns only candidate documents (about 1–3 per week).
  We never download or parse the ~500/yr DHS documents or ~250/yr CBP documents we don't want.
- **Nothing is fetched for known documents.** The document ID set is checked *before* any full-text
  fetch or Gemini call.
- **It uses the metadata the API already structures:** `abstract`, `action`, `effective_on`,
  `comments_close_on`, `cfr_references`, `regulation_id_numbers`, `correction_of`, `html_url`,
  `raw_text_url`. No HTML scraping and no fragile selectors, unlike the USCIS-Drupal path.
- **It reuses everything:** the same daily scheduler job, endpoint, secret, publish path, doc_kind and
  gov-tier filter.

## 4. Immigration-only filter (four layers, all deterministic, no LLM)

**L1 — two server-side selectors (union, de-duplicated by `document_number`):**
- **R (rules):** `type ∈ {RULE, PRORULE}` AND `cfr_references` intersects the **CFR allowlist**:
  - 8 CFR (all parts except the L3 denylist)
  - 20 CFR 655, 656 (DOL: LCA/H-1B, H-2A/H-2B, PERM)
  - 22 CFR 40, 41, 42 (State: visa rules)

  This means one API query per CFR clause (4–5 cheap calls), or a single call per title with the part
  filter.
- **N (notices):** `type = NOTICE` AND `agencies ∈ {u-s-citizenship-and-immigration-services,
  u-s-immigration-and-customs-enforcement, executive-office-for-immigration-review}`.
  **CBP is excluded** (it is almost entirely customs and trade).

**L2 — PRA/administrative exclusion** (applied to `action + " " + title`):
`\b\d+-day notice\b | information collection | collection of information | currently approved collection
| paperwork reduction | privacy act | system of records | \bmeeting\b | sunshine act`

**L3 — CFR-part denylist for non-immigrant noise inside 8 CFR:** port-of-entry and vessel/crew
housekeeping (e.g. airport or seaplane-base designations, bridge ports of entry, vessel forms, lightering).
Start by denying 8 CFR **100** (port designations) plus title patterns
`port of entry | seaplane base | user fee airport | lightering | vessel`. Tune these from the backfill
dry-run.

**L4 — belt-and-braces guard (per document):** keep only if it has **≥1 positive signal**: an allowlisted
CFR part, an immigration agency, or an immigration keyword in the title or abstract. A document from
selector R with no immigration signal at all is logged as `filtered:no_signal` and skipped.

Every skipped document is **counted by reason** in the run summary (`filtered_pra`, `filtered_cfr_deny`,
`filtered_no_signal`), so precision stays observable.

**Expected steady-state volume:** about 55 rules/yr plus about 19 notices/yr, roughly **75 docs/yr
(about 1–2 per week)**. The 24-month backfill is about **150 docs**.

## 5. Incremental strategy (never re-ingest unchanged content)

**Key property: Federal Register documents are immutable once published.** A correction, delay,
withdrawal or final rule is a **new document** with its own `document_number` (corrections are `C1-…`,
`C2-…` and point to the original via `correction_of`). So incremental ingest needs **no content
hashing of the source**; a new-ID check is enough.

| Concern | Design |
|---|---|
| **Identity** | `source_item_id = document_number` (unique, immutable). `case_id` is deterministic, as with gov_news, so a retry can never duplicate. |
| **What's new** | **Stateless rolling window + ID set.** Each run queries `publication_date >= today − 21 days` and loads the known IDs for `source_system="federal-register"` from BigQuery (the existing `_existing_hashes()` query). New = returned − known. |
| **Why a window, not a stored watermark** | No new state or resource. It is idempotent, and it self-heals after up to about 3 weeks of missed or failed runs. It also catches late API indexing. The 21-day overlap costs about 2 tiny API calls. |
| **Unchanged docs** | Skipped **before** any `raw_text` fetch, Gemini tag call, or GCS/Discovery Engine/BigQuery write, so an unchanged run is zero-cost except for about 5 metadata calls and 1 BQ query. |
| **Our own derived changes** (e.g. we change the digest format, or mark a proposed rule superseded) | Edits happen only through **explicit triggers**: a supersession event (§6.3) or a manual `--force-reformat` CLI flag. Both use the existing `is_edit=True` delete-before-insert path. No blind re-hashing. |
| **Per-run cap** | At most **25 publishes per scheduled run**. The gov-news HTTP route runs under Cloud Run's 300 s timeout (see the 2026-07-27 hang notes in `gov_news_poll.py`). Anything over the cap simply stays "new" and publishes the next day. |
| **Backfill** | One-time **CLI run**, not the HTTP route: `poll_gov_news.py --source federal-register --since 2024-09-27 --dry-run`, then a real run. It is chunked and resumable for free, because every published ID becomes "known". |
| **Failure** | If one document fails, it is logged and skipped and retries on the next run (its ID is still unknown). If the API is down, the source is skipped for that run and other sources are unaffected. |

## 6. What gets stored (content model)

### 6.1 Placement — reuse, no schema change
- `doc_kind = "gov_news"`, which means it is already inside the assist gov tier
  (`_GOV_FILTER`, assist.py) and the News tab. No datastore schema change and no filter change.
- `source_system = "federal-register"`, `channel = "gov_news"`, `ingestion_method = "api"`,
  `author_handle = "Federal Register (<agency>)"`, `full_url = html_url`,
  `posting_date = publication_date`.

### 6.2 A bounded "operational digest", not the full text
DS-1 parses **whole documents with no chunking** (verified: `digitalParsingConfig`, no `chunkingConfig`),
and rules run from 300 to more than 24,000 words. A full-text document would dilute retrieval and send a
very large prompt to the Gemini tagger. So each doc body is a **digest capped at about 2,500 words**,
ordered **operational facts first, legal interpretation second**:

```
[FINAL RULE | PROPOSED RULE — NOT IN EFFECT | NOTICE | CORRECTION] <title>
Agencies · Action · Published <date> · Effective <effective_on | "n/a">
Comments close <comments_close_on> (proposed rules) · CFR: 8 CFR 214, 274a … · RIN/Docket
Federal Register citation + document number · Official text: <html_url>

SUMMARY: <abstract>
DATES: <dates>
KEY EXCERPT: <first ~1,800 words of SUPPLEMENTARY INFORMATION / Executive Summary, from raw_text_url>

Source: Federal Register (National Archives). Public domain. Not legal advice. Read the official text.
```

- **Tagging (Gemini `_extract`) runs on the header plus SUMMARY only**, which is cheap and reflects the
  topic. This needs one small, backward-compatible change: an optional `tag_text` parameter on
  `posting.publish_gov_news_item`.
- **Corrections** (`C1-…`) are ingested as their own small document titled
  "Correction: <original title>", linking to the corrected document.

### 6.3 Proposed rules vs. final rules (safety-critical)
- Proposed rules are ingested with an explicit **"PROPOSED — NOT IN EFFECT"** status line, so the
  assistant never presents a proposal as current law.
- **Supersession (Phase 1.5):** when a final rule arrives with the same `regulation_id_numbers` (RIN) as
  an ingested proposed rule, republish the proposed rule (as an `is_edit`) with the header
  "SUPERSEDED by final rule <link>, effective <date>".

## 7. Where it plugs in (zero net-new GCP resources)

- **Code:** `backend/federal_register_poll.py` (the adapter: selectors, L2–L4 filter, digest builder).
  `gov_news_poll.poll_source()` dispatches `fetch_method="federalregister_api"` to it. Today that
  function already returns `skipped` for any non-RSS `fetch_method`, so it is **safe by default**.
- **Selector config:** version-controlled `backend/config/federal_register_selectors.json` (CFR
  allowlist and denylist, notice agencies, exclusion regex, lookback days, per-run cap). This is
  trust-sensitive, so it lives in git like the official_reference config. It ships in the image and
  needs a redeploy to change.
- **On/off switch:** a Firestore `news_sources` entry `federal-register`
  (`fetch_method="federalregister_api"`, `content_license="public_domain"`, `content_type="news"`,
  `enabled`). Existing gates are untouched.
- **Trigger:** the existing **daily** job `gov-news-poll-uscis` (06:00 ET, no `source` param, polls
  every enabled source). No new scheduler job. Documents published that morning are caught on the next
  day's run, well inside the 21-day window.
- **Unchanged:** the endpoint, secret, datastore, schema and assist filter.

## 8. Tests (no GCP; hand-rolled check()/SUMMARY harness; wired into CI)

`backend/tests/test_federal_register.py`, using recorded API fixtures (JSON) and no network:
- **Filter:** PRA "60-Day notice." and "Currently Approved Collection" are dropped; a TPS termination
  notice is kept; a CBP gauger notice never selected; an 8 CFR seaplane-base rule denied by L3; a
  Medicaid rule is `no_signal`; a DOL 20 CFR 655 rule is kept; a State 22 CFR 41 visa rule is kept.
- **Incremental:** a known ID means no raw-text fetch and no publish (assert the fetch stub was never
  called); a new ID publishes exactly once; a rerun is a no-op; the per-run cap defers the rest; a
  correction `C1-…` is its own ID.
- **Digest:** the header order is correct; a proposed rule carries "NOT IN EFFECT"; the word cap is
  enforced; `tag_text` excludes the excerpt.
- **Supersession:** a final rule with a matching RIN triggers an edit of the proposed doc.
- **E2E, deterministic:** stub `search_client.answer_query`, then check that a TPS question produces a
  gov-tier answer citing `federalregister.gov/d/<docnum>`.
- **Regression:** the existing gov_news RSS path is unchanged, and existing suites pass.

## 9. Rollout (respects the no-deploy and no-main-merge holds)

1. Build the adapter, config and tests on this branch, then PR into `feature/gov-grounding-expansion`.
2. **Local dry-run** against the live API (read-only): print selected, filtered-by-reason and digest
   samples for 24 months, then hand-review precision and tune L3.
3. At the umbrella release (after coordinating with the mobile developer): merge to main, then deploy
   the backend.
4. **Backfill** through the CLI (dry-run first, then real) with `--since 2024-09-27`.
5. **Enable:** create the Firestore `federal-register` source (needs explicit go-ahead; this is the
   go-live switch).
6. **Verify:** the next daily run shows `new: 0–3, filtered_*` counts; spot-check assist answers for
   TPS and H-1B fee questions.
7. Update `GROUNDING-SOURCES.md` in the same change: move the row from B to A.

## 10. Risks and open items

| Risk | Mitigation |
|---|---|
| Proposed rule presented as law | "NOT IN EFFECT" status line + supersession (§6.3); the assist guardrail still forbids eligibility determinations |
| Rule stayed or enjoined by a court (not in the Federal Register) | Out of scope for this source. The digest says "check official text", and the USCIS newsroom (already grounded) usually posts court-driven changes. Flag for a future court-status source. |
| Precision drift (new noise patterns) | Per-reason filter counters in every run summary, plus L3/L2 in version-controlled config |
| API outage or rate limits | 5 calls per run and a polite UA; the source is skipped on error; the 21-day window self-heals |
| Large doc diluting retrieval | Digest cap about 2,500 words; full text is linked, not indexed |
| "Current law" questions (what 8 CFR says today) | Not this source. eCFR Title 8 adapter (Option E) is the follow-up |

**Deferred:** Public Inspection (T−1 day) pre-publication alerts (Option D) and the eCFR Title 8
consolidated-text tier (Option E).
