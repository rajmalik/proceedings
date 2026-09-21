'use client'

import { useCallback, useEffect, useState } from 'react'
import PostingCardComponent, { type PostingCardData } from '@/components/PostingCard'
import SuggestedFilters, { facetId, type SuggestedFilterGroup } from '@/components/SuggestedFilters'

type SearchResponse = {
  results: PostingCardData[]
  next_page_token: string
  total: number
  suggested_filters: SuggestedFilterGroup[]
}

export default function NewsPage() {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [selectedFacets, setSelectedFacets] = useState<string[]>([])
  const [items, setItems] = useState<PostingCardData[]>([])
  const [total, setTotal] = useState(0)
  const [suggested, setSuggested] = useState<SuggestedFilterGroup[]>([])
  const [nextPageToken, setNextPageToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback((q: string, facets: string[], pageToken = '') => {
    const isMore = !!pageToken
    if (isMore) setLoadingMore(true)
    else setLoading(true)
    // doc_kind:gov_news is the hard filter that actually scopes results to
    // News — always present regardless of what's typed, so a topic search
    // never accidentally broadens into non-news content. `sort=event`
    // orders by the article's own original publish date (not when we
    // ingested it — see search_client.py's _SORT_FIELDS/api.py's /api/search
    // docstring), which is what "most recent" means for a news feed.
    const qs = new URLSearchParams({ facet: 'doc_kind:gov_news', sort: 'event', page_size: '20' })
    if (q) qs.set('q', q)
    facets.forEach((f) => qs.append('facet', f))
    if (pageToken) qs.set('page_token', pageToken)
    fetch(`/api/search?${qs.toString()}`)
      .then(async (res) => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.detail || 'Could not load news')
        return json as SearchResponse
      })
      .then((data) => {
        setItems((prev) => (isMore ? [...prev, ...data.results] : data.results))
        setTotal(data.total || 0)
        setNextPageToken(data.next_page_token || '')
        if (!isMore) setSuggested(data.suggested_filters || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load news'))
      .finally(() => {
        setLoading(false)
        setLoadingMore(false)
      })
  }, [])

  useEffect(() => {
    load('', [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submit(q: string) {
    const t = q.trim()
    setQuery(t)
    load(t, selectedFacets)
  }

  function toggleFacet(field: string, code: string) {
    const id = facetId(field, code)
    const next = selectedFacets.includes(id) ? selectedFacets.filter((x) => x !== id) : [...selectedFacets, id]
    setSelectedFacets(next)
    load(query, next)
  }

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-margin-desktop py-8">
      <div className="mb-6">
        <h1 className="text-headline-lg text-primary mb-2">News</h1>
        <p className="text-body-md text-on-surface-variant">
          Official updates from government immigration agencies.
        </p>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); submit(input) }}
        className="mb-6 max-w-2xl relative flex items-center bg-surface-container-lowest border border-outline-variant rounded-full focus-within:border-primary transition-all shadow-sm"
      >
        <span className="material-symbols-outlined text-on-surface-variant ml-4">search</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search news by topic, visa type, agency…"
          className="flex-1 px-4 py-3 bg-transparent border-none focus:ring-0 focus:outline-none text-body-md text-on-surface"
        />
        {input && (
          <button
            type="button"
            onClick={() => { setInput(''); submit('') }}
            aria-label="Clear search"
            className="p-1 mr-1 rounded-full hover:bg-surface-container text-on-surface-variant"
          >
            <span className="material-symbols-outlined text-[18px]">close</span>
          </button>
        )}
        <button type="submit" className="btn-primary rounded-full mr-2 my-2">Search</button>
      </form>

      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
        <aside className="space-y-4">
          {suggested.length > 0 && (
            <div className="bg-surface-container-low rounded-xl p-4">
              <SuggestedFilters
                groups={suggested}
                selected={new Set(selectedFacets)}
                onToggle={toggleFacet}
                title="Browse by topic"
              />
            </div>
          )}
        </aside>

        <main>
          {loading && <div className="card text-on-surface-variant">Loading news…</div>}
          {error && <div className="card text-error">{error}</div>}
          {!loading && !error && items.length === 0 && (
            <div className="card text-on-surface-variant">
              {query || selectedFacets.length > 0
                ? 'No news updates match that search — try a different topic.'
                : 'No news updates yet — check back soon.'}
            </div>
          )}

          {!loading && items.length > 0 && (
            <div className="space-y-4 max-w-3xl">
              <p className="text-label-md text-on-surface-variant">{total} updates</p>
              {items.map((item) => (
                <PostingCardComponent key={item.case_id} r={item} />
              ))}

              {nextPageToken && (
                <button
                  onClick={() => load(query, selectedFacets, nextPageToken)}
                  disabled={loadingMore}
                  className="w-full py-3 text-label-md text-primary border border-outline-variant rounded-xl hover:bg-surface-container transition-colors disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load older updates'}
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
