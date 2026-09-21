# UI_AUDIT.md — Meridian Mobile Visual/Cosmetic Audit

> Scope: visual/cosmetic only — logic, data, and backend assumed working.
> Ground truth: `mobile/theme.md` + `src/constants/theme.ts`. Severity = **visual impact** only.
> Generated 2026-07-23.

## Summary

Meridian has a **genuinely good design system on paper** — a full token file (`theme.ts`), a documented
reference (`theme.md`), and a solid component kit (`AppText`, `Button`, `Card`, `FilterChip`, `Badge`,
`ScreenHeader`, `Skeleton`/`EmptyState`/`ErrorState`, glass + orb chrome, a coherent motion/haptics
language). The auth "dark Aurora" screens and the AI orb are distinctive and on-brand.

The problem is **erosion**: most screens bypass the system and hand-roll equivalents. Three themes dominate:

1. **The system exists but isn't used.** 334 inline `fontSize` and 154 `fontWeight` literals (much of it on
   the *system font* because weight is set without a loaded family); `<Button>` appears in 5 screens while
   16 hand-roll red `TouchableOpacity` buttons; ~15 bespoke chip/badge styles; three different header
   components; non-loaded fonts (`Georgia`, `Courier`) silently falling back to the OS font on the header,
   the AI wordmark, and *all* long-form markdown content.
2. **Hierarchy is weak or inverted on the highest-traffic screens.** Login/Signup stack three equal-weight
   sign-in buttons; HomeScreen fires four red CTAs; and in two places the *recommended* action is gray while
   the secondary is red (`FindScreen` profile offer, `AIConsentScreen` "Not now").
3. **States and tokens are applied inconsistently.** One feed has no loading skeleton (blanks on load), the
   same "approved" outcome is green in the feed but gray on the detail screen, the "you" chat bubble has two
   different looks, and two separate AI chat UIs coexist with different names.

Net: the app doesn't feel broken, but it feels *stitched together* — like several good screens built by
different hands. The highest-leverage work is **consolidation**, not redesign: route screens through the
components that already exist. A handful of true rework candidates (EmailVerification, the onboarding mega-
scroll, the Search/VisaExperiences duplicate, FindScreen) are called out separately.

---

## 1. Visual consistency (vs theme.md)

### Typography
- **[High]** | app-wide (334 inline `fontSize`, 154 `fontWeight`) | Most text bypasses `AppText`/`typography.*`.
  Worst offenders: `FindScreen` (32 sizes/15 weights), `PostScreen` (28/11), `ExperiencesOnboardingScreen`
  (27/12), `BackgroundOnboardingScreen` (26/11), `CaseDetailsScreen` (14/7), `GroupChat` (14). | Migrate to
  `AppText variant=...`; delete literals.
- **[High]** | non-loaded fonts → silent system fallback | `Header.tsx:99` `Georgia-Bold`/`serif`;
  `AIChatScreen.tsx:345` `Georgia` (+ `fontWeight:'600'` on the same style = double violation);
  `Markdown.tsx:44,52,60` `Courier`. None are loaded in `App.tsx`. Markdown draws CaseDetails bodies,
  FindScreen AI bubbles, AuthorCard background — so lots of *real content* is off-brand. | `Lora_700Bold` /
  `Lora_600SemiBold`; no monospace is loaded, so restyle code blocks with a tokened background instead.
- **[Med]** | `size 14` used **98×** with no matching token (sits between `labelMd 13` and `bodyMd 15`);
  `size 11` used 30× (overlines/tab labels) also untokened | These two are the single largest consistency
  gaps. | **Add two tokens** (`bodySm`=14, `overline`=11) — genuinely new, nothing existing covers them —
  then migrate. `10/18/22/28` are rarer one-offs: snap to `caption`/`bodyLg`/`headlineMd`/`headlineLg`.

### Color
- **[Med]** | hardcoded hex/rgba in 10 files (theme.md named 9; +1 new) | `AIChatScreen.tsx:423`
  `rgba(21,72,126,0.12)` (a **blue** tint on a red-brand app); `HomeScreen.tsx:332,349` `#FFFFFF`;
  `CaseMatchCard.tsx:109,114` `#fff`; `WelcomeScreen.tsx:104` `#FFFFFF` shadow; `AIOrb.tsx:82-96`
  `#FF4444`/`#FF6666`; `CommunityScreen.tsx:214` `#000`; `FloatingTabBar.tsx:145-155` rgba glass + `#000`. |
  Map to `surfaceContainerLowest`, `onPrimary`, `primaryContainer`/`coolAccent`, `orb.*`; shadow → `#1a202c`.
