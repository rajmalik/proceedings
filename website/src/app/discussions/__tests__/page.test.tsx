import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Child components pull heavier transitive deps (posting cards, vote controls);
// this page's own behavior under test is the header + the create entry point.
vi.mock('@/components/PostingCard', () => ({ default: () => null }))
vi.mock('@/components/SuggestedFilters', () => ({
  default: () => null,
  facetId: (field: string, code: string) => `${field}:${code}`,
}))

import DiscussionsPage from '../page'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, json: async () => ({ results: [], total: 0, next_page_token: '', suggested_filters: [] }),
  })))
})

describe('DiscussionsPage', () => {
  it('offers a "Start a discussion" entry that deep-links to /post?type=discussion', async () => {
    render(<DiscussionsPage />)
    const link = await screen.findByRole('link', { name: /Start a discussion/i })
    expect(link).toHaveAttribute('href', '/post?type=discussion')
  })
})
