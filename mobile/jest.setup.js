// Jest setup for the Expo/React-Native app (runs before each test file).
//
// React Native Testing Library v12.4+ registers its jest matchers automatically,
// so no extend-expect import is needed. Add native-module mocks here for modules
// that have no JS implementation under the test (node) environment.

// AsyncStorage - use the official in-memory jest mock.
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock')
);

// @expo/vector-icons pulls native font/asset modules that don't resolve under
// jest. Mock every icon family with a lightweight text host component.
jest.mock('@expo/vector-icons', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return new Proxy(
    {},
    { get: () => (props) => React.createElement(Text, props, props.name || null) }
  );
});

// react-native-worklets (Reanimated 4's worklets runtime) has no native part
// under the jest (node) environment, so any suite importing a Reanimated-backed
// component crashed at import with "[Worklets] Native part of Worklets doesn't
// seem to be initialized". Use the library's official jest mock (TS source
// entrypoint, transformed via the react-native-* allowlist in
// transformIgnorePatterns). See the React Native Worklets testing guide.
jest.mock('react-native-worklets', () =>
  require('react-native-worklets/src/mock')
);

// Firebase ships ESM (@firebase/util postinstall.mjs) that jest can't parse, and
// no test exercises real auth — stub the SDK so any module importing it (via the
// components barrel → AuthContext) loads cleanly.
jest.mock('firebase/app', () => ({
  initializeApp: jest.fn(() => ({})),
  getApps: jest.fn(() => []),
  getApp: jest.fn(() => ({})),
}));
jest.mock('firebase/auth', () => ({
  getReactNativePersistence: jest.fn(),
  initializeAuth: jest.fn(() => ({})),
  getAuth: jest.fn(() => ({})),
  onAuthStateChanged: jest.fn(() => () => {}),
  onIdTokenChanged: jest.fn(() => () => {}),
  signInWithEmailAndPassword: jest.fn(),
  createUserWithEmailAndPassword: jest.fn(),
  signOut: jest.fn(),
  signInWithCredential: jest.fn(),
  updateProfile: jest.fn(),
  GoogleAuthProvider: { credential: jest.fn() },
  OAuthProvider: class {
    credential() {
      return {};
    }
  },
}));

// @shopify/react-native-skia ships an ESM entrypoint (`import` syntax) that
// jest can't parse under the CommonJS transform, and the native Canvas has no
// JS implementation under jest anyway. Use the library's official jest mock
// (see the react-native-skia testing guide) so anything importing it (e.g.
// AuroraBackground) loads cleanly.
require('@shopify/react-native-skia/jestSetup');

// expo-apple-authentication is an iOS-native module with no JS impl under jest.
// Provide a light mock so anything importing it (AuthContext, AppleSignInButton)
// loads. The official button is mocked to a plain host component.
jest.mock('expo-apple-authentication', () => {
  const React = require('react');
  const { View } = require('react-native');
  return {
    isAvailableAsync: jest.fn(async () => true),
    signInAsync: jest.fn(async () => ({ identityToken: 'tok', fullName: null })),
    AppleAuthenticationButton: (props) => React.createElement(View, props),
    AppleAuthenticationButtonType: { SIGN_IN: 0, SIGN_UP: 1, CONTINUE: 2 },
    AppleAuthenticationButtonStyle: { WHITE: 0, WHITE_OUTLINE: 1, BLACK: 2 },
    AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  };
});

// react-native-webview renders native WebView — stub it under jest (used by the
// AI Assist web-tier Google search-suggestion chips).
jest.mock('react-native-webview', () => ({ WebView: () => null }));
