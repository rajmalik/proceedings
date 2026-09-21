# Meridian Mobile — Design System Reference

_Last generated: 2026-07-20. This is a snapshot of styling as currently implemented in code, not a spec._

Styling in `mobile/` is centralized in a single token file: [src/constants/theme.ts](src/constants/theme.ts). There is **no NativeWind/Tailwind, no styled-components, no CSS, and no ThemeContext**. Every screen/component builds a local `StyleSheet.create` that pulls from these tokens; there are no exported shared `StyleSheet` objects. Conventions are enforced in [AGENTS.md](AGENTS.md): text through `<AppText>`, colors from `theme.colors`, weight encoded in the font-family name (never `fontWeight` + `fontFamily`).

---

## Colors

### Light Mode

The app ships a single light theme. All tokens below are defined in [src/constants/theme.ts](src/constants/theme.ts) `colors` (L22–138).

| Token | Hex | Usage | Defined In |
|---|---|---|---|
| `primary` | `#AE0000` | Main brand red — buttons, active states, links, icons | theme.ts:24 |
| `onPrimary` | `#ffffff` | Text/icons on primary | theme.ts:25 |
| `primaryContainer` | `#FFEBEB` | Tonal primary surface (selected chips, info badge) | theme.ts:26 |
| `onPrimaryContainer` | `#5C0000` | Text on primary container | theme.ts:27 |
| `inversePrimary` | `#FFCDD2` | Inverse/pressed primary tint | theme.ts:28 |
| `secondary` | `#4A4A4A` | Neutral gray — secondary text/accents | theme.ts:31 |
| `onSecondary` | `#ffffff` | Text on secondary | theme.ts:32 |
| `secondaryContainer` | `#E8E8E8` | Tonal secondary surface | theme.ts:33 |
| `onSecondaryContainer` | `#2A2A2A` | Text on secondary container | theme.ts:34 |
| `accent` | `#d62828` | Flame red — the mark, highlights, emphasis | theme.ts:37 |
| `onAccent` | `#ffffff` | Text on accent | theme.ts:38 |
| `accentContainer` | `#fbe0de` | Tonal accent surface | theme.ts:39 |
| `onAccentContainer` | `#8e1b1b` | Text on accent container | theme.ts:40 |
| `tertiary` | `#353b41` | Dark slate — tertiary accents | theme.ts:43 |
| `onTertiary` | `#ffffff` | Text on tertiary | theme.ts:44 |
| `tertiaryContainer` | `#4b5258` | Tonal tertiary surface | theme.ts:45 |
| `onTertiaryContainer` | `#bfc5cd` | Text on tertiary container | theme.ts:46 |
| `surface` | `#fbfcff` | Base surface / page ground | theme.ts:49 |
| `surfaceDim` | `#d4daea` | Dimmed surface; **disabled** button bg | theme.ts:50 |
| `surfaceBright` | `#fbfcff` | Bright surface | theme.ts:51 |
| `surfaceContainerLowest` | `#ffffff` | Cards, inputs, elevated containers | theme.ts:52 |
| `surfaceContainerLow` | `#f1f4fb` | Filled cards, icon circles | theme.ts:53 |
| `surfaceContainer` | `#e8eef8` | Container fill; AI chat bubble bg | theme.ts:54 |
| `surfaceContainerHigh` | `#e1e8f4` | Higher container fill; default badge, skeleton block | theme.ts:55 |
| `surfaceContainerHighest` | `#dae1f0` | Highest container fill | theme.ts:56 |
| `onSurface` | `#15202e` | Primary body text | theme.ts:57 |
| `onSurfaceVariant` | `#43474f` | Secondary/muted text, inactive icons | theme.ts:58 |
| `inverseSurface` | `#2a303d` | Inverse surface (dark chips/toasts) | theme.ts:59 |
| `inverseOnSurface` | `#ecf0ff` | Text on inverse surface | theme.ts:60 |
| `surfaceVariant` | `#dde2f3` | Variant surface fill | theme.ts:61 |
| `surfaceTint` | `#AE0000` | Elevation tint (= primary) | theme.ts:62 |
| `outline` | `#737780` | Borders, dividers, inactive tab icons, placeholders | theme.ts:65 |
| `outlineVariant` | `#c3c6d0` | Hairline borders, input borders | theme.ts:66 |
| `background` | `#fbfcff` | Screen background (= surface) | theme.ts:75 |
| `onBackground` | `#15202e` | Text on background | theme.ts:76 |
| `primaryFixed` | `#FFEBEB` | Fixed primary tonal (selected option bg) | theme.ts:121 |
| `primaryFixedDim` | `#FFCDD2` | Fixed primary dim | theme.ts:122 |
| `secondaryFixed` | `#E8E8E8` | Fixed secondary tonal | theme.ts:123 |
| `secondaryFixedDim` | `#CCCCCC` | Fixed secondary dim | theme.ts:124 |
| `coolAccent` | `#8B5CF6` | AI-screen accent (also glass shadow color) | theme.ts:136 |
| `coolAccentLight` | `#A78BFA` | AI-screen light accent | theme.ts:137 |
| `googleRed` | `#DB4437` | Google sign-in button icon | theme.ts:90 |

