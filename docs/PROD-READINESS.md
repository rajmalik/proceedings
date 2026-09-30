# Production readiness & go-live prerequisites — `meridianjourney.ai`

What must be in place to take the **website** and **mobile app** to production on the
newly-obtained domain **`meridianjourney.ai`** (support email **`support@meridianjourney.ai`**).

This is the *prerequisites + ordered plan*. The *how-to-deploy* mechanics already
live in [`DEPLOYMENT.md`](DEPLOYMENT.md) (Cloud Run runbook) and
[`CI-CD.md`](CI-CD.md) (the PR gate + manual-approval deploy). Read this first,
then execute against those.

> **Current state (baseline):** backend = Cloud Run `immiguide-api`; website =
> Cloud Run `immiguide-web` (both `us-central1`, project `proceedings-490601`,
> served only on `*.run.app` URLs). Mobile = Expo/RN, **never built or
> published**. Identity = dev **`X-User-Id` impersonation** (`ALLOW_USER_IMPERSONATION=1`),
> **not** real auth.

---

## ⚠️ Audit (2026-06-15) — launch blockers

A code-level audit of all three surfaces. **Verdict: NOT production-ready.** One cross-cutting blocker (auth) plus per-surface blockers. Foundation is otherwise solid (no committed server secrets; PII scrub at every write; backend Dockerfile COPY complete; import retry; recency ordering).

### 🔴 BLOCKER-0 (cross-cutting) — no real authentication; full account-takeover
> Full design + steps + risk: **[`AUTH-INTEGRATION.md`](AUTH-INTEGRATION.md)**.
Identity is an **unverified `X-User-Id` header**. `_active_user` (`api.py:606`) trusts the raw header; `ALLOW_USER_IMPERSONATION` defaults to `"1"` (`api.py:576`) and is **not** set to `0` in any deploy config. Both clients send the Firebase uid as a plaintext header that the server **never verifies** (web `activeUser.ts:23-27`, mobile `apiService.ts:37-43`). Anyone can `X-User-Id: <victim-uid>` (uids are public via `/api/postings/{id}.author_id`) and post/vote/delete, read+send **private group messages**, and overwrite a victim's profile. **The integration that unblocks launch:** server-side **Firebase ID-token verification** in `_active_user` (verify `Authorization: Bearer <idToken>` via `firebase-admin`), have web+mobile send the token, then set `ALLOW_USER_IMPERSONATION=0`.

| # | Surface | Blocker | Evidence |
|---|---|---|---|
| W1 | Web | Anon visitors **auto-impersonate a seed persona**; demo-user picker still rendered in prod; `/post`,`/onboarding`,`/find` have no login gate | `onboarding/page.tsx:101-109`, `find/page.tsx:317`; only `/profile` gates |
| W2 | Web | Dockerfile **bakes the wrong/old backend URL** (`fbtmilucfq…`, the retired Vector-Search build) into the build | `website/Dockerfile:16,26` vs `.env.local:7` |
| W3 | Web | **CORS omits `https://meridianjourney.ai`** (functional break) + over-broad `*.vercel.app` regex | `api.py:104-113` |
| W4 | Web | Raw **posting JSON debug block** shown to every user (`<details open>` dumps `author_id`/internal fields) | `case/[id]/page.tsx:122-128` |
| W5 | Web | Standalone build **drops `public/`** → `og-image.jpg`/favicon 404 | `website/Dockerfile:27` |
| M1 | Mobile | **No `eas.json`** — no production build pipeline exists | (absent) |
| M2 | Mobile | **"Skip Authentication (Dev Mode)" button ships** (no `__DEV__` guard) → bypasses all auth | `LoginScreen.tsx:196`, `SignupScreen.tsx:252` |
| M3 | Mobile | **No account-deletion flow** (Apple 5.1.1(v) + Google require it) | `ProfileScreen` has Sign Out only |
| M4 | Mobile | **No working Privacy/Terms URL** (footer links are dead `<Text>`) | `OnboardingScreen.tsx:92-94` et al. |
| M5 | Mobile | **No Android `package`** id → can't build/submit Android | `app.json:14-22` |
| M6 | Mobile | **No "Sign in with Apple"** while Google sign-in offered (Apple 4.8) | `AuthContext.tsx:120` |

