import React, { useState } from 'react';
import { View, StyleSheet, ScrollView, Linking, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppText, AnimatedPressable } from '../components';
import { colors, spacing, borderRadius } from '../constants/theme';
import { useAIConsent } from '../contexts/AIConsentContext';

const PRIVACY_URL = 'https://meridianjourney.ai/privacy';

/**
 * One-time disclosure + affirmative permission before any user data is sent to
 * the third-party AI service (Google Gemini / Google Cloud AI). Required by App
 * Store Guideline 5.1.1(i) / 5.1.2(i). Shown by MainNavigator whenever the user
 * has not yet decided. "Not now" keeps the rest of the app usable with AI off.
 */

const POINTS: { icon: keyof typeof Ionicons.glyphMap; title: string; body: string }[] = [
  {
    icon: 'document-text-outline',
    title: 'What is sent',
    body:
      'The text you type into AI features — your questions and the profile details you ' +
      'provide during onboarding (such as visa type, consulate, and background).',
  },
  {
    icon: 'business-outline',
    title: 'Who it is sent to',
    body:
      "Google's Gemini AI (Google Cloud AI), our AI service provider, which processes your " +
      'input to generate a response and returns it to you.',
  },
  {
    icon: 'shield-checkmark-outline',
    title: 'How it is used',
    body:
      'Only to generate answers and structure your onboarding. It is handled per our Privacy ' +
      'Policy. We do not sell your data. You can decline and still browse the community.',
  },
];

export function AIConsentScreen() {
  const { grantAIConsent, declineAIConsent } = useAIConsent();
  const [busy, setBusy] = useState<null | 'grant' | 'decline'>(null);

  const onGrant = async () => {
    setBusy('grant');
    await grantAIConsent();
    // MainNavigator re-renders past this screen once the decision is recorded.
  };
  const onDecline = async () => {
    setBusy('decline');
    await declineAIConsent();
  };

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.iconCircle}>
          <Ionicons name="sparkles-outline" size={30} color={colors.onPrimary} />
        </View>
        <AppText variant="headlineLg" color="onSurface" align="center" style={styles.title}>
          AI-powered answers
        </AppText>
        <AppText variant="bodyMd" color="onSurfaceVariant" align="center" style={styles.subtitle}>
          Meridian uses a third-party AI service to answer your immigration questions and guide
          onboarding. Please review how your data is shared before continuing.
        </AppText>

        <View style={styles.card}>
          {POINTS.map((p, i) => (
            <View key={p.title} style={[styles.row, i < POINTS.length - 1 && styles.rowDivider]}>
              <View style={styles.rowIcon}>
                <Ionicons name={p.icon} size={20} color={colors.primary} />
              </View>
              <View style={styles.rowText}>
                <AppText variant="titleMd" color="onSurface">
                  {p.title}
                </AppText>
                <AppText variant="bodyMd" color="onSurfaceVariant" style={styles.rowBody}>
                  {p.body}
                </AppText>
              </View>
            </View>
          ))}
        </View>

        <AppText variant="caption" color="onSurfaceVariant" align="center" style={styles.policy}>
          Read our{' '}
          <AppText
            variant="caption"
            color="primary"
            style={styles.link}
            onPress={() => Linking.openURL(PRIVACY_URL)}
          >
            Privacy Policy
          </AppText>{' '}
          for full details on data collection, use, and sharing.
        </AppText>
      </ScrollView>

      <View style={styles.actions}>
        <AnimatedPressable
          onPress={onGrant}
          haptics="medium"
          disabled={busy !== null}
          style={styles.primaryButton}
        >
          {busy === 'grant' ? (
            <ActivityIndicator color={colors.onPrimary} />
          ) : (
            <AppText variant="titleMd" color="onPrimary">
              Agree & continue
            </AppText>
          )}
        </AnimatedPressable>
        <AnimatedPressable
          onPress={onDecline}
          haptics="light"
          disabled={busy !== null}
          style={styles.secondaryButton}
        >
          <AppText variant="titleMd" color="onSurfaceVariant">
            Not now
          </AppText>
        </AnimatedPressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.marginMobile, paddingBottom: spacing.lg },
  iconCircle: {
    alignSelf: 'center',
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.md,
  },
  title: { marginBottom: spacing.xs },
  subtitle: { marginBottom: spacing.lg, paddingHorizontal: spacing.xs },
  card: {
    backgroundColor: colors.surface,
    borderRadius: borderRadius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.outlineVariant,
    paddingHorizontal: spacing.base,
  },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, paddingVertical: spacing.base },
  rowDivider: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.outlineVariant },
  rowIcon: { paddingTop: 2 },
  rowText: { flex: 1 },
  rowBody: { marginTop: 2, lineHeight: 20 },
  policy: { marginTop: spacing.md, paddingHorizontal: spacing.sm, lineHeight: 18 },
  link: { textDecorationLine: 'underline' },
  actions: {
    paddingHorizontal: spacing.marginMobile,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    gap: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.outlineVariant,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: borderRadius.default,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButton: {
    // Real secondary treatment (outlined) so "Not now" reads as a deliberate choice,
    // not a disabled afterthought (UI_AUDIT §2).
    paddingVertical: 15,
    borderRadius: borderRadius.default,
    borderWidth: 1,
    borderColor: colors.outline,
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default AIConsentScreen;
