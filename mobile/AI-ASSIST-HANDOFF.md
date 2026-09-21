# AI Assist (mobile) — enablement & simulator-verification handoff

**Status:** code complete + unit-tested, shipping **OFF**. What's left is a
device/simulator verification pass and then flipping the feature flag.

This document is for the developer taking over the enablement of
`EXPO_PUBLIC_AI_ASSIST_ENABLED=1` and the iOS-simulator verification of the
mobile AI Assist feature (PR: `feature/sync-mobile` → `build-release-1.3`).

---

## 1. What's already done

- The AI Assist chatbot and discussion/blog authoring are fully built in the
  Expo/RN app (`mobile/`), against the **same production backend**
  (`immiguide-api`) the website uses. `POST /api/assist` is **live in prod**
  (the website AI Assist is already fully enabled).
- **277 Jest tests pass**; all edited source is `tsc`-clean. See
  `src/components/chat/__tests__/AssistModal.test.tsx`,
  `src/services/__tests__/apiService.test.ts`,
  `src/screens/__tests__/PostScreen.test.tsx`.
- The feature is gated by a **build-time** flag `EXPO_PUBLIC_AI_ASSIST_ENABLED`,
  which defaults **OFF**. Nothing is user-visible until it is set to `1`.

Key files: `src/constants/flags.ts`, `src/components/chat/AssistModal.tsx`,
`src/services/apiService.ts` (`assistTurn`, `getAssistSessionId`),
`src/navigation/MainNavigator.tsx` (floating launcher + modal),
`src/navigation/navigationRef.ts`, `src/utils/assistLauncher.ts`,
`src/screens/SearchScreen.tsx` (Home "Ask AI/Post" entry),
`src/screens/PostScreen.tsx` + `src/screens/FindScreen.tsx` (handoff targets).

---

## 2. ⚠️ Known environment blocker (read first)

The original machine had **Xcode 27**, which is **incompatible with Expo SDK 56**
and could not produce a native build. Concretely, on Xcode 27:

1. Expo's `devicectl` detection is broken → `expo run:ios` mislabels the
   **simulator** as a physical device and fails with
   `No code signing certificates are available to use.`
2. Several transitive CocoaPods declare `IPHONEOS_DEPLOYMENT_TARGET` < 15.0,
   which Xcode 27 rejects.
3. **The Swift compiler crashes** compiling `expo-modules-jsi`
   (`JavaScriptRuntime.swift`) — a hard toolchain incompatibility.

**Use a compatible toolchain (Xcode 16.x, which Expo SDK 56 supports).** On
Xcode 16 none of the above occur and `expo run:ios` "just works" against a
simulator.

> If you are stuck on Xcode 27 for some reason, prefer an **EAS cloud build**
> (§5) — do not try to force a local Xcode-27 build.

---

## 3. Prerequisites

- macOS with **Xcode 16.x** installed and selected:
  ```bash
  # install Xcode 16 (e.g. via the `xcodes` tool) then select it:
  brew install xcodesorg/made/xcodes
  xcodes install 16.2
  sudo xcode-select -s /Applications/Xcode_16.2.app
  xcodebuild -version   # expect Xcode 16.x
  ```
- CocoaPods with a UTF-8 locale (avoids a Ruby encoding crash during
  `pod install`):
  ```bash
  export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8   # add to your ~/.zprofile
  ```
- Node deps installed: `cd mobile && npm install`.
- A booted iOS simulator (any modern iPhone), e.g.
  `xcrun simctl boot "iPhone 16 Pro"`.

---

## 4. Enable the flag + build on the simulator (recommended path)

`EXPO_PUBLIC_*` vars are **inlined at build/bundle time**, so the flag must be
present in the environment when Metro bundles.

### Option A — one-off (does not commit anything)
```bash
cd mobile
EXPO_PUBLIC_AI_ASSIST_ENABLED=1 npx expo run:ios
# If prompted to choose a device, pick a SIMULATOR (not a physical device).
```
This runs `pod install`, builds the debug app, installs it on the simulator,
and starts Metro with the flag inlined.