### 🟠 HIGH
- **Rate limiter is in-memory/per-instance** (`api.py:120-133`) — ineffective on autoscaled Cloud Run, unbounded memory growth; move to shared (Firestore/Redis) + honor `X-Forwarded-For`.
- **No security headers** on the website (no CSP/HSTS/X-Frame-Options/Referrer-Policy) — add `headers()` in `next.config.js`.
- **No request body-size cap** (`api.py`) — list/dict fields uncapped; Gemini cost-amplification + DoS surface.
- Mobile **`ios/GoogleService-Info.plist` committed**; native iOS display name still **"Proceedings"**; no `ios.infoPlist` permission strings; no `android.package`/`buildNumber`/`versionCode`.

### 🟡 MEDIUM / cleanup
- Web: dead `#` links in `signup/page.tsx:209-211`; delete stale `Footer.tsx`/`Header.tsx` (old `proceedings.io` brand, unused); add `not-found.tsx`/`error.tsx`; add `robots`/`sitemap`.
- Mobile: **mock data in shipping screens** (`mockData.ts` → Community/News/AskPro/Onboarding); no splash plugin/config; verify icon/splash are the new brand; reconcile portrait-vs-iPad-landscape.

### ✅ Already solid (no action)
No committed server secrets (ADC only); backend `Dockerfile` COPY includes all 8 modules; **PII scrub** at every write; inline-import **retry** re-raises on persistent failure; BigQuery best-effort; facet-filter injection guarded; web `metadataBase`/OG on `meridianjourney.ai`; `/privacy`+`/terms` pages exist (web).

### ✅ Resolved (quick-win pass, 2026-06-15)
W3 CORS now includes `meridianjourney.ai` + anchored vercel regex · W2 Dockerfile URL aligned to the live backend · W5 Dockerfile copies `public/` · W4 case-page debug-JSON block removed · web security headers added (`next.config.js` — HSTS/X-Frame/nosniff/Referrer/Permissions; CSP still deferred) · signup dead links → `/terms`,`/privacy` · stale `Footer.tsx`/`Header.tsx` deleted · `not-found.tsx`+`error.tsx` added · M1 `eas.json` scaffolded · M5 Android `package` + version codes set · M4 (partial) Privacy/Terms links wired into mobile Profile (→ web pages).
**Still open (the auth project + store work):** BLOCKER-0 auth (token verification + remove dev bypasses W1/M2 + `ALLOW_USER_IMPERSONATION=0`), M3 account deletion, M6 Sign in with Apple, shared rate limiter, body-size cap, brand icon PNGs, counsel review.

---

## 0. Open decisions (need owner sign-off before executing)

| # | Decision | Recommendation |
|---|---|---|
| D1 | Canonical host: apex `meridianjourney.ai` vs `www` | Apex for the site, `www` 301→apex |
| D2 | API hostname | **DECIDED: keep `*.run.app`** — backend stays on its Cloud Run URL; no `api.` subdomain |
| D3 | `APP_SOURCE_SYSTEM` value | **DECIDED: `meridianjourney`** going forward (provenance label only; the small old corpus keeps `unclesamcalling`, ranking unaffected) |
| D4 | Mobile bundle IDs (hard to change post-publish) | **DEFERRED** to the mobile build phase (§6/F); current `com.krishmalik.proceedings` |
| D5 | Auth for launch | **Require Firebase Auth + turn off impersonation** before public launch (see §3, §8) |
| D6 | iOS "Sign in with Apple" | Required by Apple if offering Google sign-in → add, or restrict sign-in options |
| D7 | Support mailbox provider for `support@meridianjourney.ai` | Google Workspace / Zoho / forwarding-only |

---

## 1. Domain, DNS & email (`meridianjourney.ai`)

**Hostname plan**

| Host | Serves | Target |
|---|---|---|
| `meridianjourney.ai` | Website | Cloud Run `immiguide-web` (domain mapping) |
| `www.meridianjourney.ai` | redirect → apex | 301 |
| `support@meridianjourney.ai` | Support inbox | mailbox or forwarding |

> **Backend (D2):** stays on its Cloud Run `*.run.app` URL — **no `api.meridianjourney.ai`**. The website reaches it **server-side** (the `/api/*` proxy routes), and the mobile app calls it directly (native → run.app). Only the **website** gets a custom domain.

