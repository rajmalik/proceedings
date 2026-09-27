# Exploration — external MCP server as a grounded US-immigration source for our Vertex AI Agent

Status: **exploration / spike** (branch `explore/mcp-server-option`). No code — a landscape scan,
feasibility check, and recommendation.

## Goal

Find an **external, public MCP server grounded in authoritative, current US-immigration knowledge**
(USCIS / DHS / State Dept / INA / 8 CFR / BIA) that we can wire into our **Vertex AI Agent on GCP
as a grounding source** — so the agent answers from trusted, up-to-date immigration facts instead of
stale training weights. "Authenticated" is read as **authoritative + access-controlled**.

**Priority (decided):** **operational facts first** (visa bulletin / priority dates, processing
times, case status, alerts), **legal interpretation second** (INA / 8 CFR / Federal Register /
Policy Manual / BIA precedent).

## 1. How Vertex AI Agents consume an external MCP server (authoritative — Google docs)

Confirmed via Google's own documentation (Developer Knowledge API):

- A Vertex AI Agent **can** use an external MCP server as a tool/grounding source, but **direct
  connections are deprecated** — you now go through the **Agent Registry**:
  1. Deploy/host the MCP server (e.g. Cloud Run / Cloud Functions).
  2. **Register it in the Agent Registry.**
  3. In Agent Studio → Tools → **"MCP Server from Agent Registry"** → pick location + server + an
     **Auth Config** (e.g. "None" = standard IAM bindings, or an auth config for authenticated servers).
- **Hard requirements on the server:** an **HTTP endpoint** using **StreamableHTTP transport**. **SSE
  is not supported**, and **stdio/local servers won't work** — they must be hosted HTTP.
- Grounding on our **existing Vertex AI Search datastore** is *also* now MCP-based — via the built-in
  **Agent Search MCP** (`discoveryengine.googleapis.com`) in the Agent Registry (a unified search
  across data stores; the old direct datastore tool is deprecated).
- **MCP vs Vertex AI Search grounding:** Vertex AI Search = verifiable live facts from indexed
  docs/sites; MCP = broader (fetch data **and** take actions/use prompts from a backend). They compose.

**Implication:** any external immigration MCP we adopt must be (or be wrapped as) a **hosted
StreamableHTTP endpoint** and **registered in Agent Registry**. A stdio/OSS server can't be plugged
in as-is — we'd deploy it to Cloud Run first.

## 2. Landscape of external immigration-knowledge MCP options

### Tier A — Community / open-source immigration MCP servers (unofficial)
Wrap official sources; great for prototyping, **not warranted/authenticated** for production.
| Server | Grounds on | Transport | Notes |
|---|---|---|---|
| `immigration-mcp` (tushariitr-19) | live Visa Bulletin, priority-date checker, USCIS news, term explainer | stdio (self-host) | operational facts, current |
| `uscis-mcp` (viniciussouzax) | USCIS regulations, form doc reqs, processing times, **full USCIS Policy Manual**, BIA precedent | stdio (self-host) | broadest official-knowledge coverage |
| `us-immigration-mcp` (sebastianomarchesini) | EB1A / EB2-NIW petition tooling | stdio (self-host) | narrow (employment-based) |
| "Immigration and Travel" (martc03) | State Dept visa bulletins, CBP border wait times | connector listing | travel-oriented |

Reality: all are individual/community projects, **self-hosted**, mostly **stdio**, no SLA, and they
**scrape/wrap** gov sites (ToS/rate-limit/staleness risk). Usable only after we host them on Cloud
Run + confirm StreamableHTTP.

### Tier B — Commercial legal-research MCPs (authoritative US law, hosted, auth'd)
From the MCP registry — hosted HTTPS MCP endpoints, citation-backed, subscription/auth:
- **Descrybe Legal Engine** — "Ground your work in clean, structured U.S. primary law."
- **Paxton Legal Research** — US case law + administrative decisions, verifiable citations.
- **Thomson Reuters CoCounsel Legal**, **Midpage**, **Legal Data Hunter** (23M+ docs, 160+ jurisdictions).

