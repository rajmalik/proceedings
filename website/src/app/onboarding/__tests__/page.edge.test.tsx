import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import OnboardingPage from '../page'

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, loading: false, signOut: vi.fn() }) }))
vi.mock('@/lib/activeUser', () => ({
  getActiveUser: vi.fn(() => 'demo-arjun'),
  setActiveUser: vi.fn(),
  userHeaders: vi.fn((h?: Record<string, string>) => h || {}),
  DEMO_PICKER_ENABLED: true,
}))
vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(), useRouter: () => ({ push: vi.fn() }) }))

const VOCAB = {
  visa: ['H-1B', 'EB-2'], consulate: ['BOM', 'IN'],
  consulate_options: [{ code: 'BOM', label: 'Mumbai, India (BOM)' }, { code: 'IN', label: 'India (IN)' }],
  consulate_tree: [{ country: 'India', country_code: 'IN', cities: [{ code: 'BOM', city: 'Mumbai' }] }],
  tag: [], stage_key: [], date_key: ['h1b_filed_date'],
  outcome: ['filed', 'approved'], country: ['IN'],
  misc: ['NIW', 'premium-processing'],
  misc_options: [
    { code: 'NIW', label: 'NIW — National Interest Waiver' },
    { code: 'premium-processing', label: 'premium-processing — Premium Processing' },
  ],
  profile_stage_key: ['outcome_status', 'I-485'],
  stage_value_domains: { outcome_status: 'outcome', 'I-485': 'outcome' },
}
const PROFILE = {
  username: 'arjun-h1b', current_visa_or_greencard_category: ['H-1B'], visa_applying_for: [],
  primary_consulate: 'BOM', consulates: ['BOM'], tags: ['NIW'],
  key_stages_or_info: {}, key_dates: {}, background_text: 'on H-1B', journey: [],
  updated_at: '2026-06-01T00:00:00Z',
}

function mockApi(opts: { vocabFails?: boolean } = {}) {
  global.fetch = vi.fn(async (url: string) => {
    const u = String(url)
    if (u.includes('/api/users')) return { ok: true, status: 200, json: async () => [{ id: 'demo-arjun', username: 'arjun-h1b', label: 'Arjun' }] } as Response
    if (u.includes('/api/tag-vocab')) {
      if (opts.vocabFails) return { ok: false, status: 503, json: async () => ({ detail: 'down' }) } as Response
      return { ok: true, status: 200, json: async () => VOCAB } as Response
    }
    if (u.includes('/api/profile')) return { ok: true, status: 200, json: async () => PROFILE } as Response
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

describe('OnboardingPage — edge cases', () => {
  beforeEach(() => mockApi())

  it('does not add a duplicate tag', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    expect(screen.getAllByText('NIW')).toHaveLength(1)  // one chip on load
    const input = screen.getByPlaceholderText('Add miscellaneous tags and topics…')
    fireEvent.change(input, { target: { value: 'NIW — National Interest Waiver' } })  // already present
    expect(screen.getAllByText('NIW')).toHaveLength(1)  // still one — no duplicate
  })

  it('rejects a tag value not in the vocabulary', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    const input = screen.getByPlaceholderText('Add miscellaneous tags and topics…')
    fireEvent.keyDown(input, { key: 'Enter', target: { value: 'totally-made-up' } })
    expect(await screen.findByText(/pick a tag from the list/i)).toBeInTheDocument()
  })

  it('adds a key-date pair (date key + date value)', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    fireEvent.change(screen.getByPlaceholderText('date key'), { target: { value: 'h1b_filed_date' } })
    const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement
    fireEvent.change(dateInput, { target: { value: '2026-10-01' } })
    const addButtons = screen.getAllByText('Add')
    fireEvent.click(addButtons[addButtons.length - 1])  // the key-dates "Add" (after key-stages)
    expect(await screen.findByText('h1b_filed_date: 2026-10-01')).toBeInTheDocument()
  })

  it('two-part consulate picker: country then a city dropdown (code-mapped, no dup)', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    // 1) type-to-filter the country, then 2) pick a city from the fixed dropdown.
    fireEvent.change(screen.getByPlaceholderText('Type a country…'), { target: { value: 'India (IN)' } })
    const citySelect = document.querySelector('select') as HTMLSelectElement
    fireEvent.change(citySelect, { target: { value: 'BOM' } })  // city code
    // BOM already present from PROFILE; adding it again must not create a 2nd chip
    expect(screen.getAllByText('Mumbai, India (BOM)')).toHaveLength(1)
  })

  it('two-part consulate picker: a country can be added on its own (country-wide)', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    fireEvent.change(screen.getByPlaceholderText('Type a country…'), { target: { value: 'India (IN)' } })
    fireEvent.click(screen.getByText(/Add India \(country-wide\)/))
    expect(await screen.findByText('India (IN)')).toBeInTheDocument()  // stored as the country code IN
  })

  it('still renders the profile when /api/tag-vocab fails', async () => {
    mockApi({ vocabFails: true })
    render(<OnboardingPage />)
    expect(await screen.findByText('H-1B')).toBeInTheDocument()  // profile renders; vocab just empty
    expect(screen.getByRole('heading', { name: 'Your profile' })).toBeInTheDocument()
  })
})
