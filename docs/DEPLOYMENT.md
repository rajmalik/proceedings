# Deployment & DevOps runbook (app: backend + web + mobile)

How the Proceedings app ships. Two independent deploy targets today, plus mobile (not yet deployed).
*(The Reddit-ingestion pipeline has its own infra doc: [docs/ingestion/DEPLOYMENT.md](ingestion/DEPLOYMENT.md). This doc is the **app** — the FastAPI BFF + the Next.js site.)*

---

## 1. Topology — who deploys where

```
  Browser ──HTTPS──▶  Cloud Run (Next.js site, immiguide-web)  ──server-side fetch (PYTHON_API_URL)──▶  Cloud Run (FastAPI, immiguide-api)
                      • static pages + /api/* proxy routes                                               • Firestore · Vertex AI Search · GCS · BigQuery · Gemini
```

| Component | Source dir | Platform | Deploy trigger | Today |
|---|---|---|---|---|
| **Backend (BFF)** | `backend/` | **GCP Cloud Run** (`immiguide-api`, `us-central1`) | **Manual** `gcloud run deploy` (no CI) | Live |
| **Frontend** | `website/` | **GCP Cloud Run** (`immiguide-web`, `us-central1`) | **Manual** `gcloud run deploy --source website` (no CI) | Live |
| **Mobile (iOS)** | `mobile/` | Expo / EAS → App Store | **Manual** `eas build`/`eas submit`, or `workflow_dispatch` via `mobile-deploy.yml` (gated) | Submitted to App Store Review (2 rounds); see [`docs/MOBILE-APP-STORE-DEPLOYMENT.md`](MOBILE-APP-STORE-DEPLOYMENT.md) |

> **Frontend host change:** the site was previously on **Vercel** (git-driven). We moved it to **Cloud Run** (`immiguide-web`) after losing admin access to the Vercel project — see §3. The old `proceedings.vercel.app` is orphaned.

**Both deploys are now manual + git-independent** — each builds from your *local* working tree (`gcloud run deploy --source <dir>`), not from git. They're decoupled: the backend can lead the frontend (new endpoints are additive; nothing calls them until the site ships).

GCP project: **`proceedings-490601`** (number `971592620882`) · region **`us-central1`** (Vertex datastore location `global`).

---

## 2. Backend — Cloud Run (`immiguide-api`)

### 2.1 Prerequisites
- `gcloud` CLI authenticated with deploy rights on `proceedings-490601`; **ADC** for running scripts/tests locally (`gcloud auth application-default login`).
- APIs enabled: Cloud Run, Cloud Build, Artifact Registry, Firestore, Discovery Engine (Vertex AI Search), Vertex AI, Storage, BigQuery.
- **No service-account key files** (org policy `iam.disableServiceAccountKeyCreation`, D-018) — auth is the **attached service account** + ADC.

### 2.2 Deploy
```bash
gcloud run deploy immiguide-api --source backend --region us-central1
# (--quiet to skip the confirm prompt)
```
What happens: `--source backend` uploads the `backend/` dir → **Cloud Build** builds the image (`backend/Dockerfile`) → pushes to **Artifact Registry** (`us-central1-docker.pkg.dev/proceedings-490601/cloud-run-source-deploy/immiguide-api`) → rolls out a **new Cloud Run revision** serving 100% traffic. URL: `https://immiguide-api-fbtmilucfq-uc.a.run.app` (and `https://immiguide-api-971592620882.us-central1.run.app`).

> **Dockerfile gotcha:** the image COPYs an explicit module list. **When you add a new backend `.py` module, add it to `backend/Dockerfile`'s `COPY` line** or the deploy will crash on import (this bit phases L/M/N — `interactions.py`, `matching.py`, `group_messages.py` each had to be added).

### 2.3 Configuration (env vars on the service)
Set on the Cloud Run service (Console → Variables, or `gcloud run deploy … --set-env-vars k=v,…` / `--update-env-vars`). The service reads them at startup (`api.py` lifespan):

