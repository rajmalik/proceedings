import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted spies so the vi.mock factories can reference them.
const { push, writePostDraft } = vi.hoisted(() => ({ push: vi.fn(), writePostDraft: vi.fn() }))
// pathname defaults to a non-home route so the fixed bottom-right launcher
// renders in these tests (on "/" the launcher is inline in UnifiedSearch).
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }), usePathname: () => '/find' }))
vi.mock('@/lib/assistDraft', () => ({ writePostDraft }))
vi.mock('@/lib/assistSession', () => ({ getAssistSessionId: () => 'sess-test' }))
// activeUser pulls in Firebase init at import time (throws in the test env with
// no Firebase config); we only need userHeaders here.
vi.mock('@/lib/activeUser', () => ({ userHeaders: (extra: Record<string, string> = {}) => ({ ...extra }) }))
vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }))

import AiAssist from '@/components/AiAssist'

function resp(over: Record<string, unknown> = {}) {
  return {
    intent: 'answer-gov', confidence: 0.9, answer: '', source_tier: '',
    citations: [], community_cards: [], clarify_questions: [],
    post_draft: null, timeline: null, find_url: '', search_suggestions_html: '', disclaimer: 'Not legal advice.',
    can_post: true, can_find_timeline: false, can_find_similar: false, rationale: '', id: 'x', turns_used: 1,
    ...over,
  }
}

function fetchReturns(...responses: Array<{ ok?: boolean; status?: number; data: unknown }>) {
  const f = vi.fn()
  for (const r of responses) {
    f.mockResolvedValueOnce({ ok: r.ok ?? true, status: r.status ?? 200, json: async () => r.data })
  }
  ;(global as unknown as { fetch: unknown }).fetch = f
  return f
}

