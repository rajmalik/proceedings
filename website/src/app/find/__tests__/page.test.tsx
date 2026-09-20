import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import FindPage from '../page'

vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, loading: false, signOut: vi.fn() }) }))
vi.mock('@/lib/activeUser', () => ({
  getActiveUser: vi.fn(() => ''),
  setActiveUser: vi.fn(),
  userHeaders: vi.fn((h?: Record<string, string>) => h || {}),
  DEMO_PICKER_ENABLED: true,
}))
const push = vi.fn()
// searchParams is mutable so the deep-link tests can set ?type=timeline&…
const { sp } = vi.hoisted(() => ({ sp: { value: new URLSearchParams() } }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => sp.value, useRouter: () => ({ push }) }))

// The base period pair every Timeline scope leads with. The server resolves
// it onto each option before sending, so fixtures carry it the same way.
const PERIOD_ROWS = [
  { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
    options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
  { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
]

const VOCAB = {
  visa: ['H-1B', 'F-1'],
  consulate_options: [{ code: 'BOM', label: 'Mumbai, India (BOM)' }],
  tag: ['rfe-experience', 'timeline', 'stem-opt', 'stem-opt-extension'],
  tag_attribute_templates: {
    // Every scope gets the same Month + Year pair — there is no Cycle.
    'stem-opt-extension': [
      { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
        options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
      { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
    ],
    'H-1B': [
      { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
        options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
      { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
    ],
    // Non-OPT categories get a calendar Month instead of an academic Cycle.
    'h4-ead': [
      { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
        options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
      { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
    ],
  },
  post_join_attribute_templates: {
    'stem-opt-extension': [{ label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' }],
  },
  processing_types: [
    {
      value: 'EAD', label: 'EAD',
      eligibility_categories: [
        // These two carry no scope_rows on purpose — they exercise the
        // fallback to tag_attribute_templates that keeps a vocab payload
        // cached before the framework landed working.
        { code: '(c)(3)(C)', label: 'F-1 STEM OPT extension (24-month)', tag: 'stem-opt-extension' },
        { code: '(c)(26)', label: 'H-4 spouse of H-1B', tag: 'h4-ead' },
        // AOS resolves its rows server-side. Its priority date is a
        // per-member fact collected on JOIN, so it is NOT a scope row here.
        {
          code: '(c)(9)', label: 'Pending adjustment of status (I-485)', tag: 'adjustment-of-status',
          scope_rows: [
            { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
              options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
            { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
          ],
          post_join_rows: [
            { kind: 'date', label: 'Priority Date', field: 'key_dates', key: 'priority_date', required: false },
          ],
        },
        // No category configures an extra SCOPE row today; this one carries a
        // synthetic date row so the panel's date control and its key_dates
        // routing stay covered (mirrors the backend's M45).
        {
          code: '(c)(x)', label: 'Synthetic scope-extra category', tag: 'synthetic-scope-extra',
          scope_rows: [
            { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
              options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
            { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
            { kind: 'date', label: 'Receipt Date', field: 'key_dates', key: 'receipt_date', name_prefix: 'RD' },
          ],
        },
      ],
    },
    // H-1B's second dropdown is application types, not 8 CFR eligibility
    // categories, so it names its own heading.
    {
      value: 'H-1B', label: 'H-1B', category_label: 'Application type',
      // Each carries the period rows the server already resolved for it —
      // H-1B configures no scope extras, so all three get the base pair.
      eligibility_categories: [
        { code: 'CoS', label: 'Change of Status (initial, in the U.S.)', tag: 'change-of-status-COS', scope_rows: PERIOD_ROWS },
        { code: 'Consular', label: 'Consular processing / stamping (initial)', tag: 'h1b-stamping', scope_rows: PERIOD_ROWS },
        { code: 'COE', label: 'Change of employer (H-1B transfer)', tag: 'change-of-employer-COE', scope_rows: PERIOD_ROWS },
      ],
    },
    // A type that configures no categories at all — the second dropdown is
    // hidden entirely rather than rendered empty.
    { value: 'O-1', label: 'O-1', eligibility_categories: [] },
  ],
}

const GROUP = {
  group_id: 'g1', name: 'H-1B at BOM', group_type: '', criteria_text: 'looking for H-1B folks',
  members: [{ user_id: 'u1', username: 'alpha' }], score: 4.5,
}

const PREVIEW = { name: 'H-1B-change-of-status-COS-Mar-2026', description: 'Generated blurb.' }

function mockFetch(overrides: {
  search?: Record<string, unknown>; groups?: Record<string, unknown>
  browse?: Record<string, unknown>; preview?: Record<string, unknown>
} = {}) {
  const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
    const method = opts?.method || 'GET'
    if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
    if (String(url) === '/api/groups/preview' && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ...PREVIEW, ...overrides.preview }) } as Response
    }
    if (String(url).includes('/api/users')) {
      return { ok: true, status: 200, json: async () => [{ id: 'demo-arjun', username: 'arjun-h1b', label: 'Arjun' }] } as Response
    }
    if (String(url) === '/api/groups/all') return { ok: true, status: 200, json: async () => ({ groups: [], ...overrides.browse }) } as Response
    if (String(url) === '/api/groups/search' && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ groups: [GROUP], ...overrides.search }) } as Response
    }
    if (String(url) === '/api/groups' && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ group_id: 'new-g', ...overrides.groups }) } as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Opens the Find / create tab and selects a group type.
 *
 * The tab now DEFAULTS to Timeline, so the many Regular-centric tests below
 * have to opt in to Regular explicitly — hence the default arg. The default
 * itself is asserted separately (see "defaults to Timeline"), which is why
 * that test doesn't use this helper.
 */
function openFindTab(groupType: 'regular' | 'timeline' = 'regular') {
  fireEvent.click(screen.getByText('Find / create group'))
  fireEvent.click(screen.getByText(groupType === 'timeline' ? 'Timeline' : 'Regular'))
}

/**
 * Switches the find tab from SEARCH mode into CREATE mode. Group description,
 * validity and the Create button live only there now — the search view is
 * purely "what am I looking for".
 */
function enterCreateMode(groupType: 'regular' | 'timeline' = 'regular') {
  fireEvent.click(screen.getByText(`Create a ${groupType === 'timeline' ? 'Timeline' : 'Regular'} Group`))
}

beforeEach(() => {
  vi.restoreAllMocks()
  push.mockReset()
  sp.value = new URLSearchParams()
})

describe('FindPage — resilience to a bad /api/users response', () => {
  it('does NOT crash when /api/users returns an error object (non-array)', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false, status: 404, json: async () => ({ detail: 'Not Found' }),
    })) as unknown as typeof fetch

    render(<FindPage />)
    expect(await screen.findByText(/Find groups in the same boat/i)).toBeInTheDocument()
    expect(screen.queryAllByRole('option')).toHaveLength(0)
  })

  it('renders the persona options when /api/users returns a proper array', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => [{ id: 'demo-arjun', username: 'arjun-h1b', label: 'Arjun (H-1B)' }],
    })) as unknown as typeof fetch

    render(<FindPage />)
    expect(await screen.findByText(/Find groups in the same boat/i)).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Arjun (H-1B)' })).toBeInTheDocument()
  })
})

