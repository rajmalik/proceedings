// Meridian Design System — Clean red brand identity
// Meridian red (dominant) · neutral gray (secondary) · crisp near-white ground.
//
// Brand type: Lora (serif — display/headlines) + Nunito Sans (body/labels).
// These exact family names are loaded in App.tsx via @expo-google-fonts; every
// fontFamily below MUST be one of those loaded names (an unknown name silently
// falls back to the system font — the old Inter/Georgia tokens did exactly
// that on every screen).

// Font families — aliases onto the LOADED families so legacy `fonts.*`
// consumers (Header.tsx etc.) render the brand type with no call-site changes.
export const fonts = {
  heading: 'Lora_400Regular',
  headingBold: 'Lora_700Bold',
  headingItalic: 'Lora_500Medium', // no italic variant loaded; medium reads as emphasis
  body: 'NunitoSans_400Regular',
  bodyMedium: 'NunitoSans_500Medium',
  bodyHeavy: 'NunitoSans_600SemiBold',
  bodyBlack: 'NunitoSans_700Bold',
};

export const colors = {
  // Primary (Meridian red)
  primary: '#AE0000',
  onPrimary: '#ffffff',
  primaryContainer: '#FFEBEB',
  onPrimaryContainer: '#5C0000',
  inversePrimary: '#FFCDD2',

  // Secondary (neutral gray)
  secondary: '#4A4A4A',
  onSecondary: '#ffffff',
  secondaryContainer: '#E8E8E8',
  onSecondaryContainer: '#2A2A2A',

  // Accent (flame red — reserved for the mark, highlights & emphasis)
  accent: '#d62828',
  onAccent: '#ffffff',
  accentContainer: '#fbe0de',
  onAccentContainer: '#8e1b1b',

  // Tertiary
  tertiary: '#353b41',
  onTertiary: '#ffffff',
  tertiaryContainer: '#4b5258',
  onTertiaryContainer: '#bfc5cd',

  // Surface (crisp, cool near-white ground)
  surface: '#fbfcff',
  surfaceDim: '#d4daea',
  surfaceBright: '#fbfcff',
  surfaceContainerLowest: '#ffffff',
  surfaceContainerLow: '#f1f4fb',
  surfaceContainer: '#e8eef8',
  surfaceContainerHigh: '#e1e8f4',
  surfaceContainerHighest: '#dae1f0',
  onSurface: '#15202e',
  onSurfaceVariant: '#43474f',
  inverseSurface: '#2a303d',
  inverseOnSurface: '#ecf0ff',
  surfaceVariant: '#dde2f3',
  surfaceTint: '#AE0000',

  // Outline
  outline: '#737780',
  outlineVariant: '#c3c6d0',

  // Error
  error: '#ba1a1a',
  onError: '#ffffff',
  errorContainer: '#ffdad6',
  onErrorContainer: '#93000a',

  // Background
  background: '#fbfcff',
  onBackground: '#15202e',

  // Status colors
  statusResolved: '#0f7b53', // Green
  statusInProgress: '#d97706', // Amber
  statusVerified: '#2c6fb5', // Liberty blue

  // Success / warning containers (previously hardcoded in Badge.tsx)
  successContainer: '#dcfce7',
  onSuccessContainer: '#166534',
  warningContainer: '#fef3c7',
  onWarningContainer: '#92400e',

  // Third-party brand (Google sign-in button icon)
  googleRed: '#DB4437',

  // Welcome/onboarding hero gradient wash — brand blush → surface, run diagonally.
  // Deeper top-left stop than the old flat pink so the hero reads as branded, not washed out.
  welcomeWash: ['#FFC9C9', '#FFDEDC', '#FFF1EF', '#FFFFFF'] as const,

  // Dark Aurora hero ground (radial: warm maroon core → near-black) for the
  // Skia-rendered Welcome background.
  welcomeDark: ['#2A0A0A', '#160606', '#0A0303'] as const,

  // Dark-auth (Login/Signup) glass surfaces — translucent whites layered over the
  // Aurora background. Kept here so screens carry no rgba literals.
  authGlass: {
    inputBg: 'rgba(255, 255, 255, 0.06)',
    inputBorder: 'rgba(255, 255, 255, 0.22)',
    inputBorderFocused: 'rgba(255, 255, 255, 0.50)',
    placeholder: 'rgba(236, 240, 255, 0.55)',
    divider: 'rgba(255, 255, 255, 0.18)',
    checkboxBorder: 'rgba(255, 255, 255, 0.40)',
    googleBg: 'rgba(255, 255, 255, 0.10)',
    googleBorder: 'rgba(255, 255, 255, 0.22)',
  },

  // AI orb gradient stops (previously hardcoded in AIChatScreen + ChatInput + AIOrb).
  // redBright/redGlow/redDeep are the orb's own highlight ramp — kept as tokens so the
  // signature orb has no raw hex, without changing its rendered look (UI_AUDIT §1/§10).
  orb: {
    red: '#AE0000',
    redBright: '#FF4444',
    redGlow: '#FF6666',
    redDeep: '#5C0000',
    pink: '#E85F9E',
    purple: '#7B3FA0',
  },

  // Fixed colors
  primaryFixed: '#FFEBEB',
  primaryFixedDim: '#FFCDD2',
  secondaryFixed: '#E8E8E8',
  secondaryFixedDim: '#CCCCCC',

  // Liquid Glass Palette (AI Assistant screen only)
  glass: {
    gradientTop: '#E9E7F6',
    gradientBottom: '#C9CEE8',
    surface: 'rgba(255, 255, 255, 0.50)',
    border: 'rgba(255, 255, 255, 0.6)',
    divider: 'rgba(200, 200, 220, 0.3)',
  },

  // Cool accent (for AI screens)
  coolAccent: '#8B5CF6',
  coolAccentLight: '#A78BFA',

  // Modal/overlay scrim — one token for the dark dim behind sheets & dropdowns
  // (was duplicated as rgba(0,0,0,0.5)/0.35 across Select/ChatModal/ContentActionsMenu).
  scrim: 'rgba(0, 0, 0, 0.5)',

  // Neutral shadow color (matches the shadows.* tokens) for elevation drop-shadows.
  shadowTint: '#1a202c',
};

