import React from 'react';
import { View, Image, StyleSheet, ImageSourcePropType, useWindowDimensions } from 'react-native';
import Animated, { FadeIn, FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from './AppText';
import { Button } from './Button';
import { ProgressStepper } from './ProgressStepper';
import { colors, spacing } from '../constants/theme';

interface OnboardingIntroProps {
  /** Illustration for this step. */
  image: ImageSourcePropType;
  /** The asset's own width/height, so the frame never squashes it. */
  imageRatio: number;
  title: string;
  subtitle: string;
  steps: { label: string }[];
  currentStep: number;
  onNext: () => void;
  nextLabel?: string;
}

/**
 * The opening panel of an onboarding step: illustration, headline, and a single
 * Next button — nothing else competing for the screen.
 *
 * The form that follows is dense (AI chat, chips, date pickers), and pinning a
 * decorative image above it meant the illustration got squeezed into whatever
 * space was left over. Giving it a panel of its own lets it render at a size
 * that reads, and lets the form start at the top of the next screen.
 */
export function OnboardingIntro({
  image,
  imageRatio,
  title,
  subtitle,
  steps,
  currentStep,
  onNext,
  nextLabel = 'Next',
}: OnboardingIntroProps) {
  const { height } = useWindowDimensions();
  // The illustration is the hero on this panel, so it gets real room — but it
  // still yields on short screens so the headline and button stay visible.
  const imageHeight = Math.min(340, Math.max(190, height * 0.33));

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.body}>
        <Animated.View entering={FadeIn.duration(450)} style={styles.imageWrap}>
          <Image
            source={image}
            style={{ height: imageHeight, aspectRatio: imageRatio }}
            resizeMode="contain"
          />
        </Animated.View>

        <Animated.View entering={FadeInDown.delay(120).duration(400)} style={styles.copy}>
          <ProgressStepper steps={steps} currentStep={currentStep} />
          <AppText variant="headlineLgMobile" align="center" style={styles.title}>
            {title}
          </AppText>
          <AppText variant="bodyLg" color="onSurfaceVariant" align="center">
            {subtitle}
          </AppText>
        </Animated.View>
      </View>

      <View style={styles.footer}>
        <Button
          onPress={onNext}
          fullWidth
          icon={<Ionicons name="arrow-forward" size={18} color={colors.onPrimary} />}
        >
          {nextLabel}
        </Button>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  body: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.marginMobile,
  },
  imageWrap: {
    alignItems: 'center',
    marginBottom: spacing.xl,
  },
  copy: {
    alignItems: 'center',
    gap: spacing.sm,
  },
  title: {
    marginTop: spacing.md,
  },
  footer: {
    paddingHorizontal: spacing.marginMobile,
    paddingBottom: spacing.md,
    paddingTop: spacing.base,
  },
});
