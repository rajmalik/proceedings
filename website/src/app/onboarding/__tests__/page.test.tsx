import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
  visa: ['H-1B', 'EB-2', 'F-1'], consulate: ['BOM'],
  consulate_options: [{ code: 'BOM', label: 'Mumbai, India (BOM)' }],
  tag: [], stage_key: [], date_key: ['h1b_filed_date'],
  outcome: ['filed', 'approved', 'received', 'RFE'], country: ['IN', 'US'],
  misc: ['NIW', 'premium-processing'],
  misc_options: [
    { code: 'NIW', label: 'NIW — National Interest Waiver' },
    { code: 'premium-processing', label: 'premium-processing — Premium Processing' },
  ],
  profile_stage_key: ['citizen_of_country', 'outcome_status', 'I-485'],
  stage_value_domains: { citizen_of_country: 'country', outcome_status: 'outcome', 'I-485': 'outcome' },
}
const PROFILE = {
  username: 'arjun-h1b',
  current_visa_or_greencard_category: ['H-1B'], visa_applying_for: [],
  primary_consulate: 'BOM', consulates: ['BOM'], tags: ['NIW'],
  key_stages_or_info: { citizen_of_country: 'IN' }, key_dates: {},
  background_text: 'On H-1B from India; EB-2 PERM in progress.',
  journey: [], updated_at: '2026-06-01T00:00:00Z',  // already onboarded
}

let onboardBody: { stage?: string; messages?: { content: string }[] } | null = null
let createdBody: { username?: string } | null = null
function mockApi() {
  onboardBody = null; createdBody = null
  global.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
    const u = String(url); const method = opts?.method || 'GET'
    if (u.includes('/api/users') && method === 'POST') {
      createdBody = JSON.parse(opts!.body as string)
      return { ok: true, status: 200, json: async () => ({ id: 'new-abc123', username: 'Tester', label: '🆕 Tester' }) } as Response
    }
    if (u.includes('/api/users')) return { ok: true, status: 200, json: async () => [{ id: 'demo-arjun', username: 'arjun-h1b', label: 'Arjun' }] } as Response
    if (u.includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
    if (u.includes('/api/onboard') && method === 'POST') {
      onboardBody = JSON.parse(opts!.body as string)
      return { ok: true, status: 200, json: async () => ({ reply: 'Updated your tags.', profile: { ...PROFILE, visa_applying_for: ['EB-2'] }, done: false }) } as Response
    }
    if (u.includes('/api/profile')) return { ok: true, status: 200, json: async () => PROFILE } as Response
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
}

beforeEach(() => mockApi())

describe('OnboardingPage (consolidated profile)', () => {
  it('loads the saved profile and greets a returning user', async () => {
    render(<OnboardingPage />)
    expect(await screen.findByText('H-1B')).toBeInTheDocument()                  // current-status tag chip (right panel)
    expect(screen.getByDisplayValue(/EB-2 PERM in progress/)).toBeInTheDocument() // background prefilled (left panel)
    expect(screen.getByText(/Welcome back/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Your profile' })).toBeInTheDocument()
    expect(screen.getByText('citizen_of_country: IN')).toBeInTheDocument()        // key-stage chip shown
    expect(screen.getByText('NIW')).toBeInTheDocument()                           // miscellaneous tag chip shown
  })

  it('adds a miscellaneous tag from the dropdown (selected by its description label)', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    const input = screen.getByPlaceholderText('Add miscellaneous tags and topics…')
    fireEvent.change(input, { target: { value: 'premium-processing — Premium Processing' } })  // datalist label
    expect(await screen.findByText('premium-processing')).toBeInTheDocument()                   // stored as the code
  })

  it('treats a FORM key (I-485) as taking an outcome value', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    fireEvent.change(screen.getByPlaceholderText('stage key'), { target: { value: 'I-485' } })
    const valInput = screen.getByPlaceholderText('outcome value…')  // form key -> outcome domain
    fireEvent.change(valInput, { target: { value: 'banana' } })       // not an outcome
    fireEvent.keyDown(valInput, { key: 'Enter' })
    expect(await screen.findByText(/not a valid value for "I-485"/i)).toBeInTheDocument()
    fireEvent.change(valInput, { target: { value: 'filed' } })        // 'filed' is now a valid outcome
    fireEvent.keyDown(valInput, { key: 'Enter' })
    expect(await screen.findByText('I-485: filed')).toBeInTheDocument()
  })

  it('creates a new user from the "New user…" dropdown option', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('Tester')
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    const userSelect = screen.getAllByRole('combobox')[0]  // the demo-user picker (first combobox)
    fireEvent.change(userSelect, { target: { value: '__new__' } })
    await waitFor(() => expect(createdBody).not.toBeNull())
    expect(createdBody?.username).toBe('Tester')
    expect(await screen.findByRole('option', { name: '🆕 Tester' })).toBeInTheDocument()
  })

  it('constrains a key-stage value to the key’s domain', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    fireEvent.change(screen.getByPlaceholderText('stage key'), { target: { value: 'outcome_status' } })
    const valInput = screen.getByPlaceholderText('outcome value…')
    fireEvent.change(valInput, { target: { value: 'banana' } })
    fireEvent.keyDown(valInput, { key: 'Enter' })
    expect(await screen.findByText(/not a valid value for "outcome_status"/i)).toBeInTheDocument()
    fireEvent.change(valInput, { target: { value: 'approved' } })
    fireEvent.keyDown(valInput, { key: 'Enter' })
    expect(await screen.findByText('outcome_status: approved')).toBeInTheDocument()
  })

  it('re-generates tags from the background text via /api/onboard', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    fireEvent.click(screen.getByRole('button', { name: /Re-generate tags/ }))
    await waitFor(() => expect(onboardBody).not.toBeNull())
    expect(onboardBody?.stage).toBe('basics')
    expect(onboardBody?.messages?.[0].content).toMatch(/EB-2 PERM/)
    expect(await screen.findByText('EB-2')).toBeInTheDocument()
    expect(screen.getByText(/Tags updated from your background/)).toBeInTheDocument()
  })

  it('auto-adds a valid tag selected from the dropdown', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    const input = screen.getByPlaceholderText('Add applying for…')
    fireEvent.change(input, { target: { value: 'EB-2' } })   // simulates a datalist selection
    expect(await screen.findByText('EB-2')).toBeInTheDocument()
  })

  it('rejects an out-of-vocabulary tag', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    const input = screen.getByPlaceholderText('Add applying for…')
    fireEvent.keyDown(input, { key: 'Enter', target: { value: 'NOPE' } })
    expect(await screen.findByText(/is not a valid visa/i)).toBeInTheDocument()
  })

  it('removes a tag chip', async () => {
    render(<OnboardingPage />)
    await screen.findByText('H-1B')
    fireEvent.click(screen.getByLabelText('Remove H-1B'))
    await waitFor(() => expect(screen.queryByText('H-1B')).not.toBeInTheDocument())
  })
})