// Type scale tightened per UI-beautify.md §3.1 (smaller) — larger sizes
// trimmed more, body −1px, caption held at 12px for legibility.
//
// NOTE: weight is encoded in the loaded family name (Lora_700Bold etc.); tokens
// deliberately carry NO fontWeight — co-setting one makes Android faux-bold or
// drop to the system face. Headlines = Lora (serif), body/labels = Nunito Sans.
export const typography = {
  displayLg: {
    fontFamily: 'Lora_700Bold',
    fontSize: 40,
    lineHeight: 46,
    letterSpacing: -0.8, // -0.02em * 40
  },
  headlineLg: {
    fontFamily: 'Lora_600SemiBold',
    fontSize: 27,
    lineHeight: 34,
    letterSpacing: -0.27, // -0.01em * 27
  },
  headlineLgMobile: {
    fontFamily: 'Lora_600SemiBold',
    fontSize: 24,
    lineHeight: 31,
  },
  headlineMd: {
    fontFamily: 'Lora_600SemiBold',
    fontSize: 20,
    lineHeight: 27,
  },
  // Card/list-item titles — sans, bolder than body (new in the A1 unification).
  titleMd: {
    fontFamily: 'NunitoSans_700Bold',
    fontSize: 16,
    lineHeight: 22,
  },
  bodyLg: {
    fontFamily: 'NunitoSans_400Regular',
    fontSize: 17,
    lineHeight: 26,
  },
  bodyMd: {
    fontFamily: 'NunitoSans_400Regular',
    fontSize: 15,
    lineHeight: 22,
  },
  // Small body — the dominant inline size (14) that had no token (UI_AUDIT §1).
  bodySm: {
    fontFamily: 'NunitoSans_400Regular',
    fontSize: 14,
    lineHeight: 20,
  },
  // Bold small-body (14) — the vote-score role that had only an inline
  // `NunitoSans_700Bold`/fontSize:14 literal (nested-replies A1 fix).
  labelBold: {
    fontFamily: 'NunitoSans_700Bold',
    fontSize: 14,
    lineHeight: 20,
  },
  labelMd: {
    fontFamily: 'NunitoSans_600SemiBold',
    fontSize: 13,
    lineHeight: 18,
    letterSpacing: 0.13, // 0.01em * 13
  },
  caption: {
    fontFamily: 'NunitoSans_400Regular',
    fontSize: 12,
    lineHeight: 16,
  },
  // Overlines / chips / tab labels — the size-11 role that had no token (UI_AUDIT §1).
  overline: {
    fontFamily: 'NunitoSans_600SemiBold',
    fontSize: 11,
    lineHeight: 14,
    letterSpacing: 0.5,
  },
};

// Spacing tightened per UI-beautify.md §3.2 (less white space).
export const spacing = {
  base: 8,
  xs: 4,
  sm: 10,
  md: 16,
  lg: 24,
  xl: 36,
  gutter: 16,
  marginMobile: 14,
  marginDesktop: 32,
  maxWidthContent: 720,
};

export const borderRadius = {
  sm: 4, // 0.25rem
  default: 8, // 0.5rem
  md: 12, // 0.75rem
  lg: 16, // 1rem
  xl: 24, // 1.5rem
  full: 9999,
};

export const shadows = {
  level1: {
    shadowColor: '#1a202c',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.05,
    shadowRadius: 12,
    elevation: 2,
  },
  level2: {
    shadowColor: '#1a202c',
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.1,
    shadowRadius: 32,
    elevation: 4,
  },
  // Modals / FABs / floating chrome
  level3: {
    shadowColor: '#1a202c',
    shadowOffset: { width: 0, height: 16 },
    shadowOpacity: 0.14,
    shadowRadius: 40,
    elevation: 8,
  },
  // Glass shadow (used by AI Chat components)
  glass: {
    shadowColor: '#8B5CF6',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 3,
  },
};

export default {
  colors,
  fonts,
  typography,
  spacing,
  borderRadius,
  shadows,
};
