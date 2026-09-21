import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import AuthorByHandlePage from '../page'

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(), useParams: () => ({ handle: 'brave-maple-3272' }) }))
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}))

const POSTINGS = [
  { case_id: 'app-1', title: 'H-1B RFE experience', visa: ['H-1B'], consulates: ['BOM'], outcome: 'approved', date: '2026-06-13' },
  { case_id: 'app-2', title: 'EB-2 timeline update', visa: ['EB-2'], consulates: [], outcome: '', date: '2026-06-01' },
]

function mockPostings(postings: unknown[]) {
  global.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ postings }),
  })) as unknown as typeof fetch
}

describe('AuthorByHandlePage', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('lists the author handle’s postings with a count and links to each case', async () => {
    mockPostings(POSTINGS)
    render(<AuthorByHandlePage />)

    // handle shown as the page heading
    expect(await screen.findByRole('heading', { name: 'brave-maple-3272' })).toBeInTheDocument()
    // count reflects the number of postings
    expect(screen.getByText('Postings by brave-maple-3272 (2)')).toBeInTheDocument()
    // each posting title is rendered and links to its case page
    const first = screen.getByText('H-1B RFE experience').closest('a') as HTMLAnchorElement
    expect(first).toHaveAttribute('href', '/case/app-1')
    expect(screen.getByText('EB-2 timeline update').closest('a')).toHaveAttribute('href', '/case/app-2')

    // the fetch hit the by-handle proxy for this handle
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('/api/authors/by-handle/brave-maple-3272/postings'))
  })

  it('shows an empty state when the author has no postings', async () => {
    mockPostings([])
    render(<AuthorByHandlePage />)

    await waitFor(() => expect(screen.getByText('Postings by brave-maple-3272 (0)')).toBeInTheDocument())
    expect(screen.getByText('No postings found for this author.')).toBeInTheDocument()
  })
})
