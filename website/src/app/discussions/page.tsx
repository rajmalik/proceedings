'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import PostingCardComponent, { type PostingCardData } from '@/components/PostingCard'
import SuggestedFilters, { facetId, type SuggestedFilterGroup } from '@/components/SuggestedFilters'

type SearchResponse = {
  results: PostingCardData[]
  next_page_token: string
  total: number
  suggested_filters: SuggestedFilterGroup[]
}

export default function DiscussionsPage() {
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
    // tags:discussion OR tags:blog is the hard filter that scopes results to
    // non-personal content (general topic chat, shared news reactions,
    // standalone how-to/explainer write-ups) — the same OR-within-field
    // facet mechanism the News tab uses for doc_kind:gov_news, just on a
    // different field (api.py's _facets_filter). `sort=event` orders by
    // the posting's own date, same as News.
    const qs = new URLSearchParams({ sort: 'event', page_size: '20' })
    qs.append('facet', 'tags:discussion')
    qs.append('facet', 'tags:blog')
    if (q) qs.set('q', q)
    facets.forEach((f) => qs.append('facet', f))
    if (pageToken) qs.set('page_token', pageToken)
    fetch(`/api/search?${qs.toString()}`)
      .then(async (res) => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.detail || 'Could not load discussions')
        return json as SearchResponse
      })
      .then((data) => {
        setItems((prev) => (isMore ? [...prev, ...data.results] : data.results))
        setTotal(data.total || 0)
        setNextPageToken(data.next_page_token || '')
        if (!isMore) setSuggested(data.suggested_filters || [])
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load discussions'))
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
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-headline-lg text-primary mb-2">Discussions</h1>
          <p className="text-body-md text-on-surface-variant">
            General immigration topics, shared articles, and how-to guides — not tied to one person&apos;s case.
          </p>
        </div>
        <Link
          href="/post?type=discussion"
          className="btn-primary rounded-full flex items-center gap-1.5 shrink-0 whitespace-nowrap"
        >
          <span className="material-symbols-outlined text-[20px]">edit_square</span>
          <span className="hidden sm:inline">Start a discussion</span>
        </Link>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); submit(input) }}
        className="mb-6 max-w-2xl relative flex items-center bg-surface-container-lowest border border-outline-variant rounded-full focus-within:border-primary transition-all shadow-sm"
      >
        <span className="material-symbols-outlined text-on-surface-variant ml-4">search</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search discussions by topic, visa type…"
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
          {loading && <div className="card text-on-surface-variant">Loading discussions…</div>}
          {error && <div className="card text-error">{error}</div>}
          {!loading && !error && items.length === 0 && (
            <div className="card text-on-surface-variant">
              {query || selectedFacets.length > 0
                ? 'No discussions match that search — try a different topic.'
                : 'No discussions yet — check back soon.'}
            </div>
          )}

          {!loading && items.length > 0 && (
            <div className="space-y-4 max-w-3xl">
              <p className="text-label-md text-on-surface-variant">{total} discussions</p>
              {items.map((item) => (
                <PostingCardComponent key={item.case_id} r={item} />
              ))}

              {nextPageToken && (
                <button
                  onClick={() => load(query, selectedFacets, nextPageToken)}
                  disabled={loadingMore}
                  className="w-full py-3 text-label-md text-primary border border-outline-variant rounded-xl hover:bg-surface-container transition-colors disabled:opacity-50"
                >
                  {loadingMore ? 'Loading…' : 'Load older discussions'}
                </button>
              )}
            </div>
          )}
        </main>
      </div>
    </div>
  )
}
