import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import FindPage from '../page'

// A real Firebase-authenticated user (no dev picker) — the "Signed in as"
// line must show the anonymized handle, never the real displayName/email.
// See features/ui-changes-1 follow-up.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'real-uid-1', displayName: 'Real Name', email: 'real@example.com' }, loading: false, signOut: vi.fn() }),
}))
vi.mock('@/lib/activeUser', () => ({
  getActiveUser: vi.fn(() => ''),
  setActiveUser: vi.fn(),
  userHeaders: vi.fn((h?: Record<string, string>) => h || {}),
  DEMO_PICKER_ENABLED: false,
}))
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }))

beforeEach(() => {
  global.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/profile')) return { ok: true, status: 200, json: async () => ({ username: 'wise-harbor-2203' }) } as Response
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
})

describe('FindPage identity (never leaks real name/email — features/ui-changes-1)', () => {
  it('shows the anonymized handle from /api/profile, not Firebase displayName/email', async () => {
    render(<FindPage />)
    expect(await screen.findByText(/Signed in as wise-harbor-2203/)).toBeInTheDocument()
    expect(screen.queryByText(/Real Name/)).not.toBeInTheDocument()
    expect(screen.queryByText(/real@example\.com/)).not.toBeInTheDocument()
  })
})

// Reported live: a real (non-demo-picker) user created a group, navigated
// back to the Groups tab (the default landing tab), and it looked like the
// group had vanished. Root cause: the groups-list effect gated on `activeId`
// — a state variable only ever set by the DEV demo-picker (off in prod) —
// so for a real Firebase-authenticated user the list was simply never
// fetched at all, not empty.
describe('FindPage — groups list loads for a real (non-demo) user', () => {
  it('fetches /api/groups/all on the default "Groups" tab without any demo-picker interaction', async () => {
    render(<FindPage />)
    await screen.findByText(/Signed in as wise-harbor-2203/)

    await waitFor(() => {
      const calledGroupsAll = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
        .some(([url]) => String(url).includes('/api/groups/all'))
      expect(calledGroupsAll).toBe(true)
    })
  })
})
