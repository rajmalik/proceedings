import { render } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// safeReturnPath/loginHref's open-redirect cases live in
// groups/[id]/__tests__/shared-link.test.tsx, next to the bug they fixed.
// THIS file covers the hook itself — when it redirects, when it deliberately
// does nothing, and what it carries along — which nothing else exercises.

const replace = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace }),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}))

let mockPathname = '/groups/g1'
let mockSearch = ''
let mockAuth: { user: unknown; loading: boolean } = { user: null, loading: false }
let mockDemoPicker = false

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mockAuth }))
vi.mock('@/lib/activeUser', () => ({
  get DEMO_PICKER_ENABLED() { return mockDemoPicker },
}))

const { useRequireUser } = await import('@/lib/useRequireUser')

function Probe() {
  useRequireUser()
  return <div>probe</div>
}

beforeEach(() => {
  replace.mockClear()
  mockPathname = '/groups/g1'
  mockSearch = ''
  mockAuth = { user: null, loading: false }
  mockDemoPicker = false
})

describe('useRequireUser — production (no demo picker)', () => {
  it('sends a signed-out visitor to /login carrying where they were headed', () => {
    render(<Probe />)
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fgroups%2Fg1')
  })

  it('preserves the query string, not just the path', () => {
    // A shared link with params has to survive the detour intact.
    mockSearch = 'invite=abc&ref=email'
    render(<Probe />)
    expect(replace).toHaveBeenCalledWith('/login?next=%2Fgroups%2Fg1%3Finvite%3Dabc%26ref%3Demail')
  })

  it('does not redirect a signed-in user', () => {
    mockAuth = { user: { uid: 'u1' }, loading: false }
    render(<Probe />)
    expect(replace).not.toHaveBeenCalled()
  })

  it('waits for auth to settle — a slow Firebase restore is not "signed out"', () => {
    // Redirecting during `loading` would bounce a user who IS signed in.
    mockAuth = { user: null, loading: true }
    render(<Probe />)
    expect(replace).not.toHaveBeenCalled()
  })

  it('sends a signed-out visitor on the root path to a bare /login', () => {
    // No point round-tripping "next=/" — it is where login lands anyway.
    mockPathname = '/'
    render(<Probe />)
    expect(replace).toHaveBeenCalledWith('/login')
  })
})

describe('useRequireUser — dev/test (demo picker enabled)', () => {
  it('is a deliberate no-op — the picker supplies identity, guarding would fight it', () => {
    mockDemoPicker = true
    render(<Probe />)
    expect(replace).not.toHaveBeenCalled()
  })

  it('stays a no-op even mid-auth-load', () => {
    mockDemoPicker = true
    mockAuth = { user: null, loading: true }
    render(<Probe />)
    expect(replace).not.toHaveBeenCalled()
  })
})