### Dark Mode

**There is no global dark mode.** The app is hard-locked to light: `userInterfaceStyle: "light"` in `app.config.js:10` and `<StatusBar style="dark" />` in `App.tsx`. There is no `useColorScheme`/`Appearance` switching anywhere.

The only "dark" values in the codebase are **per-surface** palettes scoped to specific screens (dark Aurora auth/welcome grounds and translucent-glass overlays), not a theme:

| Token | Value(s) | Usage | Defined In |
|---|---|---|---|
| `welcomeDark` | `['#2A0A0A', '#160606', '#0A0303']` | Skia radial ground for the Welcome hero (maroon core → near-black) | theme.ts:98 |
| `welcomeWash` | `['#FFC9C9', '#FFDEDC', '#FFF1EF', '#FFFFFF']` | Light onboarding hero gradient wash | theme.ts:94 |
| `authGlass.inputBg` | `rgba(255,255,255,0.06)` | Login/Signup translucent input fill over dark Aurora | theme.ts:103 |
| `authGlass.inputBorder` | `rgba(255,255,255,0.22)` | Auth input border | theme.ts:104 |
| `authGlass.inputBorderFocused` | `rgba(255,255,255,0.50)` | Auth input focused border | theme.ts:105 |
| `authGlass.placeholder` | `rgba(236,240,255,0.55)` | Auth placeholder text | theme.ts:106 |
| `authGlass.divider` | `rgba(255,255,255,0.18)` | Auth divider | theme.ts:107 |
| `authGlass.checkboxBorder` | `rgba(255,255,255,0.40)` | Auth checkbox border | theme.ts:108 |
| `authGlass.googleBg` | `rgba(255,255,255,0.10)` | Auth Google button fill | theme.ts:109 |
| `authGlass.googleBorder` | `rgba(255,255,255,0.22)` | Auth Google button border | theme.ts:110 |
| `glass.gradientTop` | `#E9E7F6` | Liquid-Glass gradient top (AI screen) | theme.ts:128 |
| `glass.gradientBottom` | `#C9CEE8` | Liquid-Glass gradient bottom (AI screen) | theme.ts:129 |
| `glass.surface` | `rgba(255,255,255,0.50)` | Glass surface fill (GlassCard/GlassButton) | theme.ts:130 |
| `glass.border` | `rgba(255,255,255,0.6)` | Glass border | theme.ts:131 |
| `glass.divider` | `rgba(200,200,220,0.3)` | Glass divider | theme.ts:132 |
| `orb.red` | `#AE0000` | AI orb gradient stop | theme.ts:115 |
| `orb.pink` | `#E85F9E` | AI orb gradient stop | theme.ts:116 |
| `orb.purple` | `#7B3FA0` | AI orb gradient stop | theme.ts:117 |

### Semantic Colors

| Token | Hex | Usage | Defined In |
|---|---|---|---|
| `error` | `#ba1a1a` | Error text/border, downvote-active | theme.ts:69 |
| `onError` | `#ffffff` | Text on error | theme.ts:70 |
| `errorContainer` | `#ffdad6` | Error surface fill | theme.ts:71 |
| `onErrorContainer` | `#93000a` | Text on error container | theme.ts:72 |
| `statusResolved` | `#0f7b53` | Status: resolved (green) | theme.ts:79 |
| `statusInProgress` | `#d97706` | Status: in-progress (amber) | theme.ts:80 |
| `statusVerified` | `#2c6fb5` | Status: verified (liberty blue) | theme.ts:81 |
| `successContainer` | `#dcfce7` | Success badge fill | theme.ts:84 |
| `onSuccessContainer` | `#166534` | Text on success container | theme.ts:85 |
| `warningContainer` | `#fef3c7` | Warning badge fill | theme.ts:86 |
| `onWarningContainer` | `#92400e` | Text on warning container | theme.ts:87 |
| `surfaceDim` | `#d4daea` | Disabled button background | theme.ts:50 |
| `outlineVariant` | `#c3c6d0` | Disabled border | theme.ts:66 |
| `outline` | `#737780` | Disabled/inactive text & icons | theme.ts:65 |

