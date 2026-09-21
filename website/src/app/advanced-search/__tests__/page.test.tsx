import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest'
import AdvancedSearchPage from '../page'

const VOCAB = {
  visa: ['H-1B', 'F-1'],
  consulate: ['BOM'],
  consulate_options: [{ code: 'BOM', label: 'Mumbai, India (BOM)' }],
  tag: ['rfe-experience', 'timeline'],
}

const POSTING = {
  case_id: 'app-1', title: 'H-1B RFE experience', description: '', visa: ['H-1B'],
  consulates: [], outcome: '', subreddit: '', channel: 'app', tags: [], url: '',
  date: '2026-07-28',
}

function mockFetch(overrides: {
  queryTags?: { field: string; code: string; label: string }[]
  search?: Record<string, unknown>
} = {}) {
  const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
    const method = opts?.method || 'GET'
    if (String(url).includes('/api/tag-vocab')) {
      return { ok: true, status: 200, json: async () => VOCAB } as Response
    }
    if (String(url).includes('/api/search/query-tags') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ tags: overrides.queryTags || [] }) } as Response
    }
    if (String(url).includes('/api/search')) {
      return {
        ok: true, status: 200,
        json: async () => ({
          results: [POSTING], total: 1, next_page_token: '',
          ...overrides.search,
        }),
      } as Response
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response
  }) as unknown as typeof fetch
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
})

describe('AdvancedSearchPage — header visibility', () => {
  it('shows no category sections initially, only "+ Add" pills', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Current status')).toBeInTheDocument())
    expect(screen.queryByText('Current status')).toBeNull()
    expect(screen.getByText('+ Add Applying for')).toBeInTheDocument()
    expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument()
    expect(screen.getByText('+ Add Tags')).toBeInTheDocument()
  })

  it('reveals only the category with a generated tag after Send', async () => {
    mockFetch({ queryTags: [{ field: 'visa_applying_for', code: 'H-1B', label: 'H-1B' }] })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Current status')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'H-1B experience' } })
    fireEvent.click(screen.getByText('Send'))

    expect(await screen.findByText('Applying for')).toBeInTheDocument()
    expect(screen.queryByText('Current status')).toBeNull()
    expect(screen.queryByText('+ Add Applying for')).toBeNull()
  })

  it('"+ Add" reveals an empty section', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Consulate(s)'))
    expect(await screen.findByText('Consulate(s)')).toBeInTheDocument()
    expect(screen.getByText('None.')).toBeInTheDocument()
  })
})

