'use client'

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import PostingCard, { type PostingCardData } from '@/components/PostingCard'
import { facetId } from '@/components/SuggestedFilters'
import TagAutocomplete from '@/components/TagAutocomplete'
import StrictnessSlider, { useStrictness } from '@/components/StrictnessSlider'

type TagField = 'current_visa_or_greencard_category' | 'visa_applying_for' | 'consulates' | 'tags'
type Tag = { field: TagField; code: string; label: string }
type ConsulateOption = { code: string; label: string }
type Vocab = {
  visa: string[]
  consulate: string[]
  consulate_options: ConsulateOption[]
  tag: string[]
}
const EMPTY_VOCAB: Vocab = { visa: [], consulate: [], consulate_options: [], tag: [] }

// "Cutoff period" slider steps — days-back cutoffs sent to the backend as
// max_age_days (0 = All time = no restriction, matching /api/search's own
// default so an untouched slider changes nothing).
const CUTOFF_STEPS: { days: number; label: string }[] = [
  { days: 0, label: 'All time' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 182, label: '6 months' },
  { days: 365, label: '1 year' },
]

const CATEGORY_FIELDS: { field: TagField; label: string; kind: 'visa' | 'consulate' | 'tag' }[] = [
  { field: 'current_visa_or_greencard_category', label: 'Current status', kind: 'visa' },
  { field: 'visa_applying_for', label: 'Applying for', kind: 'visa' },
  { field: 'consulates', label: 'Consulate(s)', kind: 'consulate' },
  { field: 'tags', label: 'Tags', kind: 'tag' },
]

