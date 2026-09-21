import React, { useState, useEffect } from 'react';
import { View, StyleSheet, ActivityIndicator, Platform, DeviceEventEmitter } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, NativeStackNavigationOptions } from '@react-navigation/native-stack';
import {
  SearchScreen,
  AdvancedSearchScreen,
  CaseDetailsScreen,
  AuthorScreen,
  AuthorByHandleScreen,
  FindScreen,
  PostScreen,
  GroupChatScreen,
  GroupAttributesScreen,
  LoginScreen,
  SignupScreen,
  EmailVerificationScreen,
  AIConsentScreen,
  ProfileScreen,
  DisclaimerScreen,
  BackgroundOnboardingScreen,
  ExperiencesOnboardingScreen,
  AIChatScreen,
  VisaExperiencesScreen,
  WelcomeScreen,
  NewsScreen,
  DiscussionsScreen,
} from '../screens';
import { colors, spacing } from '../constants/theme';
import { FloatingChatButton, ChatModal, AssistModal } from '../components/chat';
import { AI_ASSIST_ENABLED } from '../constants/flags';
import { ASSIST_OPEN_EVENT } from '../utils/assistLauncher';
import { FloatingTabBar } from '../components/FloatingTabBar';
import { useAuth } from '../contexts/AuthContext';
import { useAIConsent } from '../contexts/AIConsentContext';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();
const AuthStack = createNativeStackNavigator();
const OnboardingStackNav = createNativeStackNavigator();

// Polished screen transition options
const screenTransitionOptions: NativeStackNavigationOptions = {
  headerShown: false,
  animation: Platform.OS === 'ios' ? 'ios_from_right' : 'slide_from_right',
  animationDuration: 300,
  gestureEnabled: true,
  fullScreenGestureEnabled: true,
};

// Modal presentation options
const modalTransitionOptions: NativeStackNavigationOptions = {
  headerShown: false,
  presentation: 'modal',
  animation: 'slide_from_bottom',
  gestureEnabled: true,
};

// Fade transition for auth flow
const fadeTransitionOptions: NativeStackNavigationOptions = {
  headerShown: false,
  animation: 'fade',
  animationDuration: 250,
};