- **[Med]** | overlay scrim `rgba(0,0,0,0.5)` duplicated (`Select.tsx:152`, `chat/ChatModal.tsx:228`) with a
  4th variant `rgba(0,0,0,0.35)` (`ContentActionsMenu.tsx:194`) | No scrim token; alphas disagree. | Add
  `colors.scrim` = `rgba(0,0,0,0.5)` and reuse.
- **[Med]** | same outcome, two colors | "approved" = `successContainer` green in `PostingCard.tsx:52` but
  `secondaryContainer` gray in `CaseDetailsScreen.tsx:34`. | Share one `getOutcomeBadgeStyle` helper.

### Spacing
- **[Low]** | off-grid atoms `6/9/14/20` pervasive | `gap:6` (FindScreen:683,757,896; HomeScreen:403;
  ProfileScreen:651; GroupChat:393); `paddingVertical:9` (BackgroundOnboarding:798; PostScreen:923);
  `paddingVertical:14` misusing the `marginMobile` value (PostScreen:812-979; Login:342; Signup:474). | Snap
  to `xs(4)/base(8)/sm(10)/md(16)`; `14` is horizontal-margin only.

### Shape & shadow
- **[Low]** | hardcoded radii off the `4/8/12/16/24/9999` scale | `50` (LoginScreen:287) & `30`
  (Signup:372, FloatingChatButton:34) should be `full`; `18`/`20`/`22` (Home:301,449; Signup:357;
  FindScreen:877; GroupChatScreen:234) have no token. | `borderRadius.full` for pills; snap others to `lg`/`xl`.
- **[Med]** | shadow-color drift vs token `#1a202c` | `#000` (CommunityScreen:214, FloatingTabBar:148),
  `#FFFFFF` (WelcomeScreen:104), `colors.primary` glow (Login:356; Signup:441; AIOrb:129). | Use
  `shadows.level2/3`; colored glow is a deliberate exception only on the orb.

### Iconography
- **[Low]** | Ionicons used exclusively (good, matches theme.md). Oddball sizes off the documented ramp:
  `13`, `30`, `32`, `36`, `44` (one-offs). | Normalize `13→14`, `30/32→28` where not feature glyphs.

### Component reuse
- **[High]** | `<Button>` used in only 5 screens; **16 screens hand-roll** `TouchableOpacity` +
  `backgroundColor: colors.primary` (EmailVerification, GroupChatScreen, both onboarding screens,
  AuthorByHandle, VisaExperiences, PostScreen:834,978,1022, Signup, Profile, Search, AIConsent, Home, Login,
  FindScreen:809,874,920,999, CaseDetails). | Route through `<Button variant="primary">`.
- **[High]** | **~15 rolled-own chip/badge styles** duplicating `FilterChip`/`Badge` | BackgroundOnboarding
  (`miniChip`/`consChip`/`cityChip`/`suggestChip`/`outcomeChip`), Experiences (`milestoneChip`/`suggestionChip`/
  `sharedBadge`), PostScreen (`tag`/`typeBadge`), CaseDetails (`topicChips`), AuthorCard (`Chips`),
  Search/VisaExperiences (`facetChip`), FindScreen (`miniChipActive`). | `FilterChip`/`ChipSelector` for
  selectables, `Badge` for read-only. `ProfileScreen` (uses `Badge` correctly) is the reference.
- **[Med]** | `<Card>` imported in only 1 screen despite many card surfaces; screens re-implement outlined/
  elevated containers (e.g. `ReplyItem.tsx:96`, `HomeScreen sectionCard:350` which mixes border+shadow at
  radius 22 — Card is one or the other at radius `lg`). | Use `Card variant="outlined|elevated"`.

---

## 2. Layout & visual hierarchy

- **[High]** | `LoginScreen.tsx:170-219` / `SignupScreen.tsx:269-318` | Three heavy competing sign-in CTAs
  (red primary, solid-white Apple, glass Google) at near-equal weight; on the dark ground the **white Apple
  block is the loudest**, out-shouting the intended primary. | Demote both social buttons to one tier
  (Apple `whiteOutline` or `authGlass` fill) so it reads as two zones, not five buttons.
