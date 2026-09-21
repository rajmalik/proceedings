'use client'

import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'

type AuthorPosting = {
  case_id: string
  title: string
  visa: string[]
  consulates: string[]
  outcome: string
  date: string
}

export default function AuthorByHandlePage() {
  const params = useParams<{ handle: string }>()
  const handle = params?.handle ? decodeURIComponent(params.handle) : ''
  const [postings, setPostings] = useState<AuthorPosting[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!handle) return
    setLoading(true)
    fetch(`/api/authors/by-handle/${encodeURIComponent(handle)}/postings`)
      .then(async (res) => {
        const json = await res.json()
        if (!res.ok) throw new Error(json.detail || 'Could not load postings')
        return json
      })
      .then((d) => setPostings((d.postings || []) as AuthorPosting[]))
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load postings'))
      .finally(() => setLoading(false))
  }, [handle])

  return (
    <div className="max-w-3xl mx-auto px-4 py-6">
      <Link
        href="/"
        className="inline-flex items-center gap-1 text-label-md text-on-surface-variant hover:text-primary mb-4 transition-colors"
      >
        <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        Back to Search
      </Link>

      <div className="flex items-center gap-3 mb-1">
        <span className="material-symbols-outlined text-primary text-[32px]">account_circle</span>
        <div>
          <p className="overline">Author</p>
          <h1 className="text-headline-md text-on-surface">{handle || 'Author'}</h1>
        </div>
      </div>
      <p className="text-caption text-on-surface-variant mb-5">
        An anonymous community handle. These are the postings shared under it.
      </p>

      {loading && <div className="card text-on-surface-variant">Loading postings…</div>}
      {error && <div className="card text-error">{error}</div>}

      {!loading && !error && (
        <div className="card">
          <h2 className="text-label-md font-semibold text-on-surface mb-3">
            Postings by {handle} ({postings.length})
          </h2>
          {postings.length === 0 ? (
            <p className="text-body-md text-on-surface-variant">No postings found for this author.</p>
          ) : (
            <ul className="space-y-3">
              {postings.map((p) => (
                <li key={p.case_id} className="border-b border-outline-variant last:border-0 pb-3 last:pb-0">
                  <Link href={`/case/${encodeURIComponent(p.case_id)}`} className="block group">
                    <span className="text-body-md text-on-surface group-hover:text-primary line-clamp-2">
                      {p.title || p.case_id}
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5 mt-1">
                      {p.visa.slice(0, 3).map((v) => (
                        <span key={v} className="badge-primary text-caption">{v}</span>
                      ))}
                      {p.consulates.slice(0, 2).map((c) => (
                        <span key={c} className="badge-secondary text-caption">{c}</span>
                      ))}
                      {p.outcome ? <span className="badge-success text-caption">{p.outcome}</span> : null}
                      {p.date ? <span className="text-caption text-on-surface-variant">{p.date}</span> : null}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
