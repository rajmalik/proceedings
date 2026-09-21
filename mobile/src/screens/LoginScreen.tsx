import React, { useState } from 'react';
import {
  View,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  ActivityIndicator,
  Image,
  Dimensions,
  Linking,
} from 'react-native';
import Animated, { FadeInDown, FadeInUp } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius } from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { AppleSignInButton, AppText, AnimatedPressable, AuroraBackground } from '../components';

const { height: H } = Dimensions.get('window');
const PRIVACY_URL = 'https://meridianjourney.ai/privacy';

export function LoginScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const { signInWithEmail, signInWithGoogle, signInWithApple } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState('');

  const handleEmailSignIn = async () => {
    if (!email.trim() || !password.trim()) {
      setError('Please enter both email and password.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      await signInWithEmail(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setGoogleLoading(true);
    setError('');
    try {
      await signInWithGoogle();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Google Sign-In failed');
    } finally {
      setGoogleLoading(false);
    }
  };

  const handleAppleSignIn = async () => {
    setError('');
    try {
      await signInWithApple();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign in with Apple failed');
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <AuroraBackground focalY={H * 0.3} />

      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Logo / Header */}
            <Animated.View entering={FadeInDown.duration(400).springify()} style={styles.header}>
              <View style={styles.logoCircle}>
                <Image
                  source={require('../../assets/meridian-new-logo-transparent.png')}
                  style={styles.logo}
                  resizeMode="contain"
                />
              </View>
              <AppText variant="headlineLg" color="onPrimary" align="center" style={styles.title}>
                Welcome Back
              </AppText>
              <AppText variant="bodyMd" color="inverseOnSurface" align="center" style={styles.subtitle}>
                Sign in to continue your immigration journey
              </AppText>
            </Animated.View>

            {/* Error message */}
            {error ? (
              <View style={styles.errorContainer}>
                <Ionicons name="alert-circle" size={20} color={colors.error} />
                <AppText variant="bodyMd" color="onErrorContainer" style={styles.errorText}>
                  {error}
                </AppText>
              </View>
            ) : null}

            {/* Email input */}
            <View style={styles.inputContainer}>
              <AppText variant="labelMd" color="inverseOnSurface" style={styles.label}>
                Email
              </AppText>
              <View style={styles.inputWrapper}>
                <Ionicons name="mail-outline" size={20} color={colors.inverseOnSurface} style={styles.inputIcon} />
                <TextInput
                  value={email}
                  onChangeText={setEmail}
                  placeholder="Enter your email"
                  placeholderTextColor={colors.authGlass.placeholder}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="none"
                  style={styles.input}
                />
              </View>
            </View>

            {/* Password input */}
            <View style={styles.inputContainer}>
              <AppText variant="labelMd" color="inverseOnSurface" style={styles.label}>
                Password
              </AppText>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={20} color={colors.inverseOnSurface} style={styles.inputIcon} />
                <TextInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder="Enter your password"
                  placeholderTextColor={colors.authGlass.placeholder}
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="oneTimeCode"
                  style={styles.input}
                />
                <TouchableOpacity onPress={() => setShowPassword(!showPassword)} style={styles.eyeButton} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons
                    name={showPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={colors.inverseOnSurface}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {/* Sign In button */}
            <AnimatedPressable
              onPress={handleEmailSignIn}
              haptics="medium"
              disabled={loading || googleLoading}
              style={styles.primaryButton}
            >
              {loading ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <AppText variant="titleMd" color="onPrimary" style={styles.primaryButtonText}>
                  Sign In
                </AppText>
              )}
            </AnimatedPressable>

            {/* Divider */}
            <View style={styles.divider}>
              <View style={styles.dividerLine} />
              <AppText variant="bodyMd" color="inverseOnSurface" style={styles.dividerText}>
                or
              </AppText>
              <View style={styles.dividerLine} />
            </View>

            {/* Sign in with Apple (iOS only — Apple Guideline 4.8) */}
            <AppleSignInButton
              type="SIGN_IN"
              appearance="white"
              onPress={handleAppleSignIn}
              style={styles.appleButton}
            />

            {/* Google Sign In */}
            <AnimatedPressable
              onPress={handleGoogleSignIn}
              haptics="medium"
              disabled={loading || googleLoading}
              style={styles.googleButton}
            >
              {googleLoading ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <>
                  <Ionicons name="logo-google" size={20} color={colors.onPrimary} />
                  <AppText variant="titleMd" color="onPrimary" style={styles.googleButtonText}>
                    Continue with Google
                  </AppText>
                </>
              )}
            </AnimatedPressable>

            {/* Sign Up link */}
            <Animated.View entering={FadeInUp.delay(150).duration(400)} style={styles.signUpContainer}>
              <AnimatedPressable onPress={() => navigation.navigate('Signup')} haptics="light">
                <AppText variant="bodyMd" color="inverseOnSurface" align="center">
                  Don't have an account?{' '}
                  <AppText variant="bodyMd" color="onPrimary" style={styles.signUpLink}>
                    Sign Up
                  </AppText>
                </AppText>
              </AnimatedPressable>
            </Animated.View>

            {/* Terms notice — the EULA (with its zero-tolerance objectionable-content
                policy) is presented before logging in too, not only at signup
                (App Store Guideline 1.2). */}
            <AppText variant="caption" color="inverseOnSurface" align="center" style={styles.termsNotice}>
              By continuing you agree to our{' '}
              <AppText
                variant="caption"
                color="onPrimary"
                style={styles.termsLink}
                onPress={() => navigation.navigate('Disclaimer')}
              >
                Terms of Use (EULA)
              </AppText>{' '}
              and{' '}
              <AppText
                variant="caption"
                color="onPrimary"
                style={styles.termsLink}
                onPress={() => Linking.openURL(PRIVACY_URL)}
              >
                Privacy Policy
              </AppText>
              .
            </AppText>
          </ScrollView>
        </KeyboardAvoidingView>
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
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    padding: spacing.marginMobile,
    paddingTop: spacing.lg,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  logoCircle: {
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 18,
    elevation: 6,
  },
  logo: {
    width: 130,
    height: 130,
    tintColor: colors.onPrimary,
  },
  title: {
    marginBottom: spacing.base,
  },
  subtitle: {
    opacity: 0.82,
  },
  errorContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.errorContainer,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.base,
    borderRadius: borderRadius.default,
    marginBottom: spacing.md,
    gap: 8,
  },
  errorText: {
    flex: 1,
  },
  inputContainer: {
    marginBottom: spacing.md,
  },
  label: {
    marginBottom: 8,
  },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.authGlass.inputBg,
    borderWidth: 1,
    borderColor: colors.authGlass.inputBorder,
    borderRadius: borderRadius.lg,
    paddingHorizontal: spacing.sm,
  },
  inputIcon: {
    marginRight: 8,
  },
  input: {
    flex: 1,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.inverseOnSurface,
  },
  eyeButton: {
    padding: 8,
  },
  primaryButton: {
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: borderRadius.default,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.sm,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.4,
    shadowRadius: 12,
    elevation: 6,
  },
  primaryButtonText: {
    fontSize: 17,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: spacing.md,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: colors.authGlass.divider,
  },
  dividerText: {
    marginHorizontal: spacing.sm,
    opacity: 0.8,
  },
  appleButton: {
    marginBottom: spacing.sm,
  },
  googleButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.authGlass.googleBg,
    borderWidth: 1,
    borderColor: colors.authGlass.googleBorder,
    paddingVertical: 14,
    borderRadius: borderRadius.default,
    gap: 10,
  },
  googleButtonText: {
    fontSize: 16,
  },
  signUpContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  signUpLink: {
    fontFamily: 'NunitoSans_700Bold',
  },
  termsNotice: {
    marginTop: spacing.md,
    opacity: 0.8,
    paddingHorizontal: spacing.sm,
  },
  termsLink: {
    fontFamily: 'NunitoSans_700Bold',
    textDecorationLine: 'underline',
  },
});

export default LoginScreen;