describe('AdvancedSearchPage — Send (tag generation)', () => {
  it('calls query-tags with the typed text', async () => {
    const fetchMock = mockFetch({ queryTags: [{ field: 'tags', code: 'rfe-experience', label: 'rfe-experience' }] })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'my RFE story' } })
    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/search/query-tags'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).includes('/api/search/query-tags'))!
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({ q: 'my RFE story' })
    expect(await screen.findByText('rfe-experience')).toBeInTheDocument()
  })

  it('a second Send resets the panel — replaces the previous tags/headers rather than merging', async () => {
    let call = 0
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method || 'GET'
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).includes('/api/search/query-tags') && method === 'POST') {
        call += 1
        const tags = call === 1
          ? [{ field: 'tags', code: 'rfe-experience', label: 'rfe-experience' }]
          : [{ field: 'consulates', code: 'BOM', label: 'BOM' }]
        return { ok: true, status: 200, json: async () => ({ tags }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    const input = screen.getByPlaceholderText(/H-1B RFE experiences/)

    fireEvent.change(input, { target: { value: 'first text' } })
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText('rfe-experience')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'second text' } })
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText('Mumbai, India (BOM)')).toBeInTheDocument()
    expect(screen.queryByText('rfe-experience')).toBeNull()
    expect(screen.queryByText('Tags')).toBeNull()
  })

  it('a repeat Send with an unchanged/overlapping result is still visibly reflected (no silent no-op)', async () => {
    const fetchMock = mockFetch({ queryTags: [{ field: 'tags', code: 'rfe-experience', label: 'rfe-experience' }] })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    const input = screen.getByPlaceholderText(/H-1B RFE experiences/)

    fireEvent.change(input, { target: { value: 'same text' } })
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText('rfe-experience')).toBeInTheDocument()
    fireEvent.click(screen.getByLabelText('Remove rfe-experience'))
    await waitFor(() => expect(screen.queryByText('rfe-experience')).toBeNull())

    fireEvent.click(screen.getByText('Send'))

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/search/query-tags'))
      expect(calls.length).toBe(2)
    })
    expect(await screen.findByText('rfe-experience')).toBeInTheDocument()
  })

  it('Send resets manually-added tags too, not just AI-generated ones (full reset)', async () => {
    const fetchMock = mockFetch({ queryTags: [{ field: 'consulates', code: 'BOM', label: 'BOM' }] })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Current status')).toBeInTheDocument())

    fireEvent.click(screen.getByText('+ Add Current status'))
    const statusInput = await screen.findByPlaceholderText('Search current status…')
    fireEvent.change(statusInput, { target: { value: 'H-1B' } })
    fireEvent.click(await screen.findByText('H-1B'))
    expect(screen.getByLabelText('Remove H-1B')).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'some text' } })
    fireEvent.click(screen.getByText('Send'))

    expect(await screen.findByText('Mumbai, India (BOM)')).toBeInTheDocument()
    expect(screen.queryByText('H-1B')).toBeNull()
    expect(screen.queryByText('Current status')).toBeNull()
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/api/search/query-tags')).length).toBe(1)
  })
})

describe('AdvancedSearchPage — Send error handling', () => {
  it('surfaces an error and stops generating when query-tags fails', async () => {
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method || 'GET'
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).includes('/api/search/query-tags') && method === 'POST') {
        return { ok: false, status: 503, json: async () => ({ detail: 'The assistant is temporarily unavailable.' }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Send'))

    expect(await screen.findByText('The assistant is temporarily unavailable.')).toBeInTheDocument()
    expect(screen.getByText('Send')).toBeInTheDocument()
    expect(screen.getByText('Send').closest('button')).not.toBeDisabled()
  })

  it('a failed second Send preserves the tags from the previous successful Send', async () => {
    let call = 0
    const fetchMock = vi.fn(async (url: string, opts?: { method?: string }) => {
      const method = opts?.method || 'GET'
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).includes('/api/search/query-tags') && method === 'POST') {
        call += 1
        if (call === 1) {
          return { ok: true, status: 200, json: async () => ({ tags: [{ field: 'tags', code: 'rfe-experience', label: 'rfe-experience' }] }) } as Response
        }
        return { ok: false, status: 503, json: async () => ({ detail: 'The assistant is temporarily unavailable.' }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    const input = screen.getByPlaceholderText(/H-1B RFE experiences/)

    fireEvent.change(input, { target: { value: 'first text' } })
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText('rfe-experience')).toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'second text' } })
    fireEvent.click(screen.getByText('Send'))

    expect(await screen.findByText('The assistant is temporarily unavailable.')).toBeInTheDocument()
    expect(screen.getByText('rfe-experience')).toBeInTheDocument()
  })

  it('disables Send while text is empty or whitespace-only', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    expect(screen.getByText('Send').closest('button')).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: '   ' } })
    expect(screen.getByText('Send').closest('button')).toBeDisabled()

    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'real text' } })
    expect(screen.getByText('Send').closest('button')).not.toBeDisabled()
  })
})

