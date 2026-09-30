# CI/CD

GitHub Actions pipeline for the `proceedings` monorepo (`backend/`, `website/`,
`mobile/`). Two workflows:

| Workflow | File | Trigger | Purpose |
|---|---|---|---|
| **CI** | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | every push / PR to `main`, `proceedings-app` | fast, no-credentials test gate |
| **Deploy** | [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) | `workflow_dispatch` (manual) + approval | gated Cloud Run deploy (backend/website) *(scaffold — see [Deferred](#deferred-gcp-tiers))* |
| **Mobile Deploy** | [`.github/workflows/mobile-deploy.yml`](../.github/workflows/mobile-deploy.yml) | `workflow_dispatch` (manual) + approval | gated EAS build/submit (iOS) — **live**, see [`docs/MOBILE-APP-STORE-DEPLOYMENT.md`](MOBILE-APP-STORE-DEPLOYMENT.md) |

## Design principle — tier tests by dependency

The backend tests already split into scopes (`unit | integration | all`). The
pipeline leans on that split:

| Tier | What | Needs | Where it runs |
|---|---|---|---|
| **1 — unit/pure** | no-network suites + all Vitest + all Jest | nothing | **every PR** (CI gate) |
| **2 — integration** | live-Firestore suites (`test_interactions all`, `test_group_messages`, `test_matching`, …) | GCP creds | post-merge / nightly *(not built yet)* |
| **3 — E2E** | deployed-backend suites (`test_cloud_run`, `test_e2e_journey`, `test_grounding_e2e`) | deployed target + creds | inside Deploy, post-approval *(scaffold)* |

**Why tiers 2–3 are *not* on the PR gate:** they need GCP credentials (unsafe to
expose to fork PRs), hit live Firestore/Vertex (slow, costs, flaky), and write
data. The PR gate stays credential-free so it's fast and safe on every check-in.

## CI workflow (Tier 1 — active)

Runs on every push/PR. Uses [`dorny/paths-filter`](https://github.com/dorny/paths-filter)
so a website-only change doesn't run backend/mobile jobs.

| Job | Steps |
|---|---|
| `changes` | detect which of `backend/ website/ mobile/` changed |
| `backend` | `compileall` + no-GCP suites: `test_profile_edge`, `test_profile_vocab`, `test_reconcile unit`, `test_interactions unit` (run with `GCP_PROJECT_ID=''` to prove they never touch cloud) |
| `website` | `npm ci` → `lint` → `tsc --noEmit` → `vitest run` → `next build` |
| `mobile` | `npm ci` → `jest` |
| `ci-gate` | aggregates the above into one status check (green when a surface is path-filtered out, red if any ran job failed) |

Wire **`ci-gate`** into branch protection as the single required check.

### What's intentionally excluded from the gate (and why)
- **`test_profile.py`, `test_search_features.py`** — mix integration groups
  (hit `/api/chat` → live Vertex/Gemini); not pure. Belong in Tier 2.
- **mobile `tsc --noEmit`** — pre-existing strict-TS errors (`Button.tsx`,
  `Input.tsx`); Metro/Babel never typecheck, so the app runs fine. Re-add once
  cleared (see follow-ups).

## Deploy workflow (manual approval — scaffold)

CD is **never automatic**. Two layers of human control:

1. **`workflow_dispatch`** — the run only starts when someone clicks *Run
   workflow* in the Actions tab and picks `target` (backend/website/both) + `ref`.
2. **`environment: production`** — the deploy job **pauses for a required
   reviewer's approval** before it runs.

Flow: `dispatch → verify (no-GCP gate) → ⏸ approval → deploy → E2E smoke → promote traffic`.

The deploy strategy is **canary**: deploy a `--no-traffic` candidate revision,
run `test_cloud_run.py` against its tagged URL, and only migrate traffic to it
if the smoke passes (instant rollback otherwise).

> The GCP auth + `gcloud run deploy` + E2E steps are **commented TODO blocks**
> until the [GCP tier decision](#deferred-gcp-tiers) is made. Nothing in this
> workflow touches GCP yet.

## One-time GitHub setup (needs repo admin)

1. **Branch protection** — Settings ▸ Branches ▸ add rule for `proceedings-app`
   (and `main`): require status check **`ci-gate`** before merging.
2. **Approval gate** — Settings ▸ Environments ▸ create **`production`** ▸ add a
   **Required reviewer**. (Optionally limit deployment branches to
   `main`/`proceedings-app`.) `mobile-deploy.yml` reuses this same
   environment — no separate gate to configure.
3. **`EXPO_TOKEN` secret** (mobile only) — Settings ▸ Secrets and variables ▸
   Actions ▸ New repository secret. See
   [`docs/MOBILE-APP-STORE-DEPLOYMENT.md` §3.1](MOBILE-APP-STORE-DEPLOYMENT.md#31-expo_token--required).

## Running the gate locally

From `backend/` (mirrors the CI `backend` job):

```bash
GCP_PROJECT_ID='' python tests/test_profile_edge.py
GCP_PROJECT_ID='' python tests/test_profile_vocab.py
GCP_PROJECT_ID='' python tests/test_reconcile.py unit
GCP_PROJECT_ID='' python tests/test_interactions.py unit
```

Website: `cd website && npm run lint && npx tsc --noEmit && npm run test && npm run build`
Mobile: `cd mobile && npm test`

The full integration/E2E suites (need GCP ADC + the deployed backend) are run
manually today — see [`backend/tests/`](../backend/tests) and
[`mobile/TESTING.md`](../mobile/TESTING.md).

---

## Deferred — GCP tiers

To activate integration tests, E2E, and real deploys, one decision is pending:
**which GCP project CI uses** (a dedicated staging/CI project — recommended — vs
the existing `proceedings-490601`) and **how it authenticates**.

**Recommended auth:** keyless **Workload Identity Federation** (OIDC) via
[`google-github-actions/auth`](https://github.com/google-github-actions/auth) —
no long-lived service-account JSON key stored in GitHub secrets.

Setup outline (once the project is chosen):
1. Create a Workload Identity Pool + Provider bound to this GitHub repo.
2. Create a deploy service account (`run.admin`, `cloudbuild.builds.editor`,
   `iam.serviceAccountUser`, `datastore.user`, etc.); let the WIF provider
   impersonate it.
3. Store `GCP_WIF_PROVIDER` + `GCP_DEPLOY_SA` as repo secrets/vars.
4. Uncomment the two `TODO(GCP auth)` / deploy / E2E blocks in `deploy.yml`.

---

## Follow-up tasks

### CI/CD
- [ ] **GitHub setup** — branch protection (`ci-gate` required) + `production`
      environment with required reviewers. *(repo admin; ~5 min)*
- [ ] **Decide the CI GCP project** (dedicated staging vs prod) — gates everything below.
- [ ] **Workload Identity Federation** — provision pool/provider + deploy SA; add secrets.
- [ ] **Activate `deploy.yml`** — fill the TODO blocks; do a first manual canary deploy.
- [ ] **`ci-integration.yml`** — new workflow running Tier-2 integration suites
      on merge to `proceedings-app`/`main` (or nightly `schedule`), authed via WIF
      against the CI project.
- [ ] **Bump action versions** — `actions/*` currently warn about Node 20
      deprecation (forced to Node 24 on 2026-06-16); bump `checkout`/`setup-*`/
      `paths-filter` to Node-24-ready versions.
- [ ] *(optional)* Build & push backend/website Docker images to Artifact
      Registry as a CI job (currently `gcloud run deploy --source` builds on deploy).

### Test-debt surfaced by CI
- [ ] **Mobile strict-TS** — fix `mobile/src/components/Button.tsx` &
      `Input.tsx` (`TS2769: No overload matches this call`), then re-add the
      `tsc --noEmit` step to the mobile CI job.
- [ ] **`test_profile.py` B16** — stale assertion: asserts the profile schema has
      no `tags`/`concerns_or_questions_tags` field, but the schema now includes
      `tags`. Update the test (or split its pure groups behind a `unit` scope so
      it can join the gate).
- [ ] **`test_search_features.py`** — add a `unit` scope so its pure groups can
      join the gate while the `/api/chat` integration groups stay deferred.
