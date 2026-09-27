# Exploration — grounding strategy: authenticated, latest US-immigration knowledge as a one-stop shop

Status: **exploration / spike** (branch `explore/mcp-server-option`). Supersedes the MCP-only scan in
[`mcp-immigration-grounding.md`](mcp-immigration-grounding.md) with a broader grounding strategy.
No code — evaluation + gap analysis + recommendation.

## Goal

Make the app a **one-stop shop for the latest, authenticated US-immigration information** — grounding
our Vertex AI answer path on **government (Tier-1) sources first**, kept current, legally, so users get
answers based on the newest authoritative info. Priority: **operational facts first** (visa bulletin,
processing times, case status, alerts), **legal interpretation second** (INA / 8 CFR / Federal Register
/ Policy Manual / BIA).

---

## 1. Key finding: we already have the right architecture — extend it, don't rebuild

The codebase already ingests and grounds government content. There is **one datastore** — DS-1
`imm-postings-datastore` — holding community postings *and* official content, tagged by a `doc_kind`
field. The AI-Assist **gov tier** retrieves official docs via the filter
`doc_kind: ANY("gov_news","official_reference")` (`backend/assist.py:222`). Two proven ingestion paths
already feed it:

- **`official_reference` poller** (`backend/official_reference_poll.py`, config
  `backend/config/official_reference_sources.default.json`) — fetches static official pages, extracts
  body text, content-hash upserts one doc per URL via `posting.publish_official_reference_item()`
  (`doc_kind="official_reference"`), with a **public-domain-only** gate and a
  `meridianjourney-grounding-bot/1.0` UA.
- **`gov_news` poller** (`backend/gov_news_poll.py`) — RSS newsroom feeds → `publish_gov_news_item()`
  (`doc_kind="gov_news"`), gated to `content_license="public_domain"` + `content_type="news"`; sources
  live in the Firestore `news_sources` collection.

Both are triggered by internal poll routes (Cloud Scheduler), already grounded in the RAG answer path,
and already feed the mobile **News** tab.

**Implication:** filling the gaps is mostly **adding sources/adapters to an existing, compliant
pipeline** — not a new grounding technology. MCP is optional (see §3).

---

## 2. Non-MCP grounding options (MCP is not required)

Per Google's docs, a Vertex AI Agent can ground several ways — MCP is one delivery option, not a
prerequisite:

| Mechanism | Best for | Fit for us |
|---|---|---|
| **Vertex AI Search / Discovery Engine data store** (website URLs + unstructured PDF/HTML; one-time, periodic, or **near-real-time GCS streaming**) | curated, refreshable corpus of gov pages/PDFs | ✅ **primary — it's what DS-1 already is** |
| **Vertex AI RAG Engine** | DIY managed corpus | alternative, more ops |
| **Grounding with Google Search** | live public web, "latest" | ⚠️ less authenticated/controllable; we already have a `.gov`-restricted web tier (off by default) |
| **Function calling** | live official **APIs** (Case Status, Federal Register, eCFR) | ✅ **for live facts** that shouldn't be pre-indexed |
| **MCP server (via Agent Registry)** | plug-and-play tools/actions; StreamableHTTP + registry | optional wrapper over the above |

**Recommendation:** keep the **Vertex AI Search datastore (DS-1) as the primary grounding store**
(extend the pollers to fill gaps), and add **function-calling adapters** for live APIs. Reserve MCP for
if/when we want to expose these as portable tools (details in the MCP doc). No MCP dependency to ship
value.

---

## 3. Government Tier-1 gap analysis (what's grounded vs. the gaps)

### Already ingested + grounded today
| Source | Coverage | Path |
|---|---|---|
| **USCIS** (`uscis.gov`) | 10 static pages: AR-11, addresschange, I-765, I-140, I-485, I-130, adjustment-of-status, EAD, visa-availability & priority dates, family | `official_reference` (config) |
| **ICE** (`ice.gov/sevis`) | SEVP/SEVIS | `official_reference` |
| **DHS Study in the States** (`studyinthestates.dhs.gov/students`) | student info | `official_reference` |
| **USCIS newsroom** (RSS) | alerts/news | `gov_news` (Firestore-configured) |

### Capable-but-off (already wired, just disabled)
- **DS-2 web crawl** (`imm-public-reference-datastore`, `PUBLIC_WEBSITE`): targets `uscis.gov`,
  `travel.state.gov`, `dol.gov` (+ law-firm sites) — tier-3 fallback, **off** (`GCP_VERTEX_PUBLIC_ENGINE_ID` unset).
