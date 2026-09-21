# Proceedings Vault

Start here: **[[Proceedings — Project Overview]]**

This vault documents the Proceedings codebase — a RAG immigration-intake assistant grounded on a **managed Vertex AI Search (Discovery Engine)** datastore, with a FastAPI backend, a Next.js website, and a React Native mobile app.

> The original Firecrawl → self-managed Vector Search prototype is **retired** and archived under `legacy/`. Its per-script notes have been removed from this vault.

---

## Backend (live — `backend/`)
- [[api.py]] — FastAPI HTTP API (search, postings, profile, onboarding, reconcile, social, moderation)
- [[search_client.py]] — grounded retrieval via the Answer/Search API + facets/strictness
- [[query.py]] — Gemini helpers (direct answer, intent) + Firestore Q&A log
- [[posting.py]] — user-posting + experience tagging → GCS sidecar → `documents.import`
- [[profile.py]] — user profile + two-stage AI onboarding (Firestore `users/{id}`)
- [[reconcile.py]] — profile ↔ message reconciliation at publish time
- [[matching.py]] — "same boat" criteria chat + similarity scoring + group formation
- [[interactions.py]] — replies + votes (transactional tallies)
- [[group_messages.py]] — group chat messaging (PII scrub + moderation gate)
- [[moderation.py]] — UGC reports / blocks / takedown (Apple 1.2 compliance)

## Frontends
- [[Mobile App]] — React Native + Expo app (screens, components, contexts, services)
- [[Design System]] — Meridian design tokens (colors, type, spacing, motion); full reference in `mobile/theme.md`
- [[Website]] — Next.js 14 marketing + search/onboarding/posting UI

## Infrastructure & process
- [[Deployment]] — Cloud Run (API) + Vercel (website) + Expo (mobile)
- [[GCP Setup]] — bucket provisioning script
- [[Docs Map]] — index of the `docs/` tree (CI/CD, release, ingestion, tagging, app specs)

## Taxonomy & tagging
- [[us_immigration_tag_specification]] — authoritative tag categories & naming rules
- [[JSON-SCHEMA-FIELD-DICTIONARY]] — posting metadata field rules
- [[LLM-EXTRACTION-PROMPT]] — production tagging system prompt
- [[TAGGING-EVALUATION]] — tagging accuracy evaluation
- [[posting-specs]] — posting structure notes

## Business
- [[Business Documents]] — all client-facing documents
- [[Data Intake Checklist]] — client onboarding form
- [[Launch Requirements]] — V1 vs Later prioritization
- [[Pilot Offer]] — 30-day pilot one-pager
