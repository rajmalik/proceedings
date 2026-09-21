'use client'

import { Suspense,useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Markdown from '@/components/Markdown'
import { useAuth } from '@/contexts/AuthContext'
import { getActiveUser, setActiveUser, userHeaders, DEMO_PICKER_ENABLED } from '@/lib/activeUser'
import { useRequireUser } from '@/lib/useRequireUser'

type JourneyEntry = { milestone: string; date: string; experience: string; shared?: boolean; experience_case_id?: string }
type Profile = {
  username: string
  current_visa_or_greencard_category: string[]
  visa_applying_for: string[]
  primary_consulate: string
  consulates: string[]
  tags: string[]
  key_stages_or_info: Record<string, string>
  key_dates: Record<string, string>
  background_text: string
  journey: JourneyEntry[]
  created_at?: string
  updated_at?: string
}
type SeedUser = { id: string; username: string; label?: string }
type Turn = { id: string; role: 'user' | 'ai'; content: string }
type Stage = 'basics' | 'experiences'
type ConsulateOption = { code: string; label: string }
type ConsulateCountry = { country: string; country_code: string; cities: { code: string; city: string }[] }
type Vocab = {
  visa: string[]; consulate: string[]; consulate_options: ConsulateOption[]; tag: string[]
  consulate_tree: ConsulateCountry[]
  stage_key: string[]; date_key: string[]; outcome: string[]; country: string[]
  misc: string[]; misc_options: ConsulateOption[]; profile_stage_key: string[]
  stage_value_domains: Record<string, string>
}

const EMPTY: Profile = {
  username: '', current_visa_or_greencard_category: [], visa_applying_for: [],
  primary_consulate: '', consulates: [], tags: [], key_stages_or_info: {}, key_dates: {},
  background_text: '', journey: [], created_at: '', updated_at: '',
}
const EMPTY_VOCAB: Vocab = {
  visa: [], consulate: [], consulate_options: [], consulate_tree: [], tag: [], stage_key: [], date_key: [],
  outcome: [], country: [], misc: [], misc_options: [], profile_stage_key: [], stage_value_domains: {},
}

const GREETING_BASICS =
  "Hi! Let's set up the **basics** of your immigration profile — your current situation, journey and key " +
  "dates. This is just your background, not a Q&A (you can post questions as messages later). " +
  "After we save this, I'll ask about your **experiences** at the milestones you've crossed.\n\n" +
  "To start: are you currently in the U.S. on a visa, or applying for one from abroad? " +
  "(Please don't share personal details like your name, date of birth, or passport number.)"

const GREETING_EXPERIENCES =
  "Your basic profile is saved ✓. Now let's capture your **experiences** at the milestones you've already " +
  "crossed — these help others going through the same steps (and aren't tagged to your current status)."

const GREETING_RETURNING =
  "Welcome back! Your **current tags** are on the right. Update them any way you like: add or remove tags " +
  "directly, edit your **background** below and hit *Re-generate tags*, or just tell me what changed " +
  "(e.g. \"my I-140 was approved on March 1\") and I'll update the tags for you."

type ListField = 'current_visa_or_greencard_category' | 'visa_applying_for' | 'consulates' | 'tags'
type TagKind = 'visa' | 'consulate' | 'misc'
const LIST_SECTIONS: { field: ListField; label: string; kind: TagKind }[] = [
  { field: 'current_visa_or_greencard_category', label: 'Current status', kind: 'visa' },
  { field: 'visa_applying_for', label: 'Applying for', kind: 'visa' },
  { field: 'consulates', label: 'Consulate(s)', kind: 'consulate' },
  { field: 'tags', label: 'Miscellaneous tags and topics', kind: 'misc' },
]

function OnboardingPageInner() {
  const router = useRouter()
  const { user: authUser } = useAuth()
  useRequireUser()
  const [users, setUsers] = useState<SeedUser[]>([])
  const [activeId, setActiveId] = useState('')
  const [stage, setStage] = useState<Stage>('basics')
  const [draft, setDraft] = useState<Profile>(EMPTY)
  const [vocab, setVocab] = useState<Vocab>(EMPTY_VOCAB)
  const [messages, setMessages] = useState<Turn[]>([{ id: 'greet', role: 'ai', content: GREETING_BASICS }])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [connectCardId, setConnectCardId] = useState('')
  const [error, setError] = useState('')
  const [regen, setRegen] = useState(false)
  const [regenNote, setRegenNote] = useState('')
  // KV add inputs (key stages / key dates)
  const [sKey, setSKey] = useState(''); const [sVal, setSVal] = useState('')
  const [dKey, setDKey] = useState(''); const [dVal, setDVal] = useState('')
  // Two-part consulate picker: type-to-filter a country, then pick a city.
  const [consCountry, setConsCountry] = useState<ConsulateCountry | null>(null)
  // Generated facets for each SHARED/published experience (the experience JSON), fetched from its doc.
  type ExpFacets = { visa: string[]; consulates: string[]; outcome: string; tags: string[]; date: string }
  const [expFacets, setExpFacets] = useState<Record<string, ExpFacets>>({})
  const threadRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Dev-only demo-user picker. In prod this is off, so anonymous visitors are
    // never silently adopted into a seed account (real identity = Firebase token).
    if (DEMO_PICKER_ENABLED) {
      fetch('/api/users').then((r) => r.json()).then((list: unknown) => {
        // Defensive: a proxy/backend error returns an object ({detail:…}), not an
        // array — feeding it to setUsers would crash users.map() at render time.
        const arr: SeedUser[] = Array.isArray(list) ? list : []
        setUsers(arr)
        const saved = getActiveUser()
        const id = saved && arr.some((u) => u.id === saved) ? saved : (arr[0]?.id || '')
        if (id) { setActiveUser(id); setActiveId(id) }
      }).catch(() => {})
    }
    fetch('/api/tag-vocab').then((r) => r.json()).then((d) => setVocab({
      visa: d.visa || [], consulate: d.consulate || [], consulate_options: d.consulate_options || [],
      consulate_tree: d.consulate_tree || [],
      tag: d.tag || [], stage_key: d.stage_key || [], date_key: d.date_key || [],
      outcome: d.outcome || [], country: d.country || [],
      misc: d.misc || [], misc_options: d.misc_options || [], profile_stage_key: d.profile_stage_key || [],
      stage_value_domains: d.stage_value_domains || {},
    })).catch(() => {})
  }, [])

  const loadProfile = useCallback(() => {
    fetch('/api/profile', { headers: userHeaders() }).then((r) => r.json()).then((p: Profile) => {
      setDraft({ ...EMPTY, ...p })
      setSavedAt(p.updated_at || '')
      setStage('basics')
      // "Welcome back" only when there's actual profile content (a freshly-minted
      // new user has a timestamp but no data → show the setup greeting instead).
      const hasData = (p.current_visa_or_greencard_category?.length || p.visa_applying_for?.length ||
        p.consulates?.length || p.tags?.length || Object.keys(p.key_stages_or_info || {}).length ||
        Object.keys(p.key_dates || {}).length || (p.background_text || '').trim().length)
      setMessages([{ id: 'greet', role: 'ai', content: hasData ? GREETING_RETURNING : GREETING_BASICS }])
    }).catch(() => {})
  }, [])

  // Mint a brand-new dev user ('new-…') and switch to it to onboard from scratch.
  async function createNewUser() {
    const name = (typeof window !== 'undefined' ? window.prompt('Name for the new user (optional):', '') : '') || ''
    try {
      const res = await fetch('/api/users', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: name.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not create user')
      setUsers((prev) => [...prev, { id: data.id, username: data.username, label: data.label }])
      switchUser(data.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create user')
    }
  }

  useEffect(() => {
    // Dev picker path (activeId) OR a real Firebase-authenticated user —
    // previously this only fired for the dev picker, so a real production
    // user's existing profile never loaded here at all (silently starting
    // every visit from a blank draft, and risking overwriting their saved
    // profile with empty data on save).
    if (activeId || authUser) loadProfile()
  }, [activeId, authUser, loadProfile])
  useEffect(() => { if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight }, [messages, loading])

  // Lazily fetch the generated facets (the experience JSON) for each shared/published experience.
  useEffect(() => {
    const ids = draft.journey.map((e) => e.experience_case_id).filter((id): id is string => !!id && !(id in expFacets))
    if (ids.length === 0) return
    Promise.all(ids.map((id) =>
      fetch(`/api/postings/${encodeURIComponent(id)}`).then((r) => (r.ok ? r.json() : null))
        .then((d) => [id, d] as const).catch(() => [id, null] as const)))
      .then((pairs) => setExpFacets((prev) => {
        const next = { ...prev }
        for (const [id, d] of pairs) {
          if (d) next[id] = { visa: d.visa || [], consulates: d.consulates || [], outcome: d.outcome || '', tags: d.tags || [], date: d.date || '' }
        }
        return next
      }))
  }, [draft.journey, expFacets])

  const vocabSets = useMemo(() => ({
    visa: new Set(vocab.visa), consulate: new Set(vocab.consulate), misc: new Set(vocab.misc),
    profile_stage_key: new Set(vocab.profile_stage_key), date_key: new Set(vocab.date_key),
    outcome: new Set(vocab.outcome), country: new Set(vocab.country),
  }), [vocab])
  const consulateByLabel = useMemo(() => new Map(vocab.consulate_options.map((o) => [o.label, o.code])), [vocab])
  const consulateByCode = useMemo(() => new Map(vocab.consulate_options.map((o) => [o.code, o.label])), [vocab])
  const miscByLabel = useMemo(() => new Map(vocab.misc_options.map((o) => [o.label, o.code])), [vocab])
  // value-domain of the currently-typed stage key (country|outcome|visa|consulate|'')
  const stageDomain = vocab.stage_value_domains[sKey.trim()] || ''
  function stageValueOk(domain: string, v: string): boolean {
    if (domain === 'country') return vocabSets.country.has(v)
    if (domain === 'consulate') return vocabSets.consulate.has(v)
    if (domain === 'visa') return vocabSets.visa.has(v)
    if (domain === 'outcome') return vocabSets.outcome.has(v)
    return true
  }

  function switchUser(id: string) { setActiveUser(id); setActiveId(id) }

  async function send(text: string) {
    const t = text.trim()
    if (t.length < 1 || loading) return
    setError('')
    const history = messages.map((m) => ({ role: m.role, content: m.content }))
    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, role: 'user', content: t }])
    setLoading(true)
    try {
      const res = await fetch('/api/onboard', {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ stage, messages: [...history, { role: 'user', content: t }], draft }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Onboarding error')
      setMessages((prev) => [...prev, { id: `${Date.now()}-a`, role: 'ai', content: data.reply }])
      setDraft({ ...EMPTY, ...data.profile })
    } catch (e) {
      setMessages((prev) => [...prev, { id: `${Date.now()}-x`, role: 'ai', content: e instanceof Error ? e.message : 'Onboarding error' }])
    } finally { setLoading(false) }
  }

  // --- tag editing (right panel) ---
  function removeChip(field: ListField, value: string) {
    setDraft((d) => ({ ...d, [field]: d[field].filter((v) => v !== value) }))
  }
  function addTag(field: ListField, kind: TagKind, raw: string) {
    let value = raw.trim(); if (!value) return
    if (kind === 'consulate' && consulateByLabel.has(value)) value = consulateByLabel.get(value) as string
    if (kind === 'misc' && miscByLabel.has(value)) value = miscByLabel.get(value) as string
    if (!vocabSets[kind].has(value)) {
      setError(kind === 'consulate' ? 'Pick a consulate from the list (e.g. "Mumbai, India (BOM)").'
        : kind === 'misc' ? 'Pick a tag from the list.'
        : `"${value}" is not a valid ${kind} — pick one from the list.`)
      return
    }
    setError('')
    setDraft((d) => (d[field].includes(value) ? d : { ...d, [field]: [...d[field], value] }))
  }
  function removeKV(field: 'key_stages_or_info' | 'key_dates', key: string) {
    setDraft((d) => { const n = { ...d[field] }; delete n[key]; return { ...d, [field]: n } })
  }
  function addStage() {
    const k = sKey.trim(); let v = sVal.trim(); if (!k || !v) return
    if (!vocabSets.profile_stage_key.has(k)) { setError(`"${k}" is not a valid stage key — pick one from the list.`); return }
    const domain = vocab.stage_value_domains[k]
    if (domain === 'consulate' && consulateByLabel.has(v)) v = consulateByLabel.get(v) as string
    if (domain && !stageValueOk(domain, v)) {
      setError(`"${v}" is not a valid value for "${k}" — pick from the ${domain} list.`); return
    }
    setError(''); setDraft((d) => ({ ...d, key_stages_or_info: { ...d.key_stages_or_info, [k]: v } })); setSKey(''); setSVal('')
  }
  function addDate() {
    const k = dKey.trim(), v = dVal.trim(); if (!k || !v) return
    if (!vocabSets.date_key.has(k)) { setError(`"${k}" is not a valid date key — pick one from the list.`); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { setError('Date must be YYYY-MM-DD.'); return }
    setError(''); setDraft((d) => ({ ...d, key_dates: { ...d.key_dates, [k]: v } })); setDKey(''); setDVal('')
  }

  // --- journey (experiences stage) ---
  function removeJourney(idx: number) { setDraft((d) => ({ ...d, journey: d.journey.filter((_, i) => i !== idx) })) }
  function toggleShare(idx: number) { setDraft((d) => ({ ...d, journey: d.journey.map((e, i) => i === idx ? { ...e, shared: !e.shared } : e) })) }
  const prettyMilestone = (m: string) => m.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

  async function persist(): Promise<Profile | null> {
    const res = await fetch('/api/profile', {
      method: 'PUT', headers: userHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(draft),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.detail || 'Could not save profile')
    setDraft({ ...EMPTY, ...data }); setSavedAt(data.updated_at || new Date().toISOString())
    return data
  }

  // Re-derive the structured tags from the free-text background, using the same
  // AI extraction engine as the chat (one-shot). Lets users edit the background
  // box and refresh the tags on the right without conversing.
  async function regenTags() {
    const text = draft.background_text.trim()
    if (text.length < 10) { setError('Add a sentence or two of background first.'); return }
    setRegen(true); setError(''); setRegenNote('')
    try {
      const res = await fetch('/api/onboard', {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ stage: 'basics', messages: [{ role: 'user', content: text }], draft }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not re-generate tags')
      if (data.profile) setDraft({ ...EMPTY, ...data.profile, background_text: data.profile.background_text || text })
      setRegenNote('Tags updated from your background ✓')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not re-generate tags')
    } finally { setRegen(false) }
  }

  // Stage 1 → save basics, then move to Stage 2 and have the bot open the experiences pass.
  async function saveAndContinue() {
    setSaving(true); setError('')
    try {
      const saved = await persist()
      setStage('experiences'); setMessages([]); setLoading(true)
      try {
        const res = await fetch('/api/onboard', {
          method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ stage: 'experiences', messages: [], draft: saved || draft }),
        })
        const data = await res.json()
        setMessages([{ id: 's2', role: 'ai', content: data.reply || GREETING_EXPERIENCES }])
        if (data.profile) setDraft({ ...EMPTY, ...data.profile })
      } catch {
        setMessages([{ id: 's2', role: 'ai', content: GREETING_EXPERIENCES }])
      } finally { setLoading(false) }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save profile')
    } finally { setSaving(false) }
  }

  async function saveExperiences() {
    setSaving(true); setError('')
    try { await persist(); router.push('/') }   // done → exit onboarding to the main page
    catch (e) { setError(e instanceof Error ? e.message : 'Could not save'); setSaving(false) }
  }

  async function publishConnectCard() {
    setConnecting(true); setError('')
    try {
      const res = await fetch('/api/connect-card', {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ note: '' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not publish connect card')
      setConnectCardId(data.case_id || '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not publish connect card')
    } finally { setConnecting(false) }
  }

  function backToBasics() {
    setStage('basics'); setMessages([{ id: 'greet', role: 'ai', content: savedAt ? GREETING_RETURNING : GREETING_BASICS }])
  }

  const hasBasics =
    draft.current_visa_or_greencard_category.length > 0 || draft.visa_applying_for.length > 0 ||
    draft.consulates.length > 0 || Object.keys(draft.key_stages_or_info).length > 0 ||
    Object.keys(draft.key_dates).length > 0 || draft.background_text.trim().length > 0

  const Step = ({ n, label, active, done }: { n: number; label: string; active: boolean; done: boolean }) => (
    <div className={`flex items-center gap-2 ${active ? 'text-primary' : 'text-on-surface-variant'}`}>
      <span className={`w-6 h-6 rounded-full flex items-center justify-center text-caption font-semibold ${active ? 'bg-primary text-on-primary' : done ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container'}`}>
        {done ? <span className="material-symbols-outlined text-[16px]">check</span> : n}
      </span>
      <span className="text-label-md">{label}</span>
    </div>
  )

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-2">
        <h1 className="text-headline-md text-on-surface">{savedAt ? 'Your profile' : 'Set up your profile'}</h1>
        {authUser ? (
          /* Firebase-authenticated — the demo picker is inert (the uid wins), so show
             identity instead. Never the real Firebase displayName/email — draft.username
             is the anonymized handle (loaded above), same as everywhere else in the app. */
          <span className="flex items-center gap-2 text-label-md text-on-surface-variant">
            <span className="material-symbols-outlined text-[20px]">account_circle</span>
            Signed in as {draft.username || 'Anonymous'}
          </span>
        ) : DEMO_PICKER_ENABLED ? (
          <label className="flex items-center gap-2 text-label-md text-on-surface-variant">
            <span className="material-symbols-outlined text-[20px]">switch_account</span>
            Demo user:
            <select value={activeId} onChange={(e) => { const v = e.target.value; if (v === '__new__') createNewUser(); else switchUser(v) }}
              className="bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-body-md focus:outline-none focus:border-primary">
              {users.map((u) => <option key={u.id} value={u.id}>{u.label || u.username}</option>)}
              <option value="__new__">➕ New user…</option>
            </select>
          </label>
        ) : null}
      </div>

      {/* stepper */}
      <div className="flex items-center gap-4 mb-4">
        <Step n={1} label="Background" active={stage === 'basics'} done={stage === 'experiences'} />
        <span className="w-8 h-0.5 bg-outline-variant" />
        <Step n={2} label="Experiences" active={stage === 'experiences'} done={false} />
      </div>

      {error && <div className="card text-error mb-4">{error}</div>}

      {/* Even split: LEFT = text (chat + background) · RIGHT = tags only */}
      <div className="grid gap-6 lg:grid-cols-2 items-start">
        {/* LEFT — text */}
        <div className="space-y-4">
          <div className="bg-surface-container-low rounded-xl p-4 flex flex-col" style={{ minHeight: '46vh' }}>
            <div ref={threadRef} className="flex-1 space-y-4 overflow-y-auto max-h-[56vh] pr-1">
              {messages.map((m) => (
                m.role === 'user' ? (
                  <div key={m.id} className="flex justify-end">
                    <div className="bg-primary-container text-on-primary-container rounded-2xl rounded-tr-sm px-3 py-2 text-body-md max-w-[85%]">{m.content}</div>
                  </div>
                ) : (
                  <div key={m.id} className="bg-surface-container rounded-2xl rounded-tl-sm p-3 text-on-surface max-w-[90%]">
                    <Markdown>{m.content}</Markdown>
                  </div>
                )
              ))}
              {loading && (
                <div className="flex gap-1 py-1">
                  <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-2 h-2 bg-primary/50 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              )}
            </div>
            {stage === 'basics' ? (
              // Single situation/background box (prefilled on load) — drives both
              // "Re-generate tags" and the conversational assistant.
              <div className="mt-3">
                <textarea value={draft.background_text}
                  onChange={(e) => { setRegenNote(''); setDraft((d) => ({ ...d, background_text: e.target.value })) }}
                  rows={4} maxLength={2000}
                  placeholder="Describe your situation in your own words — e.g. On H-1B from India, EB-2 PERM certified, I-140 filed, interviewing at Mumbai…"
                  className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-md focus:outline-none focus:border-primary resize-y" />
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <button onClick={regenTags} disabled={regen || draft.background_text.trim().length < 10}
                    className="btn-primary text-label-md disabled:opacity-40 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[18px]">auto_fix_high</span>
                    {regen ? 'Analyzing…' : 'Re-generate tags'}
                  </button>
                  <button onClick={() => send(draft.background_text)} disabled={loading || draft.background_text.trim().length < 1}
                    className="btn-secondary text-label-md disabled:opacity-40">Ask the assistant</button>
                  {regenNote && <span className="text-caption text-primary">{regenNote}</span>}
                </div>
              </div>
            ) : (
              <form onSubmit={(e) => { e.preventDefault(); send(input); setInput('') }} className="mt-3 flex items-center gap-2">
                <input value={input} onChange={(e) => setInput(e.target.value)}
                  placeholder="Share your experience…"
                  className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-full px-4 py-2 text-body-md focus:outline-none focus:border-primary" />
                <button type="submit" disabled={input.trim().length < 1 || loading} className="btn-primary rounded-full disabled:opacity-40">Send</button>
              </form>
            )}
          </div>
        </div>

        {/* RIGHT — tags only */}
        <aside className="bg-surface-container-low rounded-xl p-4 space-y-4 h-fit">
          {stage === 'basics' ? (
            <>
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-secondary">sell</span>
                <span className="text-label-md font-semibold text-on-surface">Your tags</span>
              </div>
              <p className="text-caption text-on-surface-variant">
                Generated from your background — add or remove any. New tags must be picked from the list.
              </p>

              {/* Visa / status / consulate list fields */}
              {LIST_SECTIONS.map((s) => {
                const values = draft[s.field]
                const listId = `ob-${s.kind}`
                return (
                  <div key={s.field}>
                    <p className="text-caption uppercase tracking-wide text-on-surface-variant mb-1">{s.label}</p>
                    <div className="flex flex-wrap gap-2">
                      {values.length === 0 && <span className="text-caption text-on-surface-variant">None.</span>}
                      {values.map((v) => (
                        <span key={v} className="pill-active flex items-center gap-1">
                          {s.kind === 'consulate' ? (consulateByCode.get(v) || v) : v}
                          <button onClick={() => removeChip(s.field, v)} aria-label={`Remove ${v}`}><span className="material-symbols-outlined text-[16px]">close</span></button>
                        </span>
                      ))}
                    </div>
                    {s.kind === 'consulate' ? (
                      /* Two-part picker: 1) type-to-filter country, 2) fixed city dropdown.
                         Picking a country alone is allowed (stores the country code). */
                      <div className="mt-1 space-y-2">
                        <input
                          list="ob-consulate-country"
                          placeholder="Type a country…"
                          value={consCountry ? `${consCountry.country} (${consCountry.country_code})` : ''}
                          onChange={(e) => {
                            const v = e.target.value
                            const match = vocab.consulate_tree.find(
                              (c) => `${c.country} (${c.country_code})` === v || c.country === v
                            )
                            setConsCountry(match || null)
                          }}
                          className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary"
                        />
                        {consCountry && (
                          <div className="flex flex-wrap items-center gap-2">
                            {consCountry.country_code && (
                              <button
                                onClick={() => { addTag(s.field, s.kind, consCountry.country_code); setConsCountry(null) }}
                                className="btn-secondary text-label-md whitespace-nowrap"
                              >
                                Add {consCountry.country} (country-wide)
                              </button>
                            )}
                            {consCountry.cities.length > 0 && (
                              <select
                                value=""
                                onChange={(e) => {
                                  if (!e.target.value) return
                                  // Selecting a city marks BOTH its country and the city, then closes the picker.
                                  if (consCountry.country_code) addTag(s.field, s.kind, consCountry.country_code)
                                  addTag(s.field, s.kind, e.target.value)
                                  setConsCountry(null)
                                }}
                                className="flex-1 min-w-[10rem] bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary"
                              >
                                <option value="">Add a city in {consCountry.country}…</option>
                                {consCountry.cities.map((c) => (
                                  <option key={c.code} value={c.code}>{c.city} ({c.code})</option>
                                ))}
                              </select>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <input list={listId}
                        placeholder={`Add ${s.label.toLowerCase()}…`}
                        onChange={(e) => {
                          // Auto-add as soon as a valid value is chosen from the dropdown
                          // (or fully typed). No error on partial input — Enter handles that.
                          const val = e.target.value
                          const valid = s.kind === 'misc' ? miscByLabel.has(val) : vocabSets[s.kind].has(val)
                          if (valid) { addTag(s.field, s.kind, val); e.target.value = '' }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addTag(s.field, s.kind, (e.target as HTMLInputElement).value)
                            ;(e.target as HTMLInputElement).value = ''
                          }
                        }}
                        className="mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                    )}
                  </div>
                )
              })}
              {/* country list is large — a datalist lets the user type to filter */}
              <datalist id="ob-consulate-country">
                {vocab.consulate_tree.map((c) => (
                  <option key={c.country_code || c.country} value={`${c.country} (${c.country_code})`} />
                ))}
              </datalist>
              <datalist id="ob-visa">{vocab.visa.map((v) => <option key={v} value={v} />)}</datalist>
              <datalist id="ob-consulate">{vocab.consulate_options.map((o) => <option key={o.code} value={o.label} />)}</datalist>
              <datalist id="ob-misc">{vocab.misc_options.map((o) => <option key={o.code} value={o.label} />)}</datalist>

              {/* Key stages / info */}
              <div>
                <p className="text-caption uppercase tracking-wide text-on-surface-variant mb-1">Key stages / info</p>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(draft.key_stages_or_info).length === 0 && <span className="text-caption text-on-surface-variant">None.</span>}
                  {Object.entries(draft.key_stages_or_info).map(([k, v]) => (
                    <span key={k} className="pill-active flex items-center gap-1">{k}: {v}
                      <button onClick={() => removeKV('key_stages_or_info', k)} aria-label={`Remove ${k}`}><span className="material-symbols-outlined text-[16px]">close</span></button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2 mt-1">
                  <input list="ob-stage-keys" value={sKey} onChange={(e) => { setSKey(e.target.value); setSVal('') }} placeholder="stage key"
                    className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                  <input list={stageDomain ? `ob-sv-${stageDomain}` : undefined}
                    value={sVal} onChange={(e) => setSVal(e.target.value)}
                    placeholder={stageDomain ? `${stageDomain} value…` : 'value'}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStage() } }}
                    className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                  <button onClick={addStage} className="btn-secondary text-label-md">Add</button>
                </div>
                {stageDomain && <p className="text-caption text-on-surface-variant mt-0.5">Value must be a valid {stageDomain} (pick from the list).</p>}
                <datalist id="ob-stage-keys">{vocab.profile_stage_key.map((v) => <option key={v} value={v} />)}</datalist>
                <datalist id="ob-sv-country">{vocab.country.map((v) => <option key={v} value={v} />)}</datalist>
                <datalist id="ob-sv-outcome">{vocab.outcome.map((v) => <option key={v} value={v} />)}</datalist>
                <datalist id="ob-sv-visa">{vocab.visa.map((v) => <option key={v} value={v} />)}</datalist>
                <datalist id="ob-sv-consulate">{vocab.consulate_options.map((o) => <option key={o.code} value={o.label} />)}</datalist>
              </div>

              {/* Key dates */}
              <div>
                <p className="text-caption uppercase tracking-wide text-on-surface-variant mb-1">Key dates</p>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(draft.key_dates).length === 0 && <span className="text-caption text-on-surface-variant">None.</span>}
                  {Object.entries(draft.key_dates).map(([k, v]) => (
                    <span key={k} className="pill-active flex items-center gap-1">{k}: {v}
                      <button onClick={() => removeKV('key_dates', k)} aria-label={`Remove ${k}`}><span className="material-symbols-outlined text-[16px]">close</span></button>
                    </span>
                  ))}
                </div>
                <div className="flex gap-2 mt-1">
                  <input list="ob-date-keys" value={dKey} onChange={(e) => setDKey(e.target.value)} placeholder="date key"
                    className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                  <input type="date" value={dVal} onChange={(e) => setDVal(e.target.value)}
                    className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                  <button onClick={addDate} className="btn-secondary text-label-md">Add</button>
                </div>
                <datalist id="ob-date-keys">{vocab.date_key.map((v) => <option key={v} value={v} />)}</datalist>
              </div>

              <button onClick={saveAndContinue} disabled={saving || !hasBasics} className="btn-primary w-full disabled:opacity-40">
                {saving ? 'Saving…' : 'Save & continue to experiences'}
              </button>
              <p className="text-caption text-on-surface-variant text-center">PII-free. Past experiences are added in the next step.</p>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary">timeline</span>
                  <span className="text-label-md font-semibold text-on-surface">Your experiences</span>
                </div>
                {savedAt && <span className="badge-success text-caption">saved</span>}
              </div>

              {draft.journey.length === 0 && <p className="text-caption text-on-surface-variant">No experiences yet — answer on the left to add them.</p>}

              {draft.journey.length > 0 && (
                <ol className="relative border-l border-outline-variant ml-1 space-y-3">
                  {draft.journey.map((e, i) => (
                    <li key={`${e.milestone}-${e.date}-${i}`} className="ml-3">
                      <span className="absolute -left-[5px] mt-1 w-2.5 h-2.5 rounded-full bg-primary" />
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-label-md text-on-surface font-medium">{prettyMilestone(e.milestone)}</p>
                          {e.date && <p className="text-caption text-on-surface-variant">{e.date}</p>}
                        </div>
                        <button onClick={() => removeJourney(i)} aria-label="Remove experience" className="text-on-surface-variant hover:text-error">
                          <span className="material-symbols-outlined text-[16px]">close</span>
                        </button>
                      </div>
                      <p className="text-body-md text-on-surface-variant mt-0.5 whitespace-pre-wrap">{e.experience}</p>
                      <label className="flex items-center gap-2 mt-1 cursor-pointer select-none">
                        <input type="checkbox" checked={!!e.shared} onChange={() => toggleShare(i)} className="accent-primary" />
                        <span className="text-caption text-on-surface-variant">
                          Share the timeline for other users
                          {e.shared && e.experience_case_id && <span className="text-primary"> · shared</span>}
                        </span>
                      </label>
                      {/* generated facets (the experience JSON) — only for shared/published ones */}
                      {e.experience_case_id && expFacets[e.experience_case_id] && (
                        <div className="mt-1">
                          <p className="text-caption text-on-surface-variant">Tagged for search:</p>
                          <div className="flex flex-wrap gap-1 mt-0.5">
                            {expFacets[e.experience_case_id].visa.map((v) => <span key={`v${v}`} className="badge-primary text-caption">{v}</span>)}
                            {expFacets[e.experience_case_id].consulates.map((c) => <span key={`c${c}`} className="badge-secondary text-caption">{c}</span>)}
                            {expFacets[e.experience_case_id].outcome && <span className="badge-success text-caption">{expFacets[e.experience_case_id].outcome}</span>}
                            {expFacets[e.experience_case_id].tags.slice(0, 5).map((t) => (
                              <span key={`t${t}`} className="text-caption text-on-surface-variant bg-surface-container px-2 py-0.5 rounded">{t}</span>
                            ))}
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              )}

              <button onClick={saveExperiences} disabled={saving} className="btn-primary w-full disabled:opacity-40">
                {saving ? 'Saving…' : 'Save experiences'}
              </button>
              <button onClick={backToBasics} className="btn-secondary w-full">Back to background</button>
              <p className="text-caption text-on-surface-variant text-center">Experiences are stored as text and never tagged to your current status. Only the ones you tick to share become searchable by others.</p>

              {/* Connect card */}
              <div className="pt-3 border-t border-outline-variant">
                <p className="text-caption text-on-surface-variant mb-2">
                  Want others in the same situation to find you? Publish a “looking to connect” card from your current profile.
                </p>
                <button onClick={publishConnectCard} disabled={connecting} className="btn-secondary w-full disabled:opacity-40">
                  {connecting ? 'Publishing…' : connectCardId ? 'Connect card published ✓' : 'Publish a connect card'}
                </button>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  )
}

/**
 * This page reads the query string — OnboardingPageInner (or a hook it calls, e.g.
 * useRequireUser's ?next= round-trip) uses useSearchParams(). Next 14 refuses
 * to prerender such a page unless it sits under a Suspense boundary, and
 * fails the PRODUCTION build with "useSearchParams() should be wrapped in a
 * suspense boundary" — an error `next dev`, tsc and vitest never surface.
 */
export default function OnboardingPage() {
  return (
    <Suspense fallback={null}>
      <OnboardingPageInner />
    </Suspense>
  )
}