describe('FindPage — header visibility', () => {
  it('shows no category sections initially, only "+ Add" pills', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Current status')).toBeInTheDocument())
    expect(screen.queryByText('Current status')).toBeNull()
    expect(screen.getByText('+ Add Applying for')).toBeInTheDocument()
    expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument()
    expect(screen.getByText('+ Add Tags')).toBeInTheDocument()
  })

  it('"+ Add" reveals an empty section', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))
    expect(await screen.findByText('Tags')).toBeInTheDocument()
    expect(screen.getByText('None.')).toBeInTheDocument()
  })
})

describe('FindPage — manual tag add/remove', () => {
  it('picking a suggestion adds a chip', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))

    const input = await screen.findByPlaceholderText('Search tags…')
    fireEvent.change(input, { target: { value: 'timeline' } })
    fireEvent.click(await screen.findByText('timeline'))

    expect(screen.getByLabelText('Remove timeline')).toBeInTheDocument()
  })

  it('removes a tag', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))
    const input = await screen.findByPlaceholderText('Search tags…')
    fireEvent.change(input, { target: { value: 'timeline' } })
    fireEvent.click(await screen.findByText('timeline'))

    fireEvent.click(screen.getByLabelText('Remove timeline'))
    await waitFor(() => expect(screen.queryByText('Remove timeline')).toBeNull())
  })

  it('picks a consulate by its label, storing/displaying the resolved code', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Consulate(s)'))

    const input = await screen.findByPlaceholderText('Search a consulate (city/country)…')
    fireEvent.change(input, { target: { value: 'Mumbai' } })
    fireEvent.click(await screen.findByText('Mumbai, India (BOM)'))

    expect(screen.getByLabelText('Remove BOM')).toBeInTheDocument()
  })
})

describe('FindPage — Regular vs Timeline group type', () => {
  it('defaults to Timeline — the group type this product is organised around', async () => {
    mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByText('Timeline')).toHaveClass('pill-active'))
    expect(screen.getByText('Regular')).not.toHaveClass('pill-active')
    // Timeline is exact-match, so it has no precision threshold to tune.
    expect(screen.queryByText('Match precision')).toBeNull()
  })

  it('selecting Regular shows Match Precision', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab('regular')
    await waitFor(() => expect(screen.getByText('Match precision')).toBeInTheDocument())
    expect(screen.getByText('Regular')).toHaveClass('pill-active')
  })

  it('switching to Timeline hides Match Precision (exact match has no threshold)', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Match precision')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Timeline'))

    expect(screen.queryByText('Match precision')).toBeNull()
    expect(screen.getByText('Timeline')).toHaveClass('pill-active')
  })

  it('switching back to Regular restores Match Precision', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Match precision')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))
    expect(screen.queryByText('Match precision')).toBeNull()

    fireEvent.click(screen.getByText('Regular'))
    expect(screen.getByText('Match precision')).toBeInTheDocument()
  })
})

describe('FindPage — Search (group search, not candidate matching)', () => {
  it('Search calls POST /api/groups/search with criteria + group_type + precision + cutoff', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))
    const input = await screen.findByPlaceholderText('Search tags…')
    fireEvent.change(input, { target: { value: 'timeline' } })
    fireEvent.click(await screen.findByText('timeline'))

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.criteria.tags).toEqual(['timeline'])
    expect(body.group_type).toBe('')
    expect(body.precision).toBe('balanced')
    expect(body.max_age_days).toBe(0)
  })

  it('sends group_type="timeline" and omits precision from mattering when Timeline is selected', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.group_type).toBe('timeline')
  })

  it('moving the Cutoff slider changes max_age_days sent', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByLabelText('Cutoff period')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Cutoff period'), { target: { value: '2' } })

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.max_age_days).toBe(30)
  })

  it('renders matched groups inline with a Join button', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Search')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search'))

    expect(await screen.findByText('H-1B at BOM')).toBeInTheDocument()
    expect(screen.getByText('looking for H-1B folks')).toBeInTheDocument()
    expect(screen.getByText('Join')).toBeInTheDocument()
  })

  it('clicking Join on a Regular result calls /join and navigates into the group', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method || 'GET'
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).includes('/api/users')) return { ok: true, status: 200, json: async () => [] } as Response
      if (String(url) === '/api/groups/all') return { ok: true, status: 200, json: async () => ({ groups: [] }) } as Response
      if (String(url) === '/api/groups/search' && method === 'POST') return { ok: true, status: 200, json: async () => ({ groups: [GROUP] }) } as Response
      if (String(url).includes('/join')) return { ok: true, status: 200, json: async () => ({ group_id: 'g1' }) } as Response
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Search')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search'))
    await screen.findByText('H-1B at BOM')

    fireEvent.click(screen.getByText('Join'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/join'))
      expect(call).toBeTruthy()
    })
    await waitFor(() => expect(push).toHaveBeenCalledWith('/groups/g1'))
  })

  it('shows a View link (not Join) for a Timeline result — self-service join for Timeline always goes through the gated group page', async () => {
    const fetchMock = mockFetch({ search: { groups: [{ ...GROUP, group_id: 'tl1', name: 'STEM-OPT Fall 2026', group_type: 'timeline' }] } })
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))
    fireEvent.click(screen.getByText('Search'))

    await screen.findByText('STEM-OPT Fall 2026')
    expect(screen.queryByText('Join')).toBeNull()
    const viewLink = screen.getByText('View')
    expect(viewLink.getAttribute('href')).toBe('/groups/tl1')

    fireEvent.click(viewLink)
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/join'))).toBe(false)
  })

  it('shows an empty-results message pointing at Create a group', async () => {
    mockFetch({ search: { groups: [] } })
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Search')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search'))

    expect(await screen.findByText(/No existing.*group matched/)).toBeInTheDocument()
  })

  it('surfaces an error when /api/groups/search fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url) === '/api/groups/search') return { ok: false, status: 500, json: async () => ({ detail: 'Group search unavailable' }) } as Response
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Search')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search'))

    expect(await screen.findByText('Group search unavailable')).toBeInTheDocument()
  })
})