- **[High]** | `HomeScreen.tsx:114-274` | Three identical section cards each ending in a `primaryContainer`
  CTA row → **4 red CTAs** competing with the hero; each section also already has a "See all" header link, so
  the bottom CTA is redundant. | Only the AI hero stays filled; section CTAs → `ghost`/link.
- **[High]** | `FindScreen.tsx:584` | **Inverted hierarchy** — the recommended "Update my profile & continue"
  uses `secondaryContainer` gray while `findButton`/`createGroupButton` are red. | Make the recommended offer
  the `primary` `Button`; decline → `ghost`.
- **[Med]** | `AIConsentScreen.tsx:117-126,177-182` | "Not now" is weightless bare text at `onSurfaceVariant`
  → reads as disabled next to the red primary. | Give it the `secondary` Button (`borderWidth:1 outline`).
- **[Med]** | `ProfileScreen.tsx:256-503` | Eight identical elevated Cards in a flat stack; no focal point,
  and the account/avatar block competes with 7 same-weight sections. | Make the account header a distinct
  hero; demote info sections to `outlined`/lower contrast.
- **[Med]** | `FindScreen.tsx:447-569` | "Your Match Criteria" card crams chips + two horizontal mini-chip
  scrollers + date input + button into one dense block — hard to scan. | Split into labeled sub-sections
  with whitespace, or an accordion/step.

---

## 3. Screens that don't make visual sense / need rework (brief; expanded below)
- `EmailVerificationScreen` — bypasses the design system entirely; dark text on an unscrimmed photo.
- `BackgroundOnboardingScreen` — 1063-line scroll, three redundant input paradigms, nested inner scroll.
- `SearchScreen` + `VisaExperiencesScreen` — 90%-identical duplicates that render in *different typefaces*.
- `FindScreen` — 1000-line dual-tab; dense criteria card + inverted button hierarchy.
- Two coexisting AI chat UIs (`AIChatScreen` vs global `ChatModal`/`FloatingChatButton`), different names
  ("MeridianAI" vs "Meridian AI"), different visual identity (orb/glass vs gray FAB).

---

## 4. Micro-interactions & motion

- **[Med]** | mixed back-affordance | `arrow-back` (Signup:134, Experiences:234 — material) vs `chevron-back`
  (AuthorScreen:51, Header:45, ScreenHeader:58 — iOS) in an iOS-first app; nav taps use plain
  `TouchableOpacity` (no scale/haptic) while CTAs use `AnimatedPressable`. | Standardize on `chevron-back` +
  `light`-haptic `AnimatedPressable` for nav.
- **[Med]** | `ChatMessage.tsx:138-161` | "AI is typing" dots are three **static** opacities (0.4/0.6/0.9) —
  a frozen graphic. | Animate with a reanimated loop or `Skeleton` pulse.
- **[Med]** | success beats missing | `PostScreen.tsx:382-413` "Posted!" and `ExperiencesOnboarding` completion
  have no entrance animation despite reanimated everywhere; the emotional peak of publishing feels flat. |
  `ZoomIn`/`FadeInUp` the checkmark; reuse the `medium` submit haptic.
- **[Low]** | list jumps | new reply prepended with no transition (`Replies.tsx:65`); `GroupChat.tsx:143`
  scroll-to-end fires on every message change incl. first load → jump on open. | `FadeInDown` new items;
  animate only on append.

---

## 5. Accessibility & readability (visual)

- **[Med]** | `outline #737780` on white ≈ **4.4:1** — sub-AA for small text; it's the placeholder/inactive
  color. | Darken toward `onSurfaceVariant #43474f` (~9:1, passes) for text uses.
- **[Med]** | `opacity:0.4/0.5` stacked on already-muted text (FindScreen:882, VoteControl:141,
  ChatMessage:151, PostScreen:846, Replies:248, both onboarding screens) drops effective contrast below AA. |
  Use a dedicated disabled token instead of opacity on text.
- **[Med]** | dark-aurora placeholder `authGlass.placeholder rgba(236,240,255,0.55)` faint over 6%-white
  inputs (Login:129,151; Signup:175-226); subtitles further multiply `opacity:0.8` (Login:307, Welcome:123). |
  Raise placeholder to ~0.7; drop the extra opacity multipliers.