These cover **US primary law** (INA / 8 CFR / BIA & AAO precedent) authoritatively **but are general
legal, not immigration-operational** — they won't give you the live Visa Bulletin, case processing
times, or form-specific guidance. They're a strong **legal-interpretation** layer, not an ops layer.
(They're listed as *Claude* connectors, but MCP is an open standard — their HTTPS endpoints could, in
principle, be registered in Agent Registry with an auth config; needs per-vendor confirmation of
StreamableHTTP + external-use terms.)

### Tier C — Official authoritative data (NOT MCP — we'd wrap it)
- **USCIS Developer Portal** — official APIs (e.g. Case Status API). Official but **narrow scope**, not MCP.
- **State Dept Visa Bulletin**, **Federal Register** (immigration rules), **USCIS Policy Manual** — authoritative primary sources, no official MCP.

There is **no official, first-party USCIS/DHS MCP server** today.

## 2A. Where does the knowledge actually come from? (provenance, authenticity, freshness)

Short answer: **the underlying knowledge is overwhelmingly official US-government information** — but
the *MCP servers that expose it* are, with rare exception, **unofficial intermediaries** that scrape or
aggregate the gov sources, add their own cache lag, and ship explicit no-warranty disclaimers. "Is it
government knowledge?" → **the authoritative sources are, yes.** "Are the MCP servers themselves
authenticated/official?" → **no** (there is no first-party USCIS/DHS MCP).

### Operational facts (priority #1) — the authoritative sources
| Fact | Authoritative source | Host / who | Gov? | Access | Freshness | How the community MCPs get it |
|---|---|---|---|---|---|---|
| Priority dates / cutoffs | **Visa Bulletin** (travel.state.gov) | US Dept of State, Visa Control & Reporting | ✅ .gov | HTML page; **no official API** | **Monthly**, issued ~2nd–3rd week | scrape the monthly page |
| Case **processing times** | egov.uscis.gov/processing-times | USCIS (DHS) | ✅ .gov | official page is **behind a Cloudflare WAF that blocks non-browser clients**; no open API | ~monthly, **data ~1 month old** (80% of cases over trailing 6 mo) | ⚠️ **`uscis-mcp` pulls from `immigrationtimes.org` — an UNOFFICIAL aggregator**, "not operated by the government," precisely because the official endpoint is bot-blocked |
| **Case status** | **USCIS Case Status API** (developer.uscis.gov) | USCIS (DHS) | ✅ .gov | **official REST API, requires auth (API key / OAuth)** | near real-time | not covered by the community MCPs surveyed |
| News / alerts | USCIS Newsroom (uscis.gov) | USCIS (DHS) | ✅ .gov | HTML / RSS | as published | scrape newsroom |

### Legal interpretation (priority #2) — the authoritative sources
| Source | Host / who | Gov? | Access | Freshness |
| **Title 8 CFR** (Aliens & Nationality) | **eCFR** (ecfr.gov), Office of the Federal Register / NARA | ✅ .gov | **official REST API** | current / near real-time |
| Rules, proposed rules, notices | **Federal Register** (federalregister.gov), NARA | ✅ .gov | **official REST API (JSON, docs since 1994)** | **daily** |
| **USCIS Policy Manual** | USCIS (DHS) | ✅ .gov | HTML (no API) | updated as policy changes |
| **BIA / AAO precedent** (~3,150 decisions, 1955–) | DOJ EOIR | ✅ .gov | PDFs (scrape/OCR) | as issued |
| INA (statute) | Congress; mirrored on uscis.gov, Cornell LII, govinfo.gov | ✅ gov/academic | HTML | as amended |

