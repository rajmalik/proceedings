import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import GroupPage from '../page'

const mockPush = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(), useParams: () => ({ id: 'g1' }), useRouter: () => ({ push: mockPush }) }))
vi.mock('@/lib/useRequireUser', () => ({ useRequireUser: () => {}, loginHref: (p: string) => `/login?next=${encodeURIComponent(p)}` }))
// The page reads auth-loading state so it doesn't mistake "Firebase hasn't
// resolved yet" for "no identity". Mocked here — the real context boots
// Firebase, which has no API key under test.
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, loading: false }) }))
vi.mock('@/lib/activeUser', () => ({
  userHeaders: vi.fn((h?: Record<string, string>) => h || {}),
  getActiveUser: vi.fn(() => 'demo-arjun'),
}))
vi.mock('@/components/GroupChat', () => ({ default: () => <div data-testid="group-chat" /> }))
// AuthorSection does its own fetching; the member-profile modal only needs to
// prove it mounts the right author.
vi.mock('@/components/AuthorSection', () => ({
  default: ({ authorId }: { authorId: string }) => <div data-testid="author-section">{authorId}</div>,
}))

const BASE_GROUP = {
  group_id: 'g1', name: 'Mumbai H-1B crew', description: 'H-1B folks near BOM',
  criteria_text: 'looking for H-1B folks at Mumbai',
  members: [
    { user_id: 'demo-arjun', username: 'arjun-h1b' },
    { user_id: 'demo-mei', username: 'mei-f1' },
  ],
  created_by: 'demo-arjun',
  is_admin: false,
  is_member: true,
  created_at: '2026-06-07T00:00:00.000Z',
  last_activity_at: '2026-06-07T00:05:00.000Z',
}

function mockGroup(overrides: Record<string, unknown> = {}) {
  global.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
    const method = opts?.method || 'GET'
    // '/invitations' contains '/invite', so it has to be matched first.
    if (String(url).includes('/invitations')) {
      return { ok: true, status: 200, json: async () => ({ invitations: [] }) } as Response
    }
    if (String(url).includes('/invite')) {
      return { ok: true, status: 200, json: async () => ({ ...BASE_GROUP, ...overrides, members: [...BASE_GROUP.members, { user_id: 'demo-omar', username: 'omar-b1b2' }] }) } as Response
    }
    if (method === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response
    }
    if (method === 'PUT') {
      const body = JSON.parse((opts as { body?: string })?.body || '{}')
      return { ok: true, status: 200, json: async () => ({ ...BASE_GROUP, ...overrides, ...body }) } as Response
    }
    return { ok: true, status: 200, json: async () => ({ ...BASE_GROUP, ...overrides }) } as Response
  }) as unknown as typeof fetch
}

beforeEach(() => {
  vi.restoreAllMocks()
  mockPush.mockClear()
  Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } })
})

describe('GroupPage — metadata + admin badge', () => {
  it('renders name, description, and dates', async () => {
    mockGroup()
    render(<GroupPage />)
    expect(await screen.findByText('Mumbai H-1B crew')).toBeInTheDocument()
    // Shown both in the header and the "Group details" metadata panel.
    expect(screen.getAllByText('H-1B folks near BOM').length).toBeGreaterThan(0)
    expect(screen.getAllByText(/Created/).length).toBeGreaterThan(0)
    expect(screen.getByText(/Last activity/)).toBeInTheDocument()
  })

  it('shows an "Admin" badge next to the creator, not other members', async () => {
    mockGroup()
    render(<GroupPage />)
    await screen.findByText('arjun-h1b')
    const adminBadges = screen.getAllByText('Admin')
    expect(adminBadges).toHaveLength(1)
  })
})

