import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import LoginPage from '../page'

// All three sign-in paths used to push('/') unconditionally, so a shared group
// link dumped the recipient on the home page with no way back. They now honour
// ?next= — which makes the login page an open-redirect target unless the value
// is validated, hence the negative cases below.

const push = vi.fn()
let mockSearch = ''
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}))

const signInWithEmail = vi.fn()
const signInWithGoogle = vi.fn()
let mockAuth: Record<string, unknown> = {}
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => mockAuth }))
// safeReturnPath comes from useRequireUser, which reaches activeUser ->
// firebase; the real module boots Firebase and has no API key under test.
vi.mock('@/lib/activeUser', () => ({ DEMO_PICKER_ENABLED: false }))

beforeEach(() => {
  push.mockClear()
  signInWithEmail.mockReset().mockResolvedValue(undefined)
  signInWithGoogle.mockReset().mockResolvedValue(undefined)
  mockSearch = ''
  mockAuth = { user: null, loading: false, signInWithEmail, signInWithGoogle }
})

function signInByEmail() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'a@b.com' } })
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } })
  fireEvent.click(screen.getByText('Sign in'))
}

describe('LoginPage — where you land after signing in', () => {
  it('returns you to the page you were trying to reach', async () => {
    mockSearch = 'next=%2Fgroups%2Fg1'
    render(<LoginPage />)
    signInByEmail()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/groups/g1'))
  })

  it('goes home when there is no next', async () => {
    render(<LoginPage />)
    signInByEmail()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/'))
  })

  it('honours next on the Google path too', async () => {
    mockSearch = 'next=%2Fgroups%2Fg1'
    render(<LoginPage />)
    fireEvent.click(screen.getByText('Continue with Google'))
    await waitFor(() => expect(push).toHaveBeenCalledWith('/groups/g1'))
  })

  it('honours next for an already-signed-in visitor who lands here', async () => {
    // The third path: the redirect effect, not a sign-in handler.
    mockSearch = 'next=%2Fgroups%2Fg1'
    mockAuth = { ...mockAuth, user: { uid: 'u1' } }
    render(<LoginPage />)
    await waitFor(() => expect(push).toHaveBeenCalledWith('/groups/g1'))
  })

  it('keeps the query string of the destination', async () => {
    mockSearch = `next=${encodeURIComponent('/groups/g1?invite=abc')}`
    render(<LoginPage />)
    signInByEmail()
    await waitFor(() => expect(push).toHaveBeenCalledWith('/groups/g1?invite=abc'))
  })
})

describe('LoginPage — a crafted next cannot redirect off-origin', () => {
  // safeReturnPath has unit coverage in shared-link.test.tsx; these assert the
  // PAGE actually routes through it rather than trusting the raw param.
  const hostile = [
    ['a protocol-relative URL', '//evil.example/phish'],
    ['a backslash-escaped host', '/\\evil.example'],
    ['an absolute https URL', 'https://evil.example'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a bare host with no leading slash', 'evil.example'],
  ] as const

  it.each(hostile)('falls back to / for %s', async (_label, next) => {
    mockSearch = `next=${encodeURIComponent(next)}`
    render(<LoginPage />)
    signInByEmail()
    await waitFor(() => expect(push).toHaveBeenCalled())
    expect(push).toHaveBeenCalledWith('/')
    expect(push).not.toHaveBeenCalledWith(next)
  })
})

describe('LoginPage — failures do not navigate', () => {
  it('shows the error and stays put when email sign-in fails', async () => {
    mockSearch = 'next=%2Fgroups%2Fg1'
    signInWithEmail.mockRejectedValue(new Error('Wrong password'))
    render(<LoginPage />)
    signInByEmail()
    expect(await screen.findByText('Wrong password')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('shows the error and stays put when Google sign-in fails', async () => {
    signInWithGoogle.mockRejectedValue(new Error('Popup closed'))
    render(<LoginPage />)
    fireEvent.click(screen.getByText('Continue with Google'))
    expect(await screen.findByText('Popup closed')).toBeInTheDocument()
    expect(push).not.toHaveBeenCalled()
  })

  it('re-enables the form after a failure so the user can retry', async () => {
    signInWithEmail.mockRejectedValue(new Error('Wrong password'))
    render(<LoginPage />)
    signInByEmail()
    await screen.findByText('Wrong password')
    expect(screen.getByText('Sign in')).not.toBeDisabled()
  })
})

describe('LoginPage — auth-loading state', () => {
  it('renders neither the form nor a redirect while auth is resolving', () => {
    mockAuth = { ...mockAuth, loading: true }
    render(<LoginPage />)
    expect(screen.queryByLabelText('Email')).toBeNull()
    expect(push).not.toHaveBeenCalled()
  })
})
