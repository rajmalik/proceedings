import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import PostPage from '../page'

// Active user = demo-arjun; userHeaders forwards it as X-User-Id (as the real lib does).
// searchParams is mutable so discussion-mode tests can set ?type=discussion.
const { sp } = vi.hoisted(() => ({ sp: { value: new URLSearchParams() } }))
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => sp.value, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }))
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, loading: false, signOut: vi.fn() }) }))
vi.mock('@/lib/activeUser', () => ({
  getActiveUser: vi.fn(() => 'demo-arjun'),
  userHeaders: vi.fn((h?: Record<string, string>) => ({ ...(h || {}), 'X-User-Id': 'demo-arjun' })),
  DEMO_PICKER_ENABLED: true,
}))

const json = (data: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => data }) as Response

const EMPTY_GROUPS = {
  visa_applying_for: [],
  current_visa_or_greencard_category: [],
  primary_consulate: '',
  consulates: [],
  tags: [],
  concerns_or_questions_tags: [],
}
const VOCAB = {
  visa: ['H-1B', 'F-1'], consulate: ['BOM'],
  consulate_options: [{ code: 'BOM', label: 'Mumbai, India (BOM)' }], consulate_tree: [],
  tag: ['premium-processing'], stage_key: [], date_key: [], outcome: [], country: [],
  misc: [], misc_options: [], profile_stage_key: [], stage_value_domains: {},
}
// The author's saved profile says H-1B; the message will say F-1 → a conflict.
const PROFILE = {
  username: 'arjun-h1b', current_visa_or_greencard_category: ['H-1B'], visa_applying_for: [],
  primary_consulate: 'BOM', consulates: ['BOM'], tags: [], key_stages_or_info: {}, key_dates: {},
  background_text: '', journey: [],
}

let putBody: Record<string, unknown> | null = null
let profileReadHeader: string | undefined
let putHeader: string | undefined

function mockApi() {
  putBody = null; profileReadHeader = undefined; putHeader = undefined
  global.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string; headers?: Record<string, string> }) => {
    const u = String(url); const method = opts?.method || 'GET'
    const xuid = opts?.headers?.['X-User-Id']
    if (u.includes('/api/tag-vocab')) return json(VOCAB)
    if (u.includes('/api/tag-suggest')) {
      return json({
        groups: { ...EMPTY_GROUPS, current_visa_or_greencard_category: ['F-1'] }, // message says F-1
        relevant_sections: ['current_visa_or_greencard_category'], posting_type: 'in_us_status',
        key_stages_or_info: {}, key_dates: {},
      })
    }
    if (u.includes('/api/reconcile')) {
      return json({
        merged: { ...EMPTY_GROUPS, current_visa_or_greencard_category: ['F-1'], consulates: ['BOM'], primary_consulate: 'BOM', key_stages_or_info: {}, key_dates: {} },
        conflicts: [{ field: 'current_visa_or_greencard_category', profile_value: ['H-1B'], message_value: ['F-1'] }],
        prefilled: [],
      })
    }
    if (u.includes('/api/profile') && method === 'PUT') {
      putHeader = xuid; putBody = JSON.parse(opts!.body as string)
      return json({ ...PROFILE, ...putBody })
    }
    if (u.includes('/api/profile')) { profileReadHeader = xuid; return json(PROFILE) }
    return json({})
  }) as unknown as typeof fetch
}

beforeEach(() => { sp.value = new URLSearchParams(); mockApi() })