**Prerequisites / actions**
- [ ] Access to the registrar's DNS for `meridianjourney.ai`.
- [ ] **Cloud Run domain mapping** for the **site only** (`gcloud run domain-mappings create --service immiguide-web`), then add the **verification TXT** and the returned **A/AAAA/CNAME** records. Managed TLS certs are auto-provisioned (allow up to ~24h).
- [ ] Verify domain ownership in **Google Search Console / Webmaster** (required for Cloud Run domain mapping on a root domain).
- [ ] **Email DNS**: `MX` (provider), `SPF` (`TXT v=spf1 …`), `DKIM` (provider key), `DMARC` (`TXT _dmarc`). Needed both to **receive** support mail and to **send** transactional/auth email without spam-foldering.
- [ ] Decide email provider (D7) and create the `support@` mailbox.

---

## 2. Domain/email references in code to update

The provenance is env-driven, but several refs are **hardcoded** or default to the
old domain. Update these (config flips where possible, code edits where not):

| Location | Current | Change to |
|---|---|---|
| `backend/posting.py:46-47` | defaults `unclesamcalling` / `https://proceedings.app` | **✅ applied** — code defaults now `meridianjourney` / `https://meridianjourney.ai` (D3); env override optional per-env |
| `backend/posting.py:1058,1104` | **hardcoded** `https://proceedings.app/case/…` | **✅ applied** — now use `APP_BASE_URL` |
| `backend/tests/*` (4 `source_system` asserts/seeds) | `unclesamcalling` | **✅ applied** — `meridianjourney` |
| `backend/api.py` CORS `allow_origins` | `localhost:3000` + `*.vercel.app` | **No change needed** (D2) — the website proxies server-side and mobile is native, so no browser cross-origin call to the backend. Add the site origin only if a *direct browser→backend* call is ever introduced. |
| `website/src/app/layout.tsx` | `https://proceedings.ai` (metadataBase + OG url) | **✅ applied** — `https://meridianjourney.ai` |
| `website/src/app/disclaimer/page.tsx` | `support@proceedings.app` | **✅ applied** — `support@meridianjourney.ai` |
| `mobile/src/screens/DisclaimerScreen.tsx` | `support@proceedings.app` | **✅ applied** — `support@meridianjourney.ai` |
| **Cloud Run env** `immiguide-web` `PYTHON_API_URL` | `…run.app` | **unchanged** — keep the `immiguide-api` `*.run.app` URL (D2) |
| **Mobile env** `EXPO_PUBLIC_API_URL` | `…run.app` | **unchanged** — `immiguide-api` `*.run.app` URL (D2) |
| `website` footer (`layout.tsx`) | Terms/Privacy/Contact = `#` | **✅ applied** — `/terms`, `/privacy`, `mailto:support@meridianjourney.ai` (pages scaffolded) |

> Tip: consider a single `SUPPORT_EMAIL` constant per app to avoid future drift.

---

## 3. Auth & Firebase prerequisites (hard gate for public launch)

The app today runs on **`X-User-Id` impersonation** — anyone can act as any seed
user. **This must not ship to a public production audience.** Before launch:

- [ ] **Enable the real Firebase Auth path** and set `ALLOW_USER_IMPERSONATION=0` on the backend.
- [ ] Firebase (project `proceedings-490601`) → **Authentication → Settings → Authorized domains**: add `meridianjourney.ai`, `www.meridianjourney.ai`.
- [ ] **OAuth consent screen** (Google Cloud): app name, logo, **support email `support@meridianjourney.ai`**, authorized domain `meridianjourney.ai`, privacy/terms URLs; move from "testing" to "in production".
- [ ] Web Google sign-in: add `https://meridianjourney.ai` to **Authorized JavaScript origins** and redirect URIs.
- [ ] Mobile Google sign-in: iOS + Android OAuth client IDs (`EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID` / `…_WEB_CLIENT_ID`), Android **SHA-1/256** fingerprints (from the EAS keystore), iOS **reversed-client-id URL scheme**.
- [ ] **Sign in with Apple** (D6) if Google sign-in is offered on iOS.

---

## 4. Backend (`immiguide-api`) production prerequisites

