// Build-time feature flags. EXPO_PUBLIC_* are inlined into the JS bundle at
// build time (same model as the website's NEXT_PUBLIC_*), so flipping one needs
// a rebuild. Mirrors website/src/lib/flags.ts.

// AI Assist chatbot — the /api/assist conversational assistant. Ships OFF; a
// build sets EXPO_PUBLIC_AI_ASSIST_ENABLED=1 to turn it on (the website is
// already live in prod).
export const AI_ASSIST_ENABLED = process.env.EXPO_PUBLIC_AI_ASSIST_ENABLED === '1';