async function previewWithConflict() {
  render(<PostPage />)
  fireEvent.change(screen.getByPlaceholderText(/H-1B extension with an RFE/), { target: { value: 'F-1 OPT to STEM OPT' } })
  fireEvent.change(screen.getByPlaceholderText(/Describe your situation/), {
    target: { value: 'I am currently on an F-1 student visa on OPT applying for the STEM OPT extension.' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
  // The reconcile conflict surfaces the "Update my profile to match" offer.
  expect(await screen.findByText('Update my profile to match')).toBeInTheDocument()
}

describe('PostPage — reconcile + update-profile-to-match (profile ↔ message)', () => {
  it('shows the conflict when the message disagrees with the saved profile', async () => {
    await previewWithConflict()
    // The conflict (H-1B vs F-1) is shown to the user.
    expect(screen.getByText(/profile: H-1B → this post: F-1/i)).toBeInTheDocument()
  })

  it('"Update my profile to match" PUTs the message value and confirms', async () => {
    await previewWithConflict()
    fireEvent.click(screen.getByText('Update my profile to match'))

    // The PUT must apply the conflict's message_value to the profile field…
    await waitFor(() => expect(putBody).not.toBeNull())
    expect(putBody?.current_visa_or_greencard_category).toEqual(['F-1'])
    // …targeted at the active user (X-User-Id forwarded for both read and write)…
    expect(profileReadHeader).toBe('demo-arjun')
    expect(putHeader).toBe('demo-arjun')
    // …and the UI confirms it persisted.
    expect(await screen.findByText(/Profile updated/)).toBeInTheDocument()
  })

  it('does not lose other profile fields on update (full profile re-sent)', async () => {
    await previewWithConflict()
    fireEvent.click(screen.getByText('Update my profile to match'))
    await waitFor(() => expect(putBody).not.toBeNull())
    // username/consulates from the existing profile are preserved in the PUT.
    expect(putBody?.username).toBe('arjun-h1b')
    expect(putBody?.consulates).toEqual(['BOM'])
  })
})

// A generic family-immigration/employment-immigration (backend:
// posting.py's _apply_visa_backfill(), a last-resort fallback meant for
// manual curation with no original poster to ask) must never be enough to
// enable Submit for a LIVE app user, who's right here and can always be
// asked directly for the specific category instead.
describe('PostPage — generic visa-fallback gating (family-immigration / employment-immigration)', () => {
  function mockTagSuggest(groups: Partial<typeof EMPTY_GROUPS>) {
    global.fetch = vi.fn(async (url: string) => {
      const u = String(url)
      if (u.includes('/api/tag-vocab')) return json(VOCAB)
      if (u.includes('/api/tag-suggest')) {
        return json({
          groups: { ...EMPTY_GROUPS, ...groups },
          relevant_sections: ['current_visa_or_greencard_category'], posting_type: 'general_question',
          key_stages_or_info: {}, key_dates: {},
        })
      }
      if (u.includes('/api/reconcile')) return json({}, false, 404) // no active user path exercised here
      return json({})
    }) as unknown as typeof fetch
  }

  async function previewWith(groups: Partial<typeof EMPTY_GROUPS>) {
    mockTagSuggest(groups)
    render(<PostPage />)
    fireEvent.change(screen.getByPlaceholderText(/H-1B extension with an RFE/), { target: { value: 'General I-130/I-485 question' } })
    fireEvent.change(screen.getByPlaceholderText(/Describe your situation/), {
      target: { value: 'For those who filed I-130 and I-485 at the same time, how long until approval?' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Review tags')
  }

  it('a generic-only category does NOT enable Submit, and shows the "need the exact category" message', async () => {
    await previewWith({ current_visa_or_greencard_category: ['family-immigration'] })
    expect(screen.getByRole('button', { name: /Submit posting/ })).toBeDisabled()
    expect(screen.getByText(/need the exact category/i)).toBeInTheDocument()
    // The generic value is still shown as a removable chip, not hidden.
    expect(screen.getByText('family-immigration')).toBeInTheDocument()
  })

  it('employment-immigration alone also does NOT enable Submit', async () => {
    await previewWith({ current_visa_or_greencard_category: ['employment-immigration'] })
    expect(screen.getByRole('button', { name: /Submit posting/ })).toBeDisabled()
  })

  it('a SPECIFIC code (e.g. IR-1) alongside — or instead of — the generic one DOES enable Submit', async () => {
    await previewWith({ current_visa_or_greencard_category: ['family-immigration', 'IR-1'] })
    expect(screen.getByRole('button', { name: /Submit posting/ })).not.toBeDisabled()
    expect(screen.queryByText(/need the exact category/i)).toBeNull()
  })

  it('no visa signal at all still shows the ORIGINAL generic-empty message, not the fallback-specific one', async () => {
    await previewWith({})
    expect(screen.getByRole('button', { name: /Submit posting/ })).toBeDisabled()
    expect(screen.getByText(/Add at least one visa\/status under/i)).toBeInTheDocument()
    expect(screen.queryByText(/need the exact category/i)).toBeNull()
  })

  it('a specific visa_applying_for code alone (unrelated to the fallback) still enables Submit as before', async () => {
    await previewWith({ visa_applying_for: ['H-1B'] })
    expect(screen.getByRole('button', { name: /Submit posting/ })).not.toBeDisabled()
  })
})

// /post?type=discussion (and =blog) reuses this composer to author a
// Discussions-feed entry: it carries the discussion/blog tag, hides the visa
// sections, and RELAXES the visa gate (a general topic post needs no personal
// visa). See DISCUSSION_KINDS in the page.
describe('PostPage — discussion/blog mode (reuse /post for the Discussions feed)', () => {
  let postingsBody: Record<string, unknown> | null

  function mockDiscussionApi() {
    postingsBody = null
    global.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      const u = String(url)
      if (u.includes('/api/tag-vocab')) return json(VOCAB)
      // tag-suggest emits no visa/status — a general topic post.
      if (u.includes('/api/tag-suggest')) return json({
        groups: { ...EMPTY_GROUPS }, relevant_sections: ['tags'],
        posting_type: 'general_question', key_stages_or_info: {}, key_dates: {},
      })
      if (u.includes('/api/reconcile')) return json({}, false, 404) // exercise the no-reconcile branch
      if (u.includes('/api/postings') && opts?.method === 'POST') {
        postingsBody = JSON.parse(opts!.body as string)
        return json({ case_id: 'disc-1', author_handle: 'anon-panda' })
      }
      return json({})
    }) as unknown as typeof fetch
  }

  async function previewDiscussion() {
    render(<PostPage />)
    fireEvent.change(screen.getByPlaceholderText(/H-1B extension with an RFE/), { target: { value: 'How premium processing actually works' } })
    fireEvent.change(screen.getByPlaceholderText(/Describe your situation/), {
      target: { value: 'A general explainer on premium processing timelines and eligibility across form types.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Review tags')
  }

  it('renders the discussion heading for ?type=discussion', async () => {
    sp.value = new URLSearchParams('type=discussion')
    mockDiscussionApi()
    render(<PostPage />)
    expect(await screen.findByRole('heading', { name: 'Start a discussion' })).toBeInTheDocument()
  })

  it('relaxes the visa gate: Submit is enabled with NO visa, and the visa-required message is hidden', async () => {
    sp.value = new URLSearchParams('type=discussion')
    mockDiscussionApi()
    await previewDiscussion()
    expect(screen.getByRole('button', { name: /Submit posting/ })).not.toBeDisabled()
    expect(screen.queryByText(/Add at least one visa\/status under/i)).toBeNull()
  })

  it('hides the visa/status sections in discussion mode', async () => {
    sp.value = new URLSearchParams('type=discussion')
    mockDiscussionApi()
    await previewDiscussion()
    expect(screen.queryByText('Visa/category applying for')).toBeNull()
    expect(screen.queryByText('Current status')).toBeNull()
  })

  it('submits the posting with the discussion tag attached', async () => {
    sp.value = new URLSearchParams('type=discussion')
    mockDiscussionApi()
    await previewDiscussion()
    fireEvent.click(screen.getByRole('button', { name: /Submit posting/ }))
    await waitFor(() => expect(postingsBody).not.toBeNull())
    const tags = (postingsBody!.tags as { tags: string[] }).tags
    expect(tags).toContain('discussion')
    expect(tags).not.toContain('blog')
  })

  it('toggling to Blog swaps the tag on the submitted posting', async () => {
    sp.value = new URLSearchParams('type=discussion')
    mockDiscussionApi()
    render(<PostPage />)
    // switch kind before writing
    fireEvent.click(screen.getByRole('button', { name: 'Blog / how-to' }))
    fireEvent.change(screen.getByPlaceholderText(/H-1B extension with an RFE/), { target: { value: 'A how-to on RFE responses' } })
    fireEvent.change(screen.getByPlaceholderText(/Describe your situation/), {
      target: { value: 'Step-by-step guide to responding to a Request for Evidence, generically.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Review tags')
    fireEvent.click(screen.getByRole('button', { name: /Submit posting/ }))
    await waitFor(() => expect(postingsBody).not.toBeNull())
    const tags = (postingsBody!.tags as { tags: string[] }).tags
    expect(tags).toContain('blog')
    expect(tags).not.toContain('discussion')
  })

  it('normal mode (no ?type) is unchanged: default heading, visa gate still enforced', async () => {
    // sp defaults to empty in beforeEach → normal posting mode.
    render(<PostPage />)
    expect(await screen.findByRole('heading', { name: 'Post a new message' })).toBeInTheDocument()
  })
})

// STEM OPT unified timeline (features/stem-opt-timeline-9/, Phase 2): when
// tag-suggest tags a posting `stem-opt-extension`, the composer shows the shared
// structured timeline card (prefilled from the parsed dates/stages) in place of
// the generic key-date/stage rows, and the structured fields are submitted.
describe('PostPage — STEM OPT timeline card', () => {
  let stemBody: Record<string, unknown> | null

  function mockStemApi(
    groupsOver: Record<string, unknown> = {},
    keyDates: Record<string, string> = { ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' },
  ) {
    stemBody = null
    global.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      const u = String(url)
      if (u.includes('/api/tag-vocab')) return json(VOCAB)
      if (u.includes('/api/tag-suggest')) return json({
        groups: { ...EMPTY_GROUPS, visa_applying_for: ['F-1'], tags: ['stem-opt-extension'], ...groupsOver },
        relevant_sections: ['visa_applying_for'], posting_type: 'in_us_status',
        key_stages_or_info: { application_status: 'approved' },
        key_dates: keyDates,
      })
      if (u.includes('/api/reconcile')) return json({}, false, 404)
      if (u.includes('/api/postings') && opts?.method === 'POST') {
        stemBody = JSON.parse(opts!.body as string)
        return json({ case_id: 'app-stem-1', author_handle: 'anon' })
      }
      return json({})
    }) as unknown as typeof fetch
  }

  async function previewStem(
    groupsOver: Record<string, unknown> = {},
    keyDates?: Record<string, string>,
  ) {
    mockStemApi(groupsOver, keyDates)
    render(<PostPage />)
    fireEvent.change(screen.getByPlaceholderText(/H-1B extension with an RFE/), { target: { value: 'STEM OPT approved after 190 days' } })
    fireEvent.change(screen.getByPlaceholderText(/Describe your situation/), {
      target: { value: 'Filed my I-765 for the STEM OPT extension on 2026-03-18, approved 2026-09-17.' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    await screen.findByText('Review tags')
  }

  it('shows the timeline card prefilled and hides the generic key-date rows', async () => {
    await previewStem()
    expect(screen.getByTestId('stem-opt-timeline-card')).toBeInTheDocument()
    expect((screen.getByLabelText('Date applied (I-765 filed)') as HTMLInputElement).value).toBe('2026-03-18')
    expect(screen.getByTestId('stem-opt-summary')).toHaveTextContent('Filed Mar 2026')
    // the generic "Key dates" section is replaced by the card
    expect(screen.queryByText('Key dates')).toBeNull()
  })

  it('does NOT show the card for a non-STEM-OPT posting', async () => {
    await previewStem({ tags: [] })  // no stem-opt-extension tag
    expect(screen.queryByTestId('stem-opt-timeline-card')).toBeNull()
  })

  it('submits with the structured STEM OPT timeline fields', async () => {
    await previewStem()
    fireEvent.click(screen.getByRole('button', { name: /Submit posting/ }))
    await waitFor(() => expect(stemBody).not.toBeNull())
    const keyDates = stemBody!.key_dates as Record<string, string>
    const keyStages = stemBody!.key_stages_or_info as Record<string, string>
    expect(keyDates.ead_filed_date).toBe('2026-03-18')
    expect(keyDates.ead_approved_date).toBe('2026-09-17')
    expect(keyStages.application_status).toBe('approved')
  })

  // Phase 3 (posting → cohort cross-link): after a STEM OPT posting publishes,
  // the success screen offers the matching EAD·stem-opt Timeline cohort, deep-
  // linked from ead_filed_date. When the filed date was not parsed, it asks for
  // just that date, then reveals the link. It never auto-joins.
  describe('STEM OPT posting → cohort bridge', () => {
    async function submitStem(keyDates?: Record<string, string>) {
      await previewStem({}, keyDates)
      fireEvent.click(screen.getByRole('button', { name: /Submit posting/ }))
      await screen.findByText('Posted!')
    }

    it('deep-links to the EAD·stem-opt cohort derived from the filed date', async () => {
      await submitStem()
      const link = (await screen.findByTestId('stem-opt-cohort-link')) as HTMLAnchorElement
      expect(link.getAttribute('href')).toBe(
        '/find?type=timeline&processing_type=EAD&eligibility=stem-opt-extension&filing_month=Mar&filing_year=2026'
      )
    })

    it('asks for the I-765 filing date when it was not parsed, then reveals the link', async () => {
      await submitStem({})  // no ead_filed_date parsed
      expect(screen.queryByTestId('stem-opt-cohort-link')).toBeNull()
      const input = screen.getByLabelText('I-765 filing date') as HTMLInputElement
      fireEvent.change(input, { target: { value: '2026-03-18' } })
      const link = (await screen.findByTestId('stem-opt-cohort-link')) as HTMLAnchorElement
      expect(link.getAttribute('href')).toContain('filing_month=Mar&filing_year=2026')
    })

    it('does NOT show the cohort bridge for a non-STEM-OPT posting', async () => {
      // non-STEM posting: tag-suggest without the stem-opt-extension tag
      global.fetch = vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
        const u = String(url)
        if (u.includes('/api/tag-vocab')) return json(VOCAB)
        if (u.includes('/api/tag-suggest')) return json({
          groups: { ...EMPTY_GROUPS, visa_applying_for: ['H-1B'], tags: ['h1b-extension'] },
          relevant_sections: ['visa_applying_for'], posting_type: 'in_us_status',
          key_stages_or_info: {}, key_dates: {},
        })
        if (u.includes('/api/reconcile')) return json({}, false, 404)
        if (u.includes('/api/postings') && opts?.method === 'POST') return json({ case_id: 'app-h1b-1', author_handle: 'anon' })
        return json({})
      }) as unknown as typeof fetch
      render(<PostPage />)
      fireEvent.change(screen.getByPlaceholderText(/H-1B extension with an RFE/), { target: { value: 'H-1B extension approved' } })
      fireEvent.change(screen.getByPlaceholderText(/Describe your situation/), { target: { value: 'H-1B extension approved.' } })
      fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
      await screen.findByText('Review tags')
      fireEvent.click(screen.getByRole('button', { name: /Submit posting/ }))
      await screen.findByText('Posted!')
      expect(screen.queryByTestId('stem-opt-cohort-link')).toBeNull()
      expect(screen.queryByLabelText('I-765 filing date')).toBeNull()
    })
  })
})
