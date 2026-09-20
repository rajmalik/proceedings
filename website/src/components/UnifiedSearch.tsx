'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/contexts/AuthContext'
import { USER_KEY } from '@/lib/activeUser'
import PostingCard, { type PostingCardData } from '@/components/PostingCard'
import Markdown from '@/components/Markdown'
import { AppliedFilters } from '@/components/StrictnessSlider'
import SuggestedFilters, { facetId, type SuggestedFilterGroup } from '@/components/SuggestedFilters'

type QueryTag = { field: string; code: string; label: string }

// Facets encoded into the URL as repeated `facet=field:code` params — parses
// selectedFacets back out on mount so "Back to Search" (router.back()) can
// fully restore a prior search, not just its query text.
function parseFacetsFromUrl(sp: { getAll: (key: string) => string[] }): string[] {
  return sp.getAll('facet').filter(Boolean)
}

// Fallback label for a facet id with no known display label yet (e.g.
// restored from the URL on mount, before any click supplied one) — turns
// "tags:change-of-status-COS" into "Change Of Status COS".
function humanizeFacetId(id: string): string {
  const code = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id
  return code.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

type Turn = { id: string; role: 'user' | 'ai'; content: string }

// TODO (phase-H): Re-enable the AI-mode right panel. Disabled for now per
// posting-specs.md §2. When re-enabling, flip this to true and revisit the
// expert/follow-up UX (see TODO list / posting-specs "Disable AI mode").
const AI_MODE_ENABLED = false

const EXAMPLES = [
  'B1/B2 interview experience in Mumbai',
  'H-1B extension with an RFE',
  'F-1 to H-1B change of status',
]

export default function UnifiedSearch() {
  const router = useRouter()
  const params = useSearchParams()

  // Post entry lives here now (moved off the top bar): shown for Firebase users
  // AND dev-mode (demo picker) users — same gating the TopAppBar used.
  const { user } = useAuth()
  const [devUid, setDevUid] = useState('')
  useEffect(() => {
    if (typeof window !== 'undefined') setDevUid(localStorage.getItem(USER_KEY) || '')
  }, [])
  const canPost = !!(user || devUid)

  const [input, setInput] = useState(params.get('q') || '')
  const [query, setQuery] = useState(params.get('q') || '')
  const [selectedFacets, setSelectedFacets] = useState<string[]>(() => parseFacetsFromUrl(params))
  // Display labels for selectedFacets, keyed by facet id — independent of
  // the backend's `suggested_filters`/`applied_filters` responses, which
  // are recomputed from the CURRENT (already-filtered) result set and can
  // silently stop including a facet the user has selected, leaving no
  // affordance to remove it. This map is the client's own record of what's
  // active, so the "Active filters" chips below always have something to
  // render and remove, regardless of what the backend suggests next.
  const [facetLabels, setFacetLabels] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  const [queryTags, setQueryTags] = useState<QueryTag[]>([])

  // MIDDLE — postings search
  // 'browse' = default recent feed (no typed query, mirrors the mobile app's
  // Home tab); 'search' = a typed/faceted relevance query. `searched` gates
  // the brief pre-first-load empty state from the actual results list — the
  // initial browse fetch fires on mount, so this is rarely visible.
  const [mode, setMode] = useState<'browse' | 'search'>(params.get('q') ? 'search' : 'browse')
  const [searched, setSearched] = useState(false)
  const [results, setResults] = useState<PostingCardData[]>([])
  const [total, setTotal] = useState(0)
  const [nextPageToken, setNextPageToken] = useState('')
  const [appliedFilters, setAppliedFilters] = useState<Record<string, unknown>>({})
  const [relaxed, setRelaxed] = useState(false)
  const [suggested, setSuggested] = useState<SuggestedFilterGroup[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)

  // RIGHT — AI expert (non-grounded)
  const [expertTurns, setExpertTurns] = useState<Turn[]>([])
  const [expertLoading, setExpertLoading] = useState(false)
  const [expertInput, setExpertInput] = useState('')
  const [aiCollapsed, setAiCollapsed] = useState(false)
  const expertRef = useRef<HTMLDivElement>(null)

  const syncUrl = useCallback((q: string, facets: string[]) => {
    // This component now renders at "/" (the Home page) — keep the address
    // bar in sync with "/", not the old "/search" (which is now just a
    // redirect to here). Facets are included (not just q) so "Back to
    // Search" (case/[id]/page.tsx's router.back()) restores the full prior
    // search, not just its query text — see features/ui-changes-1/
    // changes-2-.md item 3.
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    facets.forEach((f) => p.append('facet', f))
    const qs = p.toString()
    router.replace(qs ? `/?${qs}` : '/', { scroll: false })
  }, [router])

  // Main search always runs at "balanced" precision — the Broad/Strict ends
  // of the slider are advanced-user tools, moved to /advanced-search so this
  // page's search stays a single one-box action.
  //
  // No filler text when q is empty (a facet-only refine, e.g. from "Refine
  // by" or the "Active filters" chips): the backend's Discovery Engine call
  // relevance-ranks against whatever `q` it receives IN ADDITION TO
  // applying the facet filter, so a non-empty filler string here silently
  // drops facet-matching documents that don't also relevance-match the
  // filler text — confirmed live: `tags:asylum` alone returns the correct
  // 24 postings; with a filler `q` it drops to 3. An empty `q` combined
  // with a facet filter is exactly what the backend's own hard-filter
  // branch is built to handle correctly (backend/api.py's /api/search).
  const searchQs = useCallback((q: string, facets: string[], pageToken: string) => {
    const p = new URLSearchParams()
    if (q) p.set('q', q)
    facets.forEach((f) => p.append('facet', f))
    p.set('strictness', 'balanced')
    p.set('page_size', '15')
    p.set('sort', 'event')
    if (pageToken) p.set('page_token', pageToken)
    return p.toString()
  }, [])

  // Default feed (no typed query): most-recent postings, auto-loaded — same
  // empty-query browse recipe the backend's /api/search already uses for the
  // mobile app's Home tab. Deliberately does NOT apply searchQs()'s relevance
  // fallback text, since an empty q is what routes to the recency-sorted
  // browse branch server-side rather than a relevance search.
  const loadFeedQs = useCallback((pageToken: string) => {
    const p = new URLSearchParams()
    p.set('sort', 'event')
    p.set('page_size', '15')
    if (pageToken) p.set('page_token', pageToken)
    return p.toString()
  }, [])

  // Query-derived tag chips (features/ui-changes-1/changes-2-.md item 4) — a
  // real Gemini call, so this fires once per search submit (not per
  // keystroke) and in parallel with runSearch, never blocking/delaying
  // results. Best-effort: a slow/failed call just leaves the chip row empty.
  const fetchQueryTags = useCallback(async (q: string) => {
    try {
      const res = await fetch('/api/search/query-tags', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q }),
      })
      if (!res.ok) return
      const data = await res.json()
      setQueryTags(data.tags || [])
    } catch {
      // best-effort — never surfaces an error for this
    }
  }, [])

  const loadFeed = useCallback(async () => {
    setSearchLoading(true); setError(''); setMode('browse')
    setSelectedFacets([]); setFacetLabels({}); setAppliedFilters({}); setRelaxed(false); setQueryTags([])
    try {
      const res = await fetch(`/api/search?${loadFeedQs('')}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not load feed')
      setResults(data.results || [])
      setTotal(data.total || 0)
      setNextPageToken(data.next_page_token || '')
      setSuggested(data.suggested_filters || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load feed'); setResults([])
    } finally {
      setSearchLoading(false); setSearched(true)
    }
  }, [loadFeedQs])

  const runSearch = useCallback(async (q: string, facets: string[]) => {
    setSearchLoading(true); setError(''); setMode('search')
    try {
      const res = await fetch(`/api/search?${searchQs(q, facets, '')}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Search failed')
      setResults(data.results || [])
      setTotal(data.total || 0)
      setNextPageToken(data.next_page_token || '')
      setAppliedFilters(data.applied_filters || {})
      setRelaxed(data.relaxed || false)
      setSuggested(data.suggested_filters || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed'); setResults([])
    } finally {
      setSearchLoading(false); setSearched(true)
    }
  }, [searchQs])

  const loadMore = useCallback(async () => {
    if (!nextPageToken || loadingMore) return
    setLoadingMore(true)
    try {
      const qs = mode === 'browse'
        ? loadFeedQs(nextPageToken)
        : searchQs(query, selectedFacets, nextPageToken)
      const res = await fetch(`/api/search?${qs}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not load more')
      setResults((prev) => [...prev, ...(data.results || [])])
      setNextPageToken(data.next_page_token || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more')
    } finally {
      setLoadingMore(false)
    }
  }, [nextPageToken, loadingMore, mode, loadFeedQs, searchQs, query, selectedFacets])

  // RIGHT panel — independent of the search call
  const runExpert = useCallback(async (q: string) => {
    setExpertLoading(true); setExpertTurns([])
    try {
      const res = await fetch('/api/expert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'AI error')
      setExpertTurns([{ id: `${Date.now()}-ai`, role: 'ai', content: data.answer }])
    } catch (e) {
      setExpertTurns([{ id: `${Date.now()}-e`, role: 'ai', content: e instanceof Error ? e.message : 'AI error' }])
    } finally {
      setExpertLoading(false)
    }
  }, [])

  async function askExpertFollowup(fq: string) {
    const t = fq.trim()
    if (t.length < 3) return
    setExpertInput('')
    const history = expertTurns.map((tt) => ({ role: tt.role, content: tt.content }))
    setExpertTurns((prev) => [...prev, { id: `${Date.now()}-u`, role: 'user', content: t }])
    setExpertLoading(true)
    try {
      const res = await fetch('/api/expert', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: t, history }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'AI error')
      setExpertTurns((prev) => [...prev, { id: `${Date.now()}-a`, role: 'ai', content: data.answer }])
    } catch (e) {
      setExpertTurns((prev) => [...prev, { id: `${Date.now()}-x`, role: 'ai', content: e instanceof Error ? e.message : 'AI error' }])
    } finally {
      setExpertLoading(false)
    }
  }

  useEffect(() => {
    if (expertRef.current) expertRef.current.scrollTop = expertRef.current.scrollHeight
  }, [expertTurns])

  // initial load: a typed query in the URL runs that search; otherwise show
  // the default recent-postings feed immediately (website parity with the
  // mobile app's Home tab — see features/ui-changes-1).
  useEffect(() => {
    if (query) { runSearch(query, selectedFacets); if (AI_MODE_ENABLED) runExpert(query) }
    else { loadFeed() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function submit(q: string) {
    const t = q.trim()
    if (t.length < 3) return
    setQuery(t); syncUrl(t, selectedFacets)
    runSearch(t, selectedFacets)   // MIDDLE
    fetchQueryTags(t)              // query-derived tag chips (parallel, non-blocking)
    if (AI_MODE_ENABLED) runExpert(t)   // RIGHT (independent / async) — disabled for now
  }

  // Refines MIDDLE — must work from the default browse view too (no typed
  // query yet), not just once a search has been submitted: toggling a
  // facet always re-runs, falling back to loadFeed()'s pure recency feed
  // only once every facet is cleared and there's no text query either.
  function toggleFacet(field: string, code: string, label?: string) {
    const id = facetId(field, code)
    const removing = selectedFacets.includes(id)
    const next = removing ? selectedFacets.filter((x) => x !== id) : [...selectedFacets, id]
    setSelectedFacets(next)
    if (!removing && label) setFacetLabels((prev) => ({ ...prev, [id]: label }))
    if (next.length === 0 && !query) {
      loadFeed()
    } else {
      runSearch(query, next)
      syncUrl(query, next)
    }
  }

  // Definitive fallback for clearing every active facet at once — separate
  // from removing them one at a time via toggleFacet.
  function clearFilters() {
    setSelectedFacets([])
    if (!query) {
      loadFeed()
    } else {
      runSearch(query, [])
      syncUrl(query, [])
    }
  }

  // The old top-right "Post a new message" button was removed — posting is now
  // initiated from inside the AI Assist chatbot, which routes the user to /post
  // when the conversation implies they want to post.

  // ---------------- RESULTS (3 panels) ----------------
  // Always this layout now — the default (browse) feed is auto-loaded on
  // mount, so "landing" and "results" are the same view (website parity
  // with the mobile app's Home tab — see features/ui-changes-1).
  return (
    <div className="max-w-[90rem] mx-auto px-4 py-6">
      {/* search bar (top) + persistent top-right Post action */}
      <div className="flex items-center gap-3 mb-6">
        <form
          onSubmit={(e) => { e.preventDefault(); submit(input) }}
          className="flex-1 max-w-3xl relative flex items-center bg-surface-container-lowest border border-outline-variant rounded-full focus-within:border-primary transition-all shadow-sm"
        >
          <span className="material-symbols-outlined text-on-surface-variant ml-4">search</span>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search a posting or ask a question…"
            className="flex-1 px-4 py-3 bg-transparent border-none focus:ring-0 focus:outline-none text-body-lg text-on-surface"
          />
          <button type="submit" disabled={input.trim().length < 3} className="btn-primary rounded-full mr-2 my-2 disabled:opacity-40">Search</button>
        </form>
        <Link href="/advanced-search" className="btn-secondary rounded-full flex items-center gap-1.5 shrink-0 whitespace-nowrap">
          <span className="material-symbols-outlined text-[20px]">tune</span>
          <span className="hidden sm:inline">Advanced Search</span>
        </Link>
      </div>

      {error && <div className="card text-error mb-4">{error}</div>}

      <div className={`grid gap-6 ${(AI_MODE_ENABLED && !aiCollapsed) ? 'lg:grid-cols-[15rem_1fr_24rem]' : 'lg:grid-cols-[15rem_1fr]'}`}>
        {/* ===== LEFT — refine ===== */}
        <aside className="space-y-4">
          {/* The client's own record of what's currently filtering the
              results — always shown and always removable, independent of
              whether the backend's next "Refine by" response happens to
              suggest these same facets again (a facet that narrows the
              result set enough can legitimately stop being "suggested" for
              that narrower set, which previously left no way to undo it). */}
          {selectedFacets.length > 0 && (
            <div className="bg-surface-container-low rounded-xl p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-label-md text-on-surface font-medium">Active filters</p>
                <button onClick={clearFilters} className="text-caption text-primary hover:underline">Clear all</button>
              </div>
              <div className="flex flex-wrap gap-2">
                {selectedFacets.map((id) => {
                  const idx = id.indexOf(':')
                  const field = idx >= 0 ? id.slice(0, idx) : id
                  const code = idx >= 0 ? id.slice(idx + 1) : ''
                  const label = facetLabels[id] || humanizeFacetId(id)
                  return (
                    <span key={id} className="inline-flex items-center gap-1 text-caption bg-primary-container text-on-primary-container px-2 py-0.5 rounded-full">
                      {label}
                      <button onClick={() => toggleFacet(field, code)} className="material-symbols-outlined text-[14px] hover:text-error" aria-label={`Remove ${label}`}>close</button>
                    </span>
                  )
                })}
              </div>
            </div>
          )}
          {/* Tags generated from the search text itself (Gemini, same tagging
              principles as posting composition) — a separate concept from
              the "Refine by" facets below, which are backend result-derived.
              Toggling one plugs into the same selectedFacets mechanism.
              features/ui-changes-1/changes-2-.md item 4. */}
          {queryTags.length > 0 && (
            <div className="bg-surface-container-low rounded-xl p-4 space-y-2">
              <p className="text-label-md text-on-surface font-medium">Tags from your search</p>
              <div className="flex flex-wrap gap-2">
                {queryTags.map((t) => {
                  const id = facetId(t.field, t.code)
                  const on = selectedFacets.includes(id)
                  return (
                    <button
                      key={id}
                      onClick={() => toggleFacet(t.field, t.code, t.label)}
                      className={on ? 'pill-active' : 'pill'}
                    >
                      {t.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {suggested.length > 0 && (
            <div className="bg-surface-container-low rounded-xl p-4">
              <SuggestedFilters groups={suggested} selected={new Set(selectedFacets)} onToggle={toggleFacet} />
            </div>
          )}
        </aside>

        {/* ===== MIDDLE — postings ===== */}
        <main>
          <div className="flex items-center justify-between mb-2">
            <p className="text-label-md text-on-surface font-semibold">
              {searchLoading
                ? (mode === 'browse' ? 'Loading recent postings…' : 'Searching…')
                : `${total} ${mode === 'browse' ? 'recent postings' : 'postings'}`}
            </p>
            {AI_MODE_ENABLED && aiCollapsed && (
              <button onClick={() => setAiCollapsed(false)} className="text-caption text-primary flex items-center gap-1 hover:underline">
                <span className="material-symbols-outlined text-[18px]">auto_awesome</span> Show AI
              </button>
            )}
          </div>
          <AppliedFilters filters={appliedFilters} relaxed={relaxed} />
          {!searchLoading && searched && results.length === 0 && (
            <div className="card text-on-surface-variant mt-3">
              <p>
                {mode === 'browse'
                  ? 'No postings yet — check back soon.'
                  : 'No postings matched — try a broader query, or use Advanced Search to adjust match precision.'}
              </p>
              <div className="flex flex-wrap gap-2 mt-4">
                {EXAMPLES.map((ex) => (
                  <button key={ex} onClick={() => { setInput(ex); submit(ex) }} className="pill">{ex}</button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-4 mt-3">
            {results.map((r) => <PostingCard key={r.case_id} r={r} />)}
          </div>
          {!searchLoading && nextPageToken && (
            <div className="flex justify-center mt-6">
              <button onClick={loadMore} disabled={loadingMore} className="btn-secondary disabled:opacity-50">
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </main>

        {/* ===== RIGHT — AI expert (disabled for now; see AI_MODE_ENABLED) ===== */}
        {AI_MODE_ENABLED && !aiCollapsed && (
          <aside className="lg:border-l lg:border-outline-variant lg:pl-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-primary">auto_awesome</span>
                <span className="text-label-md font-semibold text-primary">AI mode</span>
              </div>
              <button onClick={() => setAiCollapsed(true)} aria-label="Hide AI panel"
                className="p-1 rounded hover:bg-surface-container text-on-surface-variant">
                <span className="material-symbols-outlined text-[20px]">close</span>
              </button>
            </div>

            <div ref={expertRef} className="space-y-4 max-h-[70vh] overflow-y-auto">
              {expertTurns.map((t) => (
                t.role === 'user' ? (
                  <div key={t.id} className="flex justify-end">
                    <div className="bg-primary-container text-on-primary-container rounded-2xl rounded-tr-sm px-3 py-2 text-body-md max-w-[90%]">{t.content}</div>
                  </div>
                ) : (
                  <div key={t.id} className="bg-surface-container rounded-2xl rounded-tl-sm p-3 text-on-surface">
                    <Markdown>{t.content}</Markdown>
                  </div>
                )
              ))}
              {expertLoading && (
                <div className="flex gap-1 py-1">
                  <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              )}
            </div>

            {expertTurns.length > 0 && (
              <form onSubmit={(e) => { e.preventDefault(); askExpertFollowup(expertInput) }} className="mt-3 flex items-center gap-2">
                <input
                  value={expertInput}
                  onChange={(e) => setExpertInput(e.target.value)}
                  placeholder="Ask a follow-up…"
                  className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-full px-4 py-2 text-body-md focus:outline-none focus:border-primary"
                />
                <button type="submit" disabled={expertInput.trim().length < 3 || expertLoading}
                  className="btn-secondary rounded-full disabled:opacity-40">Ask</button>
              </form>
            )}
            <p className="text-caption text-on-surface-variant mt-3">
              General expert info — not from our postings, and not legal advice.
            </p>
          </aside>
        )}

      </div>
    </div>
  )
}