describe('FindPage — Create a group', () => {
  it('POSTs the panel criteria + group_type + description, then navigates to the new group', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab('timeline')
    await waitFor(() => expect(screen.getByText('Search criteria')).toBeInTheDocument())
    enterCreateMode('timeline')

    fireEvent.change(screen.getByLabelText('Group description'), { target: { value: 'Fall cohort' } })
    fireEvent.click(screen.getByText('Create a Timeline group'))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/groups/new-g'))
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups' && (c[1] as { method?: string })?.method === 'POST')!
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.group_type).toBe('timeline')
    expect(body.description).toBe('Fall cohort')
  })

  it('does not send a group description for Regular groups', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab('regular')
    await waitFor(() => expect(screen.getByText('Search criteria')).toBeInTheDocument())
    enterCreateMode('regular')

    // The description box is Timeline-only.
    expect(screen.queryByLabelText('Group description')).toBeNull()
    fireEvent.click(screen.getByText('Create a group'))

    await waitFor(() => expect(push).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups' && (c[1] as { method?: string })?.method === 'POST')!
    expect(JSON.parse((call[1] as { body: string }).body).description).toBe('')
  })

  it('never asks for the post-join attributes — those belong to joining', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab('timeline')
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'stem-opt-extension' } })

    // Not in search mode... (the heading over Month/Year reads "Date
    // Applied" too, so this asserts on the post-join CONTROL, not the text.)
    expect(screen.queryByLabelText('Date Applied')).toBeNull()
    enterCreateMode('timeline')
    // ...and not in create mode either.
    expect(screen.queryByLabelText('Date Applied')).toBeNull()

    // Create is therefore never gated on them.
    const btn = screen.getByText('Create a Timeline group')
    expect(btn.closest('button')).not.toBeDisabled()
    fireEvent.click(btn)

    await waitFor(() => expect(push).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups' && (c[1] as { method?: string })?.method === 'POST')!
    expect(JSON.parse((call[1] as { body: string }).body).values).toBeUndefined()
  })
})

describe('FindPage — Timeline-only panel shape', () => {
  it('Regular shows Cutoff period and Consulate(s); Timeline shows neither', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByLabelText('Cutoff period')).toBeInTheDocument())
    expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Timeline'))

    expect(screen.queryByLabelText('Cutoff period')).toBeNull()
    expect(screen.queryByText('+ Add Consulate(s)')).toBeNull()
  })

  it('switching back to Regular restores Cutoff and Consulate(s)', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByLabelText('Cutoff period')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))
    expect(screen.queryByLabelText('Cutoff period')).toBeNull()

    fireEvent.click(screen.getByText('Regular'))

    expect(screen.getByLabelText('Cutoff period')).toBeInTheDocument()
    expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument()
  })

  it('a Timeline search never sends consulates, even if one was picked while on Regular', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Consulate(s)'))
    const input = await screen.findByPlaceholderText('Search a consulate (city/country)…')
    fireEvent.change(input, { target: { value: 'Mumbai' } })
    fireEvent.click(await screen.findByText('Mumbai, India (BOM)'))

    fireEvent.click(screen.getByText('Timeline'))
    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.criteria.consulates).toEqual([])
  })
})

describe('FindPage — Status facts / Key dates / Tags entry removed from the Timeline panel', () => {
  it('no manual stage-key / date-key inputs render for Timeline', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))

    expect(screen.queryByPlaceholderText('stage key')).toBeNull()
    expect(screen.queryByPlaceholderText('date key')).toBeNull()
    expect(screen.queryByText('Status facts')).toBeNull()
    expect(screen.queryByText('Key dates')).toBeNull()
  })

  it('Tags category is hidden for Timeline (Processing type is the only tag entry point)', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Timeline'))

    expect(screen.queryByText('+ Add Tags')).toBeNull()
    expect(screen.queryByPlaceholderText('Search tags…')).toBeNull()
  })

  it('switching back to Regular restores the Tags category', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))
    expect(screen.queryByText('+ Add Tags')).toBeNull()

    fireEvent.click(screen.getByText('Regular'))

    expect(screen.getByText('+ Add Tags')).toBeInTheDocument()
  })
})

