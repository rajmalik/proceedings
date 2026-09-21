import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import CaseDetailsPage from '../page'

// (Vitest hoists vi.mock — only `mock`-prefixed vars may be referenced inside.)
const mockBack = vi.fn()
const mockPush = vi.fn()

// Route param + Link (→ plain anchor so we can read hrefs) + the heavy children
// the case page composes (each of which fetches on its own — stub them out).
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ id: 'app-1' }),
  useRouter: () => ({ back: mockBack, push: mockPush }),
}))
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}))
vi.mock('@/components/Markdown', () => ({ default: ({ children }: { children: string }) => <div>{children}</div> }))
vi.mock('@/components/VoteControl', () => ({ default: () => <div data-testid="vote" /> }))
vi.mock('@/components/Replies', () => ({ default: () => <div data-testid="replies" /> }))
vi.mock('@/components/AuthorSection', () => ({
  default: ({ authorId }: { authorId: string }) => <div data-testid="author-section">AS:{authorId}</div>,
}))

const BASE = {
  case_id: 'app-1', title: 'My H-1B experience', description: '', visa: ['H-1B'],
  consulates: [], outcome: '', subreddit: '', channel: 'app', tags: [], url: '',
  date: '2026-06-13', body: 'hello', author_id: '', author_handle: '', tag_sections: [],
}

function mockPosting(overrides: Record<string, unknown>) {
  global.fetch = vi.fn(async () => ({
    ok: true, status: 200, json: async () => ({ ...BASE, ...overrides }),
  })) as unknown as typeof fetch
}

const handleLink = () => document.querySelector('a[href^="/author-by-handle/"]') as HTMLAnchorElement | null

describe('CaseDetailsPage — author panel', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('first-party posting (handle, no captured uid): shows the handle as a clickable author link', async () => {
    mockPosting({ channel: 'app', author_id: '', author_handle: 'brave-maple-3272' })
    render(<CaseDetailsPage />)

    const link = await waitFor(() => {
      const l = handleLink()
      expect(l).not.toBeNull()
      return l!
    })
    expect(link).toHaveAttribute('href', '/author-by-handle/brave-maple-3272')
    expect(link.textContent).toContain('brave-maple-3272')
    // the rich uid-based profile section must NOT render in this case
    expect(screen.queryByTestId('author-section')).toBeNull()
  })

  it('in-app author (real uid): renders the rich AuthorSection, not the handle link', async () => {
    mockPosting({ channel: 'app', author_id: 'user-9', author_handle: 'brave-maple-3272' })
    render(<CaseDetailsPage />)

    const section = await screen.findByTestId('author-section')
    expect(section).toHaveTextContent('AS:user-9')
    expect(handleLink()).toBeNull()
  })

  it('external (Reddit) posting: shows no author link and no AuthorSection', async () => {
    mockPosting({ channel: 'reddit', author_id: '', author_handle: '' })
    render(<CaseDetailsPage />)

    // wait until the posting has loaded (title rendered), then assert no author UI
    await screen.findByText('My H-1B experience')
    expect(handleLink()).toBeNull()
    expect(screen.queryByTestId('author-section')).toBeNull()
  })
})

// features/ui-changes-1/changes-2-.md item 3: "Back to Search" used to be a
// hardcoded <Link href="/"> that reset all search state on every visit.
// router.back() instead lands on the history entry UnifiedSearch already
// kept in sync with the full prior search (query + facets).
describe('CaseDetailsPage — "Back to Search"', () => {
  beforeEach(() => { vi.restoreAllMocks(); mockBack.mockClear(); mockPush.mockClear() })

  it('calls router.back() (not a plain navigation to "/") when history exists', async () => {
    mockPosting({})
    Object.defineProperty(window, 'history', { value: { length: 2 }, configurable: true })
    render(<CaseDetailsPage />)

    await screen.findByText('My H-1B experience')
    screen.getByText('Back to Search').click()
    expect(mockBack).toHaveBeenCalledTimes(1)
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('falls back to push("/") when there is no real history to pop', async () => {
    mockPosting({})
    Object.defineProperty(window, 'history', { value: { length: 1 }, configurable: true })
    render(<CaseDetailsPage />)

    await screen.findByText('My H-1B experience')
    screen.getByText('Back to Search').click()
    expect(mockPush).toHaveBeenCalledWith('/')
    expect(mockBack).not.toHaveBeenCalled()
  })
})

// Reported live: an "Original Content" section heading above the posting's
// own body read as redundant clutter — the body is shown directly now, no
// label needed (the AI summary sidebar box already has its own distinct
// label, so there's no ambiguity to disambiguate against).
describe('CaseDetailsPage — no "Original Content" heading', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the posting body without an "Original Content" section heading', async () => {
    mockPosting({ body: 'The full text of the posting.' })
    render(<CaseDetailsPage />)

    await screen.findByText('The full text of the posting.')
    expect(screen.queryByText('Original Content')).not.toBeInTheDocument()
  })
})
