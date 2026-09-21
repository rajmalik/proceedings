import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import GroupPage from '../page'
import { safeReturnPath, loginHref } from '@/lib/useRequireUser'

const mockReplace = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => '/groups/g1',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'g1' }),
  useRouter: () => ({ push: vi.fn(), replace: mockReplace }),
}))
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, loading: false }) }))
vi.mock('@/components/GroupChat', () => ({ default: () => <div data-testid="group-chat" /> }))
vi.mock('@/components/AuthorSection', () => ({ default: () => <div /> }))

// No Firebase session AND no demo user — exactly what a stranger following a
// shared group link looks like.
vi.mock('@/lib/activeUser', () => ({
  userHeaders: vi.fn(() => ({})),
  getActiveUser: vi.fn(() => ''),
  DEMO_PICKER_ENABLED: true,
}))

beforeEach(() => {
  vi.restoreAllMocks()
  mockReplace.mockClear()
})

describe('safeReturnPath — the ?next= value is attacker-controlled', () => {
  it('accepts a same-origin path', () => {
    expect(safeReturnPath('/groups/g1')).toBe('/groups/g1')
    expect(safeReturnPath('/groups/g1?tab=chat')).toBe('/groups/g1?tab=chat')
  })

  it('rejects anything that could leave this origin', () => {
    // Both of these are protocol-relative and resolve to another host, so a
    // bare startsWith('/') check would be an open redirect.
    expect(safeReturnPath('//evil.example')).toBeNull()
    expect(safeReturnPath('/\\evil.example')).toBeNull()
    expect(safeReturnPath('https://evil.example')).toBeNull()
    expect(safeReturnPath('javascript:alert(1)')).toBeNull()
    expect(safeReturnPath(null)).toBeNull()
    expect(safeReturnPath('')).toBeNull()
  })

  it('loginHref carries the destination so the link survives the detour', () => {
    expect(loginHref('/groups/g1')).toBe('/login?next=%2Fgroups%2Fg1')
    expect(loginHref('/groups/g1', '?x=1')).toBe('/login?next=%2Fgroups%2Fg1%3Fx%3D1')
    // Nothing worth returning to.
    expect(loginHref('/')).toBe('/login')
  })
})

describe('GroupPage — a shared link opened with no identity', () => {
  it('never calls the API, so the raw "X-User-Id header is required" can not surface', async () => {
    // /api/tag-vocab is public and unguarded — it may fire. The group
    // endpoints are the ones that must not be touched without an identity.
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response)
    vi.stubGlobal('fetch', fetchMock)

    render(<GroupPage />)

    expect(await screen.findByText('Sign in to view this group')).toBeInTheDocument()
    // The regression: the old code fetched anyway and rendered the 400 body.
    expect(screen.queryByText(/X-User-Id/)).toBeNull()
    await waitFor(() => {
      const groupCalls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/groups/'))
      expect(groupCalls).toHaveLength(0)
    })
  })

  it('offers a way to get an identity rather than a dead end', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response))
    render(<GroupPage />)

    // DEMO_PICKER_ENABLED is true in this env, so it points at the picker.
    const cta = await screen.findByText('Pick a demo user')
    expect(cta.closest('a')).toHaveAttribute('href', '/find')
  })
})