- [ ] Backend stays on its `*.run.app` URL (D2) — **no domain mapping**.
- [ ] **CORS**: no change required (D2 — server-side proxy + native mobile); revisit only if a direct browser→backend call is ever added.
- [ ] **Env vars** finalized (`APP_BASE_URL`, `APP_SOURCE_SYSTEM`, `ALLOW_USER_IMPERSONATION=0`, plus the existing `GCP_*` set — see `DEPLOYMENT.md §2.3`).
- [ ] **IAM**: runtime SA roles already in place (`DEPLOYMENT.md §2.4`); add **Secret Manager accessor** if any secrets are introduced.
- [ ] **Secrets** → Secret Manager (no keys in env/git).
- [ ] **Scaling**: set `--min-instances=1` (avoid cold starts) and review `--cpu`/`--timeout` (the datastore cold path can be slow on `--cpu-throttling`); load-test.
- [ ] **Abuse/limits**: confirm the per-IP rate limiter is sized for real traffic; consider Cloud Armor / bot protection.
- [ ] **Observability**: uptime check on `/api/health`, error-rate + latency alerts, log-based metrics.
- [ ] **Firestore**: scheduled **export/backup**; review security rules (the BFF mediates, but lock down direct client access if Auth/SDK is added).
- [ ] **Dockerfile COPY**: any new backend module must be added to `backend/Dockerfile` (known gotcha).
- ✅ **GCS ingestion layout — verified, no change (decision: keep as-is).** Sidecars are written to `gs://imm-postings-ingestion/<YYYY-MM-DD>/<channel>/` — already **date-partitioned + source-segmented** (`reddit/`, `app/`). The date folder is computed at publish time (`datetime.now(timezone.utc)`, `posting.py:691`) and auto-created on the first write of the day — **no cron / pre-creation needed** (GCS folders are virtual prefixes; a day with zero postings simply has no folder). The first-party segment stays the controlled `channel` token **`app`** (search boost / filter chips / schema validator key on it, D-036/D-038); the brand/domain is carried in the `source_system` field (now `meridianjourney`), **not** the path. Note: the day boundary is **UTC** — switch `date_str` to a fixed US tz if local-day folders are ever required.

---

## 5. Website (`immiguide-web`) production prerequisites

- [ ] **Domain mapping** `meridianjourney.ai` + `www` (301 to apex, D1).
- [ ] **Build-time `PYTHON_API_URL`** baked in the Dockerfile = the `immiguide-api` `*.run.app` URL (D2; read at build for ISR routes), plus the runtime env var.
- [ ] **SEO/metadata**: `metadataBase`/OG → `meridianjourney.ai` (§2); replace the **placeholder OG image** (currently the logo JPEG) with a real 1200×630; add `robots.txt` + `sitemap`.
- [ ] **Real footer links**: `/terms`, `/privacy` pages (currently `#`); disclaimer is done.
- [ ] **Consent/analytics**: cookie-consent banner if serving EU; wire analytics if desired.
- [ ] **Security headers** (CSP, HSTS, etc.) via `next.config.js` headers.
- [ ] Build & smoke per `DEPLOYMENT.md §3.0`.

---

## 6. Mobile (Expo / EAS) prerequisites

> **Updated — no longer "never built."** The app has already shipped through
> **two real App Store Review submissions** (build 11 rejected on Guidelines
> 5.1.1(i)/5.1.2(i)/2.3.6; build 12 fixed and resubmitted — see
> [`docs/business/app-review-1.2-ugc-response.md`](business/app-review-1.2-ugc-response.md)),
> and `mobile/eas.json` has existed since commit `e23cab7`. The
> checklist below is kept for historical accuracy on what was originally
> flagged, with items struck through/annotated where reality has moved on.
> **For the current, accurate, step-by-step release process, automation, and
> a corrected checklist, see
> [`docs/MOBILE-APP-STORE-DEPLOYMENT.md`](MOBILE-APP-STORE-DEPLOYMENT.md).**

**Accounts & tooling**
- [x] **Apple Developer Program** ($99/yr) + App Store Connect app record — active (proven by the build 11/12 submissions).
- [ ] **Google Play Console** ($25 one-time) + app record — still not done; full step-by-step now documented in [`docs/MOBILE-PLAY-STORE-DEPLOYMENT.md`](MOBILE-PLAY-STORE-DEPLOYMENT.md) §2.1.
- [x] **Expo/EAS** account; `eas-cli` is now a pinned `mobile/package.json` devDependency (`eas login` still needed once per machine).

