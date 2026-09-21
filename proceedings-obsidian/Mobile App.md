# Mobile App

**Location:** `mobile/`
**Stack:** React Native 0.85 + Expo SDK 56 (managed, CNG prebuild), TypeScript, React 19
**App identity:** "Meridian" (`slug: meridian`, bundle `com.krishmalik.meridian`), light-locked
**Backend:** shares the FastAPI service in [[api.py]] (Cloud Run) — same contracts as [[Website]]

---

## Purpose / overview

The native iOS/Android client for Proceedings, shipped under the **Meridian** brand. It is a feature-parity companion to the [[Website]]: the same immigration-intake community, grounded AI answers, profile/onboarding, posting, matching, and group chat — all talking to the identical FastAPI backend ([[api.py]]). See [[MOBILE-WEBSITE-PARITY]] for the parity matrix.

The app is auth-gated (Firebase Auth: email/password, Google, Apple), enforces a one-time **third-party AI data-sharing consent** gate (App Store 5.1.1(i)/5.1.2(i)) before any AI feature runs, and ships UGC-safety controls (report + block, App Store 1.2). It is **light-mode only** — see [[Design System]].

---

## Stack

| Concern | Choice |
|---|---|
| Runtime | Expo SDK **56** (`expo ^56.0.12`), React Native **0.85.3**, React **19.2** |
| Language | TypeScript (`~6.0.3`) |
| Navigation | `@react-navigation` v6 — native-stack + bottom-tabs (custom tab bar) |
| Auth | `firebase` v12 (`firebase/auth`), `@react-native-google-signin/google-signin`, `expo-apple-authentication` |
| Animation | `react-native-reanimated` 4.3 + `react-native-worklets`, `react-native-gesture-handler` |
| Graphics | `@shopify/react-native-skia` (Aurora grounds), `react-native-svg` (AI orb), `expo-blur`, `expo-linear-gradient`, `react-native-magic-orb` |
| Fonts | `@expo-google-fonts/lora` + `@expo-google-fonts/nunito-sans` (runtime-loaded) |
| Storage | `@react-native-async-storage/async-storage` (session/user/consent/profile cache) |
| Haptics | `expo-haptics` |
| Testing | `jest-expo` + `@testing-library/react-native` |
| AI (client) | `@google/generative-ai` — present; primary AI runs server-side via [[api.py]] |

Build config in `mobile/app.config.js` (EAS project, Sign in with Apple entitlement injected on prebuild via `usesAppleSignIn`, Google URL scheme, adaptive Android icon). A custom config plugin `plugins/withModularHeaders` and `patch-package` (postinstall) round out the native setup.

---

## Structure

`mobile/src/`:

| Dir | Holds |
|---|---|
| `screens/` | 24 screen components (`index.ts` barrel). Auth, onboarding, feed/community, AI chat, profile, posting, groups. |
| `components/` | 38 shared UI primitives + `chat/` subfolder (5 chat components). Buttons, cards, badges, inputs, skeletons, tab bar, orb, aurora — all theme-token driven. |
| `contexts/` | `AuthContext` (Firebase session, dev mode, welcome/onboarding flags, block list) and `AIConsentContext` (per-user AI data-sharing decision). |
| `services/` | Backend + AI clients: `apiService.ts`, `aiConsent.ts`, `geminiService.ts`, `vertexSearchService.ts`. |
| `navigation/` | `MainNavigator.tsx` — the single auth/consent/onboarding gate + tab navigator. |
| `hooks/` | `animations/` (`useAnimatedPressable`, `useFadeIn`, `useSlideIn`, `useStaggeredList`) and `useExperienceFacets.ts`. |
| `constants/` | `theme.ts` (design tokens — see [[Design System]]) and `onboardingData.ts` (curated offline vocab fallbacks). |
| `config/` | `firebase.ts` (Firebase app/auth init) + `GoogleService-Info.plist`. |

---

## Screens

Grouped by area (`src/screens/`). Screens marked ⚠ are legacy/mock (use `data/mockData`, **not** wired into `MainNavigator`).

**Auth & gate**
| Screen | Purpose |
|---|---|
| `WelcomeScreen` | First-run hero (Aurora ground); routes new users → Signup, returning → Login. |
| `LoginScreen` / `SignupScreen` | Email/password + Google + Apple sign-in over a dark glass Aurora ground. |
| `EmailVerificationScreen` | 6-digit email code gate for email/password sign-ups (Google/Apple auto-verified). |
| `AIConsentScreen` | One-time third-party AI data-sharing disclosure + affirmative consent (App Store 5.1.x). |
| `DisclaimerScreen` | Legal disclaimer / EULA (modal; mirrors website `/disclaimer`). |

**Onboarding**
| Screen | Purpose |
|---|---|
| `BackgroundOnboardingScreen` | Stage 1 — conversational AI "basics" capture → profile draft. |
| `ExperiencesOnboardingScreen` | Stage 2 — conversational AI "experiences" capture. |
| `OnboardingScreen` ⚠ | Old stepper-based onboarding (unused). |

**Home / feed / community**
| Screen | Purpose |
|---|---|
| `HomeScreen` | Tab root; live recent-posting previews + entry to AI chat and posting. |
| `SearchScreen` | Community tab root — postings search/browse with facets/strictness (mirrors website `/search`). |
| `VisaExperiencesScreen` | Filterable visa-experience feed (report/block-aware). |
| `CaseDetailsScreen` | Single posting detail: body, tag sections, votes, replies, source link (Reddit-gated). |
| `PostScreen` | Compose a posting; AI tag-suggest + controlled-vocab pickers (website `<datalist>` parity). |
| `AuthorScreen` / `AuthorByHandleScreen` | Author public profile + their postings (by uid / by handle). |
| `CommunityScreen` ⚠ | Old mock forum (unused; replaced by `SearchScreen`). |
| `NewsScreen` ⚠ | Mock immigration-news feed (unused). |

