import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted spies so the vi.mock factories can reference them.
const { push, writePostDraft } = vi.hoisted(() => ({ push: vi.fn(), writePostDraft: vi.fn() }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
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
    post_draft: null, timeline: null, disclaimer: 'Not legal advice.',
    can_post: true, can_find_timeline: false, rationale: '', id: 'x', turns_used: 1,
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
  const launcher = screen.queryByRole('button', { name: 'Ask / Post a Question' })
  if (launcher) fireEvent.click(launcher)
  fireEvent.change(screen.getByLabelText('Ask or post a question'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Ask' }))
}

beforeEach(() => {
  push.mockClear(); writePostDraft.mockClear(); localStorage.clear()
})

describe('AiAssist', () => {
  it('is collapsed by default: shows the "Ask / Post a Question" launcher, not the chat input', () => {
    render(<AiAssist />)
    expect(screen.getByRole('button', { name: 'Ask / Post a Question' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Ask or post a question')).toBeNull()
  })

  it('expands on launch and collapses again (no separate Post button)', () => {
    render(<AiAssist />)
    fireEvent.click(screen.getByRole('button', { name: 'Ask / Post a Question' }))
    expect(screen.getByLabelText('Ask or post a question')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }))
    expect(screen.queryByLabelText('Ask or post a question')).toBeNull()
    expect(screen.getByRole('button', { name: 'Ask / Post a Question' })).toBeInTheDocument()
  })

  it('renders a grounded answer with the inline disclaimer and a dated source', async () => {
    fetchReturns({ data: resp({
      answer: 'The H-1B grace period is 60 days.', source_tier: 'gov',
      citations: [{ source: 'https://uscis.gov/x', title: 'USCIS grace period', as_of: '2026-09-01' }],
    }) })
    render(<AiAssist />)
    ask('grace period?')
    expect(await screen.findByText('The H-1B grace period is 60 days.')).toBeInTheDocument()
    expect(screen.getByText('Not legal advice.')).toBeInTheDocument()
    const link = screen.getByText('USCIS grace period').closest('a')
    expect(link).toHaveAttribute('href', 'https://uscis.gov/x')
    expect(screen.getByText(/as of 2026-09-01/)).toBeInTheDocument()
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

  it('timeline found: links to the /groups/{id} cohort', async () => {
    fetchReturns({ data: resp({
      intent: 'timeline-find', answer: '', can_find_timeline: true,
      timeline: { status: 'found', group_id: 'g-9', group_name: 'EAD-stem-opt-extension-Aug-2026', criteria: {} },
    }) })
    render(<AiAssist />)
    ask('how long is EAD taking?')
    const link = (await screen.findByText(/Join & post in your group/)).closest('a')
    expect(link).toHaveAttribute('href', '/groups/g-9')
  })

  it('shows a sign-in nudge on the 429 guest cap', async () => {
    fetchReturns({ ok: false, status: 429, data: { detail: 'guest limit' } })
    render(<AiAssist />)
    ask('another one')
    expect(await screen.findByText(/sign in/i)).toBeInTheDocument()
  })
})
