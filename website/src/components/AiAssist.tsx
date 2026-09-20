'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Markdown from '@/components/Markdown'
import { userHeaders } from '@/lib/activeUser'
import { getAssistSessionId } from '@/lib/assistSession'
import { writePostDraft, type Groups, type KV } from '@/lib/assistDraft'

type Citation = { source: string; title: string; as_of: string }
type CommunityCard = { case_id: string; title: string; snippet: string; url: string; channel: string }
type PostDraftData = { title: string; description: string; groups: Groups; key_stages_or_info: KV; key_dates: KV }
type Timeline = { status: string; group_id: string; group_name: string; criteria: unknown }

export type AssistResponse = {
  intent: string
  confidence: number
  answer: string
  source_tier: string
  citations: Citation[]
  community_cards: CommunityCard[]
  clarify_questions: string[]
  post_draft: PostDraftData | null
  timeline: Timeline | null
  find_url: string
  disclaimer: string
  can_post: boolean
  can_find_timeline: boolean
  can_find_similar: boolean
  rationale: string
  id: string
  turns_used: number
}

type Turn = { id: string; role: 'user' | 'ai'; content: string; data?: AssistResponse; q?: string }

let _seq = 0
const _id = (p: string) => `${p}-${Date.now()}-${_seq++}`

// Conversation + open state persist for the session so the user can navigate
// between pages (or reload) and come back to the same chat.
const CONV_KEY = 'aiAssist.conversation.v1'

function loadConversation(): { turns: Turn[]; open: boolean } {
  try {
    const raw = sessionStorage.getItem(CONV_KEY)
    if (raw) {
      const s = JSON.parse(raw)
      return {
        turns: Array.isArray(s?.turns) ? s.turns : [],
        open: typeof s?.open === 'boolean' ? s.open : false,
      }
    }
  } catch { /* sessionStorage unavailable — start fresh */ }
  return { turns: [], open: false }
}

