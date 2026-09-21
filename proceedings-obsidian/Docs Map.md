# Docs Map

**Type:** Index / map of content
**Location:** `/docs/`
**Purpose:** A guide to the repository's `docs/` tree — the authoritative operational, architectural, ingestion, tagging, and business documentation for Proceedings. Grouped by subfolder, one line per document. Where a vault note already covers a topic in depth, it is linked with a `[[wikilink]]`.

See also [[Proceedings — Project Overview]] and [[Welcome]].

---

## `docs/` (root — ops, CI/CD, deploy, auth, roadmap)

| Doc | Covers |
|-----|--------|
| `CI-CD.md` | CI/CD tiering model — no-credentials test gate on every push/PR; manual-approval Cloud Run deploys; one-time GitHub setup and deferred GCP/WIF work. |
| `DEPLOYMENT.md` | Deployment & DevOps runbook for backend + web + mobile — topology, who deploys where, Cloud Run services. See [[Deployment]]. |
| `WEBSITE-DEPLOYMENT.md` | Website (`immiguide-web`) release runbook; DNS/domain mapping is one-time and already done. See [[Website]], [[Deployment]]. |
| `RELEASE-TAGGING.md` | Component-scoped SemVer tagging strategy (`backend-` / `website-` / `mobile-vX.Y.Z`); releases are explicit, never automatic. |
| `PROD-READINESS.md` | Production readiness & go-live prerequisites for `meridianjourney.ai` (Cloud Run baseline). |
| `BACKEND-ROADMAP.md` | Deferred backend infrastructure and mobile-polish improvements. |
| `AUTH-INTEGRATION.md` | Server-side identity verification (BLOCKER-0) — threat model and Firebase ID-token verification design. |
| `AUTH-NEXT-STEPS.md` | Remaining auth work — website login verification (verified on live domain) + mobile step C. |
| `synthetic-seed-data.md` | Guide to the synthetic seed data — what gets created, prerequisites, and how to run it. |

---

## `docs/app/` (app architecture, specs & options/trade-off docs)

| Doc | Covers |
|-----|--------|
| `APP-BACKEND-ARCHITECTURE.md` | Vertex AI Search backend architecture for the mobile/web apps — high-level design and scope. See [[api.py]]. |
| `IMPROVED-BACKEND-ARCHITECTURE.md` | Identified shortcomings (double-inference latency, search↔app state drift) and improvements. |
| `APP-FRONTEND-INTEGRATION.md` | Frontend ↔ backend integration spec — transport, conventions, integration model for [[Website]] and [[Mobile App]]. |
| `app-backend-specs.MD` | Backend project overview & structure spec. |
| `app-backend-openapi.yaml` | OpenAPI definition of the app backend API. |
| `app-specs.MD` | Product Requirements Document for the AI-powered listing platform (web app). |
| `design.MD` | Design System spec ("Project Quantum") — brand identity and color tokens. See [[Design System]]. |
| `CLAUDE.md` | Web App style guide (Stitch-integrated) — design-system source and implementation rules. |
| `app-state-store-auth-options.md` | Options & trade-offs for the app-state store + auth (data domains it must hold). |
| `frontend-hosting-options.md` | Frontend hosting decision doc — Vercel vs. GCP for the Next.js website. |
| `generic-channel-identity-options.md` | Generic multi-channel identity & provenance options (de-coupling from Reddit). |
| `orchestration-options-tradeoffs.md` | Conversational-orchestration architecture options (own service vs. managed Vertex app vs. managed ADK agent). |
| `realtime-communication-options.md` | Real-time group-communication channel options & trade-offs (phase-N). |
| `imm-flows-example/` | Example immigration flow diagram(s) (e.g. F-1 → H-1B → green card). |

---

## `docs/ingestion/` (Reddit → Vertex AI Search ingestion pipeline)

| Doc | Covers |
|-----|--------|
| `PIPELINE-ARCHITECTURE-WORKFLOW.md` | Authoritative pipeline architecture & workflow — agentic design on Vertex AI Agent Engine; single sink = Vertex AI Search; BigQuery as dedup/watermark store. |
| `REDDIT-INGESTION-PIPELINE.md` | Reddit → GCS → Vertex AI Search ingestion pipeline overview. |
| `REDDIT-INGESTION-ALTERNATIVES.md` | Alternatives & cost analysis for when the official Reddit Data API path is blocked. |
| `PREREQUISITES-IAM-INFRASTRUCTURE.md` | Prerequisites, GCP IAM & infrastructure provisioning; security principles. |
| `DEPLOYMENT.md` | GCP component inventory & provisioning for the ingestion pipeline (Firestore absent by design). |
| `SIDECAR-METADATA-DESIGN.md` | Why the per-document `.json` sidecar exists and the source-of-truth model. See [[JSON-SCHEMA-FIELD-DICTIONARY]]. |
| `TAG-LIFECYCLE.md` | Master tag lifecycle — controlled process for adding new tags from live postings. |
| `QUARANTINE-PROCESS.md` | Quarantine process & human-in-the-loop self-learning (what gets quarantined and why). |
| `schema.py` | Python schema definitions backing the ingestion/sidecar metadata. |

---

## `docs/tagging/` (tag taxonomy, extraction & evaluation)

| Doc | Covers |
|-----|--------|
| `us_immigration_tag_specification.md` | Authoritative US immigration & visa tag-category specification. See [[us_immigration_tag_specification]]. |
| `JSON-SCHEMA-FIELD-DICTIONARY.md` | Posting-metadata JSON field dictionary & extraction rules (channel-prefixed `case_id` convention). See [[JSON-SCHEMA-FIELD-DICTIONARY]]. |
| `LLM-EXTRACTION-PROMPT.md` | Verbatim production system prompt for the real-time tagger (posting → tagged JSON). See [[LLM-EXTRACTION-PROMPT]]. |
| `TAGGING-EVALUATION.md` | Tagging improvement areas — validation gate, summary backfill. See [[TAGGING-EVALUATION]]. |
| `tagging-examples/` | Worked examples: tagged H-1B posting batches (`.md` raw + `.json` metadata pairs). |

---

## `docs/business/` (launch, pilot, intake, legal)

| Doc | Covers |
|-----|--------|
| `launch-requirements.md` | What else is needed to launch — V1 must-haves and sales assets. See [[Launch Requirements]]. |
| `pilot-offer.md` | 30-day pilot offer for the Legal Intake Assistant. See [[Pilot Offer]]. |
| `data-intake-checklist.md` | Client onboarding checklist — firm info and data intake for setup. See [[Data Intake Checklist]]. |
| `data-intake-checklist-email.md` | Quick-start intake email version — required info and confirmations. |
| `app-review-1.2-ugc-response.md` | App Store review resubmission kit — Guideline 5.1.1(i)/5.1.2(i) (third-party AI consent) and 2.3.6 responses. |
| `disclaimer.txt` | Plain-text legal disclaimer copy (not legal advice). |
| `h-1-docs` | Supporting H-1 reference document(s). |

---

## Related

[[Proceedings — Project Overview]] · [[Website]] · [[Mobile App]] · [[Deployment]] · [[api.py]] · [[Design System]]