function AdvancedSearchInner() {
  const searchParams = useSearchParams()
  const [freeText, setFreeText] = useState('')
  const [tags, setTags] = useState<Tag[]>([])
  const [strictness, setStrictness] = useStrictness()
  // Advanced Search's own News/Cutoff controls — always sent explicitly to
  // /api/search (unlike Home, which never sends them and keeps its
  // existing default behavior untouched; see backend/api.py's
  // _recency_news_clause). Defaults (news included, all time) match what
  // Advanced Search's tag search already did before these controls existed.
  const [includeNews, setIncludeNews] = useState(true)
  const [cutoffIdx, setCutoffIdx] = useState(0)
  const [revealedFields, setRevealedFields] = useState<Set<TagField>>(new Set())
  const [vocab, setVocab] = useState<Vocab>(EMPTY_VOCAB)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  // results — mirrors UnifiedSearch.tsx's MIDDLE panel state
  const [results, setResults] = useState<PostingCardData[]>([])
  const [total, setTotal] = useState(0)
  const [nextPageToken, setNextPageToken] = useState('')
  const [searchLoading, setSearchLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searched, setSearched] = useState(false)

  // Pre-fill the free-text box from ?q= (e.g. the AI Assist "Search community
  // forum" button hands off the user's question here).
  useEffect(() => {
    const q = searchParams?.get('q')
    if (q) setFreeText(q)
  }, [searchParams])

  useEffect(() => {
    fetch('/api/tag-vocab').then((r) => r.json()).then((d) => setVocab({
      visa: d.visa || [], consulate: d.consulate || [],
      consulate_options: d.consulate_options || [], tag: d.tag || [],
    })).catch(() => {})
  }, [])

  const consulateByLabel = useMemo(() => new Map(vocab.consulate_options.map((o) => [o.label, o.code])), [vocab])
  const consulateByCode = useMemo(() => new Map(vocab.consulate_options.map((o) => [o.code, o.label])), [vocab])

  function tagsFor(field: TagField): Tag[] {
    return tags.filter((t) => t.field === field)
  }
  function isShown(field: TagField): boolean {
    return revealedFields.has(field) || tags.some((t) => t.field === field)
  }
  function reveal(field: TagField) {
    setRevealedFields((prev) => new Set(prev).add(field))
  }

  // A category that's ever held a tag (generated or manual) stays visible
  // even after its last tag is removed — avoids layout/focus jumping while
  // the user is actively editing it. No separate "invalid value" validation
  // path is needed here — TagAutocomplete only ever offers suggestions
  // filtered from the fetched vocab list itself, so every pickable value is
  // valid by construction (mirrors mobile's TagPicker).
  function addTag(field: TagField, code: string) {
    reveal(field)
    setTags((prev) => (prev.some((t) => t.field === field && t.code === code) ? prev : [...prev, { field, code, label: code }]))
  }
  function removeTag(field: TagField, code: string) {
    setTags((prev) => prev.filter((t) => !(t.field === field && t.code === code)))
  }

  // "Send" — generate tags from free text. A reset, not a merge: each call
  // replaces the whole tags/headers panel with the latest generation, so
  // repeat or overlapping results are always visibly reflected on screen
  // (an additive merge previously left the panel unchanged whenever the new
  // tags overlapped the old ones, which looked like the request had failed).
  async function send() {
    const t = freeText.trim()
    if (t.length < 1 || generating) return
    setGenerating(true); setError('')
    try {
      const res = await fetch('/api/search/query-tags', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: t }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not generate tags')
      const generated: Tag[] = data.tags || []
      setRevealedFields(new Set(generated.map((g) => g.field)))
      setTags(generated)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not generate tags')
    } finally {
      setGenerating(false)
    }
  }

  // "Search" — runs the same /api/search mechanism as Home search, results
  // render inline on this page (no navigation).
  const runSearch = useCallback(async (q: string, tagList: Tag[], pageToken: string) => {
    if (pageToken) setLoadingMore(true); else setSearchLoading(true)
    setError('')
    try {
      const p = new URLSearchParams()
      // No filler text when q is empty (tags-only search): Discovery Engine
      // relevance-ranks against `q` IN ADDITION TO applying the facet
      // filter, so a non-empty filler string here silently drops
      // facet-matching documents that don't also relevance-match the
      // filler text — confirmed live: `tags:asylum` alone returns the
      // correct 24 postings; with a filler `q` it drops to 3.
      if (q) p.set('q', q)
      tagList.forEach((t) => p.append('facet', facetId(t.field, t.code)))
      p.set('strictness', strictness)
      // Explicit on every Advanced Search request — see backend/api.py's
      // _recency_news_clause. Home never sends these two, so this doesn't
      // affect it.
      p.set('include_news', String(includeNews))
      const maxAgeDays = CUTOFF_STEPS[cutoffIdx].days
      if (maxAgeDays > 0) p.set('max_age_days', String(maxAgeDays))
      p.set('page_size', '15')
      p.set('sort', 'event')
      if (pageToken) p.set('page_token', pageToken)
      const res = await fetch(`/api/search?${p.toString()}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Search failed')
      setResults((prev) => (pageToken ? [...prev, ...(data.results || [])] : data.results || []))
      setTotal(data.total || 0)
      setNextPageToken(data.next_page_token || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setSearchLoading(false); setLoadingMore(false); setSearched(true)
    }
  }, [strictness, includeNews, cutoffIdx])

  function loadMore() {
    if (!nextPageToken || loadingMore) return
    runSearch(freeText, tags, nextPageToken)
  }

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <Link href="/" className="inline-flex items-center gap-1 text-label-md text-on-surface-variant hover:text-primary mb-4 transition-colors">
        <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        Back to search
      </Link>
      <h1 className="text-headline-md text-on-surface mb-4">Advanced Search</h1>

      {error && <div className="card text-error mb-4">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-2 items-start">
        {/* LEFT — free text */}
        <div className="bg-surface-container-low rounded-xl p-4 flex flex-col">
          <label className="text-label-md font-semibold text-on-surface mb-2">Describe what you&apos;re looking for</label>
          <textarea value={freeText} onChange={(e) => setFreeText(e.target.value)}
            placeholder="e.g. H-1B RFE experiences at the Mumbai consulate…"
            rows={6}
            className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-md focus:outline-none focus:border-primary resize-none" />
          <button onClick={send} disabled={generating || freeText.trim().length < 1} className="btn-primary mt-3 self-start disabled:opacity-50">
            {generating ? 'Generating…' : 'Send'}
          </button>
        </div>

        {/* RIGHT — generated + editable tags */}
        <div className="card space-y-3">
          <h2 className="text-label-md font-semibold text-on-surface">Search tags</h2>
          {tags.length === 0 && revealedFields.size === 0 && (
            <p className="text-caption text-on-surface-variant">Click Send to generate tags from your text, or add one manually below.</p>
          )}

          {CATEGORY_FIELDS.filter((c) => isShown(c.field)).map((c) => {
            const values = tagsFor(c.field)
            const options = c.kind === 'visa' ? vocab.visa
              : c.kind === 'consulate' ? vocab.consulate_options.map((o) => o.label)
                : vocab.tag
            return (
              <div key={c.field}>
                <p className="text-caption uppercase tracking-wide text-on-surface-variant mb-1">{c.label}</p>
                <div className="flex flex-wrap gap-1.5">
                  {values.length === 0 && <span className="text-caption text-on-surface-variant">None.</span>}
                  {values.map((t) => (
                    <span key={t.code} className="inline-flex items-center gap-1 text-caption bg-primary-container text-on-primary-container px-2 py-0.5 rounded-full">
                      {c.kind === 'consulate' ? (consulateByCode.get(t.code) || t.code) : t.code}
                      <button onClick={() => removeTag(c.field, t.code)} className="material-symbols-outlined text-[14px] hover:text-error" aria-label={`Remove ${t.code}`}>close</button>
                    </span>
                  ))}
                </div>
                <TagAutocomplete
                  placeholder={c.kind === 'consulate' ? 'Search a consulate (city/country)…' : `Search ${c.label.toLowerCase()}…`}
                  options={options}
                  onPick={(picked) => {
                    const code = c.kind === 'consulate' ? consulateByLabel.get(picked) || picked : picked
                    addTag(c.field, code)
                  }}
                />
              </div>
            )
          })}

          {CATEGORY_FIELDS.filter((c) => !isShown(c.field)).length > 0 && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {CATEGORY_FIELDS.filter((c) => !isShown(c.field)).map((c) => (
                <button key={c.field} onClick={() => reveal(c.field)} className="pill">+ Add {c.label}</button>
              ))}
            </div>
          )}

          <div className="pt-2 border-t border-outline-variant">
            <StrictnessSlider value={strictness} onChange={setStrictness} />
          </div>

          <div className="pt-2 border-t border-outline-variant space-y-3">
            <label className="flex items-center gap-2 text-label-md text-on-surface cursor-pointer">
              <input
                type="checkbox"
                checked={includeNews}
                onChange={(e) => setIncludeNews(e.target.checked)}
                className="accent-primary w-4 h-4"
              />
              Include news articles
            </label>
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-[18px] text-secondary">schedule</span>
                <span className="text-label-md text-on-surface font-medium">Cutoff period</span>
              </div>
              <input
                type="range"
                min={0}
                max={CUTOFF_STEPS.length - 1}
                step={1}
                value={cutoffIdx}
                onChange={(e) => setCutoffIdx(Number(e.target.value))}
                className="w-full accent-primary cursor-pointer"
                aria-label="Cutoff period"
              />
              <div className="flex justify-between text-caption text-on-surface-variant">
                {CUTOFF_STEPS.map((s, i) => (
                  <span key={s.days} className={i === cutoffIdx ? 'text-primary font-medium' : ''}>{s.label}</span>
                ))}
              </div>
            </div>
          </div>

          <button onClick={() => runSearch(freeText, tags, '')} disabled={searchLoading} className="btn-primary w-full mt-2 disabled:opacity-50">
            {searchLoading ? 'Searching…' : 'Search'}
          </button>
        </div>
      </div>

      {/* Results — inline, no navigation */}
      {searched && (
        <div className="mt-6">
          <p className="text-label-md text-on-surface font-semibold mb-2">
            {searchLoading ? 'Searching…' : `${total} posting${total === 1 ? '' : 's'}`}
          </p>
          {!searchLoading && results.length === 0 && (
            <div className="card text-on-surface-variant">No postings matched your tags — try removing one or broadening your text.</div>
          )}
          <div className="space-y-4">
            {results.map((r) => <PostingCard key={r.case_id} r={r} />)}
          </div>
          {!searchLoading && nextPageToken && (
            <div className="flex justify-center mt-6">
              <button onClick={loadMore} disabled={loadingMore} className="btn-secondary disabled:opacity-50">
                {loadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// useSearchParams() (the ?q= pre-fill) requires a Suspense boundary or Next 14
// fails the production build. (Same pattern as /post.)
export default function AdvancedSearchPage() {
  return (
    <Suspense fallback={null}>
      <AdvancedSearchInner />
    </Suspense>
  )
}