- **[Med]** | tap targets < 44px | VoteControl arrows ≈28px (`padding:4` on a 20 icon) + score `minWidth:24`;
  `eyeButton` 36px (Login:346, Signup:431); Header icon 40px. | `hitSlop` or min 44×44 (ScreenHeader's 44×44
  slot is the model).
- **[Med]** | color-only signaling | VoteControl up=`primary`/down=`error` differ only by arrow + color;
  status colors (`statusResolved`/`InProgress`/`Verified`) as dots/text without icon/label. | Add a
  fill/weight/label affordance.
- **[Med]** | Dynamic Type effectively disabled | because text is inline `fontSize` (not `AppText`), system
  font-scaling largely doesn't apply, and fixed-size rows (OTP boxes `48×56` EmailVerif:326, chip scrollers)
  won't reflow. | Migrating to `AppText` (§1) restores scaling.

---

## 6. Platform-convention fit (iOS-first)

- **[Med]** | three header systems create iOS-inconsistent chrome | legacy `Header` (solid border + Georgia)
  vs `ScreenHeader` (hairline + Lora) vs Author-custom (no border); typeface + divider weight visibly change
  between screens. | Consolidate on `ScreenHeader` (native iOS large-title-ish, hairline, `chevron-back`).
- **[Med]** | material back arrow (`arrow-back`) on iOS (Signup, Experiences) breaks the platform convention. |
  `chevron-back`.
- **[Low]** | `FloatingTabBar.tsx:91` `activeOpacity={1}` disables native touch-dim, relying only on the
  spring; acceptable but leaves no fallback feedback.
- Positive: `MainNavigator` transitions are platform-aware (`ios_from_right`, modal `slide_from_bottom`,
  auth `fade`).

---

## 7. Responsive / adaptive behavior

- **[Low]** | no width breakpoints — single phone layout (`spacing.marginDesktop`/`maxWidthContent` defined
  but unused). On iPad the phone-width layout will letterbox/stretch. | Out of scope unless tablet is a target.
- **[Med]** | large Dynamic Type risk (see §5) — fixed-height rows, OTP boxes, and horizontal chip scrollers
  don't reflow; long labels in fixed-`paddingVertical` buttons will clip. | Test at XXL; migrate to `AppText`.
- Safe-area: `FloatingTabBar` uses `insets.bottom`; most screens use `SafeAreaView` — spot-check the
  `EmailVerificationScreen` `flex-end` content over a full-bleed image for home-indicator overlap.

---

## 8. States that need visual polish

- **[High]** | `VisaExperiencesScreen.tsx:205-256` | **No loading skeleton** — while `loading`, both empty and
  results are gated off → screen goes **blank**. (SearchScreen does it right with `Skeleton.Card`.) | Add
  `Skeleton.Card count={4}`.
- **[High]** | `EmailVerificationScreen.tsx:170-263` | Dark title/subtitle over an **unscrimmed** background
  photo (legibility depends on the image); loading = bare spinner; error = hand-rolled row; success = silent
  flag flip. | Add a dark scrim (reuse `AuroraBackground`); brief checkmark `FadeIn` on success.
- **[Med]** | bare `ActivityIndicator` instead of `Skeleton` | `Replies.tsx:156`, `GroupChat.tsx:294`,
  `AuthorCard.tsx:122`, both onboarding chat cards (BackgroundOnboarding:366, Experiences:270), `ProfileScreen`
  (215). | Shared `Skeleton`/typing-bubble.
- **[Med]** | plain `<Text>` errors/empties instead of `ErrorState`/`EmptyState` | `VisaExperiences:202`,
  `Replies:152,158`, `GroupChat:307`, `FindScreen:630`. | Designed states with retry.
- **[Med]** | success is purely transactional | `PostScreen` "Posted!" and onboarding completion have no
  delight (see §4). | Add a small success beat.

---

## 9. Theming

- **[Info/High-if-planned]** | light-locked (`app.config.js:10` `userInterfaceStyle:"light"`); no
  `useColorScheme`/`Appearance`. **Dark mode is not a cosmetic task** — the single `colors` object has no dark
  ramp and 334 inline color/size sites are light-baked. | If dark mode is wanted, it's a project, not a tweak.
- **[Med]** | screens that would break under dark mode today: `HomeScreen:332,349` pinned `#FFFFFF`;
  `CaseMatchCard:109,114` white text assuming a dark card; all `colors.primary`/`#000`/`#FFFFFF` shadows. |
  Tokenize these first as prep.