describe('FindPage — Processing type dropdown + Month/Year', () => {
  /**
   * Picks a processing type, and — when the caller names an eligibility tag
   * rather than a type — picks EAD first and then that category in the second
   * dropdown. Month/Year hang off the ELIGIBILITY category now, not the type.
   */
  // Pass a processing type to pick just the first dropdown, or a category tag
  // to pick its owning type and then the category. The second dropdown's
  // heading is per-type, so it's looked up rather than hardcoded.
  function selectProcessingType(value: string) {
    const owner = VOCAB.processing_types.find(
      (t) => t.eligibility_categories?.some((c) => c.tag === value))
    fireEvent.change(screen.getByLabelText('Processing type'),
                     { target: { value: owner ? owner.value : value } })
    if (owner) {
      fireEvent.change(screen.getByLabelText(owner.category_label || 'Eligibility category'),
                       { target: { value } })
    }
  }

  it('shows the Processing type dropdown for Timeline only, listing registered TYPES (EAD, not the raw tag)', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    expect(screen.queryByLabelText('Processing type')).toBeNull()

    fireEvent.click(screen.getByText('Timeline'))

    const select = screen.getByLabelText('Processing type') as HTMLSelectElement
    const values = Array.from(select.querySelectorAll('option')).map((o) => (o as HTMLOptionElement).value)
    expect(values).toEqual(['', 'EAD', 'H-1B', 'O-1'])
    // The old dropdown showed the raw action tag; "EAD" is the filing.
    expect(select.textContent).not.toContain('stem-opt-extension')
  })

  it('picking stem-opt-extension reveals Month/Year (Tags category itself is hidden for Timeline)', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))

    selectProcessingType('stem-opt-extension')

    expect(await screen.findByText('Month')).toBeInTheDocument()
    expect(screen.getByText('Year')).toBeInTheDocument()
    // The post-join attributes are NOT here — they moved to the group page's
    // join gate. Searching for a cohort never asks about your own case.
    // (The heading over Month/Year is also "Date Applied", hence byLabelText.)
    expect(screen.queryByLabelText('Date Applied')).toBeNull()

    // BOTH picks land in criteria.tags even though no chip is rendered — the
    // processing type and the eligibility category under it. The pair is what
    // the group gets named after (EAD-stem-opt-extension-Fall-2026).
    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')).toBeTruthy())
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.criteria.tags).toEqual(['EAD', 'stem-opt-extension'])
  })

  it('picking H-1B lands it in current_visa_or_greencard_category (visa vocab, not a generic tag) — no Current status category renders (hidden for Timeline)', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))

    selectProcessingType('H-1B')

    expect(screen.queryByText('Current status')).toBeNull()
    // H-1B now has application types, so — exactly like EAD — the period
    // fields wait for the second dropdown rather than appearing at once.
    expect(screen.queryByText('Month')).toBeNull()
    selectProcessingType('change-of-status-COS')
    expect(await screen.findByText('Month')).toBeInTheDocument()
    expect(screen.getByText('Year')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')).toBeTruthy())
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const body = JSON.parse((call[1] as { body: string }).body)
    // The type is visa vocabulary so it goes to the visa field; the
    // application type is a plain tag, so it goes to tags. Both together are
    // what the group gets named after.
    expect(body.criteria.current_visa_or_greencard_category).toEqual(['H-1B'])
    expect(body.criteria.tags).toEqual(['change-of-status-COS'])
  })

  it('switching Processing type removes the previous selection and adds the new one', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))
    selectProcessingType('stem-opt-extension')
    await screen.findByText('Month')

    selectProcessingType('H-1B')

    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')).toBeTruthy())
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const body = JSON.parse((call[1] as { body: string }).body)
    // EAD *and* its category are both gone — switching the first dropdown
    // must not leave the old pair's second half behind.
    expect(body.criteria.tags).toEqual([])
    expect(body.criteria.current_visa_or_greencard_category).toEqual(['H-1B'])
  })

  it('does not appear for Regular groups', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())

    expect(screen.queryByLabelText('Processing type')).toBeNull()
  })

  it('picking a Month option sticks (writes into key_stages_or_info) and is sent on Search', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))
    selectProcessingType('stem-opt-extension')
    await screen.findByText('Month')

    const monthSelect = screen.getByLabelText('Month') as HTMLSelectElement
    fireEvent.change(monthSelect, { target: { value: 'Sep' } })

    expect(monthSelect.value).toBe('Sep')
    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')).toBeTruthy())
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const body = JSON.parse((call[1] as { body: string }).body)
    expect(body.criteria.key_stages_or_info.filing_month).toBe('Sep')
  })

  it('the Year dropdown spans the last 5 years through next year', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))
    selectProcessingType('stem-opt-extension')
    await screen.findByText('Year')

    const row = screen.getByText('Year').closest('div')!
    const yearSelect = row.querySelector('select')!
    const values = Array.from(yearSelect.querySelectorAll('option')).map((o) => o.textContent)
    const thisYear = new Date().getFullYear()
    expect(values).toEqual(['—', ...Array.from({ length: 7 }, (_, i) => String(thisYear - 5 + i))])
  })

  it('clearing Processing type back to blank removes the tag and hides Month/Year', async () => {
    mockFetch()
    render(<FindPage />)
    openFindTab()
    await waitFor(() => expect(screen.getByText('Timeline')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Timeline'))
    selectProcessingType('stem-opt-extension')
    await screen.findByText('Month')

    selectProcessingType('')

    await waitFor(() => expect(screen.queryByText('Month')).toBeNull())
    expect(screen.queryByText('Year')).toBeNull()
  })
})

