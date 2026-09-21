import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import Replies from '../Replies'
import type { ReplyCardData } from '../ReplyItem'

// No Firebase session in these tests — the demo-picker mock below (which
// getActiveUser() falls back to) is what drives hasUser, same as before.
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: null, loading: false }) }))
vi.mock('@/lib/activeUser', () => ({
  getActiveUser: vi.fn(() => 'demo-arjun'),
  userHeaders: vi.fn(() => ({})),
  DEMO_PICKER_ENABLED: true,
}))
import { getActiveUser } from '@/lib/activeUser'

const ZERO = { up: 0, down: 0, score: 0, your_vote: 0 }

function reply(over: Partial<ReplyCardData> = {}): ReplyCardData {
  return {
    id: 'r1', parent_case_id: 'p1', body: 'first reply', author_handle: 'mei-f1',
    created_at: new Date().toISOString(), deleted: false,
    up: 1, down: 0, score: 1, your_vote: 0, is_author: false, ...over,
  }
}

function mockList(replies: ReplyCardData[], posting = ZERO) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ replies, posting, total: replies.length }),
  })
}

beforeEach(() => {
  ;(getActiveUser as unknown as Mock).mockReturnValue('demo-arjun')
})

describe('Replies', () => {
  it('shows the composer when a user is active', async () => {
    mockList([])
    render(<Replies postingId="p1" />)
    expect(await screen.findByPlaceholderText(/Share your experience/i)).toBeInTheDocument()
  })

  it('gates the composer behind sign-in when no user is active', async () => {
    ;(getActiveUser as unknown as Mock).mockReturnValue('')
    mockList([])
    render(<Replies postingId="p1" />)
    expect(await screen.findByText(/Sign in/i)).toBeInTheDocument()
    expect(screen.queryByPlaceholderText(/Share your experience/i)).toBeNull()
  })

  it('renders fetched replies with a count', async () => {
    mockList([reply()])
    render(<Replies postingId="p1" />)
    expect(await screen.findByText('first reply')).toBeInTheDocument()
    expect(screen.getByText('mei-f1')).toBeInTheDocument()
    expect(screen.getByText('(1)')).toBeInTheDocument()
  })

  it('reports the posting tally to the parent via onPostingTally', async () => {
    mockList([], { up: 5, down: 1, score: 4, your_vote: 1 })
    const onTally = vi.fn()
    render(<Replies postingId="p1" onPostingTally={onTally} />)
    await waitFor(() => expect(onTally).toHaveBeenCalledWith({ up: 5, down: 1, score: 4, your_vote: 1 }))
  })
})
