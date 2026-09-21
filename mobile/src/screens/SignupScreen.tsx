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
import Animated, { FadeInDown } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius } from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { AppleSignInButton, AppText, AnimatedPressable, AuroraBackground } from '../components';

const PRIVACY_URL = 'https://meridianjourney.ai/privacy';
const { height: H } = Dimensions.get('window');

export function SignupScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const { signUpWithEmail, signInWithGoogle, signInWithApple } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [error, setError] = useState('');

  // App Store Guideline 1.2: users must agree to the EULA (with its zero-tolerance
  // policy for objectionable content / abusive users) BEFORE registering. This
  // gate covers all three sign-up paths — email, Google, and Apple.
  const requireTerms = (): boolean => {
    if (!agreedToTerms) {
      setError('Please agree to the Terms of Use (EULA) and Privacy Policy to continue.');
      return false;
    }
    return true;
  };

  const validateEmail = (email: string) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleSignUp = async () => {
    if (!requireTerms()) return;
    // Validation
    if (!email.trim() || !password.trim() || !confirmPassword.trim()) {
      setError('Please fill in all fields.');
      return;
    }

    if (!validateEmail(email.trim())) {
      setError('Please enter a valid email address.');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    setError('');
    try {
      await signUpWithEmail(email.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign up failed');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    if (!requireTerms()) return;
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
    if (!requireTerms()) return;
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
      <AuroraBackground focalY={H * 0.28} />

      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={styles.scrollContent}
            keyboardShouldPersistTaps="handled"
          >
            {/* Back button */}
            <TouchableOpacity
              style={styles.backButton}
              onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Login'))}
            >
              <Ionicons name="arrow-back" size={22} color={colors.onPrimary} />
            </TouchableOpacity>

            {/* Header */}
            <Animated.View entering={FadeInDown.duration(400).springify()} style={styles.header}>
              <View style={styles.logoCircle}>
                <Image
                  source={require('../../assets/meridian-new-logo-transparent.png')}
                  style={styles.logo}
                  resizeMode="contain"
                />
              </View>
              <AppText variant="headlineLg" color="onPrimary" align="center" style={styles.title}>
                Create Account
              </AppText>
              <AppText variant="bodyMd" color="inverseOnSurface" align="center" style={styles.subtitle}>
                Join our community and get guidance on your immigration journey
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
                  placeholder="Create a password (min. 6 characters)"
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

            {/* Confirm Password input */}
            <View style={styles.inputContainer}>
              <AppText variant="labelMd" color="inverseOnSurface" style={styles.label}>
                Confirm Password
              </AppText>
              <View style={styles.inputWrapper}>
                <Ionicons name="lock-closed-outline" size={20} color={colors.inverseOnSurface} style={styles.inputIcon} />
                <TextInput
                  value={confirmPassword}
                  onChangeText={setConfirmPassword}
                  placeholder="Confirm your password"
                  placeholderTextColor={colors.authGlass.placeholder}
                  secureTextEntry={!showConfirmPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoComplete="off"
                  textContentType="oneTimeCode"
                  style={styles.input}
                />
                <TouchableOpacity onPress={() => setShowConfirmPassword(!showConfirmPassword)} style={styles.eyeButton} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons
                    name={showConfirmPassword ? 'eye-off-outline' : 'eye-outline'}
                    size={20}
                    color={colors.inverseOnSurface}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {/* EULA acceptance gate (App Store Guideline 1.2) — must be agreed to
                before registering via ANY method. The linked Terms make clear there
                is zero tolerance for objectionable content or abusive users. */}
            <TouchableOpacity
              style={styles.termsRow}
              activeOpacity={0.7}
              onPress={() => setAgreedToTerms((v) => !v)}
            >
              <View style={[styles.checkbox, agreedToTerms && styles.checkboxChecked]}>
                {agreedToTerms && <Ionicons name="checkmark" size={16} color={colors.onPrimary} />}
              </View>
              <AppText variant="caption" color="inverseOnSurface" style={styles.termsText}>
                I agree to the{' '}
                <AppText variant="caption" color="onPrimary" style={styles.termsLink} onPress={() => navigation.navigate('Disclaimer')}>
                  Terms of Use (EULA)
                </AppText>{' '}
                and{' '}
                <AppText variant="caption" color="onPrimary" style={styles.termsLink} onPress={() => Linking.openURL(PRIVACY_URL)}>
                  Privacy Policy
                </AppText>
                . I understand there is zero tolerance for objectionable content or abusive behavior.
              </AppText>
            </TouchableOpacity>

            {/* Sign Up button */}
            <AnimatedPressable
              onPress={handleSignUp}
              haptics="medium"
              disabled={loading || googleLoading}
              style={styles.primaryButton}
            >
              {loading ? (
                <ActivityIndicator color={colors.onPrimary} />
              ) : (
                <AppText variant="titleMd" color="onPrimary" style={styles.primaryButtonText}>
                  Create Account
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

            {/* Sign up with Apple (iOS only — Apple Guideline 4.8) */}
            <AppleSignInButton
              type="SIGN_UP"
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

            {/* Sign In link */}
            <View style={styles.signInContainer}>
              <AnimatedPressable onPress={() => navigation.navigate('Login')} haptics="light">
                <AppText variant="bodyMd" color="inverseOnSurface" align="center">
                  Already have an account?{' '}
                  <AppText variant="bodyMd" color="onPrimary" style={styles.signInLink}>
                    Sign In
                  </AppText>
                </AppText>
              </AnimatedPressable>
            </View>
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
    paddingTop: spacing.sm,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.authGlass.inputBg,
    borderWidth: 1,
    borderColor: colors.authGlass.inputBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  header: {
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  logoCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.primary,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.base,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.45,
    shadowRadius: 16,
    elevation: 6,
  },
  logo: {
    width: 78,
    height: 78,
    tintColor: colors.onPrimary,
  },
  title: {
    marginBottom: spacing.xs,
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
    marginBottom: spacing.sm,
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
    paddingVertical: 12,
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
    marginTop: spacing.xs,
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
    marginVertical: spacing.sm,
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
  termsRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    gap: 10,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 1.5,
    borderColor: colors.authGlass.checkboxBorder,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkboxChecked: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  signInContainer: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.md,
  },
  signInLink: {
    fontFamily: 'NunitoSans_700Bold',
  },
  termsText: {
    flex: 1,
    lineHeight: 16,
  },
  termsLink: {
    fontFamily: 'NunitoSans_700Bold',
  },
});

export default SignupScreen;
