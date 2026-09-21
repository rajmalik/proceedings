# Deployment

**Surfaces:** FastAPI API (Cloud Run) · Next.js website (Vercel) · React Native app (Expo)

---

## Architecture

```
Mobile App (Expo) ─┐
                   ├─► Cloud Run (FastAPI, backend/) ─► Vertex AI Search (Discovery Engine)
Website (Vercel) ──┘                │                    datastore `imm-postings-datastore`
                                    ├─► Gemini (Vertex AI) — tagging & answers
                                    ├─► GCS sidecars → documents.import
                                    └─► Firestore (users, qa_pairs, replies, votes, groups, …)
```

---

## API — Cloud Run

| Setting | Value |
|---|---|
| Service | `immiguide-api` |
| Region | `us-central1` |
| Source | `backend/` (Dockerfile at `backend/Dockerfile`) |

**Deploy (manual):**
```bash
gcloud run deploy immiguide-api --source backend --region us-central1
```

**Key env vars** (see root `CLAUDE.md` for the full list):
- `GCP_PROJECT_ID`, `GCP_REGION`, `GCP_BUCKET_NAME`
- `GCP_VERTEX_SEARCH_APP_ID`, `GCP_VERTEX_DATASTORE_ID`, `GCP_VERTEX_DATASTORE_LOCATION` — the managed Vertex AI Search grounding sink used by [[api.py]] / [[search_client.py]]
- `APP_SOURCE_SYSTEM`, `APP_BASE_URL` — provenance identity for first-party postings (default `meridianjourney` / `https://meridianjourney.ai`)

> The retired self-managed `VERTEX_AI_INDEX_*` vars were decommissioned along with the `legacy/` prototype.

---

## Website — Vercel

| Setting | Value |
|---|---|
| Root directory | `website/` |
| Framework | Next.js 14 |
| Deploy | Auto on push to `main` |

Set the backend URL via the website's `PYTHON_API_URL` / API-base env var so its API routes proxy to the Cloud Run service. See [[Website]].

---

## Mobile — Expo

React Native + Expo app under `mobile/`; talks to the same Cloud Run API via `mobile/src/services/apiService.ts`. Config in `mobile/app.config.js`. See [[Mobile App]].

---

## CI/CD

GitHub Actions runs a no-credentials **test gate** on every push/PR (`.github/workflows/ci.yml`); Cloud Run deploys are **manual-approval only** (`.github/workflows/deploy.yml`). Release tags are component-scoped SemVer (`backend-vX.Y.Z` / `website-vX.Y.Z` / `mobile-vX.Y.Z`) and are cut only when explicitly requested. See [[Docs Map]] → `docs/CI-CD.md`, `docs/RELEASE-TAGGING.md`.

---

## Infrastructure Summary

| Service | Provider | Purpose |
|---|---|---|
| API server | Cloud Run (`immiguide-api`) | FastAPI backend |
| Retrieval / grounding | Vertex AI Search (Discovery Engine) | Grounded answers over `imm-postings-datastore` |
| LLM | Gemini (Vertex AI) | Tagging + answer generation |
| Doc storage | GCS | Posting sidecars → `documents.import` |
| App database | Firestore | Profiles, Q&A, votes, replies, groups, moderation |
| Website hosting | Vercel | Next.js frontend |
| Mobile | Expo | React Native app |
