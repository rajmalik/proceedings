import React, { createContext, useContext, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { setAIConsentGranted } from '../services/aiConsent';
import { useAuth } from './AuthContext';

/**
 * Tracks the user's decision to share data with the third-party AI service
 * (Google Gemini / Google Cloud AI) — App Store Guideline 5.1.1(i) / 5.1.2(i).
 *
 * `decision`:
 *   - `null`      → not decided yet (show the consent screen before any AI use)
 *   - `'granted'` → AI features enabled, data may be sent
 *   - `'declined'`→ AI features disabled, no data sent to the AI backend
 *
 * The decision is namespaced PER USER and reloaded whenever the signed-in uid
 * changes, so user B on a shared device never inherits user A's consent
 * (audit P0: cross-user data-sharing without consent). AIConsentProvider must
 * render inside AuthProvider.
 */

const AI_CONSENT_PREFIX = 'proceedings_ai_consent_v1';
const consentKey = (uid: string | null | undefined): string =>
  `${AI_CONSENT_PREFIX}_${uid ?? 'anon'}`;

type Decision = 'granted' | 'declined';

interface AIConsentState {
  loading: boolean;
  decision: Decision | null;
  hasAIConsent: boolean; // decision === 'granted'
  grantAIConsent: () => Promise<void>;
  declineAIConsent: () => Promise<void>;
}

const AIConsentContext = createContext<AIConsentState | undefined>(undefined);

export function AIConsentProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const uid = user?.uid ?? null;
  const [loading, setLoading] = useState(true);
  const [decision, setDecision] = useState<Decision | null>(null);

  // Reload the decision for the current user whenever the uid changes (sign-in,
  // sign-out, or switching accounts). Resets in-memory state so the next user
  // sees the consent screen and the AI-enforcement flag matches them.
  useEffect(() => {
    let active = true;
    setLoading(true);
    AsyncStorage.getItem(consentKey(uid))
      .then((v) => {
        if (!active) return;
        const d = v === 'granted' || v === 'declined' ? (v as Decision) : null;
        setDecision(d);
        setAIConsentGranted(d === 'granted');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [uid]);

  const persist = async (d: Decision) => {
    setDecision(d);
    setAIConsentGranted(d === 'granted');
    try {
      await AsyncStorage.setItem(consentKey(uid), d);
    } catch {
      // Non-fatal: the in-memory flag still governs this session.
    }
  };

  const grantAIConsent = () => persist('granted');
  const declineAIConsent = () => persist('declined');

  return (
    <AIConsentContext.Provider
      value={{
        loading,
        decision,
        hasAIConsent: decision === 'granted',
        grantAIConsent,
        declineAIConsent,
      }}
    >
      {children}
    </AIConsentContext.Provider>
  );
}

export function useAIConsent(): AIConsentState {
  const ctx = useContext(AIConsentContext);
  if (!ctx) throw new Error('useAIConsent must be used within an AIConsentProvider');
  return ctx;
}
