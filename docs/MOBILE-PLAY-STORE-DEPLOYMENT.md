# Mobile deployment runbook — Android / Google Play Store (`mobile/`)

Step-by-step for building, submitting, and releasing the **Meridian**
Android app via **EAS (Expo Application Services)** and the **Google Play
Console**. Companion to [`docs/MOBILE-APP-STORE-DEPLOYMENT.md`](MOBILE-APP-STORE-DEPLOYMENT.md)
(the iOS equivalent) — read that doc's §0 (managed/CNG workflow) and §1
(account-ownership principles) first if you haven't; the concepts carry over,
even though the concrete facts below are all Android/Google-specific.

> **Unlike the iOS side, this is a genuine from-scratch setup, not an
> access-recovery problem.** Confirmed by directly reading the repo: there is
> no Google Play Console account, no app record, no Android signing keystore,
> no `android` block in `mobile/eas.json`, no Android-side Firebase config
> (`google-services.json`), and no Android `androidClientId` wired into
> Google Sign-In anywhere. `docs/PROD-READINESS.md:174` already flagged this
> accurately: *"Google Play Console ($25 one-time) + app record — still not
> done."* This doc is the first real plan for closing that gap.

| Fact | Value |
|---|---|
| App name / slug | Meridian / `meridian` |
| Android package (applicationId) | `com.krishmalik.meridian` (`mobile/app.config.js:37`) |
| Android `versionCode` | `1` (`mobile/app.config.js:38`) — static today; **recommend switching to EAS-remote-managed** the same way iOS already is (see §2.6) |
| Play Console account | **Does not exist yet** |
| App record in Play Console | **Does not exist yet** |
| Signing keystore | **Does not exist yet** — EAS will generate one on first `eas build --platform android` |
| Workflow type | **Managed / CNG** — `mobile/android/` would be a disposable, gitignored `expo prebuild` artifact, same posture as `mobile/ios/` (confirmed: `mobile/.gitignore:45` ignores `/android`, nothing currently tracked, nothing yet generated) |
| Config file | `mobile/app.config.js` (same dynamic JS config as iOS) |

---

## 0. How the pieces fit together

```
  mobile/app.config.js  ──expo prebuild (CNG)──▶  mobile/android/ (gitignored, generated)
         │
         ▼
  mobile/eas.json  ──eas build──▶  EAS cloud build servers ──▶  signed .aab
         │  (EAS-managed upload keystore, auto-created on first build)      │
         │                                                              eas submit
         ▼                                                                  ▼
  Expo/EAS account (same projectId as iOS)                     Google Play Console → a release track
                                                                              │
                                                            (human) internal testing (instant)
                                                                    → closed testing
                                                          (mandatory: ≥12 testers, ≥14 days
                                                           continuously opted in, for any account
                                                           created after Nov 13, 2023 — this one
                                                           will be)
                                                                              │
                                                                    → open testing (optional)
                                                                              │
                                                                    → production rollout
```

The Android and iOS builds share the **same Expo/EAS project** (`projectId`
in `app.config.js`) and the **same `mobile/eas.json`** — only the
platform-specific blocks differ. Nothing here requires a second EAS project.

---

## 1. Accounts — simpler than the iOS story, if you set it up right this time

**The good news, stated up front:** Google Play Console does **not** have
an Apple-style "Individual account = one immortal owner" trap. From the
moment the account is created, Play Console supports multiple **Owners**
and **Admins** with full access, and role changes are self-service — no
Apple-style "only the original enrollee can ever have full access"
limitation exists. The single-point-of-failure problem documented at
length in `docs/MOBILE-APP-STORE-DEPLOYMENT.md` §1 is **avoidable here by
construction**, but only if whoever creates the account actually invites a
second Owner immediately — do not repeat the iOS mistake of leaving this to
one person by default.

