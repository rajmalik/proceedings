import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import OnboardingPage from '../page'

// Production mode: no dev picker, a real Firebase-authenticated user. Prior
// to this fix, loadProfile() only ever fired via the dev-picker's `activeId`
// state — a real production user's existing profile silently never loaded
// on this page at all. See features/ui-changes-1 follow-up.
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { uid: 'real-uid-1', displayName: 'Real Name', email: 'real@example.com' }, loading: false, signOut: vi.fn() }),
}))
vi.mock('@/lib/activeUser', () => ({
  getActiveUser: vi.fn(() => ''),
  setActiveUser: vi.fn(),
  userHeaders: vi.fn((h?: Record<string, string>) => h || {}),
  DEMO_PICKER_ENABLED: false,
}))
vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }))

const VOCAB = {
  visa: ['H-1B'], consulate: [], consulate_options: [],
  tag: [], stage_key: [], date_key: [], outcome: [], country: [],
  misc: [], misc_options: [], profile_stage_key: [], stage_value_domains: {},
}
const PROFILE = {
  username: 'brave-maple-3272',
  current_visa_or_greencard_category: ['H-1B'], visa_applying_for: [],
  primary_consulate: '', consulates: [], tags: [],
  key_stages_or_info: {}, key_dates: {}, background_text: '', journey: [],
  updated_at: '2026-06-01T00:00:00Z',
}

beforeEach(() => {
  global.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
    if (u.includes('/api/profile')) return { ok: true, status: 200, json: async () => PROFILE } as Response
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
})

describe('OnboardingPage — production (no dev picker), real Firebase user', () => {
  it('loads the existing profile without the dev picker (activeId) ever being set', async () => {
    render(<OnboardingPage />)
    // H-1B only appears once the fetched PROFILE has actually landed in `draft` —
    // proves loadProfile() fired for a real authUser, not just the dev picker.
    expect(await screen.findByText('H-1B')).toBeInTheDocument()
  })

  it('shows the anonymized handle, never the real Firebase displayName/email', async () => {
    render(<OnboardingPage />)
    expect(await screen.findByText(/Signed in as brave-maple-3272/)).toBeInTheDocument()
    expect(screen.queryByText(/Real Name/)).not.toBeInTheDocument()
    expect(screen.queryByText(/real@example\.com/)).not.toBeInTheDocument()
  })
})