---

## 10. Branding & personality

- **[Med]** | **red family is not unified** — `primary #AE0000`, `accent #d62828`, `error #ba1a1a`,
  `googleRed #DB4437`, plus AIOrb `#FF4444`/`#FF6666` (no token). The bright orb reds read as a *different
  brand* on the AI screen. | Move orb reds to `orb.*`; reserve `accent` for deliberate emphasis; keep `error`
  semantic-only.
- **[Med]** | two AI identities | global gray `FloatingChatButton`/`ChatModal` ("Meridian AI", sparkles) vs
  `AIChatScreen` orb/glass ("MeridianAI"). Gray FAB has no brand color and competes with the tab bar. | Pick
  one AI surface + one name; brand the FAB (`primary`/GlassButton).
- **[Low]** | personality is underused | `EmptyState` is a flat Ionicon in a gray circle; the raster
  illustrations (`onboardingimage1.png`, `email-verification-image.png`) and `accent`/`accentContainer`
  (defined, rarely used) could add warmth to empty states, dividers, and active chips without any redesign.

---

## Screens that need real rework (structural)

1. **EmailVerificationScreen — full rework (High).** The only screen with *zero* `AppText`: every string is
   system-font inline type; dark text sits on an unscrimmed photo; loading/error/success are all hand-rolled.
   **Direction:** rebuild on `AppText` + `AuroraBackground` (to match the Login/Signup it flows from) + a real
   success beat (checkmark `FadeIn`). Fixes findings in §1, §5, §8 at once.
2. **BackgroundOnboardingScreen — restructure (High).** 1063 lines offering three redundant ways to enter the
   same data (AI chat, free-text+regenerate, six manual accordions) with no primary, plus a **nested vertical
   ScrollView** (`chatThreadScroll maxHeight:280`) inside the page scroll (gesture trap). **Direction:** two
   stepper sub-steps using the already-imported `ProgressStepper` — "Describe your situation" (AI/free-text
   hero) → "Review & edit tags" (accordions) — and flatten the nested scroll.
3. **SearchScreen + VisaExperiencesScreen — merge (High).** ~390-line, ~90%-identical screens that render in
   **different typefaces** (Search uses system-font weights; VisaExperiences uses Nunito) and have divergent
   states (VisaExperiences has no loading skeleton, raw-text errors). **Direction:** one shared
   `<ExperienceSearch>` standardized on `ScreenHeader`/`Skeleton`/`EmptyState`/`ErrorState`/`FilterChip`/
   `Input`/`Button`.
4. **FindScreen — decompose (High/Med).** 1000-line dual-tab screen; dense criteria card (§2) and inverted
   button hierarchy (`offerPrimary` gray). **Direction:** extract match/criteria sub-components; fix the
   button hierarchy (recommended = `primary`); adopt `Button`/`ChipSelector`; remove dead
   `header/title/userPicker` styles.
5. **Header consolidation — (Med).** Retire legacy `Header.tsx` (Georgia, solid border) and the two Author
   custom headers in favor of `ScreenHeader`; resolves multiple §1/§4/§6 findings and the unloaded-font issue
   across Profile/News/AskPro/Post/Author in one change.

---

## Deviations from theme.md

`current value → file:line → nearest token` (or "no token fits"). Representative, not exhaustive.

**Color / hex-literal**
- `rgba(21,72,126,0.12)` → `AIChatScreen.tsx:423` → no token fits (closest `statusVerified #2c6fb5`); likely intended `primaryContainer`
- `#FFFFFF` (×2) → `HomeScreen.tsx:332,349` → `surfaceContainerLowest`
- `#fff`, `rgba(255,255,255,0.9)` → `CaseMatchCard.tsx:109,114` → `onPrimary`
- `shadowColor:'#FFFFFF'`, `rgba(255,255,255,0.10)`, `rgba(255,255,255,0.35)` → `WelcomeScreen.tsx:104,140,132` → shadow: no token; fills: `authGlass.googleBg` / `authGlass.checkboxBorder`
- `#FF4444`, `#FF6666` → `AIOrb.tsx:82,95` → no token fits (redundant with `orb.red #AE0000`)
- `rgba(255,255,255,0.7/0.95)`, `#000`, `rgba(255,255,255,0.8)` → `FloatingTabBar.tsx:145-155` → glass: no token (add `glass.*`); shadow: `#1a202c`
- `rgba(0,0,0,0.5)` → `Select.tsx:152`, `chat/ChatModal.tsx:228`; `rgba(0,0,0,0.35)` → `ContentActionsMenu.tsx:194` → add `colors.scrim`
- `#000` shadow, `rgba(255,255,255,0.75)` → `CommunityScreen.tsx:214,164` → `#1a202c` / `onPrimary`