export default function AiAssist() {
  const router = useRouter()
  // Lazy init from sessionStorage (client only) so the persisted conversation is
  // the INITIAL state — no restore effect that a StrictMode double-invoke could
  // clobber. `mounted` gates the first paint to avoid an SSR hydration mismatch.
  const [mounted, setMounted] = useState(false)
  const [turns, setTurns] = useState<Turn[]>(() => (typeof window === 'undefined' ? [] : loadConversation().turns))
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [nudge, setNudge] = useState(false)
  const [open, setOpen] = useState<boolean>(() => (typeof window === 'undefined' ? false : loadConversation().open))
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => setMounted(true), [])

  // Persist on change. Safe against StrictMode double-invoke: the initial state
  // is already the saved value, so an early write just re-saves it (no clobber).
  useEffect(() => {
    if (!mounted) return
    try { sessionStorage.setItem(CONV_KEY, JSON.stringify({ turns, open })) } catch { /* ignore */ }
  }, [turns, open, mounted])

  const lastUserMessage = () => [...turns].reverse().find((t) => t.role === 'user')?.content || ''

  async function send(message: string, forceIntent = ''): Promise<AssistResponse | undefined> {
    const msg = message.trim()
    if (!msg || loading) return
    setError(''); setNudge(false); setLoading(true)
    const historyBefore = turns
    // A plain ask appends the user's turn; an affordance re-send (forceIntent) does not.
    if (!forceIntent) {
      setTurns((t) => [...t, { id: _id('u'), role: 'user', content: msg }])
      setInput('')
    }
    try {
      const res = await fetch('/api/assist', {
        method: 'POST',
        headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          message: msg,
          history: historyBefore.map((t) => ({ role: t.role, content: t.content, intent: t.data?.intent || '' })),
          session_id: getAssistSessionId(),
          force_intent: forceIntent,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (res.status === 429) setNudge(true)
        else setError(data.detail || 'Something went wrong. Please try again.')
        return
      }
      const resp = data as AssistResponse
      setTurns((t) => [...t, { id: _id('a'), role: 'ai', content: resp.answer || '', data: resp, q: msg }])
      queueMicrotask(() => scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }))
      return resp
    } catch {
      setError('Unable to reach the AI service. Please try again later.')
    } finally {
      setLoading(false)
    }
  }

  function startNew() {
    setTurns([]); setInput(''); setError(''); setNudge(false)
    try { sessionStorage.removeItem(CONV_KEY) } catch { /* ignore */ }
  }

  async function handlePost(turn: Turn) {
    let draft = turn.data?.post_draft || undefined
    if (!draft) {
      const resp = await send(lastUserMessage(), 'post')
      draft = resp?.post_draft || undefined
    }
    if (draft) {
      writePostDraft(draft)
      router.push('/post')
    }
  }

  function renderAi(turn: Turn) {
    const d = turn.data
    if (!d) return null
    return (
      <div key={turn.id} className="bg-surface-container rounded-2xl rounded-tl-sm p-3 text-on-surface space-y-2">
        {d.answer && <Markdown>{d.answer}</Markdown>}

        {d.clarify_questions.length > 0 && (
          <div className="text-body-md">
            <p className="text-on-surface-variant">{d.rationale || 'A few quick questions to point you right:'}</p>
            <ul className="list-disc list-inside mt-1 space-y-0.5">
              {d.clarify_questions.map((q, i) => <li key={i}>{q}</li>)}
            </ul>
          </div>
        )}

        {d.community_cards.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-caption text-on-surface-variant">Based on community experiences:</p>
            {d.community_cards.map((c) => (
              <a key={c.case_id || c.url} href={c.url} className="block card hover:border-primary p-2.5">
                <div className="text-label-md text-on-surface line-clamp-1">{c.title || 'Community posting'}</div>
                {c.snippet && <div className="text-caption text-on-surface-variant line-clamp-2">{c.snippet}</div>}
                <div className="text-caption text-primary mt-0.5">View original{c.channel ? ` · ${c.channel}` : ''} →</div>
              </a>
            ))}
          </div>
        )}

        {d.citations.length > 0 && (
          <div className="text-caption">
            <p className="text-on-surface-variant font-medium">Sources</p>
            <ul className="space-y-0.5 mt-0.5">
              {d.citations.map((c, i) => (
                <li key={i}>
                  <a href={c.source} className="text-primary hover:underline">{c.title || c.source}</a>
                  {c.as_of ? <span className="text-on-surface-variant"> (as of {c.as_of})</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {d.timeline && (
          <div className="text-body-md bg-surface-container-high rounded-xl p-2.5 space-y-1.5">
            {d.timeline.status === 'found' ? (
              <>
                <p className="text-caption text-on-surface-variant">Your processing-timeline cohort:</p>
                <Link href={`/groups/${encodeURIComponent(d.timeline.group_id)}`} className="inline-block btn-primary rounded-full text-caption">
                  Open your timeline group{d.timeline.group_name ? ` (${d.timeline.group_name})` : ''} →
                </Link>
              </>
            ) : (
              <>
                <p className="text-caption text-on-surface-variant">
                  {d.timeline.group_name
                    ? <>No “{d.timeline.group_name}” cohort yet.</>
                    : <>Tell me your process, category and filing month to find your cohort.</>}
                </p>
                <Link href="/find" className="inline-block btn-primary rounded-full text-caption">Go to the timeline page →</Link>
              </>
            )}
          </div>
        )}

        {/* find-similar: connect with others in the same boat (Regular groups). */}
        {d.can_find_similar && d.find_url && (
          <div className="text-body-md bg-surface-container-high rounded-xl p-2.5 space-y-1.5">
            <p className="text-caption text-on-surface-variant">Find others in your situation:</p>
            <button onClick={() => router.push(d.find_url)} className="btn-primary rounded-full text-caption">
              Find people in the same boat →
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-2 pt-1">
          {d.intent === 'post' && d.post_draft ? (
            <button onClick={() => handlePost(turn)} className="btn-primary rounded-full text-caption">Continue to your post →</button>
          ) : (
            <>
              {d.can_post && (
                <button onClick={() => handlePost(turn)} className="btn-secondary rounded-full text-caption">Post this to the community</button>
              )}
              {d.can_find_timeline && !d.timeline && (
                <button onClick={() => send(lastUserMessage(), 'timeline-find')} className="btn-secondary rounded-full text-caption">Find your EAD/H-1B group</button>
              )}
            </>
          )}
        </div>

        {/* Only when we couldn't answer from our grounded sources (Q2): offer the
            two search paths — community postings, and the official USCIS site. */}
        {d.source_tier === 'ungrounded' && (
          <div className="pt-2 mt-1 border-t border-outline-variant">
            <p className="text-caption text-on-surface-variant mb-1">Not from our sources — search further:</p>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => router.push(`/advanced-search?q=${encodeURIComponent(turn.q || '')}`)}
                className="btn-secondary rounded-full text-caption"
              >
                Search community forum
              </button>
              <a
                href={`https://www.uscis.gov/search?query=${encodeURIComponent(turn.q || '')}`}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary rounded-full text-caption"
              >
                Search on USCIS.gov
              </a>
            </div>
          </div>
        )}
      </div>
    )
  }

  // Client-only widget: render nothing until mounted so the server HTML (no
  // sessionStorage) and the first client render agree.
  if (!mounted) return null

  // Collapsed: a floating launcher pinned to the bottom-right on EVERY page, so
  // the user can reopen and continue the conversation from anywhere. There is no
  // separate "Post a message" button — posting starts from inside this chat and
  // routes to /post when the conversation implies it.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Ask / Post a Question"
        className="fixed bottom-5 right-5 z-50 btn-primary rounded-full shadow-lg flex items-center gap-2 px-4 py-3"
      >
        <span className="material-symbols-outlined text-[20px]">auto_awesome</span>
        <span className="hidden sm:inline">Ask / Post a Question</span>
      </button>
    )
  }

  return (
    <aside
      aria-label="AI Assist"
      className="fixed bottom-5 right-5 z-50 flex flex-col w-[26rem] max-w-[calc(100vw-2rem)] h-[80vh] max-h-[calc(100vh-6rem)] bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-2xl"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-outline-variant shrink-0">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">auto_awesome</span>
          <span className="text-label-md font-semibold text-primary">Ask / Post a Question</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={startNew}
            aria-label="New chat"
            title="Start a new conversation"
            className="p-1 rounded hover:bg-surface-container text-on-surface-variant"
          >
            <span className="material-symbols-outlined text-[20px]">add_comment</span>
          </button>
          <button
            onClick={() => setOpen(false)}
            aria-label="Collapse"
            className="p-1 rounded hover:bg-surface-container text-on-surface-variant"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>
      </header>

      {/* Conversation log — capped so the writing area stays large; scrolls. */}
      <div
        ref={scrollRef}
        className="overflow-y-auto px-4 py-3 space-y-4 shrink-0 border-b border-outline-variant"
        style={{ maxHeight: '30%' }}
      >
        {turns.length === 0 ? (
          <p className="text-caption text-on-surface-variant">
            Ask an immigration question, or describe your situation and I&apos;ll help you post it to the community.
          </p>
        ) : (
          turns.map((t) =>
            t.role === 'user' ? (
              <div key={t.id} className="flex justify-end">
                <div className="bg-primary-container text-on-primary-container rounded-2xl rounded-tr-sm px-3 py-2 text-body-md max-w-[90%]">{t.content}</div>
              </div>
            ) : (
              renderAi(t)
            )
          )
        )}
        {loading && (
          <div className="flex gap-1 py-1" aria-label="Thinking">
            <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {error && <p className="text-caption text-error px-4 pt-2">{error}</p>}
      {nudge && (
        <p className="text-caption text-on-surface-variant px-4 pt-2">
          You&apos;ve reached the guest limit — <Link href="/login?next=/" className="text-primary hover:underline">sign in</Link> to keep asking.
        </p>
      )}

      {/* Composer — the large writing area (this is where a full message/post is
          drafted). Enter inserts a newline; Cmd/Ctrl+Enter or the button sends. */}
      <form
        onSubmit={(e) => { e.preventDefault(); send(input) }}
        className="flex-1 flex flex-col p-3 gap-2 min-h-0"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(input) } }}
          placeholder="Ask a question, or describe your situation to post it…"
          aria-label="Ask or post a question"
          className="flex-1 min-h-0 resize-none bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-3 text-body-md focus:outline-none focus:border-primary"
        />
        <div className="flex items-center justify-end shrink-0">
          <button type="submit" disabled={input.trim().length < 2 || loading} className="btn-primary rounded-full disabled:opacity-40">Ask</button>
        </div>
      </form>

      {/* Disclaimer — small print, always at the bottom (not per-answer). */}
      <p className="px-4 pb-2 pt-0 text-[10px] leading-tight text-center text-on-surface-variant shrink-0">
        This is general information about U.S. immigration, not legal advice.
      </p>
    </aside>
  )
}
