import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import MembersPage from '../page'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(), useParams: () => ({ id: 'g1' }) }))
vi.mock('@/lib/useRequireUser', () => ({ useRequireUser: () => {} }))
vi.mock('@/lib/activeUser', () => ({
  userHeaders: vi.fn((h?: Record<string, string>) => h || {}),
  getActiveUser: vi.fn(() => 'demo-arjun'),
}))

const TEMPLATES = {
  'stem-opt-extension': [
    { kind: 'date', label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' },
    { kind: 'date', label: 'EAD Received', field: 'key_dates', key: 'ead_approved_date' },
    { kind: 'checkbox', label: 'Premium Processing', field: 'key_stages_or_info', key: 'premium_processing' },
    // A select column, so the filter row's "offer the configured options"
    // branch is exercised rather than only the substring one.
    { kind: 'select', label: 'Service Center', field: 'key_stages_or_info', key: 'service_center',
      options: ['PSC', 'SRC', 'VSC'] },
  ],
}

const GROUP = {
  group_id: 'g1', name: 'Fall 2026 STEM OPT', group_type: 'timeline',
  criteria_tags: { tags: ['stem-opt-extension'] },
  members: [
    { user_id: 'demo-arjun', username: 'arjun-h1b' },
    { user_id: 'demo-mei', username: 'mei-f1' },
  ],
  is_member: true,
}

const ATTRS = [
  {
    user_id: 'demo-arjun', username: 'arjun-h1b', processing_type: 'stem-opt-extension',
    values: {
      ead_filed_date: '2026-03-01', ead_approved_date: '2026-05-20',
      premium_processing: 'yes', service_center: 'PSC',
    },
    notes: 'filed early', submitted_at: '', updated_at: '',
  },
]

// A second submitter, so filtering has something to actually exclude.
const ATTRS_TWO = [
  ...ATTRS,
  {
    user_id: 'demo-mei', username: 'mei-f1', processing_type: 'stem-opt-extension',
    values: { ead_filed_date: '2025-11-02', service_center: 'VSC' },
    notes: 'still waiting', submitted_at: '', updated_at: '',
  },
]

function mockFetch(group: Record<string, unknown> = GROUP, attributes = ATTRS) {
  global.fetch = vi.fn(async (url: string) => {
    if (String(url).includes('/api/tag-vocab')) {
      return { ok: true, status: 200, json: async () => ({ post_join_attribute_templates: TEMPLATES }) } as Response
    }
    if (String(url).includes('/attributes')) {
      return { ok: true, status: 200, json: async () => ({ attributes }) } as Response
    }
    return { ok: true, status: 200, json: async () => group } as Response
  }) as unknown as typeof fetch
}

beforeEach(() => { vi.restoreAllMocks() })

describe('GroupMembersPage', () => {
  it('renders one row per member, with a dash where nothing was submitted', async () => {
    mockFetch()
    render(<MembersPage />)

    await screen.findByText('Fall 2026 STEM OPT')
    const table = screen.getByRole('table')
    const rows = within(table).getAllByRole('row')
    // header + filter row + one row per member
    expect(rows).toHaveLength(2 + GROUP.members.length)

    const arjun = within(table).getByText('arjun-h1b').closest('tr')!
    expect(within(arjun).getByText('2026-03-01')).toBeInTheDocument()
    expect(within(arjun).getByText('2026-05-20')).toBeInTheDocument()
    expect(within(arjun).getByText('filed early')).toBeInTheDocument()

    // mei submitted nothing — every cell falls back to an em dash
    // (4 attribute columns + notes).
    const mei = within(table).getByText('mei-f1').closest('tr')!
    expect(within(mei).getAllByText('—')).toHaveLength(5)
  })

  it('takes its columns from the matched attribute template', async () => {
    mockFetch()
    render(<MembersPage />)

    await screen.findByText('Fall 2026 STEM OPT')
    // The FIRST header row — the second one holds the filter controls.
    const labelRow = within(screen.getByRole('table')).getAllByRole('row')[0]
    const headers = within(labelRow).getAllByRole('columnheader').map((h) => h.textContent)
    expect(headers).toEqual(['Member', 'Date Applied', 'EAD Received', 'Premium Processing', 'Service Center', 'Notes'])
  })

  it('gives every column a filter, typed to what the column holds', async () => {
    mockFetch()
    render(<MembersPage />)
    await screen.findByText('Fall 2026 STEM OPT')

    // Every column, not just the three the brief named — the columns are
    // configuration, so a hardcoded subset would stop covering a column added
    // from Firestore tomorrow.
    expect(screen.getByLabelText('Filter Member')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter Date Applied')).toBeInTheDocument()
    expect(screen.getByLabelText('Filter Notes')).toBeInTheDocument()

    // A select column offers its own configured domain rather than free text.
    const sc = screen.getByLabelText('Filter Service Center') as HTMLSelectElement
    expect([...sc.options].map((o) => o.value)).toEqual(['', 'PSC', 'SRC', 'VSC'])
    // A checkbox column is Yes-or-all; there is no stored "no" to offer.
    const pp = screen.getByLabelText('Filter Premium Processing') as HTMLSelectElement
    expect([...pp.options].map((o) => o.value)).toEqual(['', 'Yes'])
  })

  it('filters rows down, combines filters, and clears them again', async () => {
    mockFetch(GROUP, ATTRS_TWO)
    render(<MembersPage />)
    await screen.findByText('Fall 2026 STEM OPT')
    const body = () => within(screen.getByRole('table')).getAllByRole('row').slice(2)
    expect(body()).toHaveLength(2)

    // A date column filters by substring, so a bare year works — no range
    // picker needed to answer "who filed in 2026".
    fireEvent.change(screen.getByLabelText('Filter Date Applied'), { target: { value: '2026' } })
    expect(body()).toHaveLength(1)
    expect(within(screen.getByRole('table')).getByText('arjun-h1b')).toBeInTheDocument()
    expect(screen.getByText('1 of 2 shown · 1 filter')).toBeInTheDocument()

    // Filters AND together — this one contradicts the first.
    fireEvent.change(screen.getByLabelText('Filter Service Center'), { target: { value: 'VSC' } })
    expect(body()).toHaveLength(1)
    expect(screen.getByText('No members match these filters.')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Clear filters'))
    expect(body()).toHaveLength(2)
    expect(screen.queryByText('Clear filters')).toBeNull()
  })

  it('matches case-insensitively and filters the Notes column too', async () => {
    mockFetch(GROUP, ATTRS_TWO)
    render(<MembersPage />)
    await screen.findByText('Fall 2026 STEM OPT')
    const body = () => within(screen.getByRole('table')).getAllByRole('row').slice(2)

    // Typed lowercase, stored capitalised — a filter that only matched the
    // exact casing would look broken to anyone who types naturally.
    fireEvent.change(screen.getByLabelText('Filter Member'), { target: { value: 'ARJUN' } })
    expect(body()).toHaveLength(1)

    fireEvent.change(screen.getByLabelText('Filter Member'), { target: { value: '' } })
    fireEvent.change(screen.getByLabelText('Filter Notes'), { target: { value: 'waiting' } })
    expect(body()).toHaveLength(1)
    expect(within(screen.getByRole('table')).getByText('mei-f1')).toBeInTheDocument()
  })

  it('treats an emptied filter as no filter rather than matching nothing', async () => {
    mockFetch(GROUP, ATTRS_TWO)
    render(<MembersPage />)
    await screen.findByText('Fall 2026 STEM OPT')
    const body = () => within(screen.getByRole('table')).getAllByRole('row').slice(2)

    fireEvent.change(screen.getByLabelText('Filter Date Applied'), { target: { value: '2026' } })
    expect(body()).toHaveLength(1)
    fireEvent.change(screen.getByLabelText('Filter Date Applied'), { target: { value: '' } })
    expect(body()).toHaveLength(2)
    // …and the count line goes back to the plain member count.
    expect(screen.getByText('2 members')).toBeInTheDocument()
    expect(screen.queryByText('Clear filters')).toBeNull()
  })

  it('filters on a member who submitted nothing, without crashing on the gaps', async () => {
    // mei has no attributes row at all in the single-submitter fixture, so
    // every cell resolves through `undefined` — the path most likely to throw.
    mockFetch()
    render(<MembersPage />)
    await screen.findByText('Fall 2026 STEM OPT')

    fireEvent.change(screen.getByLabelText('Filter Member'), { target: { value: 'mei' } })
    const body = within(screen.getByRole('table')).getAllByRole('row').slice(2)
    expect(body).toHaveLength(1)
    expect(within(screen.getByRole('table')).getByText('mei-f1')).toBeInTheDocument()

    // And a value filter excludes her, since she has no value to match.
    fireEvent.change(screen.getByLabelText('Filter Date Applied'), { target: { value: '2026' } })
    expect(screen.getByText('No members match these filters.')).toBeInTheDocument()
  })

  it('matches the checkbox column on its displayed Yes, not the stored value', async () => {
    mockFetch(GROUP, ATTRS_TWO)
    render(<MembersPage />)
    await screen.findByText('Fall 2026 STEM OPT')

    // Stored as 'yes', displayed as 'Yes' — the filter compares what the user
    // can actually see in the cell.
    fireEvent.change(screen.getByLabelText('Filter Premium Processing'), { target: { value: 'Yes' } })
    const body = within(screen.getByRole('table')).getAllByRole('row').slice(2)
    expect(body).toHaveLength(1)
    expect(within(screen.getByRole('table')).getByText('arjun-h1b')).toBeInTheDocument()
  })

  it('links back to the group', async () => {
    mockFetch()
    render(<MembersPage />)

    await screen.findByText('Fall 2026 STEM OPT')
    expect(screen.getByText('Back to group').closest('a')).toHaveAttribute('href', '/groups/g1')
  })

  it('shows nothing to a non-member', async () => {
    mockFetch({ ...GROUP, is_member: false })
    render(<MembersPage />)

    expect(await screen.findByText('Only members can see this.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('explains itself when the group collects no attributes at all', async () => {
    mockFetch({ ...GROUP, group_type: '', criteria_tags: {} })
    render(<MembersPage />)

    expect(await screen.findByText(/doesn.t collect timeline attributes/)).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('surfaces a load failure instead of rendering an empty table', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => ({}) } as Response
      if (String(url).includes('/attributes')) return { ok: false, status: 403, json: async () => ({}) } as Response
      return { ok: false, status: 404, json: async () => ({ detail: 'No such group.' }) } as Response
    }) as unknown as typeof fetch
    render(<MembersPage />)

    expect(await screen.findByText('No such group.')).toBeInTheDocument()
  })
})

describe('GroupMembersPage — compact, kind-aware columns', () => {
  it('lets long headers wrap to two lines instead of forcing a scroll', async () => {
    mockFetch()
    render(<MembersPage />)

    await screen.findByText('Fall 2026 STEM OPT')
    const header = screen.getByText('Premium Processing')
    // The clamp sits on an inner span so the <th> keeps table-cell layout.
    expect(header.tagName).toBe('SPAN')
    expect(header).toHaveClass('line-clamp-2')
    expect(header.closest('th')).not.toHaveClass('whitespace-nowrap')
    // Full text stays reachable when it clips.
    expect(header.closest('th')).toHaveAttribute('title', 'Premium Processing')
  })

  it('shows a checkbox column as a tick, never the raw stored "yes"', async () => {
    mockFetch()
    render(<MembersPage />)

    await screen.findByText('Fall 2026 STEM OPT')
    const arjun = screen.getByText('arjun-h1b').closest('tr')!
    expect(within(arjun).getByTitle('Yes')).toBeInTheDocument()
    expect(within(arjun).queryByText('yes')).toBeNull()
  })
})