describe('FindPage — Your groups / All groups panels', () => {
  const OPEN_TIMELINE = {
    group_id: 'open-tl', name: 'Immigration', description: 'Fall 2026 cohort', group_type: 'timeline',
    criteria_text: '', criteria_tags: { tags: ['stem-opt-extension'], current_visa_or_greencard_category: [] },
    members: [{ user_id: 'u9', username: 'zeta' }], is_member: false,
    status: 'active', expiration_date: '', created_by: 'u9', created_by_username: 'zeta', created_at: '',
  }
  const OPEN_REGULAR = {
    group_id: 'open-reg', name: 'H-1B → EB-2', description: '', group_type: '',
    criteria_text: '', criteria_tags: { current_visa_or_greencard_category: ['H-1B'], visa_applying_for: ['EB-2'], consulates: ['BOM'] },
    members: [{ user_id: 'u8', username: 'eta' }], is_member: false,
    status: 'active', expiration_date: '', created_by: 'u8', created_by_username: 'eta', created_at: '',
  }
  const JOINED = {
    group_id: 'mine', name: 'My group', description: '', group_type: '', criteria_text: '', criteria_tags: {},
    members: [{ user_id: 'demo-arjun', username: 'arjun' }], is_member: true,
    status: 'active', expiration_date: '', created_by: 'demo-arjun', created_by_username: 'arjun', created_at: '',
  }

  it('the two panels partition the groups — a joined group is never listed twice', async () => {
    mockFetch({ browse: { groups: [OPEN_REGULAR, JOINED] } })
    render(<FindPage />)

    await screen.findByText('All groups')
    const yourGroups = screen.getByText('Your groups').closest('div') as HTMLElement
    expect(within(yourGroups).getByText('My group')).toBeInTheDocument()
    expect(within(yourGroups).queryByText('H-1B → EB-2')).not.toBeInTheDocument()

    const allGroups = screen.getByText('All groups').closest('div') as HTMLElement
    expect(within(allGroups).getByText('H-1B → EB-2')).toBeInTheDocument()
    expect(within(allGroups).queryByText('My group')).not.toBeInTheDocument()
    expect(within(allGroups).getByText('H-1B · EB-2 · BOM')).toBeInTheDocument()
  })

  it('"All groups" says so when the only groups that exist are ones you have joined', async () => {
    mockFetch({ browse: { groups: [JOINED] } })
    render(<FindPage />)

    await screen.findByText('All groups')
    const allGroups = screen.getByText('All groups').closest('div') as HTMLElement
    expect(within(allGroups).getByText(/joined every group there is/)).toBeInTheDocument()
    expect(within(allGroups).queryByText(/be the first to create one/)).not.toBeInTheDocument()
  })

  it('shows a Timeline badge for a Timeline group, and its description', async () => {
    mockFetch({ browse: { groups: [OPEN_TIMELINE] } })
    render(<FindPage />)

    await screen.findByText('Immigration')
    expect(screen.getByText('Timeline')).toBeInTheDocument()
    expect(screen.getByText('Fall 2026 cohort')).toBeInTheDocument()
    expect(screen.getByText('stem-opt-extension')).toBeInTheDocument()
  })

  it('shows a Regular badge for a non-Timeline group', async () => {
    mockFetch({ browse: { groups: [OPEN_REGULAR] } })
    render(<FindPage />)

    await screen.findByText('H-1B → EB-2')
    expect(screen.getAllByText('Regular').length).toBeGreaterThan(0)
  })

  it('links to the group page (View) — no Join button on the browse card', async () => {
    mockFetch({ browse: { groups: [OPEN_TIMELINE] } })
    render(<FindPage />)

    await screen.findByText('Immigration')
    const viewLink = screen.getByText('View').closest('a')
    expect(viewLink).toHaveAttribute('href', '/groups/open-tl')
  })

  it('shows an empty-state message in "Your groups" when the user has not joined anything', async () => {
    mockFetch({ browse: { groups: [OPEN_REGULAR] } })
    render(<FindPage />)

    expect(await screen.findByText(/haven.t joined any group yet/)).toBeInTheDocument()
  })

  it('the "Create Group" button (above the panels) switches to the Find / create tab', async () => {
    mockFetch({ browse: { groups: [] } })
    render(<FindPage />)

    await screen.findByText('All groups')
    fireEvent.click(screen.getByText('Create Group'))
    expect(await screen.findByText('Search criteria')).toBeInTheDocument()
  })
})

describe('FindPage — pending invitations (Groups tab)', () => {
  const INVITED_GROUP = {
    group_id: 'inv-g', name: 'EAD filers 2026', description: '', group_type: '',
    criteria_text: '', criteria_tags: {}, members: [{ user_id: 'u7', username: 'theta' }],
    is_member: false, is_invited: true,
    status: 'active', expiration_date: '', created_by: 'u7', created_by_username: 'theta', created_at: '',
  }
  const INVITATION = {
    invitation_id: 'inv-g__demo-arjun', group_id: 'inv-g', user_id: 'demo-arjun',
    username: 'arjun-h1b', invited_by: 'u7', invited_by_username: 'theta',
    status: 'pending', requires_attributes: false,
  }

  /**
   * Browse tab with one pending invitation waiting. Stateful: once it's
   * answered the backend stops returning it, so the post-accept refetch
   * doesn't resurrect the row the way a fixed fixture would.
   */
  function mockInvited(invitation: Record<string, unknown> = INVITATION) {
    let answered = false
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).includes('/api/users')) {
        return { ok: true, status: 200, json: async () => [{ id: 'demo-arjun', username: 'arjun-h1b', label: 'Arjun' }] } as Response
      }
      if (String(url).includes('/invitations/accept') || String(url).includes('/invitations/decline')) {
        answered = true
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
      }
      if (String(url) === '/api/groups/invitations') {
        return {
          ok: true, status: 200,
          json: async () => ({ invitations: answered ? [] : [{ invitation, group: INVITED_GROUP }] }),
        } as Response
      }
      if (String(url) === '/api/groups/all') {
        return { ok: true, status: 200, json: async () => ({ groups: [INVITED_GROUP] }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('lists the invitation with who sent it', async () => {
    mockInvited()
    render(<FindPage />)

    const section = await screen.findByTestId('pending-invitations')
    expect(within(section).getByText(/Pending invitations \(1\)/)).toBeInTheDocument()
    expect(within(section).getByText('EAD filers 2026')).toBeInTheDocument()
    expect(within(section).getByText(/Invited by theta/)).toBeInTheDocument()
  })

  it('shows nothing when there are no invitations', async () => {
    mockFetch({ browse: { groups: [] } })
    render(<FindPage />)

    await screen.findByText('All groups')
    expect(screen.queryByTestId('pending-invitations')).toBeNull()
  })

  it('Accept POSTs to /invitations/accept and drops the row', async () => {
    const f = mockInvited()
    render(<FindPage />)

    const section = await screen.findByTestId('pending-invitations')
    fireEvent.click(within(section).getByText('Accept'))

    await waitFor(() => {
      expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
        (c) => String(c[0]) === '/api/groups/inv-g/invitations/accept' && (c[1] as { method?: string })?.method === 'POST',
      )).toBe(true)
    })
    await waitFor(() => expect(screen.queryByTestId('pending-invitations')).toBeNull())
  })

  it('Decline POSTs to /invitations/decline and drops the row', async () => {
    const f = mockInvited()
    render(<FindPage />)

    const section = await screen.findByTestId('pending-invitations')
    fireEvent.click(within(section).getByText('Decline'))

    await waitFor(() => {
      expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
        (c) => String(c[0]) === '/api/groups/inv-g/invitations/decline',
      )).toBe(true)
    })
    await waitFor(() => expect(screen.queryByTestId('pending-invitations')).toBeNull())
  })

  it('routes to the group page instead of accepting in place when attributes are required', async () => {
    const f = mockInvited({ ...INVITATION, requires_attributes: true })
    render(<FindPage />)

    const section = await screen.findByTestId('pending-invitations')
    expect(within(section).getByText(/asks for a few dates first/)).toBeInTheDocument()
    fireEvent.click(within(section).getByText('Accept'))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/groups/inv-g'))
    // The form lives on the group page — accepting blind would just 422.
    expect((f as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
      (c) => String(c[0]).includes('/invitations/accept'),
    )).toBe(false)
  })

  it('offers no Join on a browse card the user has already been invited to', async () => {
    mockInvited()
    render(<FindPage />)

    await screen.findByText('All groups')
    expect(screen.getByText('Invited')).toBeInTheDocument()
    expect(screen.queryByText('Join')).toBeNull()
  })
})

