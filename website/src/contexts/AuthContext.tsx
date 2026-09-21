'use client';

import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import {
  User,
  onAuthStateChanged,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  signOut as firebaseSignOut,
  AuthError,
} from 'firebase/auth';
import { auth, googleProvider } from '@/lib/firebase';
import { clearActiveUser, setIdToken } from '@/lib/activeUser';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signUpWithEmail: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

function getAuthErrorMessage(errorCode: string): string {
  switch (errorCode) {
    case 'auth/email-already-in-use':
      return 'This email is already registered. Please sign in instead.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/operation-not-allowed':
      return 'Email/password sign in is not enabled.';
    case 'auth/weak-password':
      return 'Password should be at least 6 characters.';
    case 'auth/user-disabled':
      return 'This account has been disabled.';
    case 'auth/user-not-found':
      return 'No account found with this email.';
    case 'auth/wrong-password':
      return 'Incorrect password. Please try again.';
    case 'auth/invalid-credential':
      return 'Invalid email or password. Please try again.';
    case 'auth/too-many-requests':
      return 'Too many failed attempts. Please try again later.';
    case 'auth/network-request-failed':
      return 'Network error. Please check your connection.';
    case 'auth/popup-closed-by-user':
      return 'Sign-in popup was closed. Please try again.';
    default:
      return 'An error occurred. Please try again.';
  }
}

// Register the Firebase uid with the backend so the X-User-Id gate accepts it
// (idempotent POST /api/users; a localStorage flag avoids a call on every load).
async function registerBackendUser(firebaseUser: User): Promise<void> {
  const flag = `backend-registered-${firebaseUser.uid}`;
  if (typeof window === 'undefined' || localStorage.getItem(flag)) return;
  try {
    const username =
      firebaseUser.displayName?.trim() || firebaseUser.email?.split('@')[0] || '';
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid: firebaseUser.uid, username }),
    });
    if (res.ok) localStorage.setItem(flag, '1');
  } catch {
    // Best-effort — retried on the next auth-state change / page load.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return;
    }

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Cache the bearer token BEFORE exposing `user`/`loading` to consumers.
        // Previously this happened via the separate onIdTokenChanged listener
        // below, which fetches the token asynchronously — leaving a window
        // where `user` was already truthy (pages start firing authenticated
        // requests the moment they see it) but userHeaders() had no token yet
        // to attach, so the request went out unauthenticated and 401'd. Only
        // surfaced once real users' pages started actually loading data on
        // mount instead of silently never firing (see features/ui-changes-1
        // follow-up) — not new to this fix, just newly exercised.
        try {
          setIdToken(await firebaseUser.getIdToken());
        } catch {
          setIdToken(null);
        }
        // Mutual exclusivity: a real session wins, so drop any stale demo-user
        // selection that could otherwise shadow/race the Firebase uid.
        clearActiveUser();
        void registerBackendUser(firebaseUser);
      } else {
        setIdToken(null);
      }
      setUser(firebaseUser);
      setLoading(false);
    });

    // Keeps the cached token fresh on subsequent rotation (hourly refresh) —
    // the initial cache is now handled above, before `user` is ever exposed.
    const unsubToken = onIdTokenChanged(auth, (u) => {
      if (u) void u.getIdToken().then(setIdToken).catch(() => setIdToken(null));
      else setIdToken(null);
    });

    return () => { unsubscribe(); unsubToken(); };
  }, []);

  const signInWithEmail = async (email: string, password: string) => {
    if (!auth) throw new Error('Firebase auth not initialized');
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      throw new Error(getAuthErrorMessage((error as AuthError).code));
    }
  };

  const signUpWithEmail = async (email: string, password: string) => {
    if (!auth) throw new Error('Firebase auth not initialized');
    try {
      await createUserWithEmailAndPassword(auth, email, password);
    } catch (error) {
      throw new Error(getAuthErrorMessage((error as AuthError).code));
    }
  };

  const signInWithGoogle = async () => {
    if (!auth || !googleProvider) throw new Error('Firebase auth not initialized');
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      throw new Error(getAuthErrorMessage((error as AuthError).code));
    }
  };

  const signOut = async () => {
    if (!auth) throw new Error('Firebase auth not initialized');
    try {
      await firebaseSignOut(auth);
    } catch (error) {
      throw new Error('Failed to sign out');
    }
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signInWithEmail,
        signUpWithEmail,
        signInWithGoogle,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