### Option B — persist for local dev
Add to `mobile/.env` (⚠️ confirm whether `.env` is committed in your workflow;
if it is, do **not** commit the enablement unless that's intended):
```
EXPO_PUBLIC_AI_ASSIST_ENABLED=1
```
then `npx expo run:ios`.

### Sanity check the flag actually took
The floating "sparkles" chat button (bottom-right) and the **"Ask AI / Post"**
button under the Home search bar only render when the flag is on. If you don't
see them, the flag wasn't inlined — clear Metro cache and rebuild:
```bash
npx expo start -c    # clears the transform cache
```

---

## 5. Alternative: EAS cloud build (no local Xcode needed)

Builds on Expo's macOS with a compatible Xcode; good if local Xcode is wrong.
```bash
cd mobile
# set EXPO_PUBLIC_AI_ASSIST_ENABLED=1 in the eas.json build profile's `env`
eas build -p ios --profile development
```
Install the resulting dev-client build on the simulator, then
`EXPO_PUBLIC_AI_ASSIST_ENABLED=1 npx expo start` and open it.

---

## 6. Verification checklist (simulator QA)

Sign in (or use the dev user picker in a `__DEV__` build). AI answers require
the **AI-data-sharing consent** to be accepted (Profile → AI answers); if it's
off, the modal shows a "turn on AI data sharing" message — that's expected.

**Entry points**
- [ ] Floating "sparkles" button appears bottom-right on the tab screens; tap → chat modal opens.
- [ ] Home search bar shows **"Ask AI / Post"**; tap → the same modal opens.
- [ ] "New chat" (header) clears the conversation; close + reopen restores it (session persistence).

**Answer tiers** (ask a real question, e.g. *"What form do I file for a change of address?"*)
- [ ] Grounded answer renders (Markdown) with a **Sources** list; tapping a source opens it.
- [ ] A community-type question shows **community cards** that open the posting.
- [ ] An out-of-corpus question shows the **"Not from our sources — search further"** row with **Search community forum** + **Search on USCIS.gov**.
- [ ] (If the backend web tier fires) a **"From a live search of official sources"** label + the Google search-suggestion **chips** (WebView) render; tapping a chip opens the browser. *(The web tier is priced — see §7.)*

**Handoffs**
- [ ] **Post**: a "describe your situation…" turn → "Post this to the community" / "Continue to your post" → lands on the Post composer **prefilled** from the draft.
- [ ] **Timeline**: an EAD/H-1B processing-time question → "Go to the timeline page" → Find screen opens on **Timeline** with processing type / eligibility / month-year **prefilled**; or "Open your timeline group" → the group.
- [ ] **Find-similar**: "anyone else like me…" → "Find people in the same boat" → Find screen opens on **Regular** with the situation text + visa prefilled.

**Discussion authoring** (separate from AI Assist, also new)
- [ ] Discussions tab → **"Start a discussion"** → Post composer in discussion mode (Discussion/Blog toggle, **no** visa gate, visa sections hidden).
- [ ] Submit a discussion → succeeds (no "add a visa/status" error), appears in the Discussions feed.

**Guardrails**
- [ ] Rapid repeated asks as a guest → a **guest-limit** nudge (429) appears rather than an error.
- [ ] The small-print disclaimer is pinned at the bottom of the modal.

---

## 7. Turning it on for real + notes

- **Cost:** the backend web-search tier (`AI_ASSIST_WEB_SEARCH`) is **enabled in
  prod** and is **priced per grounded query**. Once the mobile flag is on, mobile
  users can trigger it. Watch cost after enabling.
- **Rollout:** flip `EXPO_PUBLIC_AI_ASSIST_ENABLED=1` in the **distribution build
  env** (EAS build profile `env`, or CI build env) — not just locally — for the
  flag to reach TestFlight / App Store builds. The website equivalent is already
  live, so there is no backend work to coordinate.
- **Rollback / kill switch:** ship a build with the flag unset/`0`. It's
  build-time, so disabling requires a new build (there is no runtime toggle).
- **Backend contract:** `POST /api/assist` with `userHeaders()` (Firebase Bearer
  + `X-User-Id`), body `{ message, history, session_id, force_intent }`. Nothing
  to deploy — it's the same prod API the website uses.

---

## 8. Gotchas

- `ios/` is **gitignored** (Expo "prebuild"/CNG regenerates it). Any native
  tweak there (e.g. a Podfile deployment-target bump for Xcode 27) is local-only
  and will not persist — the fix is the right Xcode, not editing `ios/`.
- `EXPO_PUBLIC_AI_ASSIST_ENABLED` is **build-time**; changing it needs a rebuild
  (and often `expo start -c` to clear the transform cache).
- `react-native-webview` was added (for the web-tier chips) — a native module,
  so a `pod install` / native rebuild is required (it's already in
  `package.json` + `Podfile.lock`).
