import React from 'react';
import { Linking, Platform } from 'react-native';
import MarkdownDisplay from 'react-native-markdown-display';
import { colors, spacing } from '../constants/theme';

// No brand monospace is loaded; use each platform's built-in mono so code reads
// as code without a silent serif fallback (UI_AUDIT §1).
const MONO = Platform.select({ ios: 'Courier', android: 'monospace', default: 'monospace' });

// Mirrors website/src/components/Markdown.tsx - maps Markdown elements onto the
// design system so AI replies, posting bodies and background text render the
// same on mobile (bold, lists, links, quotes) instead of showing raw syntax.
//
// `color` overrides the base text color for use inside colored chat bubbles
// (e.g. the user bubble on a primary-container background).
interface MarkdownProps {
  children: string;
  color?: string;
  fontSize?: number;
}

export default function Markdown({ children, color = colors.onSurface, fontSize = 14 }: MarkdownProps) {
  const styles = {
    body: { color, fontSize, lineHeight: fontSize + 7 },
    paragraph: { marginTop: 0, marginBottom: spacing.base, flexWrap: 'wrap' as const },
    heading1: { color, fontSize: fontSize + 6, fontWeight: '600' as const, marginTop: spacing.base, marginBottom: 4 },
    heading2: { color, fontSize: fontSize + 4, fontWeight: '600' as const, marginTop: spacing.base, marginBottom: 4 },
    heading3: { color, fontSize: fontSize + 2, fontWeight: '600' as const, marginTop: spacing.base, marginBottom: 2 },
    strong: { fontWeight: '700' as const, color },
    em: { fontStyle: 'italic' as const },
    bullet_list: { marginBottom: spacing.base },
    ordered_list: { marginBottom: spacing.base },
    list_item: { color, marginBottom: 2 },
    link: { color: colors.secondary, textDecorationLine: 'underline' as const },
    blockquote: {
      backgroundColor: colors.surfaceContainerHigh,
      borderLeftWidth: 2,
      borderLeftColor: colors.outlineVariant,
      paddingHorizontal: spacing.base,
      paddingVertical: 4,
      marginVertical: spacing.base,
    },
    code_inline: {
      backgroundColor: colors.surfaceContainerHigh,
      color,
      borderRadius: 4,
      paddingHorizontal: 4,
      fontFamily: MONO,
      fontSize: fontSize - 1,
    },
    code_block: {
      backgroundColor: colors.surfaceContainerHigh,
      color,
      borderRadius: 6,
      padding: spacing.base,
      fontFamily: MONO,
      fontSize: fontSize - 1,
    },
    fence: {
      backgroundColor: colors.surfaceContainerHigh,
      color,
      borderRadius: 6,
      padding: spacing.base,
      fontFamily: MONO,
      fontSize: fontSize - 1,
    },
    hr: { backgroundColor: colors.outlineVariant, height: 1, marginVertical: spacing.md },
  };

  return (
    <MarkdownDisplay style={styles} onLinkPress={(url: string) => { Linking.openURL(url); return false; }}>
      {children || ''}
    </MarkdownDisplay>
  );
}