describe('GroupPage — rename (admin-only)', () => {
  it('does not show a Rename affordance for a non-admin viewer', async () => {
    mockGroup({ is_admin: false })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    expect(screen.queryByText('Rename')).toBeNull()
  })

  it('lets the admin rename the group, PUTting the new name + description', async () => {
    mockGroup({ is_admin: true })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Rename'))
    const nameInput = screen.getByDisplayValue('Mumbai H-1B crew')
    fireEvent.change(nameInput, { target: { value: 'BOM H-1B group' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const putCall = (global.fetch as unknown as Mock).mock.calls.find((c) => c[1]?.method === 'PUT')
      expect(putCall).toBeTruthy()
    })
    const putCall = (global.fetch as unknown as Mock).mock.calls.find((c) => c[1]?.method === 'PUT')!
    expect(JSON.parse(putCall[1].body)).toEqual({ name: 'BOM H-1B group', description: 'H-1B folks near BOM' })
    expect(await screen.findByText('BOM H-1B group')).toBeInTheDocument()
  })
})

describe('GroupPage — invite by handle (any member)', () => {
  it('sends an invitation and shows the invitee as pending, NOT as a member', async () => {
    global.fetch = vi.fn(async (url: string) => {
      // '/invitations' contains '/invite' — match the longer path first.
      if (String(url).includes('/invitations')) return { ok: true, status: 200, json: async () => ({ invitations: [] }) } as Response
      if (String(url).includes('/invite')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            invitation_id: 'g1__demo-omar', group_id: 'g1', user_id: 'demo-omar',
            username: 'omar-b1b2', status: 'pending',
          }),
        } as Response
      }
      if (String(url).includes('/attributes')) return { ok: true, status: 200, json: async () => ({ attributes: [] }) } as Response
      return { ok: true, status: 200, json: async () => BASE_GROUP } as Response
    }) as unknown as typeof fetch
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.change(screen.getByPlaceholderText('their handle…'), { target: { value: 'omar-b1b2' } })
    fireEvent.click(screen.getByText('Invite'))

    await waitFor(() => {
      const inviteCall = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/invite'))
      expect(inviteCall).toBeTruthy()
    })
    const inviteCall = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/invite'))!
    expect(JSON.parse(inviteCall[1].body)).toEqual({ handle: 'omar-b1b2' })
    // Appears under "Invited", awaiting a reply — the member count is unchanged.
    expect(await screen.findByText(/Invited \(1\)/)).toBeInTheDocument()
    expect(screen.getByText(/awaiting reply/)).toBeInTheDocument()
    expect(screen.getByText(/^Members \(2\)$/)).toBeInTheDocument()
  })

  it('surfaces an error when the handle is not found', async () => {
    global.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/invite')) {
        return { ok: false, status: 422, json: async () => ({ detail: 'No user with the handle "nope".' }) } as Response
      }
      return { ok: true, status: 200, json: async () => BASE_GROUP } as Response
    }) as unknown as typeof fetch
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.change(screen.getByPlaceholderText('their handle…'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByText('Invite'))
    expect(await screen.findByText(/No user with the handle/)).toBeInTheDocument()
  })

  it('clears the invite input after a successful invite', async () => {
    mockGroup()
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    const input = screen.getByPlaceholderText('their handle…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'omar-b1b2' } })
    fireEvent.click(screen.getByText('Invite'))

    await waitFor(() => expect(input.value).toBe(''))
  })
})

describe('GroupPage — rename cancel + validation', () => {
  it('Cancel restores the original name/description and does not call PUT', async () => {
    mockGroup({ is_admin: true })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Rename'))
    const nameInput = screen.getByDisplayValue('Mumbai H-1B crew')
    fireEvent.change(nameInput, { target: { value: 'Something Else' } })
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.getByText('Mumbai H-1B crew')).toBeInTheDocument()
    expect(screen.queryByText('Something Else')).toBeNull()
    expect((global.fetch as unknown as Mock).mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false)
  })

  it('disables Save when the name draft is empty/whitespace-only', async () => {
    mockGroup({ is_admin: true })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Rename'))
    const nameInput = screen.getByDisplayValue('Mumbai H-1B crew')
    fireEvent.change(nameInput, { target: { value: '   ' } })

    expect(screen.getByText('Save')).toBeDisabled()
  })
})

describe('GroupPage — empty description, loading, and error states', () => {
  it('renders no description paragraph when the group has none', async () => {
    mockGroup({ description: '' })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    expect(screen.queryByText('H-1B folks near BOM')).toBeNull()
  })

  it('shows a loading state before the fetch resolves', () => {
    global.fetch = vi.fn(() => new Promise(() => {})) as unknown as typeof fetch
    render(<GroupPage />)
    expect(screen.getByText('Loading group…')).toBeInTheDocument()
  })

  it('surfaces an error when the group fails to load', async () => {
    global.fetch = vi.fn(async () =>
      ({ ok: false, status: 404, json: async () => ({ detail: 'Group not found' }) }) as Response
    ) as unknown as typeof fetch
    render(<GroupPage />)
    expect(await screen.findByText('Group not found')).toBeInTheDocument()
  })
})