### What this means for "authentic" and "up to date"
- **Authenticity of the *data*: high** — it originates from State Dept, USCIS/DHS, NARA/Federal
  Register, eCFR, and DOJ EOIR. **Authenticity of the *MCP servers*: low** — Tier-A servers are
  individual/community projects that scrape these sites, and `uscis-mcp` explicitly warns: *"a
  prototype… no warranty of reliability, accuracy, or fitness… Always verify every authority at its
  official source."* At least one priority-#1 fact (**processing times**) is sourced from a
  **non-government aggregator** in practice.
- **Freshness varies a lot, and MCP caching compounds it:** Federal Register / eCFR are **daily /
  current via official APIs**; the **Visa Bulletin is monthly**; **processing times lag ~1 month** and
  have no clean official API; the Policy Manual updates irregularly. The community servers add their
  own **daily/weekly caches** on top, so "latest" through them can be stale by days.
- **The cleanest official APIs** (best for an "authenticated, latest" build) are **USCIS Case Status
  (authenticated)**, **Federal Register**, and **eCFR**. The weak links are **processing times**
  (bot-blocked, aggregator-only) and the **Visa Bulletin / Policy Manual** (HTML, no API) — those need
  a resilient fetch + a monthly refresh, not a live call.

**Takeaway for priority #1 (operational facts):** don't ground production on a community MCP that
itself depends on an unofficial aggregator. Wrap the **official** sources directly — Visa Bulletin
(monthly), USCIS Case Status API (authenticated), USCIS Newsroom — and treat processing times as a
known-hard, caveated field. This is exactly **Option 2** below.

## 3. Evaluation against the requirement

| Requirement | Tier A (OSS) | Tier B (commercial legal) | Tier C (official, self-wrapped) |
|---|---|---|---|
| Authoritative / "authenticated" | ❌ community, unofficial | ✅ commercial, cited | ✅ official source of truth |
| Current / "latest" (visa bulletin, processing times) | ✅ | ⚠️ legal only, not ops | ✅ (if we poll it) |
| Immigration-operational coverage | ✅ | ❌ general legal | ✅ |
| Production-safe (SLA, warranty) | ❌ | ✅ | ✅ (we own it) |
| Vertex-ready (hosted StreamableHTTP + Registry) | ❌ must self-host/convert | ⚠️ per-vendor | ✅ we build it that way |
| Control / our guardrails ("not legal advice") | ⚠️ | ⚠️ external | ✅ |

**Key finding:** no single external MCP satisfies "authoritative **and** current **and**
immigration-operational **and** Vertex-ready" off the shelf. The choice is a build-vs-buy split:
operational immigration facts have no authoritative MCP (only OSS wrappers or official raw APIs),
while authoritative *legal* grounding is available commercially but general-purpose.

## 4. Options

- **Option 1 — Prototype fast (Tier A on Cloud Run).** Fork `uscis-mcp`/`immigration-mcp`, deploy to
  Cloud Run as StreamableHTTP, register in Agent Registry, ground the Vertex agent. **Fastest proof;
  unofficial data — prototype only, not production.**
- **Option 2 — Build an authoritative internal grounding MCP (recommended for production).** A thin
  MCP (Cloud Run, StreamableHTTP, IAM-auth) that wraps **official sources** — USCIS Developer Portal +
  State Dept Visa Bulletin + Federal Register + **our own Vertex AI Search datastore of postings**.
  "Authenticated," current, ops-complete, and under our guardrails. This is the natural evolution of
  the curated-timeline/retrieval MCP idea and reuses our existing datastore (via the Agent Search MCP).
- **Option 3 — Add a commercial legal layer (Tier B).** Register Paxton/Descrybe/CoCounsel via Agent
  Registry for authoritative INA/8 CFR/BIA interpretation, **composed with** Option 2's operational
  facts. Best answer quality; adds vendor cost + external dependency.
- **Recommended path:** **Option 1 to prove the Vertex-MCP-grounding wiring this week**, then
  **Option 2** as the production grounding source, optionally **+ Option 3** for the legal layer.