| Var | Purpose |
|---|---|
| `GCP_PROJECT_ID` | project (`proceedings-490601`) |
| `GCP_REGION` | `us-central1` (Gemini/Vertex init) |
| `GCP_VERTEX_SEARCH_APP_ID` | grounding engine `imm-postings-search-app` |
| `GCP_VERTEX_DATASTORE_ID` | `imm-postings-datastore` |
| `GCP_VERTEX_DATASTORE_LOCATION` | `global` |
| `GCP_VERTEX_PUBLIC_ENGINE_ID` | *(optional)* DS-2 public tier; off if unset |
| `GCP_BUCKET_NAME` | GCS sidecar bucket `imm-postings-ingestion` |
| `GCP_GEMINI_MODEL` | *(optional)* default `gemini-2.5-flash` |
| `APP_SOURCE_SYSTEM` | first-party **provenance** id; default `meridianjourney` (D-055; registered domain) |
| `APP_BASE_URL` | base URL for `source_url`/`source_uri`/`full_url`; default `https://meridianjourney.ai` |
| `ALLOW_USER_IMPERSONATION` | `1` while on the dev `X-User-Id` model (turn off when Firebase Auth lands) |

Secrets (e.g. a future Reddit OAuth secret) → **Secret Manager**, mounted as env/volume — never committed. No GCP API keys (ADC via the attached SA).

