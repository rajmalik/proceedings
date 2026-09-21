'use client'

import { useState, useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import Markdown from '@/components/Markdown'
import VoteControl from '@/components/VoteControl'
import Replies from '@/components/Replies'
import AuthorSection from '@/components/AuthorSection'

type Tally = { up: number; down: number; score: number; your_vote: number }
const ZERO_TALLY: Tally = { up: 0, down: 0, score: 0, your_vote: 0 }

type PostingDetail = {
  case_id: string
  title: string
  description: string
  visa: string[]
  consulates: string[]
  outcome: string
  subreddit: string
  channel: string
  tags: string[]
  url: string
  date: string
  event_timestamp?: string
  body: string
  author_id: string
  author_handle?: string
  tag_sections?: { label: string; tags: string[] }[]
}

function outcomeBadge(outcome: string) {
  const o = outcome.toLowerCase()
  if (o === 'approved' || o === 'issued') return 'badge-success'
  return 'badge-secondary'
}

export default function CaseDetailsPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const id = params?.id
  const [data, setData] = useState<PostingDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [postingTally, setPostingTally] = useState<Tally>(ZERO_TALLY)

  // router.back() lands on the "/" history entry UnifiedSearch's syncUrl
  // already kept in sync (query + facets, via router.replace on every
  // search/toggle) — restores the prior search instead of resetting to a
  // blank landing state (features/ui-changes-1/changes-2-.md item 3). Fall
  // back to a plain navigation only when there's no real history to pop
  // (e.g. a directly-shared/bookmarked case link opened in a fresh tab).
  function backToSearch() {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push('/')
  }

  useEffect(() => {
    if (!id) return
    setLoading(true)
    fetch(`/api/postings/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.detail || 'Could not load posting')
        return json
      })
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load posting'))
      .finally(() => setLoading(false))
  }, [id])

  return (
    <div className="max-w-7xl mx-auto px-4 md:px-margin-desktop py-8">
      <button
        onClick={backToSearch}
        className="inline-flex items-center gap-1 text-label-md text-on-surface-variant hover:text-primary mb-6 transition-colors"
      >
        <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        Back to Search
      </button>

      {loading && <div className="card text-on-surface-variant">Loading posting…</div>}
      {error && <div className="card text-error">{error}</div>}

      {data && (
        <div className="flex flex-col lg:flex-row gap-8">
          {/* Main */}
          <div className="flex-1 space-y-6 min-w-0">
            <div className="flex gap-4">
              <div className="pt-1 shrink-0">
                <VoteControl contentId={data.case_id} score={postingTally.score} yourVote={postingTally.your_vote} />
              </div>
              <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-3">
                {data.outcome && <span className={outcomeBadge(data.outcome)}>{data.outcome}</span>}
                {data.visa.map((v) => <span key={v} className="badge-primary">{v}</span>)}
                {data.consulates.map((c) => (
                  <span key={c} className="badge-secondary flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">location_on</span>{c}
                  </span>
                ))}
              </div>
              <h1 className="text-headline-lg text-on-surface mb-2">{data.title}</h1>
              </div>
            </div>

            {/* Original content, verbatim — the AI-generated summary lives
                in its own labeled box in the sidebar (below), never mixed
                in here, so it's always clear which is which. No section
                heading here — the posting's own title above already
                introduces it. */}
            <div className="card">
              <div className="text-body-md text-on-surface leading-relaxed">
                {data.body ? <Markdown>{data.body}</Markdown> : 'No content available.'}
              </div>
            </div>

            {/* Replies — a clearly separate section below the posting */}
            <Replies postingId={data.case_id} onPostingTally={setPostingTally} />
          </div>

          {/* Sidebar */}
          <aside className="lg:w-80 space-y-6">
            <div className="card">
              <h3 className="text-label-md font-semibold text-on-surface mb-3">Details</h3>
              <dl className="space-y-2 text-body-md">
                <div className="flex justify-between"><dt className="text-on-surface-variant">Source</dt><dd className="text-on-surface">{data.subreddit ? `r/${data.subreddit}` : data.author_handle || (data.channel === 'app' ? 'Meridian' : data.channel)}</dd></div>
                <div className="flex justify-between"><dt className="text-on-surface-variant">Posted</dt><dd className="text-on-surface">{data.date || '—'}</dd></div>
                {data.outcome && <div className="flex justify-between"><dt className="text-on-surface-variant">Outcome</dt><dd className="text-on-surface">{data.outcome}</dd></div>}
              </dl>
            </div>

            {data.description && (
              <div className="card">
                <h3 className="text-label-md font-semibold text-on-surface mb-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary text-[20px]">auto_awesome</span>
                  AI Summary
                </h3>
                <p className="text-body-md text-on-surface-variant">{data.description}</p>
              </div>
            )}

            {(() => {
              // Show every tag category as its own labeled section. Fall back to
              // the flat `tags` (older API / Reddit postings) under "Topics".
              const sections =
                data.tag_sections && data.tag_sections.length > 0
                  ? data.tag_sections
                  : data.tags.length > 0
                    ? [{ label: 'Topics', tags: data.tags }]
                    : []
              if (sections.length === 0) return null
              return (
                <div className="card space-y-3">
                  <h3 className="text-label-md font-semibold text-on-surface">Tags</h3>
                  {sections.map((sec) => (
                    <div key={sec.label}>
                      <p className="text-caption uppercase tracking-wide text-on-surface-variant mb-1.5">
                        {sec.label}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {sec.tags.map((t) => (
                          <span key={t} className="text-caption text-on-surface-variant bg-surface-container px-2 py-1 rounded">{t}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )
            })()}

            {/* Author. A real in-app author (uid) gets the rich profile card.
                A first-party (channel="app") posting links its anonymous
                handle to the in-app author-by-handle page. gov-news content
                has a fixed per-source handle (e.g. "USCIS") with no in-app
                profile behind it, so it links out to the source URL instead
                — see docs/ingestion/GOV-NEWS-INGESTION-PLAN.md §3.6. Other
                external content (Reddit) shows nothing, same as before. */}
            {data.author_id ? (
              <AuthorSection authorId={data.author_id} channel={data.channel} currentCaseId={data.case_id} />
            ) : data.channel === 'gov_news' && data.author_handle ? (
              <div className="card">
                <h3 className="text-label-md font-semibold text-on-surface mb-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary text-[20px]">account_circle</span>
                  Source
                </h3>
                <a
                  href={data.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-body-md font-medium text-primary hover:underline"
                >
                  {data.author_handle}
                  <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                </a>
                <p className="text-caption text-on-surface-variant mt-1">
                  View the original announcement
                </p>
              </div>
            ) : data.channel === 'app' && data.author_handle ? (
              <div className="card">
                <h3 className="text-label-md font-semibold text-on-surface mb-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary text-[20px]">account_circle</span>
                  Author
                </h3>
                <Link
                  href={`/author-by-handle/${encodeURIComponent(data.author_handle)}`}
                  className="inline-flex items-center gap-1.5 text-body-md font-medium text-primary hover:underline"
                >
                  {data.author_handle}
                  <span className="material-symbols-outlined text-[16px]">chevron_right</span>
                </Link>
                <p className="text-caption text-on-surface-variant mt-1">
                  See all postings by this author
                </p>
              </div>
            ) : null}

            <div className="bg-gradient-to-br from-primary to-primary-container rounded-xl p-6 text-center">
              <h3 className="text-headline-md text-on-primary mb-2">Coming Soon</h3>
              <p className="text-body-md text-on-primary opacity-90 mb-4">
                Connect with verified immigration attorney
              </p>
              <button disabled className="btn-primary bg-white text-primary opacity-70 cursor-not-allowed">
                Consult an Attorney
              </button>
            </div>
          </aside>
        </div>
      )}
    </div>
  )
}
