# Design System

**Location:** `mobile/src/constants/theme.ts` (tokens) + `mobile/theme.md` (full reference)
**Stack:** single-token `StyleSheet` design system — no NativeWind/Tailwind, no styled-components, no `ThemeContext`
**Mode:** light-locked (`userInterfaceStyle: "light"`, `<StatusBar style="dark" />`) — **no dark mode**

---

## Purpose

The mobile app's ([[Mobile App]]) styling is centralized in one token file, **`src/constants/theme.ts`**. Every screen/component builds a local `StyleSheet.create` that pulls from these tokens — there are no exported shared stylesheets and no runtime theme switching.

**This note is a summary.** The exhaustive, code-accurate reference — every token value, per-component anatomy, and a live audit of convention drift — lives in **`mobile/theme.md`**. Read that for detail; read [[Mobile App]] for the conventions (AGENTS.md rules) that govern usage.

---

## Colors

Single light palette in `theme.ts` `colors`. Compact view of the key roles:

| Role | Token | Hex |
|---|---|---|
| Brand primary | `primary` | `#AE0000` |
| Primary container | `primaryContainer` / `primaryFixed` | `#FFEBEB` |
| Accent (flame) | `accent` | `#d62828` |
| Secondary (neutral) | `secondary` | `#4A4A4A` |
| Page ground | `surface` / `background` | `#fbfcff` |
| Cards / inputs | `surfaceContainerLowest` | `#ffffff` |
| Surface ramp (low→highest) | `surfaceContainerLow`…`Highest` | `#f1f4fb` → `#dae1f0` |
| Body text | `onSurface` | `#15202e` |
| Muted text / inactive | `onSurfaceVariant` / `outline` | `#43474f` / `#737780` |
| Borders (hairline) | `outlineVariant` | `#c3c6d0` |
| AI accent | `coolAccent` | `#8B5CF6` |

**Semantic:** `error #ba1a1a`, `statusResolved #0f7b53` (green), `statusInProgress #d97706` (amber), `statusVerified #2c6fb5` (blue), `successContainer #dcfce7`, `warningContainer #fef3c7`. Disabled is expressed via `surfaceDim` (fill) + `outlineVariant` (border) + `outline` (text) + opacity, not a single token.

> **No global dark mode.** The only "dark" values are per-surface palettes scoped to specific screens — `welcomeDark` (Skia auth/welcome ground), `authGlass.*` (translucent inputs over the Aurora), `glass.*` (AI-screen liquid glass), `orb.*` (AI orb gradient stops).

---

## Typography

Two **runtime-loaded** Google font families (no bundled files), loaded in `App.tsx` at weights 400/500/600/700. Weight is **encoded in the family name** — tokens carry no `fontWeight`.

- **Lora** (serif) → display / headlines
- **Nunito Sans** (sans) → body / labels

The 9 `typography.*` tokens:

| Token | Font | Size / Line |
|---|---|---|
| `displayLg` | Lora 700 | 40 / 46 |
| `headlineLg` | Lora 600 | 27 / 34 |
| `headlineLgMobile` | Lora 600 | 24 / 31 |
| `headlineMd` | Lora 600 | 20 / 27 |
| `titleMd` | Nunito Sans 700 | 16 / 22 |
| `bodyLg` | Nunito Sans 400 | 17 / 26 |
| `bodyMd` | Nunito Sans 400 | 15 / 22 |
| `labelMd` | Nunito Sans 600 | 13 / 18 |
| `caption` | Nunito Sans 400 | 12 / 16 |

Canonical primitive: `<AppText variant="…" color="…">` (`src/components/AppText.tsx`), plus a `textStyle(variant, color)` helper for `StyleSheet` callers. In practice a large tail of inline `fontSize`/`fontWeight` literals still remains (see `mobile/theme.md`).

---

## Spacing / Radius / Shadows

**Spacing** (`theme.ts` `spacing`): `xs 4`, `base 8`, `sm 10`, `marginMobile 14`, `md`/`gutter 16`, `lg 24`, `marginDesktop 32`, `xl 36`, `maxWidthContent 720`. (Off-grid atoms like 6/9/14/20 appear inline in practice.)

**Border radius** (`borderRadius`): `sm 4`, `default 8`, `md 12`, `lg 16`, `xl 24`, `full 9999`. Cards use `lg`; pills/badges/avatars use `full`; GlassCard uses `xl`.

**Shadows / elevation** (`shadows`): `level1` (default cards), `level2` (dropdowns/elevated), `level3` (modals/FABs), `glass` (`#8B5CF6` tint, AI screens). Token shadow color is `#1a202c`; some components hardcode `#000` / `#FFFFFF` / `primary`.

**Borders**: hairline `1` (`outlineVariant`) default, `2` for focused inputs / active stepper, `borderLeftWidth 3` for input errors.

---

## Iconography

- **`@expo/vector-icons` → `Ionicons`, used exclusively** (no MaterialIcons/Feather/FontAwesome). `EmptyState`/`ErrorState` type icons as `keyof typeof Ionicons.glyphMap`.
- **Vector**: `react-native-svg` in `AIOrb.tsx`; `@shopify/react-native-skia` in `AuroraBackground.tsx`.
- Standard Ionicons sizes: 20 (action), 24 (nav/back), 22 (header/tab bar), 18/16 (chips/search), 14/12 (dense meta), 28/40/48+ (feature/empty-state). Tab bar: filled when focused, `-outline` when not, size 22.

---

## Motion

Library: **`react-native-reanimated`** throughout (gestures via `react-native-gesture-handler`, haptics via `expo-haptics`). Motion constants live in `src/hooks/animations/`.

- **Press**: `useAnimatedPressable` — press-in `withTiming(scaleTo≈0.96, 100ms)`, press-out `withSpring(1, damping15 stiffness400)`.
- **Entrances**: `useFadeIn` (translateY 20→0, 400ms), `useSlideIn` (spring), `useStaggeredList` (delay `100 + index*50`). Declarative Reanimated presets (`FadeIn`/`FadeInDown`/`FadeInUp`/`ZoomIn`) for screen/card entrances.
- **Loops** (`withRepeat`): AI orb pulse, Aurora orb drift/bloom, Skeleton pulse.
- **Haptics policy**: `light` = navigation taps, `medium` = state changes (vote/submit), none = chat send.

No width breakpoints — single phone layout; adaptation is via `Platform.OS` iOS/Android branches (header font, glass opacity, keyboard behavior).

---

## Key files

| File | Role |
|---|---|
| `mobile/theme.md` | Full design-system reference (exhaustive; source of truth for this summary) |
| `src/constants/theme.ts` | All tokens: `colors`, `fonts`, `typography`, `spacing`, `borderRadius`, `shadows` |
| `src/components/AppText.tsx` | Canonical text primitive + `textStyle()` helper |
| `src/hooks/animations/` | `useAnimatedPressable`, `useFadeIn`, `useSlideIn`, `useStaggeredList` |
| `mobile/AGENTS.md` | Enforced usage conventions (see [[Mobile App]] › Conventions) |

---

## Related

- [[Mobile App]] — the app these tokens style, and the AGENTS.md conventions
- [[Website]] — sibling client (its own web styling)
- [[Proceedings — Project Overview]]