### 2.4 IAM (attached service account)
The Cloud Run service runs as **`971592620882-compute@developer.gserviceaccount.com`** (default compute SA). It needs: Firestore (`datastore.user`), Discovery Engine (search/answer + `documents.import`), Vertex AI (Gemini), GCS (read/write the bucket), BigQuery (write `postings_metadata`). Grant additional roles to **this SA**, not key files. (For phase-N's full real-time path, add FCM-send when that lands.)

### 2.5 CORS
`backend/api.py` allows `http://localhost:3000` and any `https://*.vercel.app` (regex). So Vercel preview **and** production origins work out of the box. A custom frontend domain must be **added to `allow_origins`** and redeployed.

### 2.6 Verify (post-deploy smoke)
```bash
# health
curl -s https://immiguide-api-fbtmilucfq-uc.a.run.app/api/health
# full end-to-end suite against the DEPLOYED service (grounding → chat → search → replies/votes → groups → chat)
.venv/bin/python backend/tests/test_cloud_run.py        # 35/35 expected
```

### 2.7 Rollback
Cloud Run keeps every revision:
```bash
gcloud run revisions list --service immiguide-api --region us-central1
gcloud run services update-traffic immiguide-api --region us-central1 --to-revisions <PREV_REVISION>=100
```

---

## 3. Frontend — Next.js (`website/`)

### 3.0 Hosting: Cloud Run (`immiguide-web`) — CURRENT production

The site runs on **GCP Cloud Run** (service `immiguide-web`, `us-central1`),
deployed from the local `website/` working tree — same model as the backend, and
fully under our own GCP account.

**Live URL:** `https://immiguide-web-971592620882.us-central1.run.app`

**Deploy** (manual, git-independent):
```bash
gcloud run deploy immiguide-web --source website \
  --project proceedings-490601 --region us-central1 --allow-unauthenticated \
  --port 8080 --memory 512Mi \
  --set-env-vars PYTHON_API_URL=https://immiguide-api-fbtmilucfq-uc.a.run.app
```
- Builds `website/Dockerfile` (Next.js `output: 'standalone'`) via Cloud Build.
- **`PYTHON_API_URL` = the bare backend origin** (no trailing `/api`). It's also
  baked at build time in the Dockerfile so prerendered ISR routes (e.g.
  `/api/users`) cache the correct response; `apiBase()` normalizes a stray
  `/api`/slash regardless.
- **No CORS change needed** — the browser only talks to `immiguide-web`; the
  `/api/*` → `immiguide-api` proxy hop is server-side.

**Verify:**
```bash
FE=https://immiguide-web-971592620882.us-central1.run.app
curl -s "$FE/api/users" | python3 -c "import sys,json;print(len(json.load(sys.stdin)),'users')"
curl -s -o /dev/null -w "/find -> %{http_code}\n" "$FE/find"
```

**Rollback:** `gcloud run services update-traffic immiguide-web --to-revisions <REV>=100`.
**CI / custom domain (later):** Cloud Build trigger + domain mapping — see
[`docs/app/frontend-hosting-options.md`](app/frontend-hosting-options.md).

### 3.1 (Previous host) One-time project setup — Vercel dashboard

> ⚠️ Retained for reference. The frontend is **no longer served from Vercel** (no
> admin access to the project). `proceedings.vercel.app` is orphaned.
1. **Import the GitHub repo** into a Vercel project (Vercel ↔ GitHub app).
2. **Root Directory = `website/`** (the Next app is in a subfolder of the monorepo).
3. Framework **Next.js** is auto-detected → Build `next build`, Output handled by Vercel, Install `npm install`. (No `vercel.json` needed; there is none.)
4. **Environment variables** (Project → Settings → Environment Variables) — set for **Production** *and* **Preview**:
   - **`PYTHON_API_URL`** = the Cloud Run URL `https://immiguide-api-fbtmilucfq-uc.a.run.app`.
     - It's read **server-side** in the `/api/*` proxy routes (e.g. `website/src/app/api/groups/route.ts`), defaulting to `http://localhost:8000` for local dev. **Not** prefixed `NEXT_PUBLIC_`, so it's never exposed to the browser — the backend URL stays server-side and all calls go browser → Vercel proxy → Cloud Run.

### 3.2 How deploys happen (git-driven)
- **Every push to a branch / open PR → a Preview deployment** at a unique `*.vercel.app` URL (works with the backend thanks to the `*.vercel.app` CORS rule).
- **Merge to `main` → a Production deployment** (the live site / custom domain).
- Rollbacks: Vercel dashboard → Deployments → **Promote** a previous build to Production (instant).

### 3.3 Verify
- Open the Preview/Prod URL; exercise the changed pages (e.g. `/find`, `/groups/[id]`).
- Confirm proxy wiring: a page action should hit `…/api/*` → Cloud Run (check the Network tab / Vercel function logs).

---

## 4. Shipping a feature end-to-end (the standard flow)

Using phase-N as the example:
1. **Branch + build the feature**, run tests locally (`backend/tests/*.py`, `cd website && npm test && npm run build`).
2. **Deploy the backend** to Cloud Run (`gcloud run deploy … --source backend`) and smoke it (`test_cloud_run.py`). *(Backend leads safely — new endpoints are additive.)*
3. **Push the branch & open a PR** → a **Vercel Preview** builds the new UI; click through it.
4. **Merge to `main`** → **Vercel Production** rebuilds with the feature; backend is already live.
> Order matters only in that the **backend should be deployed before the frontend that calls it** reaches production.

---

## 5. Post-merge verification (UAT) — confirm the live feature works

After a merge ships (Vercel Production rebuilt + Cloud Run live), verify in two layers: **automated API smoke** + a **manual UI walkthrough** on the live site.

### 5.1 Automated — deployed API smoke
```bash
# Full e2e suite against the DEPLOYED backend (defaults to the prod Cloud Run URL).
.venv/bin/python backend/tests/test_cloud_run.py            # 35/35 expected
# Target a specific deployment explicitly:
CLOUD_RUN_URL=https://immiguide-api-fbtmilucfq-uc.a.run.app .venv/bin/python backend/tests/test_cloud_run.py
```
- Needs **ADC** (`gcloud auth application-default login`); the suite **seeds + cleans prod Firestore** test docs (synthetic ids, auto-removed) and retries through the per-IP rate limit.
- **Group I** is the phase-N group-chat coverage: 400/403 gating · PII-scrubbed post · member-only reads · author-only delete. (Group G = replies/votes, H = find-peers/groups.)

### 5.2 Manual — group chat on the live site (Vercel Production)
Identity in production is still the **dev user-picker** (`X-User-Id`, `ALLOW_USER_IMPERSONATION=1`) until Firebase Auth lands — pick a seed user (top-right).

**Set up a group with two members** (chat needs ≥1 member; a 2-person test needs both):
1. As **User A** → `/find` → chat to build criteria → **Find matches** → tick a peer → **Create / join group** → **Open chat**. *(Matched peers need saved profiles; if there are none, use the **Browse groups** tab and **Join** an existing group instead.)*
2. As **User B** → switch the user-picker → `/find` → **Browse groups** → **Join** that group → **Open**.

**Happy path (single user):**
- [ ] Send a message → it appears in the thread immediately.
- [ ] **Reload the page** → the message is still there (persisted in Firestore).
- [ ] Send a message containing `me@example.com` and `415-555-1234` → both are **redacted** in the displayed text (PII scrub).
- [ ] **Delete** your own message → it shows **"message deleted"**; other members' messages have **no** delete control.

**Two-user delivery (polling, ~4 s):**
- [ ] Two browsers/windows — A and B both on the same `/groups/{id}` chat.
- [ ] A sends → **B sees it within ~4 seconds**, labeled with A's handle; B's own messages render right-aligned.

**Negative / authorization:**
- [ ] A **non-member** (seed user not in the group) opening `/groups/{id}` → sees the group name/members but the chat panel reads **"You're not a member of this group."**
- [ ] **No user selected** → the chat shows the **"Select a user"** gate.

**If something's off — where to look:** browser **Network tab** (the page calls the Vercel proxy `…/api/groups/{id}/messages` → 200/403) · **Vercel → Functions logs** (proxy errors) · **Cloud Run logs** (backend errors).

### 5.3 Quick health
- Backend: `curl https://immiguide-api-fbtmilucfq-uc.a.run.app/api/health` → `{"status":"ok",…}`.
- Frontend: the Production URL loads; `/find` and `/groups/[id]` render.

---

## 6. Local development
```bash
# backend
cd backend && ../.venv/bin/python -m uvicorn api:app --reload --port 8000   # reads ../.env via dotenv + ADC
# frontend (separate shell)
cd website && PYTHON_API_URL=http://localhost:8000 npm run dev               # http://localhost:3000
```
- Backend config: root **`.env`** (gitignored) loaded by `python-dotenv` + ADC for GCP creds.
- Frontend config: **`website/.env.local`** (gitignored) — set `PYTHON_API_URL` for local; defaults to `http://localhost:8000`.
- Identity in dev: the **`X-User-Id`** header (seed roster in `backend/seed_users.json`), surfaced by the website user-picker (`website/src/lib/activeUser.ts`).

---

## 7. Config & secrets inventory

| What | Where | Committed? |
|---|---|---|
| Backend runtime config | Cloud Run env vars | No (set on the service) |
| Backend local config | root `.env` | **No** (gitignored) |
| GCP credentials | **attached SA + ADC** (no key files) | No |
| Real secrets (future) | **Secret Manager** | No |
| Frontend → backend URL | Vercel env `PYTHON_API_URL` / `website/.env.local` | No |
| Noise kept out of git | `.claude/`, `*.tsbuildinfo`, `.env.local` | gitignored |

---

## 8. CI / automation status & gaps
- **No CI pipeline today** (`.github/workflows` is absent). Tests + the backend deploy are **run manually**. Vercel provides the only automation (git-triggered frontend builds + previews).
- **Future hardening** (when desired): a GitHub Actions workflow to (a) run `backend/tests` + `website` `npm test`/`build` on PRs, and (b) `gcloud run deploy` the backend on merge to `main` (via Workload Identity Federation — no SA keys), so backend + frontend ship together from git.

---

## 9. Mobile (Expo / React Native, `mobile/`)

**Full step-by-step runbook: [`docs/MOBILE-APP-STORE-DEPLOYMENT.md`](MOBILE-APP-STORE-DEPLOYMENT.md).**
The app already ships via **EAS Build** (`eas build`) → **EAS Submit** → App
Store Connect / TestFlight → Apple App Review, and has been through App
Review twice already (see
[`docs/business/app-review-1.2-ugc-response.md`](business/app-review-1.2-ugc-response.md)).
It points at the same Cloud Run `PYTHON_API_URL` as the website. A gated
`workflow_dispatch` GitHub Actions pipeline
([`mobile-deploy.yml`](../.github/workflows/mobile-deploy.yml)) automates the
build/submit steps, mirroring `deploy.yml`'s manual-approval pattern.
**Android / Play Store: [`docs/MOBILE-PLAY-STORE-DEPLOYMENT.md`](MOBILE-PLAY-STORE-DEPLOYMENT.md)**
— unlike iOS, this is a genuine from-scratch setup (no Play Console account,
app record, or signing keystore exist yet), also via EAS Build/Submit and
the same `mobile-deploy.yml` workflow (now platform-aware). (Firebase Auth
is already wired for iOS but not yet for Android — see that doc's §2.5;
FCM/push is not yet integrated on either platform — see the realtime
roadmap: [docs/app/realtime-communication-options.md](app/realtime-communication-options.md) §11.)

---

## 10. Quick reference
```bash
# Deploy backend
gcloud run deploy immiguide-api --source backend --region us-central1 --quiet
# Backend revision + URL
gcloud run services describe immiguide-api --region us-central1 \
  --format="value(status.latestReadyRevisionName,status.url)"
# Deployed e2e smoke
.venv/bin/python backend/tests/test_cloud_run.py
# Frontend: push the branch → PR (Vercel Preview) → merge main (Vercel Production)
git push -u origin <branch>
```
