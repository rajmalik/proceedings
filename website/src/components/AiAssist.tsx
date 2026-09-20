'use client'

import { useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import Markdown from '@/components/Markdown'
import DisclaimerBanner from '@/components/DisclaimerBanner'
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
  disclaimer: string
  can_post: boolean
  can_find_timeline: boolean
  rationale: string
  id: string
  turns_used: number
}

type Turn = { id: string; role: 'user' | 'ai'; content: string; data?: AssistResponse }

let _seq = 0
const _id = (p: string) => `${p}-${Date.now()}-${_seq++}`

export default function AiAssist() {
  const router = useRouter()
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [nudge, setNudge] = useState(false)
  const [open, setOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

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
      setTurns((t) => [...t, { id: _id('a'), role: 'ai', content: resp.answer || '', data: resp }])
      queueMicrotask(() => scrollRef.current?.scrollTo?.({ top: scrollRef.current.scrollHeight }))
      return resp
    } catch {
      setError('Unable to reach the AI service. Please try again later.')
    } finally {
      setLoading(false)
    }
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
          <div className="text-body-md bg-surface-container-high rounded-xl p-2.5">
            {d.timeline.status === 'found' ? (
              <Link href={`/groups/${encodeURIComponent(d.timeline.group_id)}`} className="text-primary font-medium hover:underline">
                Join &amp; post in your group{d.timeline.group_name ? ` (${d.timeline.group_name})` : ''} →
              </Link>
            ) : (
              <span>
                {d.timeline.group_name
                  ? <>No “{d.timeline.group_name}” cohort yet. </>
                  : <>Tell me your process, category and filing month to find your cohort. </>}
                <Link href="/find" className="text-primary font-medium hover:underline">Find or create your timeline group →</Link>
              </span>
            )}
          </div>
        )}

        <DisclaimerBanner text={d.disclaimer} className="mt-1 rounded-lg bg-surface-container-high text-on-surface-variant py-1.5 px-2" />

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
      </div>
    )
  }

  // Collapsed: a floating launcher on the right rail. There is no separate
  // "Post a message" button anymore — posting starts from inside this chat and
  // routes to /post when the conversation implies it.
  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label="Open AI Assist"
        className="fixed bottom-5 right-5 z-40 btn-primary rounded-full shadow-lg flex items-center gap-2 px-4 py-3"
      >
        <span className="material-symbols-outlined">auto_awesome</span>
        <span className="hidden sm:inline">Ask AI</span>
      </button>
    )
  }

  return (
    <aside
      aria-label="AI Assist"
      className="fixed bottom-5 right-5 z-40 flex flex-col w-[24rem] max-w-[calc(100vw-2.5rem)] h-[70vh] max-h-[calc(100vh-2.5rem)] bg-surface-container-lowest border border-outline-variant rounded-2xl shadow-2xl"
    >
      <header className="flex items-center justify-between px-4 py-3 border-b border-outline-variant">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">auto_awesome</span>
          <span className="text-label-md font-semibold text-primary">Ask AI</span>
        </div>
        <button
          onClick={() => setOpen(false)}
          aria-label="Collapse AI Assist"
          className="p-1 rounded hover:bg-surface-container text-on-surface-variant"
        >
          <span className="material-symbols-outlined text-[20px]">close</span>
        </button>
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-4">
        {turns.length === 0 && (
          <p className="text-caption text-on-surface-variant">
            Ask an immigration question, describe your situation to post it, or ask about EAD/H-1B processing times.
          </p>
        )}
        {turns.map((t) =>
          t.role === 'user' ? (
            <div key={t.id} className="flex justify-end">
              <div className="bg-primary-container text-on-primary-container rounded-2xl rounded-tr-sm px-3 py-2 text-body-md max-w-[90%]">{t.content}</div>
            </div>
          ) : (
            renderAi(t)
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

      {error && <p className="text-caption text-error px-4">{error}</p>}
      {nudge && (
        <p className="text-caption text-on-surface-variant px-4">
          You&apos;ve reached the guest limit — <Link href="/login?next=/" className="text-primary hover:underline">sign in</Link> to keep asking.
        </p>
      )}

      <form onSubmit={(e) => { e.preventDefault(); send(input) }} className="border-t border-outline-variant p-3 flex items-center gap-2">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about U.S. immigration…"
          aria-label="Ask AI"
          className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-full px-4 py-2 text-body-md focus:outline-none focus:border-primary"
        />
        <button type="submit" disabled={input.trim().length < 2 || loading} className="btn-secondary rounded-full disabled:opacity-40">Ask</button>
      </form>
    </aside>
  )
}