describe('FindPage — EAD processing type + eligibility category', () => {
  function openTimeline() {
    mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    fireEvent.click(screen.getByText('Timeline'))
  }

  it('the eligibility dropdown appears only after EAD is picked, and lists our TAGS', async () => {
    openTimeline()
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())
    expect(screen.queryByLabelText('Eligibility category')).toBeNull()

    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })

    const sel = screen.getByLabelText('Eligibility category') as HTMLSelectElement
    expect([...sel.options].map((o) => o.value))
      .toEqual(['', 'stem-opt-extension', 'h4-ead', 'adjustment-of-status', 'synthetic-scope-extra'])
    // The visible text is the TAG — what the group is named after and what a
    // posting carries — not the CFR label.
    expect([...sel.options].map((o) => o.text))
      .toEqual(['Select…', 'stem-opt-extension', 'h4-ead', 'adjustment-of-status', 'synthetic-scope-extra'])
    expect(sel.textContent).not.toContain('(c)(3)(C)')
    // The CFR mapping survives as a tooltip for anyone who needs it.
    expect([...sel.options][1].title).toBe('F-1 STEM OPT extension (24-month) · (c)(3)(C)')
  })

  it('a type that configures no categories gets no second dropdown at all', async () => {
    openTimeline()
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'O-1' } })
    expect(screen.queryByLabelText('Eligibility category')).toBeNull()
    expect(screen.queryByLabelText('Application type')).toBeNull()
  })

  it("the second dropdown is titled by the type's own category_label", async () => {
    openTimeline()
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'H-1B' } })
    // H-1B's list is application types — calling it "Eligibility category"
    // would be EAD's framing borrowed for something it doesn't describe.
    expect(screen.queryByLabelText('Eligibility category')).toBeNull()
    const sel = screen.getByLabelText('Application type') as HTMLSelectElement
    expect([...sel.options].map((o) => o.value))
      .toEqual(['', 'change-of-status-COS', 'h1b-stamping', 'change-of-employer-COE'])

    // EAD keeps the default heading, so the label really is per-type.
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    expect(screen.getByLabelText('Eligibility category')).toBeInTheDocument()
    expect(screen.queryByLabelText('Application type')).toBeNull()
  })

  it('the period fields appear only once an eligibility category is picked', async () => {
    openTimeline()
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })

    // EAD alone — no category picked yet, so no period fields.
    expect(screen.queryByLabelText('Month')).toBeNull()

    // Picking one reveals them.
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'stem-opt-extension' } })
    expect(await screen.findByLabelText('Month')).toBeInTheDocument()
    expect(screen.getByLabelText('Year')).toBeInTheDocument()
  })

  it('switching the eligibility category swaps the tag and clears Month/Year', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    fireEvent.click(screen.getByText('Timeline'))
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'stem-opt-extension' } })
    fireEvent.change(await screen.findByLabelText('Month'), { target: { value: 'Sep' } })

    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'h4-ead' } })

    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')).toBeTruthy())
    const body = JSON.parse((fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')![1] as { body: string }).body)
    expect(body.criteria.tags).toEqual(['EAD', 'h4-ead'])
    // The old Cycle must not survive onto a category that has no cycle.
    expect(body.criteria.key_stages_or_info).toEqual({})
  })

  it('clearing the processing type clears the eligibility category with it', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    fireEvent.click(screen.getByText('Timeline'))
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'stem-opt-extension' } })
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: '' } })

    expect(screen.queryByLabelText('Eligibility category')).toBeNull()
    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')).toBeTruthy())
    const body = JSON.parse((fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')![1] as { body: string }).body)
    expect(body.criteria.tags).toEqual([])
  })
})

describe('FindPage — the left description panel is gone', () => {
  it('renders no situation textarea for either group type, but keeps both sub-tabs', async () => {
    mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByText('Search criteria')).toBeInTheDocument())

    expect(screen.getByText('Regular')).toBeInTheDocument()
    expect(screen.getByText('Timeline')).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/e\.g\. Looking for H-1B/)).toBeNull()

    fireEvent.click(screen.getByText('Regular'))
    expect(screen.queryByPlaceholderText(/e\.g\. Looking for H-1B/)).toBeNull()
  })
})