> There is no dedicated `info` token; `primaryFixed`/`primary` are reused for the `info` badge variant (Badge.tsx). "Disabled" is not a single token — it is expressed via `surfaceDim` (fill), `outlineVariant` (border), and `outline` (text), plus `opacity: 0.4–0.5` in several components.

---

## Typography

Fonts are **runtime-loaded Google fonts** (no bundled font files): **Lora** (serif — display/headlines) and **Nunito Sans** (sans — body/labels), loaded in `App.tsx` via `@expo-google-fonts` at weights 400/500/600/700 each. Weight is **encoded in the family name** — tokens deliberately carry no `fontWeight`.

`fonts` aliases ([theme.ts:12–20](src/constants/theme.ts#L12)): `heading` → `Lora_400Regular`, `headingBold` → `Lora_700Bold`, `headingItalic` → `Lora_500Medium`, `body` → `NunitoSans_400Regular`, `bodyMedium` → `NunitoSans_500Medium`, `bodyHeavy` → `NunitoSans_600SemiBold`, `bodyBlack` → `NunitoSans_700Bold`.

The canonical text primitive is `<AppText variant="..." color="...">` ([src/components/AppText.tsx](src/components/AppText.tsx)), which spreads a `typography.*` token and a `colors.*` value; a `textStyle(variant, color)` helper exists for `StyleSheet` callers.

| Token | Font | Size | Weight | Line Height | Letter Spacing | Usage | Defined In |
|---|---|---|---|---|---|---|---|
| `displayLg` | Lora | 40 | 700 | 46 | -0.8 | Hero display | theme.ts:147 |
| `headlineLg` | Lora | 27 | 600 | 34 | -0.27 | Large headline | theme.ts:153 |
| `headlineLgMobile` | Lora | 24 | 600 | 31 | — | Large tab-root title | theme.ts:159 |
| `headlineMd` | Lora | 20 | 600 | 27 | — | Section / screen title | theme.ts:164 |
| `titleMd` | Nunito Sans | 16 | 700 | 22 | — | Card / list-item title | theme.ts:170 |
| `bodyLg` | Nunito Sans | 17 | 400 | 26 | — | Body large | theme.ts:175 |
| `bodyMd` | Nunito Sans | 15 | 400 | 22 | — | Body | theme.ts:180 |
| `labelMd` | Nunito Sans | 13 | 600 | 18 | 0.13 | Label | theme.ts:185 |
| `caption` | Nunito Sans | 12 | 400 | 16 | — | Caption / meta | theme.ts:191 |

> Weight column reflects the loaded family (`Lora_700Bold` = 700, etc.); it is not a separate `fontWeight` property.

**In practice**, despite `AppText`, screens/components still contain a large tail of inline `fontSize` literals. Distinct inline sizes observed and their typical role: **10** (tiny meta/badges), **11** (overlines, chips, tab labels), **12** (captions), **13** (labels), **14** (dominant inline body/button text), **15** (body), **16** (inputs, emphasis, `md` button), **17** (titles, header titles), **18** (subheads, `lg` button), **20** (headings), **22**, **24** (screen headers), **28** (large titles). `Markdown.tsx` derives sizes relatively from a base (`heading1 = base+6`, `+4`, `+2`, code = `base-1`).

---

## Spacing Scale

Token scale — [theme.ts:199–210](src/constants/theme.ts#L199):

| Value | Token | Common Usage |
|---|---|---|
| 4 | `xs` | Tight gaps, small margins |
| 8 | `base` | Base unit; standard gap/padding |
| 10 | `sm` | Small padding (e.g. card padding `sm`) |
| 14 | `marginMobile` | Screen horizontal edge margin |
| 16 | `md`, `gutter` | Default section/card padding, gutter |
| 24 | `lg` | Large padding, section spacing |
| 32 | `marginDesktop` | Desktop/tablet edge margin |
| 36 | `xl` | Extra-large vertical spacing |
| 720 | `maxWidthContent` | Max content width |

**De-facto atoms used inline** (hardcoded padding/margin/gap across screens+components): **2, 3, 4, 5, 6, 8, 9, 10, 12, 14, 16, 20, 24**. The most common are `gap: 6/4/8`, `paddingVertical: 8/6/4/12/14/16`, `paddingHorizontal: 8/16/10/12/24`. Note `6`, `9`, `14`, `20` are frequent but are **not** multiples of the 4/8 token grid.

---

## Shape & Elevation

### Border Radius — [theme.ts:212–219](src/constants/theme.ts#L212)

| Token | Value | Applied To |
|---|---|---|
| `sm` | 4 | Small chips, skeleton lines |
| `default` | 8 | Buttons, inputs, selects |
| `md` | 12 | Medium containers |
| `lg` | 16 | Cards, dropdowns, skeleton cards |
| `xl` | 24 | GlassCard, large surfaces |
| `full` | 9999 | Pills, badges, FABs, avatars, tab bar dot |

Token usage (approx counts): `full` ×62, `default` ×36, `lg` ×28, `md` ×15, `sm` ×12, `xl` ×4. Hardcoded radii also appear (6, 16, 18, 20, 22, 28, 30, 32, 50), e.g. FloatingTabBar container `borderRadius.xl + 8` (=32), EmptyState icon circle 28 (56px), ProgressStepper step circle 16 (32px).

### Border Widths

| Value | Applied To |
|---|---|
| `StyleSheet.hairlineWidth` | ScreenHeader bottom border |
| 1 | Standard hairline — cards (outlined), inputs, badges, dividers (×47) |
| 1.5 | Occasional emphasis borders (×2) |
| 2 | Focused input, active/current stepper circle (×4) |
| `borderLeftWidth: 3` | Error accent on Input / Select |
| `borderLeftWidth: 4` | Left accent bars |

Border colors: default `outlineVariant` (`#c3c6d0`), focused `primary`, error `error`.

### Shadows / Elevation — [theme.ts:221–252](src/constants/theme.ts#L221)

| Token | Color | Offset | Opacity | Radius | Elevation | Applied To |
|---|---|---|---|---|---|---|
| `level1` | `#1a202c` | 0, 4 | 0.05 | 12 | 2 | Default cards (elevation 1) |
| `level2` | `#1a202c` | 0, 12 | 0.10 | 32 | 4 | Dropdowns, elevated cards, Select modal |
| `level3` | `#1a202c` | 0, 16 | 0.14 | 40 | 8 | Modals, FABs, floating chrome |
| `glass` | `#8B5CF6` | 0, 4 | 0.15 | 16 | 3 | GlassCard / GlassButton (AI screens) |

**Hardcoded shadows** (bypassing tokens) exist in: CommunityScreen (`#000`, elev 4), WelcomeScreen (`#FFFFFF` white glow), Login/SignupScreen (`colors.primary`, elev 6), AIOrb (`colors.primary` glow, elev 10), FloatingTabBar (`#000`, elev 12).

---

## Iconography

- **Library: `@expo/vector-icons` → `Ionicons`, used exclusively.** No MaterialIcons/Feather/FontAwesome elsewhere. `EmptyState`/`ErrorState` type their icon as `keyof typeof Ionicons.glyphMap`.
- **Vector graphics**: `react-native-svg` in `AIOrb.tsx` (RadialGradient orb); `@shopify/react-native-skia` in `AuroraBackground.tsx` (Canvas/Blur/RadialGradient grounds).
- **Raster assets** via `require`: `assets/meridian-new-logo-transparent.png` (Welcome, Signup), `assets/email-verification-image.png`, `assets/onboardingimage1.png`.
- **Standard Ionicons sizes** (by frequency): **20** (default action icon), **24** (back chevron / nav), **22** (header & tab-bar icon), **18 / 16** (inline chips, search), **14 / 12** (dense meta), **28 / 40 / 48+** (feature & empty-state glyphs). Tab bar (`FloatingTabBar.tsx`): filled glyph when focused, `-outline` when not, size 22, focused `primary` / unfocused `outline`.
- **Image conventions**: logos are rounded via a `borderRadius.full` circle mask; no global aspect-ratio or placeholder system — loading is handled by `Skeleton`.

---

## Components

All components live in [src/components/](src/components/) and consume theme tokens via local `StyleSheet.create`.

### Button — `src/components/Button.tsx`
- **Variants**: `primary` (bg `primary`, text `onPrimary`; disabled bg → `surfaceDim`), `secondary` (transparent, `borderWidth:1` `outline`; disabled border → `outlineVariant`, text → `outline`), `ghost` (transparent, text `primary`; disabled `outline`), `link` (transparent, `paddingHorizontal:0`, underlined).
- **Sizes**: `sm` pad 8/16, text 14 · `md` pad 12/20, text 16 · `lg` pad 16/24, text 18.
- **Base**: `flexDirection:'row'`, `borderRadius.default` (8), `minHeight:48`, text `NunitoSans_600SemiBold`.
- **States**: pressed → `AnimatedPressable scaleTo={0.97}`; haptics `medium` (primary) else `light`; `loading` → `ActivityIndicator`; disabled via `disabled || loading`.

### Input — `src/components/Input.tsx`
- **Base**: bg `surfaceContainerLowest`, `borderWidth:1` `outlineVariant`, `borderRadius.default`, `minHeight:48`; placeholder color `outline`.
- **States**: focused → border `primary`, `borderWidth:2`; error → border `error`, `borderLeftWidth:3`.
- **Anatomy**: label (`labelMd`, `fontWeight:'500'`), left/right icon slots, helper/error text (`caption`; error color `error`, helper `onSurfaceVariant`).

### Select — `src/components/Select.tsx`
- **Trigger**: styled like Input (bg `surfaceContainerLowest`, border `outlineVariant`, radius `default`, `minHeight:48`, chevron-down icon 20); error → `borderLeftWidth:3` `error`.
- **Modal**: fade; overlay `rgba(0,0,0,0.5)`; dropdown bg `surfaceContainerLowest`, `borderRadius.lg`, `maxHeight:300`, `shadows.level2`; selected option bg `primaryFixed`, text `primary` `'500'`, checkmark.

### Badge — `src/components/Badge.tsx`
- **Variants**: `default` (surfaceContainerHigh/onSurface), `primary`, `secondary`, `success` (successContainer/onSuccessContainer), `warning` (warningContainer/onWarningContainer), `info` (primaryFixed/primary), `outline` (transparent + `borderWidth:1` outline).
- **Base**: `paddingHorizontal:10`, `paddingVertical:4`, `borderRadius.full`, `alignSelf:'flex-start'`, text `NunitoSans_600SemiBold` at caption size.

### Card — `src/components/Card.tsx`
- **Variants**: `elevated` (bg `surfaceContainerLowest` + shadow, no border — default), `outlined` (bg `surfaceContainerLowest` + `borderWidth:1` `outlineVariant`, no shadow), `filled` (bg `surfaceContainerLow`).
- **Props**: `elevation` 0/1/2 (→ none/`level1`/`level2`, elevated only); `padding` none/sm(10)/md(16)/lg(24); base radius `lg` (16); `animated` → `FadeInDown.delay(...).duration(300).springify()`. `AnimatedCard` wraps with `useFadeIn`.

### FilterChip / ChipSelector — `src/components/FilterChip.tsx`, `ChipSelector.tsx`
- **Base**: `paddingHorizontal:16`, `paddingVertical:8`, `borderRadius.full`, `borderWidth:1`, text 14/`'500'`.
- **States**: default (bg `surfaceContainerLowest`, border `outlineVariant`, text `onSurface`); selected (bg `primary`, border `primary`, text `onPrimary`). Press `scaleTo={0.95}` + light haptic; enters with `ZoomIn`. `ChipSelector` composes FilterChip for single/multi-select in a horizontal ScrollView.

### GlassButton / GlassCard — `src/components/GlassButton.tsx`, `GlassCard.tsx`
- **GlassButton**: circular (default `size=44`, `borderRadius=size/2`), `BlurView intensity={30} tint="light"`, fill `glass.surface`, `borderWidth:1` `glass.border`, `shadows.glass`, `activeOpacity={0.7}`.
- **GlassCard**: `BlurView intensity={25}`, `radius=24`, fill `glass.surface`, border `glass.border`, `shadows.glass`, `overflow:'hidden'`.

### FloatingTabBar — `src/components/FloatingTabBar.tsx`
- Custom bottom tab bar: width `screenWidth - md*2`, `HEIGHT=70`, radius `xl+8` (32), per-platform glass bg (see Adaptive), shadow `#000 0/8 0.15 r24 elev12`, `bottom = max(insets.bottom, 10)`.
- **Active**: 6×6 dot (`borderRadius` 3) bg `primary`; icon/label `primary` when focused else `outline`; label 11/`'500'`. Press: `withSpring(0.9, {damping:15, stiffness:400})` + light haptic on switch.

### Header / ScreenHeader — `src/components/Header.tsx`, `ScreenHeader.tsx`
- **Header (legacy)**: bg `surface`, `paddingHorizontal:marginMobile`, `borderBottomWidth:1` `outlineVariant`, content height 44; title `Platform.OS==='ios' ? 'Georgia-Bold' : 'serif'`, size 20, `fontWeight:'600'`; back chevron 24, search 22, profile circle 28.
- **ScreenHeader (canonical)**: `borderBottomWidth: StyleSheet.hairlineWidth` `outlineVariant`, bg `background`; back slot 44×44, centered `headlineMd` title (Lora 20), right-action slot. `large` variant: left-aligned `headlineLgMobile` (Lora 24), no border/back.

### ProgressStepper — `src/components/ProgressStepper.tsx`
- Step circle 32×32 (r16), bg `surfaceContainerHigh`, `borderWidth:2` `outlineVariant`. **completed**: bg+border `primary` (✓). **current**: bg `surfaceContainerLowest`, border `primary`. Step number 14/`'600'` `outline` → active `primary`. Connector `height:2` `outlineVariant` → completed `primary`. Animated with `Layout.springify().damping(15).stiffness(120)`.

### VoteControl — `src/components/VoteControl.tsx`
- Vertical/horizontal, `gap:2`, button `padding:4`, disabled `opacity:0.4`. Colors: up `primary` when voted, down `error` when voted, else `onSurfaceVariant`. Arrows size 20; score `NunitoSans_700Bold` 14, `minWidth:24`. On vote: medium haptic + count bounce `withSequence(withSpring(1.25,{damping:12,stiffness:400}), withSpring(1,{damping:14,stiffness:320}))`.

### Skeleton / EmptyState / ErrorState — `src/components/Skeleton.tsx`, `EmptyState.tsx`, `ErrorState.tsx`
- **Skeleton**: `.Line` (h14, radius `sm`), `.Circle` (radius = size/2), `.Card` (bg `surfaceContainerLowest`, radius `lg`, pad md); block bg `surfaceContainerHigh`; pulse opacity 1↔0.45, `duration:700`, `Easing.inOut(ease)`.
- **EmptyState**: icon circle 56×56 (r28) bg `surfaceContainerLow`, Ionicons 28 `onSurfaceVariant`; title `headlineMd`; body `bodyMd`/`onSurfaceVariant`, `maxWidth:300`; optional `sm` Button; container pad `xl` vertical / `lg` horizontal.
- **ErrorState**: composes EmptyState with `cloud-offline-outline` and a "Try again" retry.

### Chat components — `src/components/chat/`
- **ChatModal**: overlay `rgba(0,0,0,0.5)`; open `withSpring(1,{damping:15,stiffness:120})`, close `withTiming(0,{duration:200})`, translateY `interpolate([0,1],[600,0])`.
- **ChatMessage**: enter `FadeInUp.duration(200)`, lineHeight 22, label 11/`'700'`.
- **ChatInput**: `BlurView`; `paddingBottom` iOS `md` / Android `sm`, `paddingVertical` `xs`.
- **AIResultCard / FloatingChatButton**: result-card weights 600/500; FloatingChatButton uses legacy RN `Animated`.

---

## Motion

Library: **`react-native-reanimated`** throughout (one legacy `Animated` in `chat/FloatingChatButton.tsx`); gestures via `react-native-gesture-handler`; haptics via `expo-haptics`. Motion constants live in [src/hooks/animations/](src/hooks/animations/).

| Constant | Value | Where |
|---|---|---|
| Press-in | `withTiming(scaleTo, {duration:100})`, default `scaleTo 0.96` | `useAnimatedPressable.ts:33` |
| Press-out | `withSpring(1, {damping:15, stiffness:400})` | `useAnimatedPressable.ts` |
| Fade-in | `withTiming(1, {duration:400, Easing.out(cubic)})`, translateY 20→0 | `useFadeIn.ts:30` |
| Slide-in | `withSpring(0, {damping:18, stiffness:180})`, distance 30 | `useSlideIn.ts:37` |
| Staggered list | `withDelay(100 + index*50, withSpring(1, {damping:20, stiffness:180}))` | `useStaggeredList.ts` |

**Declarative screen entrances** (Reanimated presets): `FadeIn`/`FadeInDown`/`FadeInUp`/`ZoomIn` with explicit timings, e.g. Welcome `FadeIn.delay(150).duration(800)`, Login/Signup `FadeInDown.duration(400).springify()`, Card `FadeInDown.delay(...).duration(300).springify()`.

**Continuous loops** (`withRepeat`): AIOrb pulse scale 1↔1.06 + glow opacity 0.4↔0.6 (`duration:2000, Easing.inOut(ease)`); AuroraBackground orb drift `duration:16000, Easing.linear` + bloom breathing `duration:3200`; Skeleton pulse `duration:700`.

**Haptics policy** (AGENTS.md + `useAnimatedPressable.ts`): `light` = navigation taps, `medium` = state changes (vote/submit), none = chat send.

---

## Breakpoints / Adaptive Behavior

**No width breakpoints exist** — the app is a single phone layout (no tablet/responsive grid). `spacing.marginDesktop` (32) and `maxWidthContent` (720) tokens are defined but the mobile app renders phone-width only.

Adaptation is via **`Platform.OS` iOS/Android branches**:

| Location | iOS | Android |
|---|---|---|
| `Header.tsx:99` title font | `Georgia-Bold` | `serif` |
| `FloatingTabBar.tsx:144` glass bg | `rgba(255,255,255,0.7)` | `rgba(255,255,255,0.95)` |
| `chat/ChatInput.tsx:88` paddingBottom | `spacing.md` | `spacing.sm` |
| `KeyboardAvoidingView` behavior (many screens) | `'padding'` | `undefined` / `'height'` |

---

## Inconsistencies Observed

_Neutral, factual notes — found in code as of this snapshot._

- **Duplicate hex values across tokens**: `#fbfcff` defined 3× (`surface`, `surfaceBright`, `background`); `#15202e` 2× (`onSurface`, `onBackground`); `#ffffff` 7× (`onPrimary`, `onSecondary`, `onAccent`, `onTertiary`, `onError`, `surfaceContainerLowest`); `#AE0000` 3× (`primary`, `surfaceTint`, `orb.red`); `#FFEBEB` = `primaryContainer` and `primaryFixed`; `#FFCDD2` = `inversePrimary` and `primaryFixedDim`; `#E8E8E8` = `secondaryContainer` and `secondaryFixed`.
- **Non-unified red family**: `primary #AE0000`, `accent #d62828`, `error #ba1a1a`, `googleRed #DB4437`, plus hardcoded AIOrb stops `#FF4444`/`#FF6666` and `welcomeDark #2A0A0A`.
- **Tight blue-gray cluster** in the surface ramp: `#f1f4fb`, `#e8eef8`, `#e1e8f4`, `#dae1f0`, `#dde2f3`, `#d4daea`, `#c3c6d0` are all close in value.
- **Inline typography despite `AppText`**: ~250 inline `fontSize` literals and ~150 inline `fontWeight` literals remain across screens/components (notably `BackgroundOnboardingScreen`, `FindScreen`, `PostScreen`, `ExperiencesOnboardingScreen`, `GroupChat`, `AuthorCard`, `HomeScreen`).
- **Non-loaded fonts referenced** (silent system fallback): `Georgia` / `Georgia-Bold` / `serif` (`Header.tsx`, `AIChatScreen.tsx`) and `Courier` (`Markdown.tsx` code blocks) — none are loaded in `App.tsx`.
- **`fontWeight` inline literals** (`'400'`/`'500'`/`'600'`/`'700'`) contradict the "weight lives in the family name" rule; they mostly appear without an explicit family (i.e. on the system font).
- **Shadow-color drift**: tokens use `#1a202c`, but hardcoded shadows use `#000`, `#FFFFFF`, and `colors.primary`.
- **Off-grid spacing atoms**: `6`, `9`, `14`, `20` are used frequently in practice but are not multiples of the 4/8 token grid.
- **Hardcoded color literals remain in 9 files** despite the "no hex literals in screens/components" rule: `CommunityScreen`, `WelcomeScreen`, `HomeScreen`, `AIChatScreen`, `AIOrb`, `ContentActionsMenu`, `FloatingTabBar`, `Select`, `CaseMatchCard`, `chat/ChatModal`.