describe('GroupPage — delete group (admin-only)', () => {
  it('does not show a Delete affordance for a non-admin viewer', async () => {
    mockGroup({ is_admin: false })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    expect(screen.queryByText('Delete group')).toBeNull()
  })

  it('shows an inline confirm step before deleting, and Cancel backs out without calling DELETE', async () => {
    mockGroup({ is_admin: true })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Delete group'))
    expect(await screen.findByText(/can.t be undone/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText(/can.t be undone/)).toBeNull()
    expect((global.fetch as unknown as Mock).mock.calls.some((c) => c[1]?.method === 'DELETE')).toBe(false)
  })

  it('confirming delete calls DELETE and navigates to /find', async () => {
    mockGroup({ is_admin: true })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Delete group'))
    fireEvent.click(await screen.findByText('Confirm delete'))

    await waitFor(() => {
      const delCall = (global.fetch as unknown as Mock).mock.calls.find((c) => c[1]?.method === 'DELETE')
      expect(delCall).toBeTruthy()
    })
    const delCall = (global.fetch as unknown as Mock).mock.calls.find((c) => c[1]?.method === 'DELETE')!
    expect(String(delCall[0])).toContain('/api/groups/g1')
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/find'))
  })

  it('surfaces an error and resets the confirm step when delete fails', async () => {
    global.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (opts?.method === 'DELETE') {
        return { ok: false, status: 403, json: async () => ({ detail: "Only the group's creator can delete it." }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ ...BASE_GROUP, is_admin: true }) } as Response
    }) as unknown as typeof fetch
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Delete group'))
    fireEvent.click(await screen.findByText('Confirm delete'))

    expect(await screen.findByText(/Only the group's creator can delete it/)).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
    expect(screen.queryByText('Confirm delete')).toBeNull()
  })
})

describe('GroupPage — non-member join preview', () => {
  it('shows a Join button instead of the chat/admin controls for a non-member', async () => {
    mockGroup({ is_member: false })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    expect(screen.getByText('Join group')).toBeInTheDocument()
    expect(screen.queryByTestId('group-chat')).toBeNull()
    expect(screen.queryByText('Invite someone')).toBeNull()
    expect(screen.queryByText('Find candidates')).toBeNull()
  })

  it('clicking Join calls the join route and reveals the full group page', async () => {
    let joined = false
    global.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/join')) { joined = true; return { ok: true, status: 200, json: async () => ({ ...BASE_GROUP, is_member: true }) } as Response }
      return { ok: true, status: 200, json: async () => ({ ...BASE_GROUP, is_member: joined }) } as Response
    }) as unknown as typeof fetch
    render(<GroupPage />)
    await screen.findByText('Join group')

    fireEvent.click(screen.getByText('Join group'))

    await waitFor(() => {
      const joinCall = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/join'))
      expect(joinCall).toBeTruthy()
    })
    expect(await screen.findByTestId('group-chat')).toBeInTheDocument()
  })

  it('a member sees the full chat/admin UI, not the join preview', async () => {
    mockGroup({ is_member: true })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    expect(screen.queryByText('Join group')).toBeNull()
    expect(screen.getByTestId('group-chat')).toBeInTheDocument()
  })
})

describe('GroupPage — copy link', () => {
  it('copies the current URL to the clipboard and shows confirmation', async () => {
    mockGroup()
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Copy link'))

    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(window.location.href))
    expect(await screen.findByText('Copied!')).toBeInTheDocument()
  })

  it('shows a Timeline badge for a Timeline group', async () => {
    mockGroup({ group_type: 'timeline' })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    // Shown both in the header and the "Group details" metadata panel.
    expect(screen.getAllByText('Timeline').length).toBeGreaterThan(0)
  })

  it('shows a Regular badge for a non-Timeline group', async () => {
    mockGroup({ group_type: '' })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    expect(screen.getAllByText('Regular').length).toBeGreaterThan(0)
  })
})

describe('GroupPage — Find candidates (member-only)', () => {
  const CANDIDATE = { user_id: 'u9', username: 'nine', score: 4.5, shared: ['H-1B'], summary: 'H-1B', background: '' }

  function mockWithCandidates() {
    global.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method || 'GET'
      if (String(url).includes('/find-candidates')) {
        return { ok: true, status: 200, json: async () => ({ matches: [CANDIDATE], total: 1 }) } as Response
      }
      if (String(url).includes('/add-members')) {
        // Candidates are INVITED now — the group comes back unchanged.
        return {
          ok: true, status: 200,
          json: async () => ({
            group: BASE_GROUP,
            invited: [{ invitation_id: 'g1__u9', group_id: 'g1', user_id: 'u9', username: 'nine', status: 'pending' }],
            skipped: [],
          }),
        } as Response
      }
      if (String(url).includes('/invitations')) return { ok: true, status: 200, json: async () => ({ invitations: [] }) } as Response
      if (String(url).includes('/attributes')) return { ok: true, status: 200, json: async () => ({ attributes: [] }) } as Response
      return { ok: true, status: 200, json: async () => BASE_GROUP } as Response
    }) as unknown as typeof fetch
  }

  it('finds candidates scoped to this group and renders them', async () => {
    mockWithCandidates()
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByRole('button', { name: 'Find candidates' }))

    expect(await screen.findByText('nine')).toBeInTheDocument()
    const call = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/find-candidates'))!
    expect(String(call[0])).toContain('/api/groups/g1/find-candidates')
  })

  it('shows a no-candidates message when none are found', async () => {
    global.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/find-candidates')) return { ok: true, status: 200, json: async () => ({ matches: [], total: 0 }) } as Response
      return { ok: true, status: 200, json: async () => BASE_GROUP } as Response
    }) as unknown as typeof fetch
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByRole('button', { name: 'Find candidates' }))

    expect(await screen.findByText(/No candidates found/)).toBeInTheDocument()
  })

  it('selecting a candidate and adding calls add-members with the selected user_ids', async () => {
    mockWithCandidates()
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    fireEvent.click(screen.getByRole('button', { name: 'Find candidates' }))
    await screen.findByText('nine')

    fireEvent.click(screen.getByLabelText('Include nine'))
    fireEvent.click(screen.getByText('Invite 1 selected'))

    await waitFor(() => {
      const call = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/add-members'))
      expect(call).toBeTruthy()
    })
    const call = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/add-members'))!
    expect(JSON.parse(call[1].body)).toEqual({ user_ids: ['u9'] })
    // the group's member list refreshes from the add-members response, and the
    // just-added candidate is dropped from the find-candidates suggestion list
    await waitFor(() => expect(screen.getAllByText('nine')).toHaveLength(1))
  })

  it('the Add button is disabled until a candidate is selected', async () => {
    mockWithCandidates()
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    fireEvent.click(screen.getByRole('button', { name: 'Find candidates' }))
    await screen.findByText('nine')

    expect(screen.getByText('Invite selected')).toBeDisabled()
  })
})