describe('FindPage — search vs create are separate modes', () => {
  async function timelineSearch() {
    mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByText('Search criteria')).toBeInTheDocument())
  }

  it('the search view offers no validity, no description and no Create button', async () => {
    await timelineSearch()

    expect(screen.queryByText('Group validity')).toBeNull()
    expect(screen.queryByLabelText('Group description')).toBeNull()
    expect(screen.queryByText('Create a Timeline group')).toBeNull()
    // Search itself is here.
    expect(screen.getByText('Search')).toBeInTheDocument()
  })

  it('the Create link sits at the top and swaps the view over', async () => {
    await timelineSearch()

    fireEvent.click(screen.getByText('Create a Timeline Group'))

    expect(screen.getByText('New Timeline group')).toBeInTheDocument()
    expect(screen.getByText('Group validity')).toBeInTheDocument()
    expect(screen.getByLabelText('Group description')).toBeInTheDocument()
    expect(screen.getByText('Create a Timeline group')).toBeInTheDocument()
    // Search UI is gone while creating.
    expect(screen.queryByText('Search')).toBeNull()
  })

  it('shows the generated group name at the top of the create view', async () => {
    await timelineSearch()
    fireEvent.click(screen.getByText('Create a Timeline Group'))

    // The name comes from the server, not from a client reimplementation —
    // Timeline dedup keys on it, so a local guess that drifted would promise
    // a new cohort and deliver a join into an existing one.
    expect(await screen.findByTestId('preview-name')).toHaveTextContent(PREVIEW.name)
    expect(screen.getByText('Group name')).toBeInTheDocument()
  })

  it('the generated name is not shown while searching, only while creating', async () => {
    await timelineSearch()
    await waitFor(() => expect(screen.queryByTestId('preview-name')).toBeNull())
  })

  it('is asked for a preview with the criteria currently in the panel', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'stem-opt-extension' } })

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => c[0] === '/api/groups/preview')
      const last = JSON.parse((calls[calls.length - 1]![1] as { body: string }).body)
      expect(last.group_type).toBe('timeline')
      expect(last.criteria.tags).toEqual(['EAD', 'stem-opt-extension'])
    })
  })

  it('prefills the description with the generated one, and stops once you edit it', async () => {
    await timelineSearch()
    fireEvent.click(screen.getByText('Create a Timeline Group'))

    const box = await screen.findByLabelText('Group description') as HTMLTextAreaElement
    await waitFor(() => expect(box.value).toBe(PREVIEW.description))
    // No reset offered while it still matches — a no-op control is noise.
    expect(screen.queryByText('Reset to generated')).toBeNull()

    fireEvent.change(box, { target: { value: 'my own words' } })
    expect(box.value).toBe('my own words')

    // Changing a criterion must not silently discard what they wrote.
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    await waitFor(() => expect(screen.getByLabelText('Eligibility category')).toBeInTheDocument())
    expect((screen.getByLabelText('Group description') as HTMLTextAreaElement).value).toBe('my own words')

    fireEvent.click(screen.getByText('Reset to generated'))
    expect((screen.getByLabelText('Group description') as HTMLTextAreaElement).value).toBe(PREVIEW.description)
  })

  it('sends the generated description when the creator leaves it alone', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByText('Search criteria')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Create a Timeline Group'))
    await waitFor(() => expect((screen.getByLabelText('Group description') as HTMLTextAreaElement).value)
      .toBe(PREVIEW.description))

    fireEvent.click(screen.getByText('Create a Timeline group'))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/groups')).toBeTruthy())
    const body = JSON.parse((fetchMock.mock.calls.find((c) => c[0] === '/api/groups')![1] as { body: string }).body)
    expect(body.description).toBe(PREVIEW.description)
  })

  it('a failed preview leaves the create view usable rather than erroring', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method || 'GET'
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url) === '/api/groups/preview') throw new Error('down')
      if (String(url) === '/api/users') return { ok: true, status: 200, json: async () => [] } as Response
      if (String(url) === '/api/groups' && method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ group_id: 'new-g' }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByText('Search criteria')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Create a Timeline Group'))

    expect(screen.queryByTestId('preview-name')).toBeNull()
    expect(screen.getByText('Create a Timeline group')).toBeInTheDocument()
  })

  it('criteria typed while searching carry into the create view', async () => {
    const fetchMock = mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'stem-opt-extension' } })
    fireEvent.click(screen.getByText('Create a Timeline Group'))
    fireEvent.click(screen.getByText('Create a Timeline group'))

    await waitFor(() => expect(push).toHaveBeenCalled())
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups' && (c[1] as { method?: string })?.method === 'POST')!
    expect(JSON.parse((call[1] as { body: string }).body).criteria.tags).toEqual(['EAD', 'stem-opt-extension'])
  })

  it('Back to search returns without losing the criteria', async () => {
    await timelineSearch()

    fireEvent.click(screen.getByText('Create a Timeline Group'))
    fireEvent.click(screen.getByText('Back to search'))

    expect(screen.getByText('Find a group')).toBeInTheDocument()
    expect(screen.getByText('Search')).toBeInTheDocument()
  })
})

describe('FindPage — two panels: criteria left, results right', () => {
  it('puts the criteria and the results in separate grid columns', async () => {
    const fetchMock = mockFetch({ search: { groups: [GROUP] } })
    const { container } = render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByText('Search criteria')).toBeInTheDocument())

    const grid = container.querySelector('div.grid')!
    expect(grid).toBeTruthy()
    const [left, right] = Array.from(grid.children)

    expect(left.contains(screen.getByLabelText('Processing type'))).toBe(true)

    fireEvent.click(screen.getByText('Search'))
    await waitFor(() => expect(fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')).toBeTruthy())

    const heading = await screen.findByText(/group.* found|No groups found/)
    expect(right.contains(heading)).toBe(true)
    expect(left.contains(heading)).toBe(false)
  })

  it('keeps the criteria column narrow — it is a form, not content', async () => {
    const { container } = render(<FindPage />)
    mockFetch()
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByText('Search criteria')).toBeInTheDocument())

    const grid = container.querySelector('div.grid')!
    // A capped left track and a flexible right one.
    expect(grid.className).toMatch(/lg:grid-cols-\[minmax\(0,19rem\)_1fr\]/)
  })
})