describe('AdvancedSearchPage — manual tag add/remove (search-to-select)', () => {
  it('typing a substring shows matching suggestions to pick from', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))

    const input = await screen.findByPlaceholderText('Search tags…')
    fireEvent.change(input, { target: { value: 'time' } })

    expect(await screen.findByText('timeline')).toBeInTheDocument()
  })

  it('clicking a suggestion adds it as a chip and clears the search box', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))

    const input = await screen.findByPlaceholderText('Search tags…') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'timeline' } })
    fireEvent.click(await screen.findByText('timeline'))

    expect(screen.getByLabelText('Remove timeline')).toBeInTheDocument()
    await waitFor(() => expect(input.value).toBe(''))
  })

  it('typing a substring with no matches shows no suggestions', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))

    const input = await screen.findByPlaceholderText('Search tags…')
    fireEvent.change(input, { target: { value: 'not-a-real-tag' } })

    expect(screen.queryByText('not-a-real-tag')).toBeNull()
  })

  it('a category revealed by Send stays visible (but empty) after its last tag is removed', async () => {
    mockFetch({ queryTags: [{ field: 'tags', code: 'timeline', label: 'timeline' }] })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Send'))
    await screen.findByText('timeline')

    fireEvent.click(screen.getByLabelText('Remove timeline'))

    await waitFor(() => expect(screen.queryByText('timeline')).toBeNull())
    expect(screen.getByText('Tags')).toBeInTheDocument()
    expect(screen.getByText('None.')).toBeInTheDocument()
    expect(screen.queryByText('+ Add Tags')).toBeNull()
  })

  it('removes a tag', async () => {
    mockFetch({ queryTags: [{ field: 'tags', code: 'timeline', label: 'timeline' }] })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Send'))
    expect(await screen.findByText('timeline')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Remove timeline'))
    await waitFor(() => expect(screen.queryByText('timeline')).toBeNull())
  })

  it('picking the same value twice does not create a duplicate chip', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))
    const input = await screen.findByPlaceholderText('Search tags…')

    fireEvent.change(input, { target: { value: 'timeline' } })
    fireEvent.click(await screen.findByText('timeline'))
    fireEvent.change(input, { target: { value: 'timeline' } })
    // Two "timeline" texts now exist (the chip already added + the
    // TagAutocomplete suggestion, which doesn't filter out already-selected
    // values) — the suggestion is the last one in document order.
    const matches = await screen.findAllByText('timeline')
    fireEvent.click(matches[matches.length - 1])

    await waitFor(() => expect(screen.getAllByText('timeline')).toHaveLength(1))
  })

  it('picks a consulate by its label, storing/displaying the resolved code', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Consulate(s)'))

    const input = await screen.findByPlaceholderText('Search a consulate (city/country)…')
    fireEvent.change(input, { target: { value: 'Mumbai' } })
    fireEvent.click(await screen.findByText('Mumbai, India (BOM)'))

    expect(screen.getByLabelText('Remove BOM')).toBeInTheDocument()
  })

  it('typing an unmatched consulate substring shows no suggestions', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Consulate(s)')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Consulate(s)'))

    const input = await screen.findByPlaceholderText('Search a consulate (city/country)…')
    fireEvent.change(input, { target: { value: 'Nowhere City' } })

    expect(screen.queryByText('Nowhere City')).toBeNull()
    expect(screen.queryByText(/is not a valid/)).toBeNull()
  })

  it('all four categories revealed leaves no "+ Add" pills', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Current status')).toBeInTheDocument())

    fireEvent.click(screen.getByText('+ Add Current status'))
    fireEvent.click(screen.getByText('+ Add Applying for'))
    fireEvent.click(screen.getByText('+ Add Consulate(s)'))
    fireEvent.click(screen.getByText('+ Add Tags'))

    await waitFor(() => expect(screen.queryByText(/^\+ Add/)).toBeNull())
  })
})

describe('AdvancedSearchPage — Match precision', () => {
  it('shows the Match precision control, defaulting to Balanced', async () => {
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Match precision')).toBeInTheDocument())
    expect(screen.getByText('Balanced')).toHaveClass('text-primary')
  })

  it('sends the selected precision level on Search', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Match precision')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Match precision'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).toContain('strictness=strict')
  })

  it('picks up a previously saved precision level from localStorage', async () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => (k === 'search-strictness' ? 'strict' : null), setItem: () => {} })
    mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Match precision')).toBeInTheDocument())
    expect(await screen.findByText('Strict')).toHaveClass('text-primary')
  })
})

