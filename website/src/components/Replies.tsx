'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useAuth } from '@/contexts/AuthContext'
import { getActiveUser, userHeaders, DEMO_PICKER_ENABLED } from '@/lib/activeUser'
import ReplyItem, { ReplyCardData } from './ReplyItem'

type Tally = { up: number; down: number; score: number; your_vote: number }
const ZERO: Tally = { up: 0, down: 0, score: 0, your_vote: 0 }

// Self-contained replies section: owns the single fetch to the replies endpoint,
// renders the composer (gated on an active user) + the sorted list, and reports
// the posting's vote tally up to the parent via `onPostingTally`.
export default function Replies({
  postingId,
  onPostingTally,
}: {
  postingId: string
  onPostingTally?: (t: Tally) => void
}) {
  const [replies, setReplies] = useState<ReplyCardData[]>([])
  const [sort, setSort] = useState<'top' | 'new'>('new')  // default: most recent first
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  // Bug fixed: this used to be a one-shot getActiveUser() check on mount,
  // which races Firebase's async session restore (onAuthStateChanged fires
  // AFTER mount) — a real signed-in production user could see "Select a
  // user" forever, since the check never re-ran once auth actually
  // resolved. `useAuth()`'s `user` is reactive (updates when the session
  // restores), so re-deriving `hasUser` from it fixes the race. The
  // dev-only demo picker (`getActiveUser()`'s localStorage fallback, OFF in
  // production — see DEMO_PICKER_ENABLED) doesn't have this problem since
  // it's synchronous, but is included here too for dev/test parity.
  const { user: authUser } = useAuth()
  const [hasUser, setHasUser] = useState(false)
  useEffect(() => { setHasUser(!!authUser || !!getActiveUser()) }, [authUser])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `/api/postings/${encodeURIComponent(postingId)}/replies?sort=${sort}`,
        { headers: { ...userHeaders() } }
      )
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not load replies')
      setReplies(data.replies || [])
      onPostingTally?.(data.posting || ZERO)
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load replies')
    } finally {
      setLoading(false)
    }
  }, [postingId, sort, onPostingTally])

  useEffect(() => { load() }, [load])

  async function submit() {
    const body = text.trim()
    if (!body || submitting) return
    setSubmitting(true); setError('')
    try {
      const res = await fetch(`/api/postings/${encodeURIComponent(postingId)}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...userHeaders() },
        body: JSON.stringify({ body }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not post reply')
      setText('')
      setReplies((prev) => [data, ...prev])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post reply')
    } finally {
      setSubmitting(false)
    }
  }

  async function remove(id: string) {
    const prev = replies
    setReplies((cur) => cur.filter((r) => r.id !== id)) // optimistic
    try {
      const res = await fetch(
        `/api/postings/${encodeURIComponent(postingId)}/replies/${encodeURIComponent(id)}`,
        { method: 'DELETE', headers: { ...userHeaders() } }
      )
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.detail || 'Delete failed')
      }
    } catch (e) {
      setReplies(prev) // revert
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-headline-md text-on-surface flex items-center gap-2">
          <span className="material-symbols-outlined text-secondary">forum</span>
          Replies <span className="text-on-surface-variant">({replies.length})</span>
        </h2>
        <div className="flex items-center gap-1">
          <button onClick={() => setSort('top')} className={`pill ${sort === 'top' ? 'pill-active' : ''}`}>Top</button>
          <button onClick={() => setSort('new')} className={`pill ${sort === 'new' ? 'pill-active' : ''}`}>New</button>
        </div>
      </div>

      {hasUser ? (
        <div className="card space-y-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={5000}
            placeholder="Share your experience or ask a question…"
            className="w-full resize-y rounded-lg border border-outline-variant bg-surface px-3 py-2 text-body-md text-on-surface focus:border-primary focus:outline-none"
          />
          <div className="flex items-center justify-between">
            <span className="text-caption text-on-surface-variant">{text.length}/5000</span>
            <button onClick={submit} disabled={!text.trim() || submitting} className="btn-primary disabled:opacity-50">
              {submitting ? 'Posting…' : 'Post reply'}
            </button>
          </div>
        </div>
      ) : (
        <div className="card text-body-md text-on-surface-variant">
          {/* "Select a user" was dev-picker jargon that leaked into
              production copy — a real visitor has no such picker (it's
              OFF in production) and no "user" to select; replying only
              ever requires being signed in. Demo picker link kept as a
              dev/test-only fallback, matching find/page.tsx's pattern. */}
          <Link href="/login" className="text-secondary hover:underline">Sign in</Link> to reply and vote.
          {DEMO_PICKER_ENABLED && (
            <>
              {' '}(dev: <Link href="/onboarding" className="text-secondary hover:underline">pick a demo user</Link>)
            </>
          )}
        </div>
      )}

      {error && <div className="text-error text-label-md">{error}</div>}

      {loading ? (
        <div className="text-on-surface-variant text-body-md">Loading replies…</div>
      ) : replies.length === 0 ? (
        <div className="text-on-surface-variant text-body-md">No replies yet — be the first to share.</div>
      ) : (
        <div className="space-y-3">
          {replies.map((r) => <ReplyItem key={r.id} r={r} onDelete={remove} />)}
        </div>
      )}
    </section>
  )
}