describe('FindPage — scope rows are configuration, not code', () => {
  async function pickCategory(tag: string) {
    const fetchMock = mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: tag } })
    return fetchMock
  }

  it('renders the extra row its category configures, on top of the period pair', async () => {
    await pickCategory('synthetic-scope-extra')
    const extra = await screen.findByLabelText('Receipt Date')
    expect(extra).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('Month')).toBeInTheDocument()
    expect(screen.getByLabelText('Year')).toBeInTheDocument()
  })

  it('sends a date row in key_dates and a period row in key_stages_or_info', async () => {
    const fetchMock = await pickCategory('synthetic-scope-extra')
    fireEvent.change(await screen.findByLabelText('Receipt Date'), { target: { value: '2026-08-20' } })
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: 'Aug' } })
    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/groups/search'),
    ).toBe(true))
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    const { criteria } = JSON.parse((call[1] as { body: string }).body)
    expect(criteria.key_dates).toEqual({ receipt_date: '2026-08-20' })
    expect(criteria.key_stages_or_info).toEqual({ filing_month: 'Aug' })
  })

  it('a category without its own rows shows only the period pair', async () => {
    await pickCategory('h4-ead')
    expect(await screen.findByLabelText('Month')).toBeInTheDocument()
    expect(screen.queryByLabelText('Receipt Date')).toBeNull()
  })

  it('switching category drops the previous one’s values', async () => {
    const fetchMock = await pickCategory('synthetic-scope-extra')
    fireEvent.change(await screen.findByLabelText('Receipt Date'), { target: { value: '2026-08-20' } })
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'h4-ead' } })
    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => expect(
      fetchMock.mock.calls.some((c) => c[0] === '/api/groups/search'),
    ).toBe(true))
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/groups/search')!
    expect(JSON.parse((call[1] as { body: string }).body).criteria.key_dates).toEqual({})
  })

  it('I-485 asks for the priority date on JOIN, not on the find/create panel', async () => {
    await pickCategory('adjustment-of-status')
    expect(await screen.findByLabelText('Month')).toBeInTheDocument()
    expect(screen.queryByLabelText('Priority Date')).toBeNull()
  })
})

describe('FindPage — the period pair is labelled, and spans real filing years', () => {
  async function openScope() {
    mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })
    fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: 'h4-ead' } })
    await screen.findByLabelText('Month')
  }

  it('labels Month/Year as the Date Applied', async () => {
    await openScope()
    expect(screen.getByText('Date Applied')).toBeInTheDocument()
  })

  it('offers the last 5 years through next year', async () => {
    await openScope()
    const y = new Date().getFullYear()
    const year = screen.getByLabelText('Year') as HTMLSelectElement
    expect([...year.options].map((o) => o.value))
      .toEqual(['', ...Array.from({ length: 7 }, (_, i) => String(y - 5 + i))])
  })
})

describe('FindPage — Month everywhere, no Cycle', () => {
  it('gives every eligibility category the same Month + Year pair', async () => {
    mockFetch()
    render(<FindPage />)
    fireEvent.click(screen.getByText('Find / create group'))
    await waitFor(() => expect(screen.getByLabelText('Processing type')).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Processing type'), { target: { value: 'EAD' } })

    for (const tag of ['stem-opt-extension', 'h4-ead']) {
      fireEvent.change(screen.getByLabelText('Eligibility category'), { target: { value: tag } })
      expect(await screen.findByLabelText('Month')).toBeInTheDocument()
      expect(screen.getByLabelText('Year')).toBeInTheDocument()
      expect(screen.queryByLabelText('Cycle')).toBeNull()
    }
  })
})

// The AI-Assist timeline button hands off as
// /find?type=timeline&processing_type=..&eligibility=..&filing_month=..&filing_year=..
// The panel must open on the Find/create Timeline tab with those prefilled.
describe('FindPage — timeline deep-link prefill (AI Assist handoff)', () => {
  it('opens the Timeline Find/create panel with the processing type prefilled', async () => {
    sp.value = new URLSearchParams('type=timeline&processing_type=EAD')
    mockFetch()
    render(<FindPage />)
    // "Processing type" only renders inside the Find/create tab in Timeline
    // mode, so its presence proves both tab + groupType were switched.
    const ptype = await screen.findByLabelText('Processing type')
    await waitFor(() => expect((ptype as HTMLSelectElement).value).toBe('EAD'))
    // no eligibility param -> left for the user to pick
    expect((screen.getByLabelText('Eligibility category') as HTMLSelectElement).value).toBe('')
  })

  it('prefills eligibility + filing month/year from a full deep-link', async () => {
    sp.value = new URLSearchParams(
      'type=timeline&processing_type=EAD&eligibility=stem-opt-extension&filing_month=Aug&filing_year=2026')
    mockFetch()
    render(<FindPage />)
    const ptype = await screen.findByLabelText('Processing type')
    await waitFor(() => expect((ptype as HTMLSelectElement).value).toBe('EAD'))
    expect((screen.getByLabelText('Eligibility category') as HTMLSelectElement).value).toBe('stem-opt-extension')
    await waitFor(() => expect((screen.getByLabelText('Month') as HTMLSelectElement).value).toBe('Aug'))
    expect((screen.getByLabelText('Year') as HTMLSelectElement).value).toBe('2026')
  })

  it('does NOT prefill / switch tabs when there is no timeline deep-link', async () => {
    // Default (no params) -> lands on the browse "Groups" tab, no panel.
    mockFetch()
    render(<FindPage />)
    await waitFor(() => expect(screen.getByText('Find groups in the same boat')).toBeInTheDocument())
    expect(screen.queryByLabelText('Processing type')).toBeNull()
  })
})