**One real constraint worth knowing early:** only an existing **Owner** can
promote someone else to Owner — a new invitee must first be added as
**Admin**, then upgraded. So the very first thing to do after account
creation is invite a second person as Admin, then promote them to Owner.
This takes minutes and permanently removes the single-point-of-failure risk
for this platform.

---

## 2. One-time setup

### 2.1 Create the Google Play Console developer account

1. Go to https://play.google.com/console/signup and sign in with the Google
   account that should be the account's first Owner (consider: should this
   be a shared/organizational Google account rather than one person's
   personal Gmail, precisely to avoid a repeat of the iOS situation? Decide
   before creating it — this choice is much harder to undo than to get
   right up front).
2. Choose **account type** — Personal or Organization. (Google's split here
   is much lighter-weight than Apple's: it mainly affects the developer
   name shown on the store listing and identity-verification document
   type; it does **not** gate who can be an Owner/Admin the way Apple's
   Individual-vs-Organization split gates Developer Portal access.)
3. **Identity verification** (required for every new developer account,
   regardless of type):
   - A government-issued ID (passport, driver's license, national ID, or
     residence permit).
   - Proof of address (a recent bank statement, utility bill, or similar
     official document).
   - Possibly a live selfie/face check.
   - Confirmation you have access to a real Android device.
   - Processing typically takes a few hours, up to 2 business days.
4. **Payment profile** — link or create a Google payments profile; this
   also confirms legal name/address and is where the fee is charged.
5. **Pay the one-time $25 USD registration fee** — this is not annual
   (unlike Apple's $99/yr), it's paid once, ever, per account. **It is not
   refunded if identity verification later fails**, so get step 3 right the
   first time.
6. Once verified, the account is active — proceed to §1's recommendation:
   invite a second Owner before doing anything else.

### 2.2 Create the app record

1. Play Console → **All apps** → **Create app**.
2. App name: **Meridian** (or the exact store-facing name once decided —
   see the equivalent open question in `mobile/store.config.json` for iOS;
   Android doesn't share that file, see §5.4).
3. Default language, App or Game → **App**, Free or Paid → **Free**.
4. Accept the Developer Program Policies and US export laws declarations.
5. This creates an internal app record in **Draft** state — you'll fill in
   its store listing, content rating, and data safety details before it can
   move to any testing track (§4).

### 2.3 Android signing — simpler than iOS, EAS handles almost all of it

Unlike iOS (which needs interactive Apple ID + 2FA login the first time),
Android signing under EAS's managed workflow needs **no interactive Google
login at all** for the build side:

```bash
cd mobile
npx eas-cli build --platform android --profile production
```

- On the **very first** Android build for this project, EAS **automatically
  generates an upload keystore** and stores it on EAS's servers — there is
  no equivalent of Apple's "sign in with the account holder's Apple ID"
  step. Every subsequent build reuses it.
- Google's actual **app signing key** (the one that ultimately signs what
  ships to users) is managed by **Play App Signing**, Google's own
  service — the default and recommended setup for any new app since 2021.
  The first time you upload a build to Play Console, it'll show a one-time
  notice about "App Signing by Google Play" — **this is the default
  behavior and needs no action beyond clicking Continue.**
- From EAS's build process's own perspective, there's no difference between
  an "upload key" and a Google-managed "app signing key" — both just work.
- Inspect/back up the EAS-generated keystore any time:
  ```bash
  npx eas-cli credentials --platform android
  ```
  → lets you view the keystore, download it for backup (recommended — store
  in the same shared secrets vault as the iOS ASC API key, §2.4 below and
  `MOBILE-APP-STORE-DEPLOYMENT.md` §2.3), or associate a different one if
  needed.
- **Build artifact type**: defaults to **Android App Bundle (`.aab`)**,
  Google's required/recommended format (`eas.json`'s `android.buildType`
  is unset anywhere today, per repo survey — EAS's own default of
  `app-bundle` is correct and needs no change). `.apk` remains available
  (`buildType: "apk"`) but isn't needed here.

### 2.4 Google Service Account — for non-interactive `eas submit`