- **Live Google Search web tier**: `.gov`-restricted, **off** (`AI_ASSIST_WEB_SEARCH=0`).

### Gaps — authoritative gov sources NOT ingested/grounded
| Gap | Source | Priority | How to ground |
|---|---|---|---|
| **Visa Bulletin** (priority dates) | travel.state.gov (monthly) | **P1 (ops)** | monthly fetch → `official_reference`-style adapter (note: travel.state.gov blocks naive fetchers — needs a resilient fetch; see `scripts/seed_official_reference.py:58`) |
| **Processing times** | egov.uscis.gov | **P1 (ops)** | ⚠️ official page WAF-blocks bots, no clean API — decide: resilient fetch vs. caveated aggregator |
| **Case status** | USCIS Case Status **API** (developer.uscis.gov, authenticated) | **P1 (ops)** | **function-calling adapter** (live, per-user; do not pre-index) |
| **Federal Register** (rules/notices) | federalregister.gov **API** (daily, JSON) | P2 (legal) | scheduled API adapter → new `doc_kind` (e.g. `federal_register`) |
| **Title 8 CFR** | eCFR **API** (current) | P2 (legal) | API adapter → datastore |
| **BIA/AAO precedent** | DOJ EOIR | P2 (legal) | PDF ingest (heavier) |
| **DOL** (PERM/LCA/foreign labor) | dol.gov / flag.dol.gov | P2 | add to `official_reference` config |
| **CBP / DHS OHSS** | cbp.gov, ohss.dhs.gov | P3 | add to config as needed |
| **More USCIS** (Policy Manual, forms beyond the 10, fees) | uscis.gov | P2 | expand `official_reference` config |

**Fastest wins (reuse the existing pipeline):** add `dol.gov`, more USCIS pages, and the **Visa
Bulletin** to `official_reference_sources.default.json`; add a **Federal Register / eCFR API adapter**
(clean official APIs) as new `doc_kind`s; add a **Case Status function-calling** tool for live per-user
status.

---

## 4. Legal / copyright — what we can ground, and how (this gates the whole thing)

- ✅ **US federal government works are public domain** — 17 U.S.C. §105. USCIS/State/DOL/EOIR/Federal
  Register **text** is generally free to ingest, store, and even republish. This is the legal basis for
  Tier-1 = government.
- ⚠️ **"Public domain ≠ unlimited republish" — carve-outs to respect:**
  - **Licensed images on USCIS.gov are NOT public domain** (owner retains copyright); only State Dept
    **photos** are PD. → **ingest text, not images**, unless individually cleared.
  - **Third-party content embedded on gov sites** isn't automatically PD.
  - **ToS / robots.txt / CFAA** still govern *how* you fetch — prefer **official APIs / bulk data**
    over scraping; identify the bot (we already use `meridianjourney-grounding-bot/1.0`); respect
    robots.txt and rate limits.
  - USCIS requests a **byline/credit** — we should **attribute + link to the official source** on every
    grounded answer/article (also good UX + trust).
- ✅ **Our pipeline already enforces this:** the pollers gate on `content_license="public_domain"` and
  official source lists — a strong compliance foundation to build on. **Keep the public-domain-only
  gate; add sources within it.**
- **Guardrail interaction:** our product must not give legal advice / eligibility determinations —
  grounding on authoritative text must feed *informational* answers with citations, not adjudication.

**Net:** government Tier-1 grounding is **legally clean** (text, public-domain-gated, official-source,
attributed, API-preferred). The compliance risk lives in the *non-government* enrichment (§5).

---

## 5. Immigration-lawyer communities / blogs — enrichment, with real legal limits

Surveyed top sources: **AILA** ("Think Immigration" blog, AILALink), **Murthy** (blog + forum),
**Trackitt**, **AM22tech**, **VisaJourney**, **ILW / Immigration Daily**, **Reddit** (r/immigration,
r/USCIS), Cyrus Mehta / Wolfsdorf blogs, Feedspot's "100 best immigration blogs."

**The catch — these are NOT free to ingest:**
- **AILA content is explicitly copyrighted**: no reproduction/reposting **without prior written
  permission** (books@aila.org), attribution required, unedited, one-time-use grants; AILALink is a
  paid subscription. **Cannot scrape into the corpus.**
- Forums/blogs are third-party **copyrighted** and carry **user-generated-content + PII** concerns
  (real names, case details). Reposting risks copyright **and** privacy issues.
