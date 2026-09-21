import React from 'react';
import { View, StyleSheet, Image, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BlurView } from 'expo-blur';
import { StatusBar } from 'expo-status-bar';
import Animated, { FadeIn, FadeInDown, FadeInUp } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { colors, spacing, borderRadius } from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { AnimatedPressable, AppText, AuroraBackground } from '../components';

const { height: H } = Dimensions.get('window');
const LOGO_CY = H * 0.39; // focal point for the aurora bloom (sits behind the logo)

export function WelcomeScreen() {
  const { completeWelcome } = useAuth();
  const navigation = useNavigation<any>();

  // Persist "welcome seen" and route: new users → Signup, returning → Login.
  // Navigate first, then flip the flag, so the destination survives the
  // AuthNavigator dropping the Welcome screen from the stack.
  const go = (route: 'Signup' | 'Login') => {
    navigation.navigate(route);
    completeWelcome();
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <AuroraBackground focalY={LOGO_CY} />

      <SafeAreaView style={styles.container} edges={['bottom']}>
        {/* Hero lockup — white torch in the bloom, wordmark + tagline below. */}
        <View style={styles.content}>
          <Animated.View entering={FadeIn.delay(150).duration(800)}>
            <Image
              source={require('../../assets/meridian-new-logo-transparent.png')}
              style={styles.logo}
              resizeMode="contain"
            />
          </Animated.View>

          <Animated.View
            style={styles.textBlock}
            entering={FadeInDown.delay(350).duration(700)}
          >
            <AppText variant="displayLg" color="onPrimary" align="center" style={styles.wordmark}>
              Meridian
            </AppText>
            <AppText variant="bodyLg" color="inverseOnSurface" align="center" style={styles.tagline}>
              Your USA Immigration Journey Starts Here
            </AppText>
          </Animated.View>
        </View>

        {/* CTA cluster — frosted glass primary + sign-in link. */}
        <Animated.View
          style={styles.ctaCluster}
          entering={FadeInUp.delay(450).duration(650).springify()}
        >
          <AnimatedPressable onPress={() => go('Signup')} haptics="light" style={styles.ctaWrap}>
            <BlurView intensity={38} tint="light" style={styles.getStartedBlur}>
              <AppText variant="titleMd" color="onPrimary" style={styles.getStartedText}>
                Get Started
              </AppText>
              <Ionicons name="arrow-forward" size={20} color={colors.onPrimary} />
            </BlurView>
          </AnimatedPressable>

          <AnimatedPressable onPress={() => go('Login')} haptics="light" style={styles.signInWrap}>
            <AppText variant="bodyMd" color="inverseOnSurface" align="center">
              Already have an account?{' '}
              <AppText variant="bodyMd" color="onPrimary" style={styles.signInLink}>
                Sign in
              </AppText>
            </AppText>
          </AnimatedPressable>
        </Animated.View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.welcomeDark[2],
  },
  container: {
    flex: 1,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.marginMobile,
  },
  logo: {
    width: 140,
    height: 140,
    tintColor: colors.onPrimary,
    // Soft white lift so the mark reads crisply against the bloom.
    shadowColor: '#FFFFFF',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 18,
  },
  textBlock: {
    marginTop: spacing.lg,
    alignItems: 'center',
  },
  wordmark: {
    // Subtle dark backing keeps the serif crisp over the brightest part of the bloom.
    textShadowColor: 'rgba(0, 0, 0, 0.28)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 10,
  },
  tagline: {
    marginTop: spacing.sm,
    letterSpacing: 0.4,
    opacity: 0.82,
  },
  ctaCluster: {
    paddingHorizontal: spacing.marginMobile,
    paddingBottom: spacing.xl,
  },
  ctaWrap: {
    borderRadius: borderRadius.lg,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.35)',
  },
  getStartedBlur: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.10)',
  },
  getStartedText: {
    fontSize: 18,
  },
  signInWrap: {
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  signInLink: {
    fontFamily: 'NunitoSans_700Bold',
  },
});

export default WelcomeScreen;