**Project config**
- [x] ~~Create `mobile/eas.json` (absent)~~ — **exists**, has `development` / `preview` / `production` build profiles + `submit` config (6 commits of history since `e23cab7`).
- [x] **Bundle IDs finalized** (D4): iOS `bundleIdentifier` `com.krishmalik.meridian` (already submitted to Apple twice). `ios.buildNumber` is managed **remotely by EAS** (`eas.json`'s `appVersionSource: "remote"` + `production.autoIncrement: true`) — don't hand-edit it.
- [ ] **Icons/splash**: regenerate `assets/icon.png`, `splash`, and the **adaptive-icon foreground** from a transparent brand asset (flame-in-ring). *(Only the adaptive background color is on-brand today.)*
- [ ] **Env**: `EXPO_PUBLIC_API_URL=https://api.meridianjourney.ai`, Firebase config, Google client IDs (§3) — set as EAS build secrets, not committed.
- [ ] **Permissions strings**: iOS `Info.plist` `NS*UsageDescription` for any camera/photo/notification use; Android permissions in `app.json`.
- [ ] **Deep links / universal links**: keep/replace the `proceedings` scheme; host **`apple-app-site-association`** and **`assetlinks.json`** on `meridianjourney.ai` to enable iOS Universal Links / Android App Links.
- [ ] **Push (FCM/APNs)** keys/certs **if** notifications are enabled (currently the AI-chat/FCM path is off).

**Store listing assets** (both stores)
- [ ] Name, subtitle, description, keywords, **screenshots** (per device size), app preview, **category**, **content/age rating**, marketing URL.
- [ ] **Support URL/email** = `support@meridianjourney.ai`; **Privacy Policy URL** = `https://meridianjourney.ai/privacy` (must exist — §5).
- [ ] **Apple Privacy "nutrition labels"** + **Google Play Data Safety** form (declare PII collected; we PII-scrub user content — document it).
- [ ] **In-app account deletion** flow — **required** by Apple (and Google) when accounts exist → currently **missing**, build it.
- [ ] iOS **export-compliance** answer (uses HTTPS only → usually "exempt").

**Release path**
- [ ] `eas build --profile production` (iOS + Android) → **TestFlight** / **Play internal testing** → fix → **store review** → public release.

---

## 7. Legal / compliance prerequisites

- [ ] **Privacy Policy** (`/privacy`) and **Terms of Service** (`/terms`) — required by both app stores and generally; the disclaimer is done but is **not** a privacy policy.
- [ ] **Account deletion** (in-app + a web path) — store requirement.
- [ ] Data handling note: user-content **PII scrub** is live (postings/replies/profiles/chat); document retention.
- [ ] GDPR/CCPA basics + cookie consent if in scope.
- [ ] Have **counsel review** the disclaimer/privacy/terms; swap the placeholder support email/dates.

---

## 8. Security & ops prerequisites (cross-cutting)

- [ ] **Disable `X-User-Id` impersonation** in prod (the single biggest security gate — §3).
- [ ] **CI/CD**: branch protection requiring the `ci-gate`; activate the **manual-approval deploy** (`deploy.yml`) via **Workload Identity Federation** (no SA keys) — see `CI-CD.md`.
- [ ] Secrets in **Secret Manager**; rotate any exposed values.
- [ ] **Monitoring/alerting** + error tracking (e.g. Sentry) across backend/website/mobile.
- [ ] **Backups** (Firestore export) + a tested **rollback** (Cloud Run revisions; store phased rollout).
- [ ] **Cost controls**: budget alerts, quota review (Gemini/Discovery Engine), min/max instances.
- [ ] Revisit the documented **pseudonymous `user_id` exposure** (defense-in-depth) — decide.

### 8.1 Monitoring incoming traffic & ingestion

A new app post fans out to **four sinks** at publish time. Where to watch, and what each is authoritative for:

| Want to know… | Where | Authoritative for |
|---|---|---|
| Volume / trends / by source | **BigQuery** `proceedings-490601.postings.postings_metadata` (partitioned by `posting_date`) | analytics — **best-effort** (BQ write is non-blocking; an outage drops the row while the post still indexes, so not an exact audit) |
| Raw sidecars landing | **GCS** `gs://imm-postings-ingestion/<date>/app/` (`<case_id>.md` + `.json`) | "a sidecar was written" |
| Reached search | **Vertex AI Search** datastore `imm-postings-datastore` (Console → Documents count, or a `channel:"app"` search) | "it's in the index" |
| API traffic / errors / latency | **Cloud Run** logs + Monitoring (`immiguide-api`) — `POST /api/postings`, plus `posting: …` app logs incl. the import-retry warnings | real-time health |
| Author/identity records | **Firestore** `posting_authors` | secondary |

Quick commands:
```bash
# BigQuery — posts per day (filter app via source_system or case_id prefix)
bq query --use_legacy_sql=false 'SELECT posting_date, COUNT(*) AS posts
  FROM `proceedings-490601.postings.postings_metadata`
  WHERE source_system="meridianjourney" GROUP BY posting_date ORDER BY posting_date DESC LIMIT 14'

# GCS — today's landed posts (UTC date)
gcloud storage ls gs://imm-postings-ingestion/$(date -u +%F)/app/ | grep -c '\.json$'

# Cloud Run — ingestion failures (the retry safety net logs these)
gcloud logging read 'resource.labels.service_name="immiguide-api"
  AND textPayload:("datastore import failed" OR "transient import error")' \
  --project proceedings-490601 --freshness=1d
```

**To set up for prod (Cloud Monitoring):**
- [ ] Dashboard: `POST /api/postings` request count + 5xx rate + p95 latency; daily-posts chart from BigQuery.
- [ ] **Log-based metric + alert** on `"datastore import failed after"` → fires only when a post fails to index after retries (the one real ingestion-loss signal).
- [ ] Uptime check + alert on `/api/health`.

> **DECISION: monitor via GCS + BigQuery for now; Pub/Sub notification deliberately NOT introduced.** None exists today (verified — no notification code, none configured on the bucket), and we are **not** adding event-driven push at this time. Monitoring is **pull-based**: list `gs://imm-postings-ingestion/<date>/app/` and query `postings.postings_metadata`. (If event-driven is ever wanted later, it'd be a `gcloud storage buckets notifications create … --event-types=OBJECT_FINALIZE` add — out of scope now.)

---

## 9. Phased go-live plan (ordered)

1. **A — Decisions**: lock D1–D7 (§0).
2. **B — Domain & email**: DNS, Cloud Run domain mapping (**site only** — backend stays on run.app, D2), TLS, email records (§1).
3. **C — Code/config swap**: apply the §2 edits; redeploy backend (CORS/`APP_*`) and website (`PYTHON_API_URL`, metadata); add `/privacy` + `/terms` (§5, §7).
4. **D — Auth hardening**: Firebase Auth live, impersonation off, OAuth consent + authorized domains (§3, §8).
5. **E — Backend/website prod hardening**: scaling, monitoring, backups, security headers, WIF deploy gate (§4, §5, §8).
6. **F — Mobile**: accounts, `eas.json`, bundle IDs, icons, env, account-deletion, store assets → TestFlight/Play internal → review (§6).
7. **G — Launch**: cut over DNS, smoke (`test_cloud_run.py` against `api.meridianjourney.ai`), monitor; submit mobile for public release.

---

## 10. Quick prerequisite checklist (high-signal)

- [ ] DNS + Cloud Run domain mapping (`meridianjourney.ai`, `www`; backend stays on `*.run.app`) + TLS
- [ ] Email (`support@meridianjourney.ai`) with SPF/DKIM/DMARC
- [ ] §2 domain/email code+env swaps applied & redeployed; backend CORS updated
- [ ] Firebase Auth live, **impersonation off**, OAuth consent + authorized domains
- [ ] `/privacy` + `/terms` pages live; counsel-reviewed
- [ ] Apple Developer + Google Play accounts; `eas.json`; final bundle IDs; brand icons
- [ ] Mobile account-deletion + store privacy forms; TestFlight/Play internal
- [ ] Monitoring, backups, secrets in Secret Manager, WIF deploy gate, budget alerts