describe('AdvancedSearchPage — News/Cutoff controls', () => {
  it('defaults to news included and all-time, sent explicitly on every search', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Include news articles')).toBeInTheDocument())
    expect(screen.getByRole('checkbox')).toBeChecked()

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).toContain('include_news=true')
    expect(String(call[0])).not.toContain('max_age_days')
  })

  it('unchecking "Include news articles" sends include_news=false', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Include news articles')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).toContain('include_news=false')
  })

  it('moving the Cutoff period slider sends the matching max_age_days', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Cutoff period')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Cutoff period'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).toContain('max_age_days=30')
    expect(await screen.findByText('30 days')).toHaveClass('text-primary')
  })

  it.each([
    ['1', '7', '7 days'],
    ['3', '90', '90 days'],
    ['4', '182', '6 months'],
    ['5', '365', '1 year'],
  ])('cutoff step %s sends max_age_days=%s (%s)', async (stepValue, expectedDays, expectedLabel) => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Cutoff period')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Cutoff period'), { target: { value: stepValue } })
    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).toContain(`max_age_days=${expectedDays}`)
    expect(await screen.findByText(expectedLabel)).toHaveClass('text-primary')
  })

  it('leaving the slider at "All time" never sends max_age_days, even combined with a tag filter', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))
    const input = await screen.findByPlaceholderText('Search tags…')
    fireEvent.change(input, { target: { value: 'timeline' } })
    fireEvent.click(await screen.findByText('timeline'))

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).not.toContain('max_age_days')
    expect(String(call[0])).toContain(encodeURIComponent('tags:timeline'))
  })

  it('re-checking "Include news articles" after unchecking it reverts to include_news=true', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Include news articles')).toBeInTheDocument())

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).toContain('include_news=true')
  })

  it('combines a tag filter, excluded news, and a cutoff window in the same request', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))
    const input = await screen.findByPlaceholderText('Search tags…')
    fireEvent.change(input, { target: { value: 'timeline' } })
    fireEvent.click(await screen.findByText('timeline'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Cutoff period'), { target: { value: '2' } })

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = String(fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))![0])
    expect(call).toContain(encodeURIComponent('tags:timeline'))
    expect(call).toContain('include_news=false')
    expect(call).toContain('max_age_days=30')
  })

  it('does not fire a search just from toggling the controls — only Search triggers a fetch', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Include news articles')).toBeInTheDocument())
    const callsBeforeToggle = fetchMock.mock.calls.length

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Cutoff period'), { target: { value: '3' } })

    expect(fetchMock.mock.calls.length).toBe(callsBeforeToggle)
  })

  it('Load more carries forward the same include_news/max_age_days as the initial search', async () => {
    let n = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).startsWith('/api/search?')) {
        n += 1
        return {
          ok: true, status: 200,
          json: async () => ({
            results: [{ ...POSTING, case_id: `app-${n}` }],
            total: 2, next_page_token: n === 1 ? 'p2' : '',
          }),
        } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('Include news articles')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.change(screen.getByLabelText('Cutoff period'), { target: { value: '2' } })
    fireEvent.click(screen.getByText('Search'))
    await screen.findByText('Load more')

    fireEvent.click(screen.getByText('Load more'))

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/search?'))
      expect(calls.length).toBe(2)
    })
    const secondCall = String(fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/search?'))[1][0])
    expect(secondCall).toContain('include_news=false')
    expect(secondCall).toContain('max_age_days=30')
    expect(secondCall).toContain('page_token=p2')
  })
})