// "Home" is now the postings search/browse experience itself (formerly the
// separate "Community" tab, which mirrored the website's /search) — the old
// personalized HomeScreen (greeting, previews) is gone. VisaExperiences/AIChat
// stay registered even though nothing currently navigates to them (their only
// entry points were on the old HomeScreen) — harmless if unreached, and still
// resolve correctly if AI_CHAT_ENABLED is ever flipped back on.
function HomeStack() {
  return (
    <Stack.Navigator screenOptions={screenTransitionOptions}>
      <Stack.Screen name="HomeMain" component={SearchScreen} />
      <Stack.Screen name="AdvancedSearch" component={AdvancedSearchScreen} />
      <Stack.Screen name="VisaExperiences" component={VisaExperiencesScreen} />
      <Stack.Screen name="AIChat" component={AIChatScreen} />
      <Stack.Screen name="Post" component={PostScreen} />
      <Stack.Screen name="CaseDetails" component={CaseDetailsScreen} />
      <Stack.Screen name="GroupChat" component={GroupChatScreen} />
      <Stack.Screen name="GroupAttributes" component={GroupAttributesScreen} />
      <Stack.Screen name="Author" component={AuthorScreen} />
      <Stack.Screen name="AuthorByHandle" component={AuthorByHandleScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Disclaimer" component={DisclaimerScreen} options={modalTransitionOptions} />
      <Stack.Screen name="BackgroundOnboarding" component={BackgroundOnboardingScreen} />
      <Stack.Screen name="ExperiencesOnboarding" component={ExperiencesOnboardingScreen} />
    </Stack.Navigator>
  );
}

function NewsStack() {
  return (
    <Stack.Navigator screenOptions={screenTransitionOptions}>
      <Stack.Screen name="NewsMain" component={NewsScreen} />
      <Stack.Screen name="GroupChat" component={GroupChatScreen} />
      <Stack.Screen name="GroupAttributes" component={GroupAttributesScreen} />
      <Stack.Screen name="CaseDetails" component={CaseDetailsScreen} />
      <Stack.Screen name="Author" component={AuthorScreen} />
      <Stack.Screen name="AuthorByHandle" component={AuthorByHandleScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Disclaimer" component={DisclaimerScreen} options={modalTransitionOptions} />
      <Stack.Screen name="BackgroundOnboarding" component={BackgroundOnboardingScreen} />
      <Stack.Screen name="ExperiencesOnboarding" component={ExperiencesOnboardingScreen} />
    </Stack.Navigator>
  );
}

function DiscussionsStack() {
  return (
    <Stack.Navigator screenOptions={screenTransitionOptions}>
      <Stack.Screen name="DiscussionsMain" component={DiscussionsScreen} />
      <Stack.Screen name="Post" component={PostScreen} />
      <Stack.Screen name="GroupChat" component={GroupChatScreen} />
      <Stack.Screen name="GroupAttributes" component={GroupAttributesScreen} />
      <Stack.Screen name="CaseDetails" component={CaseDetailsScreen} />
      <Stack.Screen name="Author" component={AuthorScreen} />
      <Stack.Screen name="AuthorByHandle" component={AuthorByHandleScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Disclaimer" component={DisclaimerScreen} options={modalTransitionOptions} />
      <Stack.Screen name="BackgroundOnboarding" component={BackgroundOnboardingScreen} />
      <Stack.Screen name="ExperiencesOnboarding" component={ExperiencesOnboardingScreen} />
    </Stack.Navigator>
  );
}

function FindStack() {
  return (
    <Stack.Navigator screenOptions={screenTransitionOptions}>
      <Stack.Screen name="FindMain" component={FindScreen} />
      <Stack.Screen name="GroupChat" component={GroupChatScreen} />
      <Stack.Screen name="GroupAttributes" component={GroupAttributesScreen} />
      <Stack.Screen name="CaseDetails" component={CaseDetailsScreen} />
      <Stack.Screen name="Author" component={AuthorScreen} />
      <Stack.Screen name="AuthorByHandle" component={AuthorByHandleScreen} />
      <Stack.Screen name="Profile" component={ProfileScreen} />
      <Stack.Screen name="Disclaimer" component={DisclaimerScreen} options={modalTransitionOptions} />
      <Stack.Screen name="BackgroundOnboarding" component={BackgroundOnboardingScreen} />
      <Stack.Screen name="ExperiencesOnboarding" component={ExperiencesOnboardingScreen} />
    </Stack.Navigator>
  );
}

function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={screenTransitionOptions}>
      <Stack.Screen name="ProfileMain" component={ProfileScreen} />
      <Stack.Screen name="BackgroundOnboarding" component={BackgroundOnboardingScreen} />
      <Stack.Screen name="ExperiencesOnboarding" component={ExperiencesOnboardingScreen} />
      <Stack.Screen name="CaseDetails" component={CaseDetailsScreen} />
      <Stack.Screen name="GroupChat" component={GroupChatScreen} />
      <Stack.Screen name="GroupAttributes" component={GroupAttributesScreen} />
      <Stack.Screen name="Author" component={AuthorScreen} />
      <Stack.Screen name="AuthorByHandle" component={AuthorByHandleScreen} />
      <Stack.Screen name="Disclaimer" component={DisclaimerScreen} options={modalTransitionOptions} />
    </Stack.Navigator>
  );
}

function AuthNavigator({ showWelcome }: { showWelcome: boolean }) {
  return (
    <AuthStack.Navigator screenOptions={fadeTransitionOptions}>
      {showWelcome && (
        <AuthStack.Screen name="Welcome" component={WelcomeScreen} />
      )}
      <AuthStack.Screen name="Login" component={LoginScreen} />
      <AuthStack.Screen name="Signup" component={SignupScreen} />
      {/* EULA / legal terms, reachable from the signup consent gate (Apple 1.2). */}
      <AuthStack.Screen name="Disclaimer" component={DisclaimerScreen} options={modalTransitionOptions} />
    </AuthStack.Navigator>
  );
}

function OnboardingStack() {
  return (
    <OnboardingStackNav.Navigator screenOptions={screenTransitionOptions}>
      <OnboardingStackNav.Screen name="BackgroundOnboarding" component={BackgroundOnboardingScreen} />
      <OnboardingStackNav.Screen name="ExperiencesOnboarding" component={ExperiencesOnboardingScreen} />
    </OnboardingStackNav.Navigator>
  );
}

// The floating AI chat button is disabled - we now use an inline card on the Home screen
// that navigates to a full AIChatScreen instead.
const AI_CHAT_ENABLED = false;

function TabNavigator() {
  const [isChatOpen, setIsChatOpen] = useState(false);
  // AI Assist modal (flag-gated). Opened by the global floating button OR by any
  // screen emitting ASSIST_OPEN_EVENT (e.g. the Home search-row "Ask AI/Post").
  const [assistOpen, setAssistOpen] = useState(false);
  useEffect(() => {
    if (!AI_ASSIST_ENABLED) return;
    const sub = DeviceEventEmitter.addListener(ASSIST_OPEN_EVENT, () => setAssistOpen(true));
    return () => sub.remove();
  }, []);

  return (
    <View style={styles.container}>
      <Tab.Navigator
        tabBar={(props) => <FloatingTabBar {...props} />}
        screenOptions={{
          headerShown: false,
        }}
      >
        <Tab.Screen
          name="Home"
          component={HomeStack}
          options={{
            tabBarLabel: 'Home',
          }}
        />
        <Tab.Screen
          name="Find"
          component={FindStack}
          options={{
            tabBarLabel: 'Groups',
          }}
        />
        <Tab.Screen
          name="News"
          component={NewsStack}
          options={{
            tabBarLabel: 'News',
          }}
        />
        <Tab.Screen
          name="Discussions"
          component={DiscussionsStack}
          options={{
            tabBarLabel: 'Discussions',
          }}
        />
        <Tab.Screen
          name="Profile"
          component={ProfileStack}
          options={{
            tabBarLabel: 'Profile',
          }}
        />
      </Tab.Navigator>

      {/* Legacy /api/ask chat — disabled (AI_CHAT_ENABLED=false); superseded by
          the AI Assist modal below. */}
      {AI_CHAT_ENABLED && (
        <>
          <FloatingChatButton onPress={() => setIsChatOpen(true)} isOpen={isChatOpen} />
          <ChatModal visible={isChatOpen} onClose={() => setIsChatOpen(false)} />
        </>
      )}

      {/* AI Assist — the /api/assist conversational assistant (website parity),
          gated by EXPO_PUBLIC_AI_ASSIST_ENABLED. Global floating launcher + the
          full-screen chat modal, also openable from the Home search row. */}
      {AI_ASSIST_ENABLED && (
        <>
          <FloatingChatButton onPress={() => setAssistOpen(true)} isOpen={assistOpen} />
          <AssistModal visible={assistOpen} onClose={() => setAssistOpen(false)} />
        </>
      )}
    </View>
  );
}

export function MainNavigator() {
  const { user, loading, isDevMode, isEmailVerified, hasSeenWelcome, hasCompletedOnboarding } = useAuth();
  const { loading: aiConsentLoading, decision: aiConsentDecision } = useAIConsent();

  // Dev mode bypass only works in __DEV__ builds; production builds always require auth
  const allowDevMode = __DEV__ && isDevMode;

  // Show loading screen while checking auth state
  if (loading || aiConsentLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  // Show auth screens if not authenticated (dev mode only works in __DEV__ builds)
  if (!user && !allowDevMode) {
    return <AuthNavigator showWelcome={!hasSeenWelcome} />;
  }

  // Show email verification screen if user signed up with email and hasn't verified yet
  // (Google Sign-In users are auto-verified and skip this)
  if (user && !isEmailVerified && !allowDevMode) {
    return <EmailVerificationScreen />;
  }

  // Third-party AI data-sharing consent (App Store 5.1.1(i)/5.1.2(i)) — must be
  // decided before onboarding, which itself sends data to the AI. Shown once
  // (including in dev mode, since AI enforcement is global); both "Agree" and
  // "Not now" record a decision and fall through.
  if (aiConsentDecision === null) {
    return <AIConsentScreen />;
  }

  // Show onboarding if user hasn't completed it (dev mode only works in __DEV__ builds)
  if (!hasCompletedOnboarding && !allowDevMode) {
    return <OnboardingStack />;
  }

  // Show main app if authenticated and onboarding complete (or in dev mode during __DEV__)
  return <TabNavigator />;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: colors.background,
  },
});

export default MainNavigator;
