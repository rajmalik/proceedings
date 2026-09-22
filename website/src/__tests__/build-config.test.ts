import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Build-time guard (runs in the no-GCP CI gate, no network needed).
 *
 * Next.js inlines NEXT_PUBLIC_* into the CLIENT bundle at BUILD time. If the
 * Dockerfile stops providing the Firebase web config, the production build
 * ships apiKey=undefined and the browser crashes with
 * "Application error: a client-side exception has occurred" — while SSR still
 * returns 200, so it slips past server-side checks. This test fails the PR the
 * moment those vars are dropped from the build stage. (Companion to the live
 * `npm run smoke` post-deploy check.)
 */
const REQUIRED_FIREBASE_VARS = [
  'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET',
  'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID',
  'NEXT_PUBLIC_FIREBASE_APP_ID',
]

describe('Dockerfile bakes Firebase web config at build time', () => {
  const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8')

  // Only the `build` stage matters — that's where `npm run build` runs and
  // Next.js inlines the values. Slice from the build stage to the run stage.
  const buildStage = dockerfile.slice(
    dockerfile.indexOf('AS build'),
    dockerfile.indexOf('AS run'),
  )
  const buildIndex = dockerfile.indexOf('RUN npm run build')

  it('references the build stage and the build command', () => {
    expect(buildStage.length).toBeGreaterThan(0)
    expect(buildIndex).toBeGreaterThan(-1)
  })

  for (const v of REQUIRED_FIREBASE_VARS) {
    it(`provides ${v} to the build stage as ENV (before npm run build)`, () => {
      // Must be set as ENV (ARG alone is not inlined by Next.js) ...
      const envLine = new RegExp(`ENV\\s+(\\\\\\n\\s*)?${v}=`).test(buildStage) ||
        new RegExp(`${v}=\\$${v}`).test(buildStage) // ENV X=$X multi-line form
      expect(envLine, `${v} must be ENV-set in the build stage`).toBe(true)
      // ... and it must appear before the build runs.
      expect(dockerfile.indexOf(v)).toBeLessThan(buildIndex)
    })
  }
})

describe('Dockerfile bakes the AI Assist flag at build time', () => {
  const dockerfile = readFileSync(resolve(__dirname, '../../Dockerfile'), 'utf8')
  const buildIndex = dockerfile.indexOf('RUN npm run build')

  it('sets NEXT_PUBLIC_AI_ASSIST_ENABLED as ENV before npm run build', () => {
    const v = 'NEXT_PUBLIC_AI_ASSIST_ENABLED'
    const envSet = new RegExp(`ENV\\s+${v}=`).test(dockerfile) ||
      new RegExp(`${v}=\\$${v}`).test(dockerfile)
    expect(envSet, `${v} must be ENV-set in the build stage`).toBe(true)
    expect(dockerfile.indexOf(v)).toBeLessThan(buildIndex)
  })
})