describe('AdvancedSearchPage — Search', () => {
  it('runs /api/search with text + selected facets, renders results inline', async () => {
    const fetchMock = mockFetch({ queryTags: [{ field: 'visa_applying_for', code: 'H-1B', label: 'H-1B' }] })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())

    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'H-1B story' } })
    fireEvent.click(screen.getByText('Send'))
    await screen.findByText('H-1B')

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).toContain('q=H-1B')
    expect(String(call[0])).toContain(encodeURIComponent('visa_applying_for:H-1B'))
    expect(await screen.findByText('H-1B RFE experience')).toBeInTheDocument()
  })

  it('shows an empty-results message', async () => {
    mockFetch({ search: { results: [], total: 0, next_page_token: '' } })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search'))
    expect(await screen.findByText(/No postings matched your tags/)).toBeInTheDocument()
  })

  it('paginates via Load more, accumulating results', async () => {
    let n = 0
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).startsWith('/api/search?')) {
        n += 1
        return {
          ok: true, status: 200,
          json: async () => ({
            results: [{ ...POSTING, case_id: `app-${n}` }],
            total: 2, next_page_token: n === 1 ? 'p2' : '',
          }),
        } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search'))
    await screen.findByText('Load more')

    fireEvent.click(screen.getByText('Load more'))

    await waitFor(() => {
      const calls = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/search?'))
      expect(calls.length).toBe(2)
    })
    const secondCall = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith('/api/search?'))[1]
    expect(String(secondCall[0])).toContain('page_token=p2')
    await waitFor(() => expect(screen.queryByText('Load more')).toBeNull())
  })

  it('surfaces an error when /api/search fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).startsWith('/api/search?')) {
        return { ok: false, status: 500, json: async () => ({ detail: 'Search backend unavailable' }) } as Response
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search'))

    expect(await screen.findByText('Search backend unavailable')).toBeInTheDocument()
  })

  it('searching with tags only (no free text) sends no q param — a filler query would silently drop non-matching-but-tag-matching results', async () => {
    const fetchMock = mockFetch()
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('+ Add Tags'))
    const input = await screen.findByPlaceholderText('Search tags…')
    fireEvent.change(input, { target: { value: 'timeline' } })
    fireEvent.click(await screen.findByText('timeline'))

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))!
    expect(String(call[0])).not.toContain('q=')
    expect(String(call[0])).toContain(encodeURIComponent('tags:timeline'))
  })

  it('includes every selected tag across multiple categories as separate facet params', async () => {
    const fetchMock = mockFetch({
      queryTags: [
        { field: 'visa_applying_for', code: 'H-1B', label: 'H-1B' },
        { field: 'consulates', code: 'BOM', label: 'BOM' },
        { field: 'tags', code: 'timeline', label: 'timeline' },
      ],
    })
    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText(/H-1B RFE experiences/), { target: { value: 'x' } })
    fireEvent.click(screen.getByText('Send'))
    await screen.findByText('timeline')

    fireEvent.click(screen.getByText('Search'))

    await waitFor(() => {
      const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))
      expect(call).toBeTruthy()
    })
    const call = String(fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/search?'))![0])
    expect(call).toContain(encodeURIComponent('visa_applying_for:H-1B'))
    expect(call).toContain(encodeURIComponent('consulates:BOM'))
    expect(call).toContain(encodeURIComponent('tags:timeline'))
  })

  it('disables the Search button while a search is in flight', async () => {
    let resolveSearch: (v: Response) => void = () => {}
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('/api/tag-vocab')) return { ok: true, status: 200, json: async () => VOCAB } as Response
      if (String(url).startsWith('/api/search?')) {
        return new Promise<Response>((resolve) => { resolveSearch = resolve })
      }
      return { ok: true, status: 200, json: async () => ({}) } as Response
    }) as unknown as typeof fetch
    vi.stubGlobal('fetch', fetchMock)

    render(<AdvancedSearchPage />)
    await waitFor(() => expect(screen.getByText('+ Add Tags')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Search'))

    expect(await screen.findByText('Searching…')).toBeInTheDocument()
    expect(screen.getByText('Searching…').closest('button')).toBeDisabled()

    resolveSearch({ ok: true, status: 200, json: async () => ({ results: [], total: 0, next_page_token: '' }) } as Response)
    await waitFor(() => expect(screen.queryByText('Searching…')).toBeNull())
  })
})
