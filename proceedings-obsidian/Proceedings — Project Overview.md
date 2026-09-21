# Proceedings — Project Overview

**Type:** RAG (Retrieval-Augmented Generation) immigration-intake assistant
**Domain:** US immigration & visas
**Grounding sink:** Managed **Vertex AI Search (Discovery Engine)** datastore `imm-postings-datastore`
**Surfaces:** FastAPI backend (Cloud Run) · Next.js website (Vercel) · React Native + Expo mobile app

---

## What It Does

Proceedings grounds answers on user/Reddit postings indexed in the managed **Vertex AI Search (Discovery Engine)** datastore, and serves answers + auto-tagged postings + AI onboarding via **Gemini** — with strict guardrails against providing legal advice. Users post their immigration experiences, get matched with others in the "same boat," ask grounded questions, and chat in groups.

> The original prototype (Firecrawl crawl → label → self-managed Vertex AI Vector Search) is **retired** and archived under `legacy/`. It is not deployed, and its per-script notes have been removed from this vault.

---

## Architecture

```
                        ┌─────────────────────────────────────────┐
User posting ──────────►│ posting.py: tag (Gemini) → GCS sidecar   │
(app / website)         │           → documents.import             │
                        └──────────────────┬──────────────────────┘
                                           ▼
                        Vertex AI Search (Discovery Engine) datastore
                                  `imm-postings-datastore`
                                           ▲
Question ──► api.py ──► search_client.py (Answer/Search API, facets, strictness)
                 │                         │
                 │                         ▼
                 └──► query.py (Gemini direct-answer / intent) ──► Firestore Q&A log

Profiles & onboarding: profile.py → Firestore users/{id}
Social layer: matching.py (same-boat) · interactions.py (votes/replies) ·
              group_messages.py (chat) · moderation.py (reports/blocks/takedown)

Clients:  Mobile App (Expo)  ·  Website (Next.js on Vercel)  →  api.py on Cloud Run
```

---

## Backend Modules (`backend/`)

| Module | Role | Note |
|---|---|---|
| `api.py` | FastAPI HTTP API — all endpoints | [[api.py]] |
| `search_client.py` | Grounded retrieval (Answer/Search API), facets, strictness | [[search_client.py]] |
| `query.py` | Gemini helpers (direct answer, intent) + Firestore Q&A log | [[query.py]] |
| `posting.py` | Posting + experience tagging → GCS sidecar → `documents.import` | [[posting.py]] |
| `profile.py` | User profile + two-stage AI onboarding (`users/{id}`) | [[profile.py]] |
| `reconcile.py` | Profile ↔ message reconciliation at publish time | [[reconcile.py]] |
| `matching.py` | "Same boat" criteria chat + similarity + group formation | [[matching.py]] |
| `interactions.py` | Replies + votes (transactional tallies) | [[interactions.py]] |
| `group_messages.py` | Group chat messaging (PII scrub + moderation) | [[group_messages.py]] |
| `moderation.py` | UGC reports / blocks / takedown (Apple 1.2) | [[moderation.py]] |

---

## Clients

- **[[Mobile App]]** — React Native + Expo; auth, onboarding, feed/community, AI chat, profile. Design tokens in [[Design System]] (`mobile/theme.md`).
- **[[Website]]** — Next.js 14 marketing + search/onboarding/posting UI, shares the same design tokens (Tailwind config).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Retrieval / grounding | Vertex AI Search (Discovery Engine) — Answer/Search API |
| Tagging & answers | Gemini (Vertex AI) |
| Doc storage | Google Cloud Storage sidecars → `documents.import` |
| App data | Firestore (`users`, `qa_pairs`, `replies`, `votes`, `groups`, `reports`, `blocks`, …) |
| API server | FastAPI on Cloud Run (`immiguide-api`) |
| Website | Next.js 14 on Vercel, React 18, Tailwind CSS, TypeScript |
| Mobile | React Native + Expo, Reanimated, Firebase Auth |

---

## Key Design Decisions

1. **Managed grounding** — retrieval is delegated to the Discovery Engine datastore via the Answer/Search API ([[search_client.py]]); the app no longer manages its own embeddings/index.
2. **Guardrails** ([[query.py]]) — the Gemini prompt forbids legal advice, eligibility determinations, and case assessments; a `FALLBACK_MESSAGE` is returned when context is insufficient.
3. **Provenance identity** — first-party postings carry an `APP_SOURCE_SYSTEM` / `APP_BASE_URL` provenance (default `meridianjourney` / `https://meridianjourney.ai`); the `channel` token stays `"app"`.
4. **UGC compliance** (Apple 1.2) — [[moderation.py]] adds report/block/takedown flows and content filtering.

---

## Repo Layout

| Path | Contents |
|---|---|
| `backend/` | Live FastAPI service + modules (above) |
| `mobile/` | React Native + Expo app → [[Mobile App]] |
| `website/` | Next.js app → [[Website]] |
| `docs/` | Architecture, CI/CD, release, ingestion, tagging, business → [[Docs Map]] |
| `legacy/` | Retired Firecrawl → Vector Search prototype (not deployed) |
| `proceedings-obsidian/` | This documentation vault |
