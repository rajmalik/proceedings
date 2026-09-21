import { render, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AuthProvider, useAuth } from '../AuthContext'
import { userHeaders } from '@/lib/activeUser'

// Regression test for a real production bug: onAuthStateChanged used to set
// `user`/`loading` synchronously while the bearer token was cached separately
// and asynchronously (a different listener's getIdToken().then(...)). Any
// page that fired an authenticated request the moment it saw a truthy `user`
// could race ahead of the token cache and get a 401 "Authentication
// required." — see features/ui-changes-1 follow-up (Onboarding/Find pages).
// The fix caches the token BEFORE exposing `user`/`loading` to consumers, so
// this test asserts that exact ordering guarantee, not just "it doesn't crash".

let authStateCallback: ((user: unknown) => void | Promise<void>) | null = null

vi.mock('@/lib/firebase', () => ({ auth: {}, googleProvider: {} }))
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: (user: unknown) => void | Promise<void>) => {
    authStateCallback = cb
    return vi.fn() // unsubscribe
  },
  onIdTokenChanged: () => vi.fn(), // unsubscribe — rotation-only, not under test here
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  signOut: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}))

// registerBackendUser posts to /api/users on sign-in — stub it out, not under test.
beforeEach(() => {
  authStateCallback = null
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })))
  vi.stubGlobal('localStorage', {
    _store: {} as Record<string, string>,
    getItem(k: string) { return this._store[k] ?? null },
    setItem(k: string, v: string) { this._store[k] = v },
    removeItem(k: string) { delete this._store[k] },
  })
})

function Consumer({ onLoadingFalse }: { onLoadingFalse: (headers: Record<string, string>) => void }) {
  const { loading } = useAuth()
  if (!loading) onLoadingFalse(userHeaders())
  return null
}

describe('AuthContext — token is cached before user/loading are exposed', () => {
  it('userHeaders() already has the Bearer token by the time loading becomes false', async () => {
    let capturedHeaders: Record<string, string> | null = null
    render(
      <AuthProvider>
        <Consumer onLoadingFalse={(h) => { capturedHeaders = h }} />
      </AuthProvider>
    )

    expect(authStateCallback).not.toBeNull()

    const fakeUser = {
      uid: 'real-uid-1',
      displayName: 'Real Name',
      email: 'real@example.com',
      getIdToken: vi.fn(async () => 'fresh-id-token'),
    }
    await act(async () => { await authStateCallback!(fakeUser) })

    await waitFor(() => expect(capturedHeaders).not.toBeNull())
    expect(capturedHeaders!['Authorization']).toBe('Bearer fresh-id-token')
  })
})