**Font (non-loaded → system fallback)**
- `Georgia`/`Georgia-Bold`/`serif` → `Header.tsx:99`, `AIChatScreen.tsx:345` → `Lora_700Bold` / `Lora_600SemiBold`
- `Courier` (×3) → `Markdown.tsx:44,52,60` → no monospace loaded; use a tokened code background

**Typography (inline)**
- `fontSize:14` (98×) → app-wide → **no token** (add `bodySm`=14)
- `fontSize:11` (30×) → overlines/tabs → **no token** (add `overline`=11)
- `fontSize:16/17/20/24` → inputs/titles/headers → `titleMd`/`bodyLg`/`headlineMd`/`headlineLgMobile`
- `fontSize:28/22` → `PostScreen:1001`, `EmailVerif:286`, `AskPro:122` → snap to `headlineLg`/`headlineMd`
- `fontWeight:'400'..'700'` (154×) → app-wide → encode in `NunitoSans_*`/`Lora_*` family

**Spacing (off 4/8 grid)**
- `gap:6` → FindScreen/Home/Profile/GroupChat → `spacing.xs`
- `paddingVertical:9` → BackgroundOnboarding:798, PostScreen:923 → `base`/`sm`
- `paddingVertical:14` → PostScreen:812-979, Login:342, Signup:474 → `md` (14 is `marginMobile`, horizontal only)

**Radius**
- `50`, `30` → LoginScreen:287, Signup:372, FloatingChatButton:34 → `full`
- `22`, `20`, `18` → Home:301,449; Signup:357; FindScreen:877 → `lg`/`xl`
- `6` → Signup:491, Profile:793, Markdown:50 → `sm`/`default`

**Shadow color**
- `#000` → CommunityScreen:214, FloatingTabBar:148 → `#1a202c`
- `colors.primary` glow → Login:356, Signup:441, AIOrb:129 → `shadows.level2/3` (orb exempt)

**Component (rolled-own → existing)**
- primary `TouchableOpacity` buttons (16 screens) → `<Button variant="primary">`
- `miniChip`/`facetChip`/`milestoneChip`/etc (~15 styles) → `FilterChip`/`ChipSelector` or `Badge`
- local outlined/elevated containers → `<Card variant=...>`
- three headers → `<ScreenHeader>`

---

## Quick cosmetic wins (low effort, high impact)

1. **Add `bodySm`(14) + `overline`(11) typography tokens** and migrate the four worst screens
   (`FindScreen`, `PostScreen`, `ExperiencesOnboarding`, `BackgroundOnboarding`) — removes ~half of the 334
   inline sizes.
2. **Replace `Georgia`/`serif`/`Courier`** with loaded `Lora_*` (Header, AIChatScreen wordmark, Markdown) —
   fixes silent system-font fallback on the most visible chrome/content.
3. **Add `colors.scrim`** = `rgba(0,0,0,0.5)` and reuse across `Select`/`ChatModal`/`ContentActionsMenu`.
4. **Normalize shadow colors to `#1a202c`** and move `AIOrb` reds into `orb.*` (unifies the red family).
5. **Add a `Skeleton.Card` loading state to `VisaExperiencesScreen`** (stops the blank-on-load flash).
6. **Share one `getOutcomeBadgeStyle`** so "approved/denied" is the same color in feed and detail.
7. **Unify the "you" chat bubble** to `primaryContainer`/`onPrimaryContainer` across AIChat, GroupChat, Find.
8. **Enlarge VoteControl (and eye/nav) tap targets to 44px** via `hitSlop`.
9. **Fix the two inverted hierarchies** — make `FindScreen` offer and `AIConsent` "Not now" use proper
   `primary`/`secondary` Button treatments.
10. **Brand the AI FAB** (`FloatingChatButton` gray → `primary`/GlassButton) and pick one AI name
    ("Meridian AI").
