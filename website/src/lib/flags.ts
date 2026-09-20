// Client feature flags. NEXT_PUBLIC_* is inlined at BUILD time (see the website
// Dockerfile + build-config.test.ts), so flipping one is a rebuild, not a runtime
// toggle.

// AI Assist conversational surface. A NEW flag, deliberately separate from the
// legacy UnifiedSearch `AI_MODE_ENABLED` (which stays off). Ships off; flip to
// '1' in the build to enable (Q5/Q10).
export const AI_ASSIST_ENABLED = process.env.NEXT_PUBLIC_AI_ASSIST_ENABLED === '1'