function ask(text = 'hi') {
  // The chatbot is collapsed by default — open it before interacting.
  const launcher = screen.queryByRole('button', { name: 'Ask AI/Post' })
  if (launcher) fireEvent.click(launcher)
  fireEvent.change(screen.getByLabelText('Ask or post a question'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
}

beforeEach(() => {
  push.mockClear(); writePostDraft.mockClear(); localStorage.clear(); sessionStorage.clear()
})

describe('AiAssist', () => {
  it('is collapsed by default: shows the "Ask AI/Post" launcher, not the chat input', () => {
    render(<AiAssist />)
    expect(screen.getByRole('button', { name: 'Ask AI/Post' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Ask or post a question')).toBeNull()
  })

  it('expands on launch and collapses again (no separate Post button)', () => {
    render(<AiAssist />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI/Post' }))
    expect(screen.getByLabelText('Ask or post a question')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(screen.queryByLabelText('Ask or post a question')).toBeNull()
    expect(screen.getByRole('button', { name: 'Ask AI/Post' })).toBeInTheDocument()
  })

  it('renders a grounded answer with a dated source and the single static disclaimer', async () => {
    fetchReturns({ data: resp({
      answer: 'The H-1B grace period is 60 days.', source_tier: 'gov',
      citations: [{ source: 'https://uscis.gov/x', title: 'USCIS grace period', as_of: '2026-09-01' }],
    }) })
    render(<AiAssist />)
    ask('grace period?')
    expect(await screen.findByText('The H-1B grace period is 60 days.')).toBeInTheDocument()
    const link = screen.getByText('USCIS grace period').closest('a')
    expect(link).toHaveAttribute('href', 'https://uscis.gov/x')
    expect(screen.getByText(/as of 2026-09-01/)).toBeInTheDocument()
    // Disclaimer is a single static footer, NOT repeated per answer.
    expect(screen.getAllByText(/not legal advice/i)).toHaveLength(1)
  })

  it('shows the small-print disclaimer at the bottom whenever the chat is open', () => {
    render(<AiAssist />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask AI/Post' }))
    expect(screen.getByText(/general information about U\.S\. immigration, not legal advice/i)).toBeInTheDocument()
  })

  it('persists the conversation across remounts (navigation)', async () => {
    fetchReturns({ data: resp({ answer: 'Persisted answer body.' }) })
    const { unmount } = render(<AiAssist />)
    ask('remember this')
    await screen.findByText('Persisted answer body.')
    unmount()
    // A fresh mount (as if on another page) restores the open state + turns.
    render(<AiAssist />)
    expect(await screen.findByText('Persisted answer body.')).toBeInTheDocument()
    expect(screen.getByLabelText('Ask or post a question')).toBeInTheDocument()
  })

  it('renders community cards that link back to the original posting (Q9)', async () => {
    fetchReturns({ data: resp({
      intent: 'answer-community', source_tier: 'community', answer: '',
      community_cards: [{ case_id: 'p1', title: 'Mumbai 221g', snippet: 'took 3 weeks', url: 'https://reddit.com/p1', channel: 'reddit' }],
    }) })
    render(<AiAssist />)
    ask('anyone seen 221g at Mumbai?')
    const link = (await screen.findByText('Mumbai 221g')).closest('a')
    expect(link).toHaveAttribute('href', 'https://reddit.com/p1')
  })

  it('renders clarifying questions', async () => {
    fetchReturns({ data: resp({ intent: 'clarify', answer: '', clarify_questions: ['What is your current status?'] }) })
    render(<AiAssist />)
    ask('help')
    expect(await screen.findByText('What is your current status?')).toBeInTheDocument()
  })

  it('post handoff: forces a draft, writes it to sessionStorage, and navigates to /post', async () => {
    fetchReturns(
      { data: resp({ answer: 'Here is some info.', can_post: true }) },
      { data: resp({ intent: 'post', answer: '', post_draft: { title: 'My RFE case', description: 'desc', groups: {}, key_stages_or_info: {}, key_dates: {} } }) },
    )
    render(<AiAssist />)
    ask('I got an RFE on my H-1B')
    await screen.findByText('Here is some info.')
    fireEvent.click(screen.getByRole('button', { name: 'Post this to the community' }))
    await waitFor(() => expect(writePostDraft).toHaveBeenCalledTimes(1))
    expect(writePostDraft).toHaveBeenCalledWith(expect.objectContaining({ title: 'My RFE case' }))
    expect(push).toHaveBeenCalledWith('/post')
  })

  it('find-similar: routes to /find Regular via the deep-link button', async () => {
    fetchReturns({ data: resp({
      intent: 'find-similar', answer: '', can_find_similar: true,
      find_url: '/find?type=regular&q=H-1B+Mumbai',
    }) })
    render(<AiAssist />)
    ask('anyone else on H-1B who filed at Mumbai?')
    fireEvent.click(await screen.findByRole('button', { name: /Find people in the same boat/i }))
    expect(push).toHaveBeenCalledWith('/find?type=regular&q=H-1B+Mumbai')
  })

  it('timeline found: links to the /groups/{id} cohort', async () => {
    fetchReturns({ data: resp({
      intent: 'timeline-find', answer: '', can_find_timeline: true,
      timeline: { status: 'found', group_id: 'g-9', group_name: 'EAD-stem-opt-extension-Aug-2026', criteria: {} },
    }) })
    render(<AiAssist />)
    ask('how long is EAD taking?')
    const link = (await screen.findByText(/Open your timeline group/)).closest('a')
    expect(link).toHaveAttribute('href', '/groups/g-9')
  })

  it('web tier: shows the "live search" label + renders the Search-Suggestion chips', async () => {
    fetchReturns({ data: resp({
      answer: 'Naturalization takes about 8 months.', source_tier: 'web',
      citations: [{ source: 'https://vertexaisearch.google/redirect/A', title: 'uscis.gov', as_of: '' }],
      search_suggestions_html: '<div class="g-chips">Search on Google</div>',
    }) })
    render(<AiAssist />)
    ask('how long is naturalization taking?')
    expect(await screen.findByText('Naturalization takes about 8 months.')).toBeInTheDocument()
    expect(screen.getByText(/live search of official sources/i)).toBeInTheDocument()
    // the compliance chips (Google-provided HTML) are rendered
    expect(screen.getByTestId('ai-search-suggestions').innerHTML).toContain('g-chips')
    // citation link uses the redirect uri with the domain as label
    expect(screen.getByText('uscis.gov').closest('a')).toHaveAttribute('href', 'https://vertexaisearch.google/redirect/A')
    // web answers are grounded -> no "search further" buttons
    expect(screen.queryByRole('button', { name: 'Search community forum' })).toBeNull()
  })

  it('offers community + USCIS search ONLY when the answer is ungrounded', async () => {
    fetchReturns({ data: resp({ answer: 'General guidance about AR-11.', source_tier: 'ungrounded' }) })
    render(<AiAssist />)
    ask('what form for change of address?')
    await screen.findByText('General guidance about AR-11.')
    fireEvent.click(screen.getByRole('button', { name: 'Search community forum' }))
    expect(push).toHaveBeenCalledWith(expect.stringContaining('/advanced-search?q='))
    const uscis = screen.getByRole('link', { name: 'Search on USCIS.gov' })
    expect(uscis.getAttribute('href')).toContain('uscis.gov')
  })

  it('hides the search-further buttons on a confident grounded answer', async () => {
    fetchReturns({ data: resp({ answer: 'Grounded answer.', source_tier: 'gov' }) })
    render(<AiAssist />)
    ask('a grounded question')
    await screen.findByText('Grounded answer.')
    expect(screen.queryByRole('button', { name: 'Search community forum' })).toBeNull()
  })

  it('clears the conversation with "New chat"', async () => {
    fetchReturns({ data: resp({ answer: 'Answer that should be cleared.' }) })
    render(<AiAssist />)
    ask('hello')
    await screen.findByText('Answer that should be cleared.')
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }))
    expect(screen.queryByText('Answer that should be cleared.')).toBeNull()
    expect(screen.getByLabelText('Ask or post a question')).toBeInTheDocument()  // still open, fresh
  })

  it('shows a sign-in nudge on the 429 guest cap', async () => {
    fetchReturns({ ok: false, status: 429, data: { detail: 'guest limit' } })
    render(<AiAssist />)
    ask('another one')
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument()
  })
})