**AI chat**
| Screen | Purpose |
|---|---|
| `AIChatScreen` | Full-screen grounded Q&A with the RAG backend (orb UI); replaced the floating chat button. |
| `AskProScreen` ⚠ | Mock "ask an attorney" screen (unused). |

**Matching & groups**
| Screen | Purpose |
|---|---|
| `FindScreen` | "Groups" tab root — conversational criteria → matches, profile reconcile, group create/join. |
| `GroupChatScreen` | Real-time-ish group message thread (polling), with report/block/delete. |

**Profile**
| Screen | Purpose |
|---|---|
| `ProfileScreen` | View/edit profile, key stages/dates, activity; sign out; delete account. |

---

## Backend integration

All backend calls go through **`src/services/apiService.ts`**, which targets the same Cloud Run FastAPI service as the website:

- **Base URL:** `EXPO_PUBLIC_API_URL` or default `https://immiguide-api-971592620882.us-central1.run.app`.
- **`apiFetch`** wraps `fetch` with a 30s `AbortController` timeout, throwing a typed `ApiError` (status `0` = network/timeout) so screens can branch on failure. `safeJson` never throws on non-JSON error bodies.
- **Auth headers (`userHeaders`)**: `Authorization: Bearer <Firebase ID token>` (token pushed by `AuthContext` via `onIdTokenChanged` → `setIdToken`) plus a legacy `X-User-Id` fallback (accepted only when backend `ALLOW_USER_IMPERSONATION=1`). `registerBackendUser(uid, username)` does an idempotent `POST /api/users` then sets the active user.
- **AI-gated calls** call `assertAIConsent()` before hitting the backend: `askQuestion` (`/api/ask`), `onboardTurn` (`/api/onboard`), `reconcile` (`/api/reconcile`).
- **Endpoints covered**: ask/QA history/feedback ([[query.py]]); search + tag-vocab + tag-suggest ([[search_client.py]], [[posting.py]]); postings CRUD + replies + votes; find chat/matches + groups + group messages ([[matching.py]]); profile get/update + reconcile ([[profile.py]], [[reconcile.py]]); UGC reports + blocks ([[moderation.py]]); email verification (`/api/auth/*`); account delete (`/api/users/me`).
- **Caching**: tag vocab cached per session (falls back to `constants/onboardingData` offline); profile cache is **namespaced per uid** (`proceedings_profile_cache_<uid>`) so accounts never leak on a shared device — same discipline as the per-user AI-consent key.

Other service clients: `aiConsent.ts` (in-memory consent flag + `assertAIConsent`), `geminiService.ts` / `vertexSearchService.ts` (direct client-side AI/search helpers).

---

## Conventions

From `mobile/AGENTS.md` (the "A1 unification" rules) — see [[Design System]] for the full token reference:

- **Text**: render via `<AppText variant="…" color="…">` or spread a `typography.*` token — never inline `fontSize:` literals or raw `<Text>` with ad-hoc styles.
- **Fonts**: only the loaded families exist (`Lora_400/500/600/700`, `NunitoSans_400/500/600/700`). **Never pair `fontWeight` with `fontFamily`** — weight is encoded in the family name; pairing causes Android faux-bold or a silent system-font fallback.
- **Colors**: all from `theme.colors` — no hex literals in screens/components.
- **Motion/haptics**: tappable cards/rows use `AnimatedPressable` (scale + haptics). Haptics — `light` = navigation taps, `medium` = state-changing actions (vote/submit), none = chat send. List entrances: `FadeInDown.springify()` staggered ≤60ms, capped at the first 6 items; no entrance animation in chat or long forms.
- **Loading/empty/error**: use the shared `Skeleton` / `EmptyState` / `ErrorState` components — never hand-roll `ActivityIndicator` screens.

> `mobile/theme.md` records a live audit of where these conventions still drift (inline `fontSize`/`fontWeight` tails, hardcoded hex in ~9 files, off-grid spacing atoms).

---

## Navigation flow

`MainNavigator.tsx` renders a single linear gate before the tabs:

1. `loading` (auth + consent) → spinner
2. no `user` (and not dev mode) → **AuthNavigator** (Welcome/Login/Signup)
3. signed-in but email unverified → **EmailVerificationScreen**
4. AI consent `decision === null` → **AIConsentScreen**
5. onboarding incomplete → **OnboardingStack** (Background → Experiences)
6. else → **TabNavigator**

`TabNavigator` uses a custom `FloatingTabBar` with four tabs: **Home**, **Groups** (`FindStack`), **Community** (`SearchStack`), **Profile** — each a native-stack. The floating AI chat button/modal is behind `AI_CHAT_ENABLED = false` (AI chat is now a full screen off Home). Dev-mode bypass only works in `__DEV__` builds.

---

## Related

- [[Design System]] — theme tokens, typography, motion (summary of `mobile/theme.md`)
- [[Website]] — the Next.js sibling client with the same backend contracts
- [[api.py]] — the FastAPI backend the app calls
- [[posting.py]], [[profile.py]] — posting/tagging and profile/onboarding backends
- [[MOBILE-WEBSITE-PARITY]] — feature parity matrix
- [[Proceedings — Project Overview]]
