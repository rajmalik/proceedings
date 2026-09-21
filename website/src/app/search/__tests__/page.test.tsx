import { describe, it, expect, vi, beforeEach } from 'vitest'
import SearchPageRedirect from '../page'

const mockRedirect = vi.fn()
vi.mock('next/navigation', () => ({
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(), redirect: (url: string) => mockRedirect(url) }))

beforeEach(() => mockRedirect.mockClear())

// "/search" was replaced by "/" as the Home/search page (features/ui-changes-1),
// kept only as a redirect so old bookmarked/shared /search links (including
// any ?q=&mode= they carried) keep working instead of 404ing.
describe('SearchPageRedirect', () => {
  it('redirects to "/" with no query string when there are no search params', async () => {
    await SearchPageRedirect({ searchParams: Promise.resolve({}) })
    expect(mockRedirect).toHaveBeenCalledWith('/')
  })

  it('preserves a single string param (e.g. ?q=...)', async () => {
    await SearchPageRedirect({ searchParams: Promise.resolve({ q: 'H-1B RFE' }) })
    expect(mockRedirect).toHaveBeenCalledWith('/?q=H-1B+RFE')
  })

  it('preserves multiple params, including repeated array-valued ones (e.g. facet=...)', async () => {
    await SearchPageRedirect({
      searchParams: Promise.resolve({
        q: 'H-1B',
        facet: ['visa_applying_for:H-1B', 'tags:RFE'],
      }),
    })
    const url = mockRedirect.mock.calls[0][0] as string
    expect(url.startsWith('/?')).toBe(true)
    const params = new URLSearchParams(url.slice(2))
    expect(params.get('q')).toBe('H-1B')
    expect(params.getAll('facet')).toEqual(['visa_applying_for:H-1B', 'tags:RFE'])
  })
})
