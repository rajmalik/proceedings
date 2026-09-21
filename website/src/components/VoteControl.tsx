'use client'

import { useEffect, useState } from 'react'
import { getActiveUser, userHeaders } from '@/lib/activeUser'

type Props = {
  contentId: string // posting case_id OR reply id
  score: number
  yourVote?: number // -1 | 0 | 1
  orientation?: 'vertical' | 'horizontal'
  onScore?: (score: number) => void
}

// Reddit-style up/down vote control with an optimistic score. Reused for the
// posting and for each reply. Voting requires an active user (X-User-Id); with
// none selected the arrows no-op and show a hint.
export default function VoteControl({ contentId, score, yourVote = 0, orientation = 'vertical', onScore }: Props) {
  const [s, setS] = useState(score)
  const [vote, setVote] = useState(yourVote)
  const [busy, setBusy] = useState(false)
  const [hint, setHint] = useState('')

  // Resync when server-provided values arrive late or change (e.g. parent refetch).
  useEffect(() => { setS(score); setVote(yourVote) }, [score, yourVote, contentId])

  async function cast(dir: 1 | -1) {
    if (busy) return
    // "Select a user" was dev-picker jargon — a real signed-out visitor has
    // no picker to select from (it's off in production); voting only ever
    // requires being signed in.
    if (!getActiveUser()) { setHint('Sign in to vote'); return }
    const target = (vote === dir ? 0 : dir) as -1 | 0 | 1
    const optimistic = s - vote + target
    const prev = { s, vote }
    setS(optimistic); setVote(target); setBusy(true); setHint('')
    onScore?.(optimistic)
    try {
      const res = await fetch('/api/votes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...userHeaders() },
        body: JSON.stringify({ content_id: contentId, dir: target }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Vote failed')
      setS(data.score); setVote(data.your_vote); onScore?.(data.score)
    } catch (e) {
      setS(prev.s); setVote(prev.vote); onScore?.(prev.s)
      setHint(e instanceof Error ? e.message : 'Vote failed')
    } finally {
      setBusy(false)
    }
  }

  const isV = orientation === 'vertical'
  const arrow = (dir: 1 | -1) => {
    const active = vote === dir
    const color = dir === 1
      ? (active ? 'text-primary' : 'text-on-surface-variant hover:text-primary')
      : (active ? 'text-error' : 'text-on-surface-variant hover:text-error')
    return (
      <button
        type="button"
        onClick={() => cast(dir)}
        disabled={busy}
        aria-label={dir === 1 ? 'Upvote' : 'Downvote'}
        aria-pressed={active}
        className={`material-symbols-outlined text-[22px] leading-none transition-colors disabled:opacity-40 ${color}`}
      >
        {dir === 1 ? 'arrow_upward' : 'arrow_downward'}
      </button>
    )
  }

  return (
    <div
      className={`flex ${isV ? 'flex-col' : 'flex-row'} items-center gap-0.5 select-none`}
      title={hint || undefined}
    >
      {arrow(1)}
      <span className={`text-label-md font-semibold tabular-nums ${vote === 1 ? 'text-primary' : vote === -1 ? 'text-error' : 'text-on-surface'}`}>
        {s}
      </span>
      {arrow(-1)}
    </div>
  )
}
