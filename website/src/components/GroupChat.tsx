'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { getActiveUser, userHeaders } from '@/lib/activeUser'

export type ChatMessage = {
  id: string
  author_handle: string
  text: string
  created_at: string
  deleted: boolean
  is_author: boolean
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso)
  if (isNaN(t)) return ''
  const s = Math.floor((Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return new Date(t).toLocaleDateString()
}

const POLL_MS = 1500

// Members-only group chat. v1 real-time = polling every ~4s with a `since`
// cursor (the cursor only advances on server fetches; sends are appended
// optimistically and reconciled by the next poll, deduped by id).
export default function GroupChat({ groupId }: { groupId: string }) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [denied, setDenied] = useState(false)
  const [hasUser, setHasUser] = useState(false)
  const threadRef = useRef<HTMLDivElement>(null)
  const sinceRef = useRef<string>('') // max created_at fetched from the server

  useEffect(() => { setHasUser(!!getActiveUser()) }, [])

  // Add messages (dedupe by id). `advance` moves the poll cursor (server fetches only).
  const merge = useCallback((incoming: ChatMessage[], advance: boolean) => {
    if (incoming.length === 0) return
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id))
      return [...prev, ...incoming.filter((m) => !seen.has(m.id))]
    })
    if (advance) {
      const last = incoming[incoming.length - 1]
      if (last && last.created_at > sinceRef.current) sinceRef.current = last.created_at
    }
  }, [])

  const loadInitial = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/messages`, { headers: { ...userHeaders() } })
      if (res.status === 403) { setDenied(true); return }
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not load messages')
      const msgs: ChatMessage[] = data.messages || []
      setMessages(msgs)
      sinceRef.current = msgs.length ? msgs[msgs.length - 1].created_at : ''
      setError('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load messages')
    } finally {
      setLoading(false)
    }
  }, [groupId])

  const poll = useCallback(async () => {
    try {
      const since = sinceRef.current
      const res = await fetch(
        `/api/groups/${encodeURIComponent(groupId)}/messages?since=${encodeURIComponent(since)}`,
        { headers: { ...userHeaders() } }
      )
      if (!res.ok) return
      const data = await res.json()
      merge(data.messages || [], true)
    } catch { /* transient; next tick retries */ }
  }, [groupId, merge])

  useEffect(() => { loadInitial() }, [loadInitial])
  useEffect(() => {
    const id = setInterval(() => { if (!document.hidden && !denied) poll() }, POLL_MS)
    return () => clearInterval(id)
  }, [poll, denied])
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight }, [messages])

  async function send() {
    const t = text.trim()
    if (!t || sending) return
    setSending(true); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...userHeaders() },
        body: JSON.stringify({ text: t }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not send')
      setText('')
      merge([data], false) // optimistic; the next poll reconciles + advances the cursor
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send')
    } finally {
      setSending(false)
    }
  }

  async function remove(id: string) {
    const prev = messages
    setMessages((cur) => cur.map((m) => (m.id === id ? { ...m, deleted: true, text: '' } : m)))
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/messages/${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { ...userHeaders() },
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.detail || 'Delete failed') }
    } catch (e) {
      setMessages(prev)
      setError(e instanceof Error ? e.message : 'Delete failed')
    }
  }

  if (!hasUser) {
    return (
      <div className="card text-body-md text-on-surface-variant">
        <Link href="/onboarding" className="text-secondary hover:underline">Select a user</Link> to open this chat.
      </div>
    )
  }
  if (denied) {
    return <div className="card text-body-md text-on-surface-variant">You&apos;re not a member of this group.</div>
  }

  return (
    <div className="bg-surface-container-low rounded-xl p-4 flex flex-col" style={{ minHeight: '60vh' }}>
      <div ref={threadRef} className="flex-1 space-y-3 overflow-y-auto max-h-[64vh] pr-1">
        {loading ? (
          <div className="text-on-surface-variant text-body-md">Loading messages…</div>
        ) : messages.length === 0 ? (
          <div className="text-on-surface-variant text-body-md">No messages yet — say hello to your group.</div>
        ) : (
          messages.map((m) => (
            m.is_author ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[85%]">
                  <div className="bg-primary-container text-on-primary-container rounded-2xl rounded-tr-sm px-3 py-2 text-body-md whitespace-pre-wrap break-words">
                    {m.deleted ? <span className="italic opacity-70">message deleted</span> : m.text}
                  </div>
                  <div className="flex items-center justify-end gap-2 text-caption text-on-surface-variant mt-0.5">
                    <span>{timeAgo(m.created_at)}</span>
                    {!m.deleted && (
                      <button onClick={() => remove(m.id)} className="hover:text-error" aria-label="Delete message" title="Delete">
                        <span className="material-symbols-outlined text-[14px]">delete</span>
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div key={m.id} className="max-w-[90%]">
                <div className="text-caption text-on-surface-variant mb-0.5">
                  <span className="font-semibold text-on-surface">{m.author_handle}</span> · {timeAgo(m.created_at)}
                </div>
                <div className="bg-surface-container rounded-2xl rounded-tl-sm px-3 py-2 text-on-surface text-body-md whitespace-pre-wrap break-words">
                  {m.deleted ? <span className="italic opacity-70">message deleted</span> : m.text}
                </div>
              </div>
            )
          ))
        )}
      </div>

      {error && <div className="text-error text-label-md mt-2">{error}</div>}

      <form onSubmit={(e) => { e.preventDefault(); send() }} className="mt-3 flex items-center gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={4000}
          placeholder="Message your group…"
          className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-full px-4 py-2 text-body-md focus:outline-none focus:border-primary"
        />
        <button type="submit" disabled={!text.trim() || sending} className="btn-primary rounded-full disabled:opacity-40">
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
    </div>
  )
}