## 5. Risks / constraints

- **Accuracy & liability** — unofficial/community data can be wrong or stale; our product's hard rule
  is **no legal advice / no eligibility determinations** — grounding must not erode that guardrail.
- **ToS / rate limits** — scraping USCIS/State sites (Tier A) may violate terms or throttle; official
  APIs (Tier C) are the durable path.
- **Transport mismatch** — most OSS servers are stdio/SSE; Vertex needs **StreamableHTTP** → a wrap step.
- **Auth model** — "authenticated" source implies an Agent Registry auth config (IAM or keyed);
  confirm per server.
- **Freshness** — visa bulletin/processing-times change monthly; the grounding source needs a refresh
  cadence.

## 6. Open questions / next steps

- ✅ **DECIDED:** operational facts first, legal interpretation second → lead with **Option 2**
  wrapping official operational sources (Visa Bulletin, Case Status API, Newsroom), add the legal
  layer (eCFR / Federal Register / Policy Manual / BIA) second.
- ☐ **Processing times** have no clean official API (bot-blocked); decide the acceptable path — a
  resilient fetch of the official page, or a clearly-labeled unofficial aggregator with a freshness
  caveat. This is the biggest authenticity risk for priority #1.
- ☐ Confirm our Vertex agent is on **Agent Studio / Agent Registry** (the supported path) vs a
  hand-rolled ADK agent.
- ☐ POC: deploy one Tier-A server to Cloud Run (StreamableHTTP) → register in Agent Registry → ground
  a test agent; measure answer quality vs our existing Vertex AI Search datastore grounding.
- ☐ For Tier B, confirm each vendor's MCP endpoint supports **external (non-Claude) use** +
  StreamableHTTP + pricing.
- ☐ Decide whether to expose **our own** corpus (postings/cohorts) as a grounding MCP (ties to the
  curated-timeline-seeding + retrieval-MCP specs).

## Sources
- Vertex AI Agent + MCP integration (Agent Registry, StreamableHTTP, Agent Search MCP): Google Cloud docs via Developer Knowledge API — `docs.cloud.google.com/agent-registry/use-agentregistry-mcp`, `docs.cloud.google.com/gemini-enterprise-cx/cx-agent-studio/mcp-server`.
- immigration-mcp — https://github.com/tushariitr-19/immigration-mcp
- uscis-mcp — https://github.com/viniciussouzax/uscis-mcp
- us-immigration-mcp — https://github.com/sebastianomarchesini/us-immigration-mcp
- Immigration and Travel MCP — https://glama.ai/mcp/connectors/io.github.martc03/immigration-travel
- USCIS Case Status API (official, authenticated) — https://developer.uscis.gov/api/case-status
- Legal-research MCPs (registry): Descrybe (https://mcp.descrybe.com/mcp), Paxton, Thomson Reuters CoCounsel, Midpage, Legal Data Hunter.

Authoritative government sources (provenance §2A):
- State Dept **Visa Bulletin** (monthly) — https://travel.state.gov/content/travel/en/legal/visa-law0/visa-bulletin.html
- USCIS **Processing Times** (~monthly; official page WAF-blocked to bots) — https://egov.uscis.gov/processing-times/ ; FAQ — https://egov.uscis.gov/processing-times/processing-times-faqs
- **Federal Register API** (official, daily, JSON) — https://www.federalregister.gov/developers/documentation/api/v1
- **eCFR API** (official, Title 8 CFR) — https://www.ecfr.gov/developers/documentation/api/v1
- USCIS **Policy Manual** — https://www.uscis.gov/policy-manual ; USCIS **Newsroom** — https://www.uscis.gov/newsroom
- DOJ **EOIR / BIA precedent decisions** — https://www.justice.gov/eoir/board-of-immigration-appeals-precedent-decisions
- Processing-times aggregator used by `uscis-mcp` (UNOFFICIAL) — immigrationtimes.org
