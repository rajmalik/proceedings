import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import VoteControl from '../VoteControl'

vi.mock('@/lib/activeUser', () => ({
  getActiveUser: vi.fn(() => 'demo-arjun'),
  userHeaders: vi.fn(() => ({})),
}))
import { getActiveUser } from '@/lib/activeUser'

function mockFetchOnce(body: object) {
  ;(global.fetch as unknown as Mock).mockResolvedValueOnce({ ok: true, json: async () => body })
}

beforeEach(() => {
  global.fetch = vi.fn()
  ;(getActiveUser as unknown as Mock).mockReturnValue('demo-arjun')
})

describe('VoteControl', () => {
  it('renders the initial score', () => {
    render(<VoteControl contentId="c1" score={7} yourVote={0} />)
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('upvotes optimistically, then reconciles to the server value', async () => {
    let resolve!: (v: unknown) => void
    ;(global.fetch as unknown as Mock).mockReturnValueOnce(new Promise((r) => { resolve = r }))
    render(<VoteControl contentId="c1" score={4} yourVote={0} />)

    fireEvent.click(screen.getByLabelText('Upvote'))
    // optimistic: 4 -> 5 immediately, before the request resolves
    expect(screen.getByText('5')).toBeInTheDocument()

    resolve({ ok: true, json: async () => ({ up: 9, down: 0, score: 9, your_vote: 1 }) })
    await screen.findByText('9') // server-authoritative value

    const [url, opts] = (global.fetch as unknown as Mock).mock.calls[0]
    expect(url).toBe('/api/votes')
    expect(opts.method).toBe('POST')
    expect(JSON.parse(opts.body)).toEqual({ content_id: 'c1', dir: 1 })
  })

  it('toggles an existing upvote off (sends dir 0)', async () => {
    mockFetchOnce({ up: 0, down: 0, score: 4, your_vote: 0 })
    render(<VoteControl contentId="c1" score={5} yourVote={1} />)

    fireEvent.click(screen.getByLabelText('Upvote'))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(JSON.parse((global.fetch as unknown as Mock).mock.calls[0][1].body)).toEqual({ content_id: 'c1', dir: 0 })
  })

  it('switches from up to down (sends dir -1)', async () => {
    mockFetchOnce({ up: 0, down: 1, score: 3, your_vote: -1 })
    render(<VoteControl contentId="c1" score={5} yourVote={1} />)

    fireEvent.click(screen.getByLabelText('Downvote'))
    await waitFor(() => expect(global.fetch).toHaveBeenCalled())
    expect(JSON.parse((global.fetch as unknown as Mock).mock.calls[0][1].body)).toEqual({ content_id: 'c1', dir: -1 })
  })

  it('does not call the API when no user is active, and hints to sign in', async () => {
    ;(getActiveUser as unknown as Mock).mockReturnValue('')
    render(<VoteControl contentId="c1" score={2} yourVote={0} />)

    fireEvent.click(screen.getByLabelText('Upvote'))
    await waitFor(() => expect(screen.getByTitle('Sign in to vote')).toBeInTheDocument())
    expect(global.fetch).not.toHaveBeenCalled()
    expect(screen.getByText('2')).toBeInTheDocument() // unchanged
  })

  it('reverts the optimistic score when the request fails', async () => {
    ;(global.fetch as unknown as Mock).mockResolvedValueOnce({ ok: false, json: async () => ({ detail: 'nope' }) })
    render(<VoteControl contentId="c1" score={4} yourVote={0} />)

    fireEvent.click(screen.getByLabelText('Upvote'))
    await waitFor(() => expect(screen.getByText('4')).toBeInTheDocument()) // reverted from optimistic 5
  })
})
