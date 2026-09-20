'use client'

import { Suspense,useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { getActiveUser, userHeaders, DEMO_PICKER_ENABLED } from '@/lib/activeUser'
import { useRequireUser } from '@/lib/useRequireUser'
import { useAuth } from '@/contexts/AuthContext'
import { readAndClearPostDraft } from '@/lib/assistDraft'
import { mergeReconcile } from '@/lib/postReconcile'

type Conflict = { field: string; profile_value?: unknown; message_value: unknown; message?: string }

type Groups = {
  visa_applying_for: string[]
  current_visa_or_greencard_category: string[]
  primary_consulate: string
  consulates: string[]
  tags: string[]
  concerns_or_questions_tags: string[]
}

type ConsulateOption = { code: string; label: string }
type Vocab = { visa: string[]; consulate: string[]; consulate_options: ConsulateOption[]; tag: string[]; stage_key: string[]; date_key: string[] }
type KV = Record<string, string>

const EMPTY: Groups = {
  visa_applying_for: [],
  current_visa_or_greencard_category: [],
  primary_consulate: '',
  consulates: [],
  tags: [],
  concerns_or_questions_tags: [],
}

type Section = { field: keyof Groups; label: string; vocab: 'visa' | 'consulate' | 'tag'; group?: string }

// primary_consulate intentionally omitted from the UI (derived from consulates[0]).
const SECTIONS: Section[] = [
  { field: 'visa_applying_for', label: 'Visa/category applying for', vocab: 'visa', group: 'Visa / status' },
  { field: 'current_visa_or_greencard_category', label: 'Current status', vocab: 'visa', group: 'Visa / status' },
  { field: 'consulates', label: 'Consulate', vocab: 'consulate', group: 'Consulate (if abroad)' },
  { field: 'tags', label: 'Background tags', vocab: 'tag', group: 'About this posting' },
  { field: 'concerns_or_questions_tags', label: 'Your questions / concerns', vocab: 'tag', group: 'About this posting' },
]

// Visa sections always show after preview so a visa/status can always be captured.
const ALWAYS = ['visa_applying_for', 'current_visa_or_greencard_category']

const POSTING_TYPE_LABEL: Record<string, string> = {
  consular_visa: 'Consular / visa abroad',
  in_us_status: 'In-US status',
  experience: 'Experience share',
  general_question: 'General question',
}

function PostPageInner() {
  useRequireUser()
  const { user, loading: authLoading } = useAuth()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [groups, setGroups] = useState<Groups>(EMPTY)
  const [stages, setStages] = useState<KV>({})
  const [dates, setDates] = useState<KV>({})
  const [vocab, setVocab] = useState<Vocab>({ visa: [], consulate: [], consulate_options: [], tag: [], stage_key: [], date_key: [] })
  const [previewed, setPreviewed] = useState(false)
  const [relevant, setRelevant] = useState<string[]>([])
  const [postingType, setPostingType] = useState('')
  const [previewing, setPreviewing] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ case_id: string; author_handle: string } | null>(null)

  // KV add inputs
  const [sKey, setSKey] = useState(''); const [sVal, setSVal] = useState('')
  const [dKey, setDKey] = useState(''); const [dVal, setDVal] = useState('')

  // phase-J reconcile (profile ↔ this message)
  const [conflicts, setConflicts] = useState<Conflict[]>([])
  const [explainer, setExplainer] = useState('')
  const [prefilled, setPrefilled] = useState<string[]>([])
  const [profileUpdated, setProfileUpdated] = useState(false)

  useEffect(() => {
    fetch('/api/tag-vocab').then((r) => r.json()).then((d) => setVocab({
      visa: d.visa || [], consulate: d.consulate || [], consulate_options: d.consulate_options || [],
      tag: d.tag || [], stage_key: d.stage_key || [], date_key: d.date_key || [],
    })).catch(() => {})
  }, [])

  const vocabSets = useMemo(() => ({
    visa: new Set(vocab.visa), consulate: new Set(vocab.consulate), tag: new Set(vocab.tag),
    stage_key: new Set(vocab.stage_key), date_key: new Set(vocab.date_key),
  }), [vocab])

  // Consulate label <-> code maps so users can type a place name (e.g. "Mumbai").
  const consulateByLabel = useMemo(() => new Map(vocab.consulate_options.map((o) => [o.label, o.code])), [vocab])
  const consulateByCode = useMemo(() => new Map(vocab.consulate_options.map((o) => [o.code, o.label])), [vocab])

  const canPreview = title.trim().length >= 3 && description.trim().length >= 10
  // family-immigration / employment-immigration (backend: posting.py's
  // _apply_visa_backfill()) are a LAST-RESORT fallback meant for manual
  // curation, where there's no original poster left to ask for more detail.
  // A live app user is right here and can always be asked directly instead
  // — so unlike curated content, a generic code should never be enough to
  // satisfy this gate on its own. Still shown as a chip (removable, same as
  // any other tag) so the user sees what was inferred and can either
  // replace it with a specific code or add one alongside it.
  const GENERIC_VISA_FALLBACKS = new Set(['family-immigration', 'employment-immigration'])
  const hasSpecificVisa = (arr: string[]) => arr.some((v) => !GENERIC_VISA_FALLBACKS.has(v))
  const hasVisa = hasSpecificVisa(groups.visa_applying_for) || hasSpecificVisa(groups.current_visa_or_greencard_category)
  const hasOnlyGenericVisa = !hasVisa && (groups.visa_applying_for.length > 0 || groups.current_visa_or_greencard_category.length > 0)
  const visibleSections = SECTIONS.filter((s) => ALWAYS.includes(s.field) || relevant.includes(s.field))

  // Reconcile the message groups against the saved profile (best-effort, only
  // with an active user) and apply the result to the composer. Shared by
  // preview() (tag-suggest path) and the AI-Assist draft mount effect so both
  // run the SAME profile-reconcile step (D1/D3).
  async function applyTagResult(g: Groups, st: KV, dt: KV) {
    let applied = false
    if (getActiveUser()) {
      try {
        const rr = await fetch('/api/reconcile', {
          method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ message: { ...g, key_stages_or_info: st, key_dates: dt } }),
        })
        if (rr.ok) {
          const a = mergeReconcile(g, st, dt, await rr.json())
          setGroups(a.groups); setStages(a.stages); setDates(a.dates)
          setConflicts(a.conflicts); setExplainer(a.explainer); setPrefilled(a.prefilled)
          applied = true
        }
      } catch { /* no active user / reconcile unavailable — post without it */ }
    }
    if (!applied) { setGroups(g); setStages(st); setDates(dt) }
    setPreviewed(true)
  }

  // AI-Assist hand-off: if a draft was stashed by the assistant, pre-fill /post
  // from it once, run it through the same reconcile step, then clear it
  // (read-once). No draft -> normal empty composer. (Q11/C2, D1/D3)
  //
  // Gated on identity: an anonymous visitor is bounced to /login by
  // useRequireUser, so we must NOT read-and-clear the draft on that pre-login
  // mount — otherwise it's consumed and gone after sign-in. Only consume once an
  // identity exists (after the ?next=/post round-trip), or in dev/demo where
  // there's no forced login. Runs when auth settles.
  useEffect(() => {
    if (authLoading) return
    if (!DEMO_PICKER_ENABLED && !user) return  // pre-login: leave the draft for after sign-in
    const draft = readAndClearPostDraft()
    if (!draft) return
    setTitle(draft.title)
    setDescription(draft.description)
    setPostingType(''); setConflicts([]); setExplainer(''); setPrefilled([]); setProfileUpdated(false)
    const g: Groups = { ...EMPTY, ...(draft.groups || {}) }
    const st: KV = draft.key_stages_or_info || {}
    const dt: KV = draft.key_dates || {}
    // The draft carries no relevant_sections — reveal any section with drafted data.
    setRelevant(SECTIONS.map((s) => s.field).filter((f) => {
      const v = g[f]
      return Array.isArray(v) ? v.length > 0 : Boolean(v)
    }) as string[])
    void applyTagResult(g, st, dt)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, authLoading])

  async function preview() {
    if (!canPreview) return
    setPreviewing(true); setError('')
    try {
      const res = await fetch('/api/tag-suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not analyze the posting')
      const g: Groups = { ...EMPTY, ...(data.groups || {}) }
      const st: KV = data.key_stages_or_info || {}
      const dt: KV = data.key_dates || {}
      setRelevant(Array.isArray(data.relevant_sections) ? data.relevant_sections : [])
      setPostingType(data.posting_type || '')
      setConflicts([]); setExplainer(''); setPrefilled([]); setProfileUpdated(false)
      await applyTagResult(g, st, dt)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not analyze the posting')
    } finally {
      setPreviewing(false)
    }
  }

  async function updateProfile() {
    try {
      const cur = await fetch('/api/profile', { headers: userHeaders() }).then((r) => r.json())
      const next: Record<string, unknown> = { ...cur }
      for (const c of conflicts) {
        if (c.field.includes('.')) {
          const [mapF, key] = c.field.split('.')
          next[mapF] = { ...((next[mapF] as Record<string, unknown>) || {}), [key]: c.message_value }
        } else {
          next[c.field] = c.message_value
        }
      }
      const res = await fetch('/api/profile', {
        method: 'PUT', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(next),
      })
      if (res.ok) { setProfileUpdated(true) }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update profile')
    }
  }

  function removeTag(field: keyof Groups, value: string) {
    setGroups((g) => ({ ...g, [field]: (g[field] as string[]).filter((t) => t !== value) }))
  }

  function addTag(section: Section, raw: string) {
    let value = raw.trim()
    if (!value) return
    // Consulate: accept a place-name label ("Mumbai, India (BOM)") and map it to the code.
    if (section.vocab === 'consulate' && consulateByLabel.has(value)) {
      value = consulateByLabel.get(value) as string
    }
    if (!vocabSets[section.vocab].has(value)) {
      setError(section.vocab === 'consulate'
        ? `Pick a consulate from the list (e.g. "Mumbai, India (BOM)").`
        : `"${value}" is not a valid ${section.vocab} tag.`)
      return
    }
    setError('')
    setGroups((g) => {
      const cur = g[section.field] as string[]
      return cur.includes(value) ? g : { ...g, [section.field]: [...cur, value] }
    })
  }

  function addStage() {
    const k = sKey.trim(), v = sVal.trim()
    if (!k || !v) return
    if (!vocabSets.stage_key.has(k)) { setError(`"${k}" is not a valid stage key.`); return }
    setError(''); setStages((s) => ({ ...s, [k]: v })); setSKey(''); setSVal('')
  }
  function addDate() {
    const k = dKey.trim(), v = dVal.trim()
    if (!k || !v) return
    if (!vocabSets.date_key.has(k)) { setError(`"${k}" is not a valid date key.`); return }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) { setError('Date must be YYYY-MM-DD.'); return }
    setError(''); setDates((d) => ({ ...d, [k]: v })); setDKey(''); setDVal('')
  }
  const removeStage = (k: string) => setStages((s) => { const n = { ...s }; delete n[k]; return n })
  const removeDate = (k: string) => setDates((d) => { const n = { ...d }; delete n[k]; return n })

  async function submit() {
    setSubmitting(true); setError('')
    try {
      const res = await fetch('/api/postings', {
        // Send the active user so the backend records the posting↔author link.
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          title, description, tags: groups, key_stages_or_info: stages, key_dates: dates,
          client_platform: 'web',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not publish posting')
      setDone({ case_id: data.case_id, author_handle: data.author_handle })
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not publish posting')
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <div className="max-w-xl mx-auto px-4 py-16 text-center">
        <span className="material-symbols-outlined text-[56px] text-primary">check_circle</span>
        <h1 className="text-headline-lg text-on-surface mt-4">Posted!</h1>
        <p className="text-body-md text-on-surface-variant mt-2">
          Published as <span className="font-medium">{done.author_handle}</span>. It may take a few
          minutes to appear in search results.
        </p>
        <div className="flex gap-3 justify-center mt-6">
          <Link href={`/case/${encodeURIComponent(done.case_id)}`} className="btn-primary">View your posting</Link>
          <button
            onClick={() => {
              setDone(null); setTitle(''); setDescription(''); setGroups(EMPTY)
              setStages({}); setDates({}); setPreviewed(false); setRelevant([]); setPostingType('')
            }}
            className="btn-secondary"
          >Post another</button>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-headline-md text-on-surface mb-1">Post a new message</h1>
      <p className="text-body-md text-on-surface-variant mb-5">
        Share your immigration experience or question. Preview to see auto-suggested tags, then submit.
      </p>

      {error && <div className="card text-error mb-4">{error}</div>}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* LEFT — compose */}
        <div className="space-y-4">
          <div>
            <label className="text-label-md text-on-surface font-medium">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={300}
              placeholder="e.g. H-1B extension with an RFE — what to expect?"
              className="mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-3 text-body-lg focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="text-label-md text-on-surface font-medium">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={8000}
              rows={16}
              placeholder="Describe your situation, what happened, and what you're asking about…"
              className="mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-xl px-4 py-3 text-body-md focus:outline-none focus:border-primary resize-y"
            />
            <p className="text-caption text-on-surface-variant mt-1">{description.length}/8000</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={preview} disabled={!canPreview || previewing} className="btn-primary disabled:opacity-40">
              {previewing ? 'Analyzing…' : previewed ? 'Re-preview' : 'Preview'}
            </button>
            <p className="text-caption text-on-surface-variant">
              We’ll tag your posting and show the relevant sections to review.
            </p>
          </div>
        </div>

        {/* RIGHT — empty until previewed, then expert-curated sections + submit */}
        <div className="bg-surface-container-low rounded-xl p-4">
          {!previewed ? (
            <div className="h-full min-h-[16rem] flex flex-col items-center justify-center text-center text-on-surface-variant">
              <span className="material-symbols-outlined text-[40px] opacity-60">sell</span>
              <p className="text-body-md mt-2 max-w-xs">
                Write your title and description, then click <strong>Preview</strong> — we’ll suggest the
                tags and sections that fit your posting.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-secondary">sell</span>
                  <span className="text-label-md font-semibold text-on-surface">Review tags</span>
                </div>
                {postingType && (
                  <span className="badge-secondary text-caption">{POSTING_TYPE_LABEL[postingType] || postingType}</span>
                )}
              </div>

              {/* phase-J: profile reconciliation */}
              {prefilled.length > 0 && conflicts.length === 0 && (
                <p className="text-caption text-on-surface-variant flex items-center gap-1">
                  <span className="material-symbols-outlined text-[16px] text-secondary">badge</span>
                  Pre-filled from your profile: {prefilled.map((f) => f.replace(/_/g, ' ')).join(', ')}.
                </p>
              )}
              {conflicts.length > 0 && (
                <div className="card bg-tertiary-container/40 border border-outline-variant">
                  <p className="text-body-md text-on-surface">{explainer || 'Some details differ from your saved profile.'}</p>
                  <ul className="text-caption text-on-surface-variant mt-1 space-y-0.5">
                    {conflicts.map((c) => (
                      <li key={c.field}>· {c.field.replace(/_/g, ' ').replace('.', ': ')} — profile: {String(c.profile_value)} → this post: {String(c.message_value)}</li>
                    ))}
                  </ul>
                  {profileUpdated ? (
                    <p className="text-caption text-primary mt-2">Profile updated ✓</p>
                  ) : (
                    <button onClick={updateProfile} className="btn-secondary text-label-md mt-2">Update my profile to match</button>
                  )}
                </div>
              )}

              {visibleSections.map((s, i) => {
                const showGroup = s.group && (i === 0 || visibleSections[i - 1].group !== s.group)
                const values = groups[s.field] as string[]
                const listId = `vocab-${s.field}`
                return (
                  <div key={s.field}>
                    {showGroup && (
                      <p className="text-caption uppercase tracking-wide text-on-surface-variant mt-2 mb-1">{s.group}</p>
                    )}
                    <label className="text-label-md text-on-surface">{s.label}</label>
                    <div className="flex flex-wrap gap-2 mt-1">
                      {values.map((v) => (
                        <span key={v} className="pill-active flex items-center gap-1">
                          {s.vocab === 'consulate' ? (consulateByCode.get(v) || v) : v}
                          <button onClick={() => removeTag(s.field, v)} aria-label={`Remove ${v}`} className="ml-0.5">
                            <span className="material-symbols-outlined text-[16px]">close</span>
                          </button>
                        </span>
                      ))}
                    </div>
                    <input
                      list={listId}
                      placeholder={s.vocab === 'consulate' ? 'Search by city or country…' : `Add ${s.label.toLowerCase()}…`}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          addTag(s, (e.target as HTMLInputElement).value)
                          ;(e.target as HTMLInputElement).value = ''
                        }
                      }}
                      className="mt-2 w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary"
                    />
                    <datalist id={listId}>
                      {s.vocab === 'consulate'
                        ? vocab.consulate_options.map((o) => <option key={o.code} value={o.label} />)
                        : vocab[s.vocab].map((v) => <option key={v} value={v} />)}
                    </datalist>
                  </div>
                )
              })}

              {/* Stages & outcomes (only when detected) */}
              {Object.keys(stages).length > 0 && (
                <div>
                  <p className="text-caption uppercase tracking-wide text-on-surface-variant mt-2 mb-1">Process / outcome</p>
                  <div className="space-y-1">
                    {Object.entries(stages).map(([k, v]) => (
                      <span key={k} className="pill-active flex items-center gap-1 w-fit">
                        {k}: {v}
                        <button onClick={() => removeStage(k)} aria-label={`Remove ${k}`} className="ml-0.5">
                          <span className="material-symbols-outlined text-[16px]">close</span>
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-2">
                    <input list="stage-keys" value={sKey} onChange={(e) => setSKey(e.target.value)} placeholder="stage key"
                      className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                    <input value={sVal} onChange={(e) => setSVal(e.target.value)} placeholder="value"
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStage() } }}
                      className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                    <button onClick={addStage} className="btn-secondary text-label-md">Add</button>
                  </div>
                  <datalist id="stage-keys">{vocab.stage_key.map((v) => <option key={v} value={v} />)}</datalist>
                </div>
              )}

              {/* Key dates (only when detected) */}
              {Object.keys(dates).length > 0 && (
                <div>
                  <p className="text-caption uppercase tracking-wide text-on-surface-variant mt-2 mb-1">Key dates</p>
                  <div className="space-y-1">
                    {Object.entries(dates).map(([k, v]) => (
                      <span key={k} className="pill-active flex items-center gap-1 w-fit">
                        {k}: {v}
                        <button onClick={() => removeDate(k)} aria-label={`Remove ${k}`} className="ml-0.5">
                          <span className="material-symbols-outlined text-[16px]">close</span>
                        </button>
                      </span>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-2">
                    <input list="date-keys" value={dKey} onChange={(e) => setDKey(e.target.value)} placeholder="date key"
                      className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                    <input type="date" value={dVal} onChange={(e) => setDVal(e.target.value)}
                      className="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                    <button onClick={addDate} className="btn-secondary text-label-md">Add</button>
                  </div>
                  <datalist id="date-keys">{vocab.date_key.map((v) => <option key={v} value={v} />)}</datalist>
                </div>
              )}

              <div className="pt-2 border-t border-outline-variant">
                {!hasVisa && (
                  <p className="text-caption text-error mb-2">
                    {hasOnlyGenericVisa
                      ? 'We could tell this is family/employment-based, but need the exact category — please add the specific one below (e.g. IR-1, EB-2) if you know it.'
                      : 'Add at least one visa/status under "Visa/category applying for" or "Current status" to submit.'}
                  </p>
                )}
                <button onClick={submit} disabled={submitting || !hasVisa} className="btn-primary w-full disabled:opacity-40">
                  {submitting ? 'Publishing…' : 'Submit posting'}
                </button>
                <p className="text-caption text-on-surface-variant mt-2 text-center">
                  Posted anonymously under a generated handle. Don’t include personal identifiers.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * This page reads the query string — PostPageInner (or a hook it calls, e.g.
 * useRequireUser's ?next= round-trip) uses useSearchParams(). Next 14 refuses
 * to prerender such a page unless it sits under a Suspense boundary, and
 * fails the PRODUCTION build with "useSearchParams() should be wrapped in a
 * suspense boundary" — an error `next dev`, tsc and vitest never surface.
 */
export default function PostPage() {
  return (
    <Suspense fallback={null}>
      <PostPageInner />
    </Suspense>
  )
}