Same purpose as iOS's App Store Connect API Key (§1.3 of the iOS doc): lets
`eas submit`/CI upload to Play Console without a human logging in each time.

**Google Cloud Console side:**
1. Create (or reuse) a Google Cloud project at
   https://console.cloud.google.com/projectcreate.
2. **IAM & Admin → Service Accounts → Create Service Account** — give it a
   descriptive name (e.g. `eas-submit-meridian`).
3. On the new service account → **Keys → Add key → Create new key → JSON**
   → download it. **Store it immediately** in the shared secrets
   vault — same handling discipline as the iOS `.p8` (never git, never
   plaintext chat/email).
4. Enable the **Google Play Android Developer API** for that Cloud project:
   https://console.cloud.google.com/apis/library/androidpublisher.googleapis.com
   → **Enable**.

**Play Console side:**
5. **Users and permissions** → **Invite new users** → enter the service
   account's email address (looks like
   `eas-submit-meridian@<project>.iam.gserviceaccount.com`, found on the
   service account's Cloud Console page).
6. Grant it these permissions specifically (least-privilege — a service
   account doesn't need everything an Owner has):
   - **App access**: view app information (read-only) is enough unless you
     want it creating releases directly, in which case add more below.
   - **Draft apps**: edit and delete draft apps.
   - **Releases**: manage production, testing-track, and tester-list
     releases.
   - **Store presence**: manage store presence.
7. **Invite user.**

**Wiring it into `eas.json`** — same two options as iOS, and the same
current state: `mobile/eas.json`'s `submit.production` is `{}` today, with
no `android` key at all (confirmed by repo survey). Add it once the key
exists:
```json
"submit": {
  "production": {
    "android": {
      "serviceAccountKeyPath": "./secrets/google-service-account.json",
      "track": "internal",
      "releaseStatus": "draft"
    }
  }
}
```
- `track`: `internal` | `alpha` | `beta` | `production` — **start with
  `internal`** while getting the pipeline working (§4), raise it as the
  release matures.
- `releaseStatus`: `draft` | `inProgress` | `halted` | `completed` — `draft`
  is the safest default (uploads without publishing; you press Publish
  yourself in Play Console the first several times until you trust the
  pipeline).
- `rollout`: `0`–`1`, only meaningful with `releaseStatus: "inProgress"` —
  a staged percentage rollout; not needed at `internal`/`draft` stage.
- `changesNotSentForReview`: `boolean` — leave `false` (default) so review
  happens automatically; only relevant once you're doing production
  releases.
- **Never commit the actual JSON key file** — add `google-service-account*.json`
  to `mobile/.gitignore` alongside the existing `*.p8`/`*.p12`/`*.jks`
  entries (`mobile/.gitignore:14-19`) before this is ever created locally.

### 2.5 Google Sign-In — Android side is not configured yet (confirmed gap)

This is a real, currently-open gap, not a "nothing to do" item like iOS's
§2.4 was. Confirmed by reading the code: `AuthContext.tsx`'s
`GoogleSignin.configure()` call passes only `iosClientId` and
`webClientId` — **no `androidClientId`** — and `app.config.js`'s
`@react-native-google-signin/google-signin` plugin config sets only
`iosUrlScheme`. `mobile/config/` has `GoogleService-Info.plist` (iOS) but
**no `google-services.json`** (the Android equivalent). Google Sign-In on
Android will not work until this is done:

1. **Add an Android app to the existing Firebase project**
   (`proceedings-490601`, the same one iOS already uses) — Firebase Console
   → Project Settings → **Add app** → Android. Package name:
   `com.krishmalik.meridian` (must exactly match `app.config.js:37`).
2. **Get the SHA-1 and SHA-256 fingerprints from the EAS-managed upload
   keystore** (this is why §2.3's build must happen before this step):
   ```bash
   npx eas-cli credentials --platform android
   ```
   → view credentials → the keystore's SHA-1/SHA-256 are shown there.
   *(Already flagged as an outstanding item elsewhere in this repo —
   `docs/AUTH-NEXT-STEPS.md:116,164` and `docs/AUTH-INTEGRATION.md:110` all
   independently note "Android Google sign-in fails silently without
   them.")*
3. Add both fingerprints to the Firebase Android app's settings.
4. **Download `google-services.json`** from Firebase Console → save to
   `mobile/config/google-services.json` (parallel to the existing
   `mobile/config/GoogleService-Info.plist`).
5. Add to `app.config.js`'s `android` block:
   ```js
   android: {
     package: "com.krishmalik.meridian",
     versionCode: 1,
     googleServicesFile: process.env.GOOGLE_SERVICES_JSON || "./config/google-services.json",
     // ...existing adaptiveIcon, predictiveBackGestureEnabled...
   }
   ```
6. Get the **Android OAuth client ID** (auto-created by Firebase when you
   register the SHA-1 — visible in Google Cloud Console → APIs & Services →
   Credentials, or in the downloaded `google-services.json` itself) and
   pass it to `GoogleSignin.configure()` alongside the existing
   `iosClientId`/`webClientId` in `AuthContext.tsx`:
   ```ts
   GoogleSignin.configure({
     iosClientId: process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID,
     webClientId: process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID,
     // androidClientId is usually NOT required when google-services.json
     // is present — GoogleSignin reads it automatically on Android. Add
     // it explicitly only if sign-in fails without it.
   });
   ```
7. Add `EXPO_PUBLIC_GOOGLE_ANDROID_CLIENT_ID` to `mobile/eas.json`'s
   `build.base.env` (parallel to the existing
   `EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID`) if step 6's explicit pass-through
   turns out to be necessary.

### 2.6 Two operational gotchas worth knowing before the first submission

**`versionCode` should switch to EAS-remote-managed, same as iOS's
`buildNumber`.** Today it's a static `1` in `app.config.js:38` with no
`autoIncrement` equivalent wired up for Android specifically. Since
`eas.json`'s `appVersionSource: "remote"` (`eas.json:4`) is a project-wide
setting already active for iOS, add the same `autoIncrement: true` under
`build.production` (it already exists there — `eas.json:22` — and this
setting is **shared across both platforms** in a single `production`
profile, so no separate Android-specific change is actually needed here;
just don't hand-edit `android.versionCode` once builds start, same
discipline as iOS's `buildNumber`).

**Target API level deadline — time-sensitive as of when this doc was
written.** Google requires **new apps and app updates to target Android 16
(API level 36) or higher starting August 31, 2026**, with a possible
extension to November 1, 2026 if requested. Since Meridian's Play Console
app record doesn't exist yet, its **first-ever submission will land after
this deadline is already in effect** unless it happens very soon — confirm
the Expo SDK version in use (`expo: "^56.0.12"` per `mobile/package.json`)
already targets API 36+ before relying on this timeline; if not, an Expo
SDK upgrade may be a prerequisite to submitting at all. Check
https://docs.expo.dev/versions/v56.0.0/ (per this repo's own
`mobile/AGENTS.md` instruction to always check current versioned docs)
for exactly which `targetSdkVersion` SDK 56 ships with.

---

## 3. CI setup (for the automated GitHub Actions path)

Reuses the same `EXPO_TOKEN` repo secret already needed for iOS
(`docs/MOBILE-APP-STORE-DEPLOYMENT.md` §3.1) — **no separate Expo-side
token is needed for Android.** The only Android-specific CI secret is the
Google Service Account JSON from §2.4: base64-encode it and store as a repo
secret (e.g. `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`), decoded to a temp file
by the workflow at build time — mirrors exactly how the iOS workflow's
commented-out ASC-API-key step works (`.github/workflows/mobile-deploy.yml`,
the "Write App Store Connect API key" step). See §5.2 for the actual
workflow change.

The same `environment: production` manual-approval gate already covers
Android once the workflow is extended — no additional GitHub setup needed
(`docs/CI-CD.md#one-time-github-setup-needs-repo-admin`).

---

## 4. Everyday release flow

1. **Bump the version** in `mobile/app.config.js`'s `version` field (shared
   with iOS — keep them released together where practical, or independently
   if only one platform changed; the underlying `mobile/package.json`
   `version` stays the single source of truth for both, per
   `docs/RELEASE-TAGGING.md`). Leave `android.versionCode` alone (§2.6).
2. **Build**: `eas build --platform android --profile production`
   (§5.1/§5.2). Produces a signed `.aab`, uploaded to EAS's servers.
3. **Submit to `internal` track first, always** — even for the very first
   release. Internal testing has **no minimum tester count, no review
   wait, and releases go out within minutes** — the fastest possible
   smoke-test of the whole pipeline.
4. **Add internal testers** — Play Console → your app → **Testing →
   Internal testing** → create/manage the tester list (up to 100 people,
   by email or a shareable opt-in link). Install via the Play Store using
   an opted-in Google account.
5. **Closed testing — mandatory before production, budget real time for
   this.** Because this Play Console account is being created after
   November 13, 2023, Google requires **at least 12 testers continuously
   opted in for a minimum of 14 days** in a closed test before the app can
   be released to production. This is a hard gate, not a suggestion —
   **plan the first production release at least ~2 weeks out from when
   closed testing actually starts**, not from when the build is ready.
6. **Open testing** (optional) — a public, unlimited-size test track if
   broader pre-launch feedback is wanted; skip if not needed.
7. **Content rating questionnaire** — Play Console → your app → **App
   content → Content rating** → answer Google's IARC questionnaire
   (violence, UGC, data collection, etc. — expect overlap with the answers
   already given for Apple's Age Rating). Required before any release,
   including internal testing in some flows — do this early, not last.
8. **Data safety form** — Play Console → **App content → Data safety** —
   Google's equivalent of Apple's Privacy "nutrition label." Declare what
   data is collected/shared, matching what's already true from the iOS
   submission (this repo already scrubs PII from user content server-side —
   document that here the same way).
9. **Production release** — once closed testing's 14-day/12-tester
   requirement is satisfied and all store-listing/content-rating/data-safety
   sections are complete, promote to **Production** track, choose a rollout
   percentage (staged rollout recommended for a first release —
   `eas.json`'s `rollout` field, or done directly in Play Console UI), and
   publish.
10. **Tag the release** — same `mobile-vX.Y.Z` tag as iOS
    (`docs/RELEASE-TAGGING.md`) once both platforms (or whichever shipped)
    are confirmed live — this project tags per-component, not per-platform,
    so a mobile release covers both when both ship together.

---

## 5. Automation

### 5.1 npm scripts (`mobile/package.json`)

```bash
cd mobile
npm run build:android:preview       # eas build --platform android --profile preview
npm run build:android:production    # eas build --platform android --profile production
npm run submit:android              # eas submit --platform android --profile production --latest
npm run release:android             # local pipeline: preflight + build (+ optional --submit) — mirrors release-ios.sh
```

### 5.2 GitHub Actions — extend the existing `mobile-deploy.yml`

Rather than a parallel workflow, `mobile-deploy.yml` gains a `platform`
input (`ios` | `android` | `both`) alongside its existing `profile`/`submit`
inputs, reusing the same manual-approval gate and `EXPO_TOKEN`. See the
actual workflow file for the current implementation.

### 5.3 Local script — `mobile/scripts/release-android.sh`

Mirrors `release-ios.sh`'s preflight discipline (auth check, clean git
tree, tests, version confirmation) before shelling out to
`eas build --platform android`.

---

## 6. What's still manual, and why

| Step | Why it can't be (fully) automated |
|---|---|
| Identity verification for the Play Console account (§2.1) | Google requires government ID + proof of address from a real person — can't be scripted, by design. One-time only. |
| The 14-day/12-tester closed testing period (§4 step 5) | A hard Google Play policy gate tied to wall-clock time and real human testers — no build pipeline can shortcut it. |
| Content rating questionnaire, Data safety form (§4 steps 7-8) | Legal/policy declarations requiring a human's judgment about what the app actually does. |
| Promoting from closed/open testing to production, and any staged-rollout percentage decisions | A deliberate release decision, same philosophy as `docs/RELEASE-TAGGING.md`'s "tagging/releasing is always explicit, never automatic" rule for the rest of this project. |
| Google Sign-In Android config (§2.5) | One-time setup requiring a human to register fingerprints and verify sign-in actually works on a device — not meaningfully automatable, and it's genuinely not done yet. |

---

## 7. Optional next steps (not implemented in this pass)

- **`eas metadata`** does not support Google Play at all (confirmed —
  `docs/MOBILE-APP-STORE-DEPLOYMENT.md` §5.4) — there's no Android
  equivalent of `mobile/store.config.json`. Play Console's own listing
  fields must be filled in manually, or automated separately via direct
  Play Developer API calls (bigger lift, not covered here).
- **Play Console App Signing key rotation / Play Integrity API** — not
  relevant until the app has real production traffic worth hardening
  against; revisit later.
- **A second Firebase/Google Cloud service account scoped even more
  tightly** (e.g. separate keys for CI vs. manual local submits) — worth
  doing once release cadence justifies the extra credential-management
  overhead; one shared key is fine to start.

---

## 8. Troubleshooting

### Google Sign-In fails silently on Android
Almost certainly means §2.5 wasn't completed — specifically, the SHA-1/256
fingerprints from the EAS keystore were never registered with the Firebase
Android app. This exact failure mode is already flagged in
`docs/AUTH-NEXT-STEPS.md:164` — not a new bug, a known gap.

### `eas submit --platform android` fails with a permissions error
Check the Google Service Account actually has the specific Play Console
permissions listed in §2.4 step 6 (view app info, edit draft apps, manage
releases, manage store presence) — a service account invited with fewer
permissions than that will authenticate fine but fail on the actual submit
call.

### Play Console rejects the build citing target API level
See §2.6 — confirm the Expo SDK version's default `targetSdkVersion` meets
the current Google Play requirement (API 36 as of August 31, 2026); an Expo
SDK upgrade may be required.

### Can't promote out of closed testing yet
Check the actual elapsed days and continuously-opted-in tester count in
Play Console → Testing → Closed testing — both the 14-day and 12-tester
conditions must be satisfied simultaneously, not just once each.

---

## 9. Quick reference

```bash
# One-time
cd mobile && npx eas-cli login   # same Expo/EAS account as iOS
npx eas-cli credentials --platform android   # view/back up the keystore

# Every release
npm run build:android:production          # or: ./scripts/release-android.sh production
npm run submit:android                    # or: ./scripts/release-android.sh production --submit
# ...then in Play Console: internal → closed (14d/12 testers) → production

# CI
gh workflow run mobile-deploy.yml -f platform=android -f profile=production -f submit=true -f ref=main

# Check build/submit status
npx eas-cli build:list --platform android --limit 5
npx eas-cli submit:list --platform android --limit 5
```

Sources: [EAS Submit (Android)](https://docs.expo.dev/submit/android/) ·
[EAS app signing credentials](https://docs.expo.dev/app-signing/app-credentials/) ·
[Creating a Google Service Account key](https://github.com/expo/fyi/blob/main/creating-google-service-account.md) ·
[eas.json reference](https://docs.expo.dev/eas/json/) ·
[Play Console — Get started](https://support.google.com/googleplay/android-developer/answer/6112435) ·
[Play Console — Users and permissions](https://support.google.com/googleplay/android-developer/answer/9844686) ·
[Play Console — Set up an open, closed, or internal test](https://support.google.com/googleplay/android-developer/answer/9845334) ·
[Play Console — Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)