- We already ingest one community source — **immihelp** (`immihelp_seed.py`) — as a bounded, manual,
  clearly-sourced community seed (not government, kept separate by `doc_kind`).

**How they actually help (legally):**
1. **Topic/question signal** — mine them (read, don't republish) to learn *which* questions and forms
   matter most, and prioritize our **government** grounding accordingly.
2. **Licensing / partnership** — AILA/Murthy content could be licensed for grounding via agreement
   (out of scope for a scrape; a BD conversation).
3. **Fair-use snippets with attribution** — narrow, risky; get counsel sign-off before any.

**Recommendation:** treat lawyer/forum content as **prioritization signal and a licensing opportunity,
not a free ingestion source.** The one-stop-shop's *authenticated* corpus should be **government**;
community/lawyer material stays clearly separated, permissioned, and attributed.

---

## 6. Recommended phased plan

- **Phase 1 (fast, reuse pipeline):** extend `official_reference_sources.default.json` with **DOL**,
  the **Visa Bulletin**, and more **USCIS** pages; verify each is public-domain + fetchable; confirm the
  monthly refresh cadence. Attribute + link on answers.
- **Phase 2 (official APIs):** add adapters for **Federal Register** and **eCFR** (clean APIs → new
  `doc_kind`s) and a **USCIS Case Status** function-calling tool (live, per-user).
- **Phase 3 (harder sources):** resilient **processing-times** fetch (decide official-vs-aggregator),
  **BIA/AAO** PDF ingest, **CBP/DHS-OHSS** as needed; consider enabling the **DS-2 web crawl** for broad
  `.gov` coverage as a fallback tier.
- **Cross-cutting:** keep the public-domain gate; per-source legal check (PD text only, no licensed
  images, respect robots/ToS, prefer APIs, attribute); "not legal advice" guardrail intact; monthly
  freshness monitoring so "latest" is real.

## 7. Open questions

- ☐ **Processing times**: official page is bot-blocked and has no clean API — resilient fetch of the
  official page, or a labeled unofficial aggregator with a freshness caveat? (Top P1 authenticity risk.)
- ☐ **Visa Bulletin fetch**: travel.state.gov blocks naive fetchers — needs a resilient method
  (headless/allowed UA) or a State Dept feed if one exists.
- ☐ **Enable DS-2 web crawl** (set `GCP_VERTEX_PUBLIC_ENGINE_ID`) for broad `.gov` fallback, or keep
  curated-only for tighter authenticity? (Crawl pulls law-firm sites too — a quality/authenticity call.)
- ☐ **Refresh cadence + monitoring**: who/what guarantees monthly Visa Bulletin & processing-times
  refresh, and alerts on staleness?
- ☐ **Lawyer content**: pursue an AILA/Murthy licensing conversation, or stay government-only for the
  authenticated corpus?
- ☐ **MCP vs. datastore-native**: do we ever need to expose this as an MCP tool (portability, external
  agents), or is DS-1 + function-calling sufficient? (See the MCP doc.)

## Sources
- Current-state architecture: `backend/official_reference_poll.py`, `backend/gov_news_poll.py`, `backend/posting.py` (publish_*/import), `backend/assist.py:222` (`_GOV_FILTER`), `backend/config/official_reference_sources.default.json`, `backend/scripts/provision_ds2_website.py`.
- Vertex grounding options — Google Cloud docs via Developer Knowledge API (Vertex AI Search / RAG Engine / Grounding with Google Search / function calling).
- Copyright: 17 U.S.C. §105 — https://uscode.house.gov/view.xhtml?req=(title:17%20section:105%20edition:prelim) ; ARL brief — https://www.arl.org/wp-content/uploads/2015/06/copyright-status-of-government-works.pdf ; USCIS Website Policies — https://www.uscis.gov/website-policies ; State Dept External Link/Copyright — https://www.state.gov/external-link-policy-and-disclaimers ; DOL external linking — https://www.dol.gov/general/aboutdol/external-policies
- Official APIs/sources: Federal Register API — https://www.federalregister.gov/developers/documentation/api/v1 ; eCFR API — https://www.ecfr.gov/developers/documentation/api/v1 ; USCIS Case Status API — https://developer.uscis.gov/api/case-status ; Visa Bulletin — https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html ; USCIS processing times — https://egov.uscis.gov/processing-times/
- Lawyer/community: AILA — https://www.aila.org/ ; AILA Copyright/Reprint — https://www.aila.org/copyright ; Think Immigration blog — https://www.aila.org/blog ; Feedspot top immigration blogs — https://bloggers.feedspot.com/immigration_law_blogs/