describe('GroupPage — join preview attribute form (non-member)', () => {
  const POST_JOIN_TEMPLATES = {
    'stem-opt-extension': [
      { label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' },
      { label: 'Notice of Intent to Deny (NOID)', field: 'key_dates', key: 'noid_date' },
    ],
  }
  const TIMELINE_GROUP = {
    ...BASE_GROUP, group_type: 'timeline', criteria_tags: { tags: ['stem-opt-extension'] }, is_member: false,
  }

  function mockJoinFlow(group: Record<string, unknown>) {
    global.fetch = vi.fn(async (url: string, fetchOpts?: { method?: string; body?: string }) => {
      if (String(url).includes('/api/tag-vocab')) {
        return { ok: true, status: 200, json: async () => ({ post_join_attribute_templates: POST_JOIN_TEMPLATES }) } as Response
      }
      if (String(url).includes('/attributes')) {
        return { ok: true, status: 200, json: async () => ({ attributes: [] }) } as Response
      }
      if (String(url).includes('/join')) {
        const body = JSON.parse(fetchOpts?.body || '{}')
        return { ok: true, status: 200, json: async () => ({ ...group, is_member: true, needs_attributes: false, _joinBody: body }) } as Response
      }
      return { ok: true, status: 200, json: async () => group } as Response
    }) as unknown as typeof fetch
  }

  it('shows the attribute form inline on the join preview for a matching Timeline group', async () => {
    mockJoinFlow(TIMELINE_GROUP)
    render(<GroupPage />)
    await screen.findByText('Join group')

    expect(screen.getByText('Your stem-opt-extension attributes')).toBeInTheDocument()
    expect(screen.getByText('Date Applied')).toBeInTheDocument()
    expect(screen.getByText('Notice of Intent to Deny (NOID)')).toBeInTheDocument()
    expect(screen.getByText('Notes')).toBeInTheDocument()
  })

  it('disables Join until the required field (row 0 — Date Applied) is filled', async () => {
    mockJoinFlow(TIMELINE_GROUP)
    render(<GroupPage />)
    await screen.findByText('Join group')

    expect(screen.getByText('Join group')).toBeDisabled()

    const dateInputs = screen.getAllByDisplayValue('') as HTMLInputElement[]
    const applied = dateInputs.find((el) => el.type === 'date')!
    fireEvent.change(applied, { target: { value: '2026-03-01' } })

    expect(screen.getByText('Join group')).not.toBeDisabled()
  })

  it('Join sends the filled values + notes in the join POST body', async () => {
    mockJoinFlow(TIMELINE_GROUP)
    render(<GroupPage />)
    await screen.findByText('Join group')

    const dateInputs = screen.getAllByDisplayValue('') as HTMLInputElement[]
    const applied = dateInputs.find((el) => el.type === 'date')!
    fireEvent.change(applied, { target: { value: '2026-03-01' } })
    fireEvent.change(screen.getByPlaceholderText('Anything else worth sharing with the cohort?'), { target: { value: 'filed early' } })
    fireEvent.click(screen.getByText('Join group'))

    await waitFor(() => {
      const call = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/join'))
      expect(call).toBeTruthy()
    })
    const call = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/join'))!
    expect(JSON.parse(call[1].body)).toEqual({ values: { ead_filed_date: '2026-03-01' }, notes: 'filed early' })
    await waitFor(() => expect(screen.getByTestId('group-chat')).toBeInTheDocument())
  })

  it('does not show the form for a Regular group, even with a matching tag, and Join has no required-field gate', async () => {
    mockJoinFlow({ ...TIMELINE_GROUP, group_type: '' })
    render(<GroupPage />)
    await screen.findByText('Join group')

    expect(screen.queryByText(/Your .* attributes/)).toBeNull()
    expect(screen.getByText('Join group')).not.toBeDisabled()
  })

  it('does not show the form when the Timeline group has no registered post-join template (e.g. H-1B)', async () => {
    mockJoinFlow({ ...TIMELINE_GROUP, criteria_tags: { current_visa_or_greencard_category: ['H-1B'] } })
    render(<GroupPage />)
    await screen.findByText('Join group')

    expect(screen.queryByText(/Your .* attributes/)).toBeNull()
    expect(screen.getByText('Join group')).not.toBeDisabled()
  })
})

describe('GroupPage — mandatory attribute gate (member view, e.g. added via invite)', () => {
  const POST_JOIN_TEMPLATES = {
    'stem-opt-extension': [
      { label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' },
    ],
  }
  const GATED_GROUP = {
    ...BASE_GROUP, group_type: 'timeline', criteria_tags: { tags: ['stem-opt-extension'] },
    is_member: true, needs_attributes: true,
  }

  function mockGate(group: Record<string, unknown>) {
    let current = { ...group }
    global.fetch = vi.fn(async (url: string, fetchOpts?: { method?: string; body?: string }) => {
      const method = fetchOpts?.method || 'GET'
      if (String(url).includes('/api/tag-vocab')) {
        return { ok: true, status: 200, json: async () => ({ post_join_attribute_templates: POST_JOIN_TEMPLATES }) } as Response
      }
      if (String(url).includes('/attributes') && method === 'POST') {
        current = { ...current, needs_attributes: false }
        return { ok: true, status: 200, json: async () => current } as Response
      }
      if (String(url).includes('/attributes')) {
        return { ok: true, status: 200, json: async () => ({ attributes: [] }) } as Response
      }
      return { ok: true, status: 200, json: async () => current } as Response
    }) as unknown as typeof fetch
  }

  it('blocks chat behind the mandatory gate when needs_attributes is true — the invite-bypass bug fix', async () => {
    mockGate(GATED_GROUP)
    render(<GroupPage />)
    await screen.findByText('Add your stem-opt-extension attributes')

    expect(screen.queryByTestId('group-chat')).toBeNull()
    expect(screen.getByText(/Required to access this group/)).toBeInTheDocument()
  })

  it('has no Skip button — the gate cannot be dismissed', async () => {
    mockGate(GATED_GROUP)
    render(<GroupPage />)
    await screen.findByText('Add your stem-opt-extension attributes')

    expect(screen.queryByText('Skip')).toBeNull()
  })

  it('hides Members, Invite someone, and Find candidates while gated — not just chat', async () => {
    mockGate(GATED_GROUP)
    render(<GroupPage />)
    await screen.findByText('Add your stem-opt-extension attributes')

    expect(screen.queryByText(/^Members \(/)).toBeNull()
    expect(screen.queryByText('Invite someone')).toBeNull()
    expect(screen.queryByText('Find candidates')).toBeNull()
    // Leave group stays available as an escape hatch even while gated.
    expect(screen.getByText('Leave group')).toBeInTheDocument()
  })

  it('submitting the gate POSTs to /api/groups/{id}/attributes and reveals chat once needs_attributes is false', async () => {
    mockGate(GATED_GROUP)
    render(<GroupPage />)
    await screen.findByText('Add your stem-opt-extension attributes')

    const dateInputs = screen.getAllByDisplayValue('') as HTMLInputElement[]
    const applied = dateInputs.find((el) => el.type === 'date')!
    fireEvent.change(applied, { target: { value: '2026-03-01' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const call = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/attributes') && c[1]?.method === 'POST')
      expect(call).toBeTruthy()
    })
    const call = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/attributes') && c[1]?.method === 'POST')!
    expect(JSON.parse(call[1].body)).toEqual({ values: { ead_filed_date: '2026-03-01' }, notes: '' })
    expect(await screen.findByTestId('group-chat')).toBeInTheDocument()
  })

  it('a member with needs_attributes false sees chat directly — no gate', async () => {
    mockGate({ ...GATED_GROUP, needs_attributes: false })
    render(<GroupPage />)
    await screen.findByTestId('group-chat')
    expect(screen.queryByText(/Add your .* attributes/)).toBeNull()
  })
})

const TEMPLATES = { 'stem-opt-extension': [{ label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' }] }
const TIMELINE_GROUP = {
  ...BASE_GROUP, group_type: 'timeline',
  criteria_tags: { tags: ['stem-opt-extension'] }, needs_attributes: false,
}

/** A Timeline group where arjun (the viewer) has submitted and mei hasn't. */
function mockTimelineGroup(attributes: Record<string, unknown>[] = [
  { user_id: 'demo-arjun', username: 'arjun-h1b', processing_type: 'stem-opt-extension', values: { ead_filed_date: '2026-03-01' }, notes: 'filed early' },
]) {
  global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
    if (String(url).includes('/api/tag-vocab')) {
      return { ok: true, status: 200, json: async () => ({ post_join_attribute_templates: TEMPLATES }) } as Response
    }
    if (String(url).includes('/invitations')) return { ok: true, status: 200, json: async () => ({ invitations: [] }) } as Response
    // The real POST /attributes upsert answers with the refreshed GroupCard,
    // not the attribute list — the page feeds it straight back into setGroup().
    if (String(url).includes('/attributes') && opts?.method === 'POST') {
      return { ok: true, status: 200, json: async () => TIMELINE_GROUP } as Response
    }
    if (String(url).includes('/attributes')) return { ok: true, status: 200, json: async () => ({ attributes }) } as Response
    return { ok: true, status: 200, json: async () => TIMELINE_GROUP } as Response
  }) as unknown as typeof fetch
}

describe('GroupPage — member attributes moved out of the sidebar', () => {
  it('no longer renders a Cohort attributes block', async () => {
    mockTimelineGroup()
    render(<GroupPage />)
    await screen.findByTestId('group-chat')
    expect(screen.queryByText('Cohort attributes')).toBeNull()
  })

  it('links to the members table from the page header as "View All Data"', async () => {
    mockTimelineGroup()
    render(<GroupPage />)
    await screen.findByTestId('group-chat')

    const link = await screen.findByText('View All Data')
    expect(link.closest('a')).toHaveAttribute('href', '/groups/g1/members')
    // It moved OUT of the Members box — inside it, it read as a property of
    // that list rather than of the whole group.
    expect(screen.queryByText('View all attributes →')).toBeNull()
  })

  it('hovering a member reveals the attributes they submitted for this group', async () => {
    mockTimelineGroup()
    render(<GroupPage />)
    await screen.findByTestId('group-chat')

    expect(screen.queryByTestId('member-hover-card')).toBeNull()
    fireEvent.mouseEnter(screen.getByText('arjun-h1b').closest('div.relative')!)

    const card = await screen.findByTestId('member-hover-card')
    expect(within(card).getByText(/2026-03-01/)).toBeInTheDocument()
    expect(within(card).getByText(/filed early/)).toBeInTheDocument()
  })

  it('shows no hover card for a member who has not submitted', async () => {
    mockTimelineGroup()
    render(<GroupPage />)
    await screen.findByTestId('group-chat')

    fireEvent.mouseEnter(screen.getByText('mei-f1').closest('div.relative')!)
    expect(screen.queryByTestId('member-hover-card')).toBeNull()
  })

  it('clicking a member opens their profile in a modal', async () => {
    mockTimelineGroup()
    render(<GroupPage />)
    await screen.findByTestId('group-chat')

    expect(screen.queryByTestId('modal-scrim')).toBeNull()
    fireEvent.click(screen.getByText('mei-f1'))

    expect(await screen.findByTestId('modal-scrim')).toBeInTheDocument()
    expect(screen.getByTestId('author-section')).toHaveTextContent('demo-mei')
  })
})

describe('GroupPage — editing your own attributes', () => {
  it('prefills the form from your submitted values and upserts to /attributes', async () => {
    mockTimelineGroup()
    render(<GroupPage />)
    await screen.findByTestId('group-chat')

    fireEvent.click(await screen.findByText(/Edit your stem-opt-extension attributes/))

    const input = screen.getByLabelText(/Date Applied/) as HTMLInputElement
    expect(input.value).toBe('2026-03-01')

    fireEvent.change(input, { target: { value: '2026-04-02' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const call = (global.fetch as unknown as Mock).mock.calls.find(
        (c) => String(c[0]).includes('/attributes') && c[1]?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(call![1].body).values.ead_filed_date).toBe('2026-04-02')
    })
  })

  it('offers no Edit affordance to a member who has not submitted anything', async () => {
    mockTimelineGroup([])
    render(<GroupPage />)
    await screen.findByTestId('group-chat')
    expect(screen.queryByText(/Edit your/)).toBeNull()
  })
})

describe('GroupPage — Leave Group (any member)', () => {
  it('shows a Leave group affordance for a non-admin member', async () => {
    mockGroup({ is_admin: false })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    expect(screen.getByText('Leave group')).toBeInTheDocument()
  })

  it('shows an inline confirm step, and Cancel backs out without calling leave', async () => {
    mockGroup()
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Leave group'))
    expect(await screen.findByText(/Leave this group/)).toBeInTheDocument()

    fireEvent.click(screen.getByText('Cancel'))
    expect(screen.queryByText(/Leave this group\?/)).toBeNull()
    expect((global.fetch as unknown as Mock).mock.calls.some((c) => String(c[0]).includes('/leave'))).toBe(false)
  })

  it('confirming leave POSTs to /leave and navigates to /find', async () => {
    mockGroup()
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Leave group'))
    fireEvent.click(await screen.findByText('Confirm leave'))

    await waitFor(() => {
      const call = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/leave'))
      expect(call).toBeTruthy()
    })
    await waitFor(() => expect(mockPush).toHaveBeenCalledWith('/find'))
  })

  it('surfaces an error and resets the confirm step when leave fails', async () => {
    global.fetch = vi.fn(async (url: string, opts?: { method?: string }) => {
      if (String(url).includes('/leave')) {
        return { ok: false, status: 404, json: async () => ({ detail: 'Group not found' }) } as Response
      }
      return { ok: true, status: 200, json: async () => BASE_GROUP } as Response
    }) as unknown as typeof fetch
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Leave group'))
    fireEvent.click(await screen.findByText('Confirm leave'))

    expect(await screen.findByText('Group not found')).toBeInTheDocument()
    expect(mockPush).not.toHaveBeenCalled()
    expect(screen.queryByText('Confirm leave')).toBeNull()
  })
})

describe('GroupPage — Timeline rename lock', () => {
  it('shows "Edit description" instead of "Rename" for a Timeline group admin, and no name input', async () => {
    mockGroup({ is_admin: true, group_type: 'timeline' })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    expect(screen.queryByText('Rename')).toBeNull()
    expect(screen.getByText('Edit description')).toBeInTheDocument()

    fireEvent.click(screen.getByText('Edit description'))
    expect(screen.queryByDisplayValue('Mumbai H-1B crew')).toBeNull()
    expect(screen.getByText('Mumbai H-1B crew')).toBeInTheDocument()
  })

  it('saving only sends {description} in the PUT body for a Timeline group — no name key', async () => {
    mockGroup({ is_admin: true, group_type: 'timeline' })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Edit description'))
    const descInput = screen.getByPlaceholderText("What's this group for?")
    fireEvent.change(descInput, { target: { value: 'updated cohort description' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const putCall = (global.fetch as unknown as Mock).mock.calls.find((c) => c[1]?.method === 'PUT')
      expect(putCall).toBeTruthy()
    })
    const putCall = (global.fetch as unknown as Mock).mock.calls.find((c) => c[1]?.method === 'PUT')!
    expect(JSON.parse(putCall[1].body)).toEqual({ description: 'updated cohort description' })
  })
})

describe('GroupPage — Group details metadata panel', () => {
  it('renders created date, status, expiration, and the full criteria breakdown — but NOT the creator', async () => {
    mockGroup({
      status: 'active', expiration_date: '2027-01-01T00:00:00.000Z', created_by_username: 'arjun-h1b',
      criteria_tags: {
        current_visa_or_greencard_category: ['H-1B'], visa_applying_for: ['EB-2'], consulates: ['BOM'],
        tags: ['rfe-experience'], key_stages_or_info: { stem_opt_cycle: 'Fall' },
      },
    })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    expect(screen.getByText('Group details')).toBeInTheDocument()
    // The creator is already flagged with an Admin badge in the Members list,
    // so naming them here said the same thing twice.
    expect(screen.queryByText(/Created by/)).toBeNull()
    expect(screen.getAllByText(/^Created /).length).toBeGreaterThan(0)
    expect(screen.getByText(/Expires/)).toBeInTheDocument()
    expect(screen.getAllByText(/H-1B/).length).toBeGreaterThan(0)
    expect(screen.getByText(/EB-2/)).toBeInTheDocument()
    expect(screen.getByText(/rfe-experience/)).toBeInTheDocument()
    expect(screen.getByText(/Fall/)).toBeInTheDocument()
  })

  it('shows "Expired" instead of "Expires" once the group is archived', async () => {
    mockGroup({ status: 'archived', expiration_date: '2020-01-01T00:00:00.000Z' })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    expect(screen.getByText(/Expired/)).toBeInTheDocument()
    expect(screen.queryByText(/^Expires/)).toBeNull()
  })
})

describe('GroupPage — Archive/Unarchive (admin-only)', () => {
  it('does not show an Archive control for a non-admin viewer', async () => {
    mockGroup({ is_admin: false })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')
    expect(screen.queryByText('Archive group')).toBeNull()
  })

  it('clicking Archive group posts {archived:true} and updates the status badge', async () => {
    let status = 'active'
    global.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      if (String(url).includes('/archive')) {
        const body = JSON.parse(opts?.body || '{}')
        status = body.archived ? 'archived' : 'active'
        return { ok: true, status: 200, json: async () => ({ ...BASE_GROUP, is_admin: true, status }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({ ...BASE_GROUP, is_admin: true, status }) } as Response
    }) as unknown as typeof fetch
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    fireEvent.click(screen.getByText('Archive group'))

    await waitFor(() => {
      const archiveCall = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/archive'))
      expect(archiveCall).toBeTruthy()
    })
    const archiveCall = (global.fetch as unknown as Mock).mock.calls.find((c) => String(c[0]).includes('/archive'))!
    expect(JSON.parse((archiveCall[1] as { body: string }).body)).toEqual({ archived: true })
    expect(await screen.findByText('Unarchive group')).toBeInTheDocument()
  })
})

describe('GroupPage — non-member view of an archived group', () => {
  it('hides the Join button and shows an archived note instead', async () => {
    mockGroup({ is_member: false, status: 'archived' })
    render(<GroupPage />)
    await screen.findByText('Mumbai H-1B crew')

    expect(screen.queryByText('Join group')).toBeNull()
    expect(screen.getByText(/archived and no longer accepting new members/)).toBeInTheDocument()
  })
})

describe('GroupPage — an all-optional template never blocks the join', () => {
  // I-485's shape: one row, explicitly optional. Without the required:false
  // declaration, required_keys()'s row-0 fallback would make it mandatory.
  const AOS_TEMPLATES = {
    'adjustment-of-status': [
      { kind: 'date', label: 'Priority Date', field: 'key_dates', key: 'priority_date', required: false },
    ],
  }
  const AOS_GROUP = {
    ...BASE_GROUP, group_type: 'timeline',
    criteria_tags: { tags: ['EAD'], current_visa_or_greencard_category: ['adjustment-of-status'] },
    needs_attributes: true,
  }

  function mockAos() {
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (String(url).includes('/api/tag-vocab')) {
        return { ok: true, status: 200, json: async () => ({ post_join_attribute_templates: AOS_TEMPLATES }) } as Response
      }
      if (String(url).includes('/invitations')) return { ok: true, status: 200, json: async () => ({ invitations: [] }) } as Response
      if (String(url).includes('/attributes') && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ...AOS_GROUP, needs_attributes: false }) } as Response
      }
      if (String(url).includes('/attributes')) return { ok: true, status: 200, json: async () => ({ attributes: [] }) } as Response
      return { ok: true, status: 200, json: async () => AOS_GROUP } as Response
    }) as unknown as typeof fetch
  }

  it('asks for the priority date on the group page and marks nothing required', async () => {
    mockAos()
    render(<GroupPage />)

    const pd = await screen.findByLabelText('Priority Date')
    expect(pd).toHaveAttribute('type', 'date')
    // No asterisk anywhere — the * marker is only rendered for required rows.
    expect(screen.queryByText('*')).toBeNull()
  })

  it('lets you save with nothing filled in', async () => {
    mockAos()
    render(<GroupPage />)
    await screen.findByLabelText('Priority Date')

    const save = screen.getByText('Save')
    expect(save).not.toBeDisabled()
    fireEvent.click(save)

    await waitFor(() => {
      const call = (global.fetch as unknown as Mock).mock.calls.find(
        (c) => String(c[0]).includes('/attributes') && c[1]?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(call![1].body).values).toEqual({})
    })
  })
})

describe('GroupPage — attribute controls follow the template kind', () => {
  const KIND_TEMPLATES = {
    'stem-opt-extension': [
      { kind: 'date', label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' },
      { kind: 'select', label: 'Status', field: 'key_stages_or_info', key: 'application_status',
        options: ['approved', 'pending', 'denied', 'RFE', 'NOID'] },
      { kind: 'checkbox', label: 'Premium Processing', field: 'key_stages_or_info', key: 'premium_processing' },
    ],
  }

  /** Timeline group where the viewer still owes their attributes (the gate). */
  function mockGate() {
    const gated = {
      ...BASE_GROUP, group_type: 'timeline',
      criteria_tags: { tags: ['stem-opt-extension'] }, needs_attributes: true,
    }
    global.fetch = vi.fn(async (url: string, opts?: RequestInit) => {
      if (String(url).includes('/api/tag-vocab')) {
        return { ok: true, status: 200, json: async () => ({ post_join_attribute_templates: KIND_TEMPLATES }) } as Response
      }
      if (String(url).includes('/invitations')) return { ok: true, status: 200, json: async () => ({ invitations: [] }) } as Response
      // The upsert answers with the refreshed GroupCard, not the attribute list.
      if (String(url).includes('/attributes') && opts?.method === 'POST') {
        return { ok: true, status: 200, json: async () => ({ ...gated, needs_attributes: false }) } as Response
      }
      if (String(url).includes('/attributes')) return { ok: true, status: 200, json: async () => ({ attributes: [] }) } as Response
      return { ok: true, status: 200, json: async () => gated } as Response
    }) as unknown as typeof fetch
  }

  it('renders a date input, a select with the template options, and a checkbox', async () => {
    mockGate()
    render(<GroupPage />)

    const date = await screen.findByLabelText(/Date Applied/)
    expect(date).toHaveAttribute('type', 'date')

    const status = screen.getByLabelText('Status') as HTMLSelectElement
    expect(status.tagName).toBe('SELECT')
    expect([...status.options].map((o) => o.value))
      .toEqual(['', 'approved', 'pending', 'denied', 'RFE', 'NOID'])

    expect(screen.getByLabelText('Premium Processing')).toHaveAttribute('type', 'checkbox')
  })

  it('submits a ticked checkbox as "yes" and an unticked one not at all', async () => {
    mockGate()
    render(<GroupPage />)

    fireEvent.change(await screen.findByLabelText(/Date Applied/), { target: { value: '2027-02-01' } })
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'RFE' } })
    fireEvent.click(screen.getByLabelText('Premium Processing'))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const call = (global.fetch as unknown as Mock).mock.calls.find(
        (c) => String(c[0]).includes('/attributes') && c[1]?.method === 'POST',
      )
      expect(call).toBeTruthy()
      expect(JSON.parse(call![1].body).values).toEqual({
        ead_filed_date: '2027-02-01', application_status: 'RFE', premium_processing: 'yes',
      })
    })
  })
})

describe('GroupPage — long member lists collapse', () => {
  const MANY = Array.from({ length: 8 }, (_, i) => ({ user_id: `u${i}`, username: `member-${i}` }))

  it('shows only the first 5, then reveals the rest on demand', async () => {
    mockGroup({ members: MANY, created_by: 'u0' })
    render(<GroupPage />)

    await screen.findByText(/Members \(8\)/)
    expect(screen.getByText('member-4')).toBeInTheDocument()
    expect(screen.queryByText('member-5')).toBeNull()

    fireEvent.click(screen.getByText('Show all members…'))

    expect(await screen.findByText('member-7')).toBeInTheDocument()
    expect(screen.queryByText('Show all members…')).toBeNull()
  })

  it('shows no link when the group fits', async () => {
    mockGroup({ members: MANY.slice(0, 5) })
    render(<GroupPage />)

    await screen.findByText(/Members \(5\)/)
    expect(screen.getByText('member-4')).toBeInTheDocument()
    expect(screen.queryByText('Show all members…')).toBeNull()
  })
})
