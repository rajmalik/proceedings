'use client'

import { Suspense,useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import TagAutocomplete from '@/components/TagAutocomplete'
import { useAuth } from '@/contexts/AuthContext'
import { getActiveUser, setActiveUser, userHeaders, DEMO_PICKER_ENABLED } from '@/lib/activeUser'
import { CHECKBOX_ON, type PostJoinRow } from '@/lib/postJoinAttributes'
import { useRequireUser } from '@/lib/useRequireUser'
import { useSearchParams } from 'next/navigation'

// backend/posting.py's PROCESSING_TYPES. `eligibility_categories` empty means
// that type has no second dropdown. Both a type and a category carry the
// `scope_rows` their selection implies, already resolved server-side (base
// period rows + whatever that type/category configures on top), so this page
// renders whichever rows it is handed rather than knowing any of them.
type EligibilityCategory = { code: string; label: string; tag: string; scope_rows?: AttributeRow[] }
type ProcessingType = {
  value: string; label: string
  // What the second dropdown is called for THIS type. EAD's list really is
  // 8 CFR eligibility categories; H-1B's is application types. Optional —
  // omitted falls back to the EAD wording below.
  category_label?: string
  eligibility_categories: EligibilityCategory[]; scope_rows?: AttributeRow[]
}

type TagField = 'current_visa_or_greencard_category' | 'visa_applying_for' | 'consulates' | 'tags'
type Tag = { field: TagField; code: string; label: string }
type Criteria = {
  current_visa_or_greencard_category: string[]
  visa_applying_for: string[]
  primary_consulate: string
  consulates: string[]
  tags: string[]
  key_stages_or_info: Record<string, string>
  key_dates: Record<string, string>
  background_text: string
}
type ConsulateOption = { code: string; label: string }
// A scope row writes into whichever criteria map its `field` names — a date
// row (I-485's priority date) lands in key_dates, the period rows in
// key_stages_or_info.
type AttributeField = 'key_stages_or_info' | 'key_dates'
type AttributeRow =
  | { kind: 'select'; label: string; field: AttributeField; key: string; options: string[] }
  | { kind: 'year'; label: string; field: AttributeField; key: string }
  | { kind: 'date'; label: string; field: AttributeField; key: string }
type Vocab = {
  visa: string[]; consulate_options: ConsulateOption[]; tag: string[]
  tag_attribute_templates: Record<string, AttributeRow[]>
  processing_types: ProcessingType[]
  post_join_attribute_templates: Record<string, PostJoinRow[]>
}
const EMPTY_VOCAB: Vocab = {
  visa: [], consulate_options: [], tag: [],
  tag_attribute_templates: {}, post_join_attribute_templates: {}, processing_types: [],
}
type GroupType = 'regular' | 'timeline'
type Precision = 'broad' | 'balanced' | 'strict'
type SeedUser = { id: string; username: string; label?: string }
type GroupResult = {
  group_id: string; name: string; group_type: string; criteria_text: string
  members: { user_id: string; username: string }[]; score: number
}
type BrowseGroup = {
  group_id: string; name: string; description: string; group_type: string; criteria_text: string
  criteria_tags?: Partial<Criteria>
  members: { user_id: string; username: string }[]; is_member: boolean
  status: string; expiration_date: string
  created_by: string; created_by_username: string; created_at: string
  is_invited?: boolean
}
type Invitation = {
  invitation_id: string; group_id: string; group_name: string
  invited_by_username: string; requires_attributes: boolean
}
type PendingInvitation = { invitation: Invitation; group: BrowseGroup }

// Group validity, chosen at creation time — value strings match backend
// matching.py's _VALIDITY_DAYS exactly. Timeline groups only offer the
// short-lived options (a processing cohort ages out); Regular groups add
// the long-lived ones too (a "same boat" support group is meant to persist).
const VALIDITY_OPTIONS: { value: string; label: string }[] = [
  { value: '1_month', label: '1 month' },
  { value: '3_months', label: '3 months' },
  { value: '6_months', label: '6 months' },
  { value: '1_year', label: '1 year' },
  { value: '3_years', label: '3 years' },
  { value: '5_years', label: '5 years' },
  { value: '10_years', label: '10 years' },
]
const TIMELINE_VALIDITY_VALUES = new Set(['1_month', '3_months', '6_months', '1_year'])
function validityOptionsFor(groupType: GroupType) {
  return groupType === 'timeline' ? VALIDITY_OPTIONS.filter((o) => TIMELINE_VALIDITY_VALUES.has(o.value)) : VALIDITY_OPTIONS
}

const CATEGORY_FIELDS: { field: TagField; label: string; kind: 'visa' | 'consulate' | 'tag' }[] = [
  { field: 'current_visa_or_greencard_category', label: 'Current status', kind: 'visa' },
  { field: 'visa_applying_for', label: 'Applying for', kind: 'visa' },
  { field: 'consulates', label: 'Consulate(s)', kind: 'consulate' },
  { field: 'tags', label: 'Tags', kind: 'tag' },
]
// Timeline groups have NO manual category entry at all — Processing type
// (+ the Cycle/Year it reveals) is the only criteria UI. Current status and
// Applying for are redundant once Processing type exists: H-1B lands in
// Current status automatically via selectProcessingType(), and a Timeline
// group's whole point is exact-match on that single dropdown, not a
// freeform visa picker.
function categoryFieldsFor(groupType: GroupType) {
  return groupType === 'timeline' ? [] : CATEGORY_FIELDS
}

// A very brief "tags used" summary for a browse-list card — current status,
// applying-for, consulates, and generic tags, capped so the card stays
// compact. "Timeline" itself is shown as a separate pill (see groupPill()),
// not folded into this list.
function tagSummary(g: BrowseGroup): string {
  const c = g.criteria_tags || {}
  const cycle = c.key_stages_or_info?.stem_opt_cycle
  const year = c.key_stages_or_info?.stem_opt_year
  const parts = [
    ...(c.current_visa_or_greencard_category || []),
    ...(c.visa_applying_for || []),
    ...(c.consulates || []),
    ...(c.tags || []),
    ...(cycle ? [cycle] : []),
    ...(year ? [year] : []),
  ]
  return parts.slice(0, 4).join(' · ')
}

function TypeBadge({ groupType }: { groupType: string }) {
  return groupType === 'timeline'
    ? <span className="text-caption text-secondary bg-secondary-container/50 px-2 py-0.5 rounded-full">Timeline</span>
    : <span className="text-caption text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full">Regular</span>
}

function StatusBadge({ status }: { status: string }) {
  if (!status || status === 'active') return null
  const label = status === 'archived' ? 'Archived' : status === 'deleted' ? 'Deleted' : status
  return <span className="text-caption text-error bg-error-container/50 px-2 py-0.5 rounded-full">{label}</span>
}

// Unified group-list card — used for both the "Your groups" and "All
// groups" panels so every card shows the same content: name, type/status
// badges, tag summary, description, member count, and a single primary
// action (Open for members, View for everyone else — joining happens on
// the group's own page, not from a browse card).
function GroupRow({ g }: { g: BrowseGroup }) {
  return (
    <div className={`card flex items-start justify-between gap-4 ${g.is_member ? 'border border-primary/40' : ''}`}>
      <div className="min-w-0">
        <p className="text-label-md font-semibold text-on-surface flex items-center gap-1.5 flex-wrap">
          {g.is_member && <span className="material-symbols-outlined text-[16px] text-primary">check_circle</span>}
          {g.name}
          <TypeBadge groupType={g.group_type} />
          <StatusBadge status={g.status} />
          {/* You have an invitation waiting — the card is otherwise
              indistinguishable from any other group you're not in. */}
          {!g.is_member && g.is_invited && (
            <span className="pill text-caption text-primary bg-primary-container">Invited</span>
          )}
        </p>
        <p className="text-caption text-on-surface-variant mt-0.5">{tagSummary(g) || 'No tags yet.'}</p>
        {g.description && <p className="text-caption text-on-surface-variant mt-0.5">{g.description}</p>}
        <p className="text-caption text-on-surface-variant mt-1">
          {g.members.length} member{g.members.length === 1 ? '' : 's'}
        </p>
      </div>
      <Link href={`/groups/${encodeURIComponent(g.group_id)}`}
        className={`text-label-md whitespace-nowrap shrink-0 inline-flex items-center gap-1 ${g.is_member ? 'btn-primary' : 'btn-secondary'}`}>
        {g.is_member ? <><span className="material-symbols-outlined text-[18px]">chat</span> Open</> : 'View'}
      </Link>
    </div>
  )
}

// "Cutoff period" — filters group SEARCH results by the group's own
// creation recency (features/timeline-notifications-3/ Find Groups plan).
// 0 = "All time" = no restriction, matching /api/groups/search's own
// default so an untouched slider changes nothing.
const CUTOFF_STEPS: { days: number; label: string }[] = [
  { days: 0, label: 'All time' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 182, label: '6 months' },
  { days: 365, label: '1 year' },
]

function FindPageInner() {
  const router = useRouter()
  const { user: authUser } = useAuth()
  useRequireUser()
  const [users, setUsers] = useState<SeedUser[]>([])
  const [activeId, setActiveId] = useState('')
  const [tab, setTab] = useState<'find' | 'browse'>('browse')  // land on existing groups
  // Within the find tab: are we searching, or filling in the create form?
  // A mode rather than a route so the criteria you just searched with carry
  // straight into the group you create from them.
  const [createMode, setCreateMode] = useState(false)
  const [vocab, setVocab] = useState<Vocab>(EMPTY_VOCAB)
  const [error, setError] = useState('')

  // search criteria panel
  // Timeline is the default — it's the group type this product is actually
  // organised around, and landing on Regular meant most users switched
  // immediately.
  const [groupType, setGroupType] = useState<GroupType>('timeline')
  const [tags, setTags] = useState<Tag[]>([])
  const [revealedFields, setRevealedFields] = useState<Set<TagField>>(new Set())
  const [precision, setPrecision] = useState<Precision>('balanced')
  const [cutoffIdx, setCutoffIdx] = useState(0)
  // Group validity, chosen at creation time — clamped to a valid option for
  // the current groupType whenever it changes (see the effect below).
  const [validity, setValidity] = useState('1_year')
  const [description, setDescription] = useState('')
  // Timeline-only: the group's own blurb (distinct from `description` above,
  // which is the searcher's "situation" text → criteria_text). Sent as the
  // group's `description` field on create only — Search doesn't use it.
  const [groupDescription, setGroupDescription] = useState('')
  // True once the creator edits the blurb themselves — after that the
  // generated one stops overwriting it. Without this, changing any criterion
  // would silently discard what they wrote.
  const [descriptionEdited, setDescriptionEdited] = useState(false)
  // The name and description these criteria WOULD produce, from the server.
  // Not computed here on purpose: Timeline dedup is name-based, so a local
  // guess that drifted from matching._timeline_group_name() would promise a
  // new group and deliver a join into an existing one.
  const [preview, setPreview] = useState<{ name: string; description: string }>({ name: '', description: '' })
  // Timeline-only: written exclusively by the scope rows the selected
  // Processing type / Eligibility category configures (no manual key-stage
  // entry point anymore). Held flat by row key and split into
  // key_stages_or_info vs key_dates at submit time by each row's `field` —
  // the keys are globally unique vocabulary entries, so one map is enough.
  const [scopeValues, setScopeValues] = useState<Record<string, string>>({})
  // Timeline-only: "Processing type" — which tag_attribute_templates entry
  // (registry key) is active. Drives the Cycle/Year fields below it.
  const [processingType, setProcessingType] = useState('')
  // Second dropdown: WHICH eligibility category under the processing type
  // (e.g. EAD → "(c)(3)(C) F-1 STEM OPT extension"). Its tag goes into the
  // criteria alongside the processing type, and is what Cycle/Year hang off.
  const [eligibility, setEligibility] = useState('')
  // Required when the selected Processing type has a registered post-join
  // attribute template — matching.py's find_or_create_group() gates a
  // brand-new group's CREATOR the same as anyone joining an existing one
  // ("create" and "join" are the same membership action).

  // search results
  const [results, setResults] = useState<GroupResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [creating, setCreating] = useState(false)

  // browse
  const [allGroups, setAllGroups] = useState<BrowseGroup[]>([])
  const [browseLoading, setBrowseLoading] = useState(false)

  // pending invitations addressed to me (accept/decline live here)
  const [invitations, setInvitations] = useState<PendingInvitation[]>([])
  const [respondingTo, setRespondingTo] = useState('')

  // The two browse panels partition the same list — a group belongs to
  // exactly one of them, never both.
  const myGroups = useMemo(() => allGroups.filter((g) => g.is_member), [allGroups])
  const otherGroups = useMemo(() => allGroups.filter((g) => !g.is_member), [allGroups])

  // Anonymized handle for the "Signed in as" identity line — never the real
  // Firebase displayName/email (same pattern as TopAppBar.tsx).
  const [handle, setHandle] = useState('')
  useEffect(() => {
    if (!authUser) { setHandle(''); return }
    fetch('/api/profile', { headers: userHeaders() })
      .then((r) => r.json())
      .then((p: { username?: string }) => setHandle(p.username || ''))
      .catch(() => setHandle(''))
  }, [authUser])

  useEffect(() => {
    // Dev-only demo-user picker (off in prod — see DEMO_PICKER_ENABLED).
    if (DEMO_PICKER_ENABLED) {
      fetch('/api/users').then((r) => r.json()).then((list: unknown) => {
        // Defensive: a backend/proxy error returns an object ({detail:…}), not an
        // array. Never feed a non-array to setUsers — users.map() in render would
        // throw a client-side exception (white-screen) instead of degrading.
        const arr: SeedUser[] = Array.isArray(list) ? list : []
        setUsers(arr)
        const saved = getActiveUser()
        const id = saved && arr.some((u) => u.id === saved) ? saved : (arr[0]?.id || '')
        if (id) { setActiveUser(id); setActiveId(id) }
      }).catch(() => {})
    }
    fetch('/api/tag-vocab').then((r) => r.json()).then((d) => setVocab({
      visa: d.visa || [], consulate_options: d.consulate_options || [], tag: d.tag || [],
      tag_attribute_templates: d.tag_attribute_templates || {},
      processing_types: d.processing_types || [],
      post_join_attribute_templates: d.post_join_attribute_templates || {},
    })).catch(() => {})
  }, [])

  // Timeline offers fewer validity options than Regular — clamp back to a
  // valid one whenever groupType changes and the current pick no longer fits.
  useEffect(() => {
    const opts = validityOptionsFor(groupType)
    if (!opts.some((o) => o.value === validity)) setValidity(opts[0].value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupType])

  // Previous/current/next year for the stem-opt-extension "Year" dropdown —
  // computed client-side (never baked into the backend template) so it's
  // always current without needing a server round-trip on Jan 1.
  // Five years back through next year. Timeline cohorts are routinely formed
  // long after filing — a 2022 priority-date crowd is still waiting — so a
  // last-year/this-year/next-year window couldn't express most real groups.
  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear()
    return Array.from({ length: 7 }, (_, i) => String(y - 5 + i))
  }, [])
  const consulateByLabel = useMemo(() => new Map(vocab.consulate_options.map((o) => [o.label, o.code])), [vocab])
  const consulateByCode = useMemo(() => new Map(vocab.consulate_options.map((o) => [o.code, o.label])), [vocab])
  const visaSet = useMemo(() => new Set(vocab.visa), [vocab])

  function resetSearch() {
    setResults([]); setSearched(false); setError('')
  }
  function switchUser(id: string) {
    setActiveUser(id); setActiveId(id)
    setTags([]); setRevealedFields(new Set()); setDescription(''); setGroupDescription('')
    setDescriptionEdited(false)
    setScopeValues({}); setProcessingType(''); setEligibility(''); setValidity('1_year')
    resetSearch()
  }

  function tagsFor(field: TagField): Tag[] {
    return tags.filter((t) => t.field === field)
  }
  function isShown(field: TagField): boolean {
    return revealedFields.has(field) || tags.some((t) => t.field === field)
  }
  function reveal(field: TagField) {
    setRevealedFields((prev) => new Set(prev).add(field))
  }
  // A category that's ever held a tag stays visible even after its last tag
  // is removed — avoids layout/focus jumping while the user is actively
  // editing it. No "invalid value" path needed — TagAutocomplete only ever
  // offers suggestions filtered from the fetched vocab, so every pickable
  // value is valid by construction.
  function addTag(field: TagField, code: string) {
    reveal(field)
    setTags((prev) => (prev.some((t) => t.field === field && t.code === code) ? prev : [...prev, { field, code, label: code }]))
  }
  function removeTag(field: TagField, code: string) {
    setTags((prev) => prev.filter((t) => !(t.field === field && t.code === code)))
  }

  // Pre-fill from a deep-link — the AI Assist "Find people in the same boat"
  // button hands off as /find?type=regular&q=<situation>&visa=<code>. Runs once.
  const searchParams = useSearchParams()
  useEffect(() => {
    if (!searchParams) return
    const type = searchParams.get('type')
    const q = searchParams.get('q')
    const visa = searchParams.get('visa')
    if (type === 'regular') { setTab('find'); setGroupType('regular') }
    if (q) setDescription(q)
    if (visa) addTag('current_visa_or_greencard_category', visa)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams])

  // Timeline deep-link — the AI Assist timeline button hands off as
  // /find?type=timeline&processing_type=EAD&eligibility=<tag>&filing_month=Aug&
  // filing_year=2026. Deferred until the vocab (processing_types) has loaded, so
  // selectProcessingType/selectEligibility resolve the right criteria field and
  // the Cycle/Year scope rows exist to receive month/year. Runs once.
  const timelinePrefilled = useRef(false)
  useEffect(() => {
    if (timelinePrefilled.current || !searchParams) return
    if (searchParams.get('type') !== 'timeline') return
    if (vocab.processing_types.length === 0) return  // wait for the vocab
    timelinePrefilled.current = true
    setTab('find'); setGroupType('timeline')
    const pt = searchParams.get('processing_type') || ''
    const el = searchParams.get('eligibility') || ''
    const fm = searchParams.get('filing_month') || ''
    const fy = searchParams.get('filing_year') || ''
    if (pt) {
      selectProcessingType(pt)          // also clears eligibility + scope values
      if (el) selectEligibility(el)     // ...which selectEligibility then re-clears
    }
    // Set filing month/year LAST — the select* calls above reset scopeValues.
    if (fm || fy) {
      setScopeValues((prev) => ({
        ...prev, ...(fm ? { filing_month: fm } : {}), ...(fy ? { filing_year: fy } : {}),
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, vocab.processing_types])

  // "Processing type" — a dedicated top-of-panel dropdown that both selects
  // which tag_attribute_templates entry drives the Cycle/Year fields below,
  // and adds the type itself to the right criteria field: a visa-vocab type
  // (e.g. H-1B) goes to Current status; anything else (e.g.
  // stem-opt-extension, a 1.6 tag) goes to the generic Tags category.
  // Single-select — switching removes the previous type's entry first.
  function processingTypeField(type: string): TagField {
    return visaSet.has(type) ? 'current_visa_or_greencard_category' : 'tags'
  }
  function selectProcessingType(next: string) {
    if (processingType) removeTag(processingTypeField(processingType), processingType)
    if (next) addTag(processingTypeField(next), next)
    setProcessingType(next)
    // The eligibility list belongs to the type — changing the type invalidates
    // whatever was picked under the old one, and with it Cycle/Year.
    selectEligibility('')
  }

  function selectEligibility(next: string) {
    if (eligibility) removeTag(processingTypeField(eligibility), eligibility)
    if (next) addTag(processingTypeField(next), next)
    setEligibility(next)
    setScopeValues({})
  }

  const selectedType = vocab.processing_types.find((t) => t.value === processingType)
  const selectedCategory = selectedType?.eligibility_categories.find((c) => c.tag === eligibility)

  // Which registry entry drives the scope rows. The backend resolves the rows
  // onto the dropdown option itself, so a category that configures an extra
  // field (I-485's priority date) needs nothing here; the tag-keyed registry
  // is the fallback for a cached vocab payload predating `scope_rows`.
  const attrTemplateKey =
    (eligibility && vocab.tag_attribute_templates[eligibility] && eligibility) ||
    (!selectedType?.eligibility_categories.length && processingType
      && vocab.tag_attribute_templates[processingType] && processingType) || ''
  const scopeRows: AttributeRow[] =
    (eligibility ? selectedCategory?.scope_rows : selectedType?.scope_rows)
    || (attrTemplateKey ? vocab.tag_attribute_templates[attrTemplateKey] : [])
    || []
  // Used by the scope fields (below) to clear a row back to "—".
  function removeScopeValue(key: string) {
    setScopeValues((prev) => { const n = { ...prev }; delete n[key]; return n })
  }

  function criteriaFromPanel(): Criteria {
    const byField = (f: TagField) => tags.filter((t) => t.field === f).map((t) => t.code)
    // Scope rows are Timeline-only — never leak into a Regular-group
    // search/create even if they were filled in before switching group type.
    const scopeIn = (field: AttributeField) => Object.fromEntries(
      groupType === 'timeline'
        ? scopeRows.filter((r) => r.field === field && scopeValues[r.key])
            .map((r) => [r.key, scopeValues[r.key]])
        : [],
    )
    return {
      current_visa_or_greencard_category: byField('current_visa_or_greencard_category'),
      visa_applying_for: byField('visa_applying_for'),
      primary_consulate: '',
      // Consulate is a Regular-only category — never leak a consulate picked
      // before switching to Timeline into a Timeline search/create.
      consulates: groupType === 'timeline' ? [] : byField('consulates'),
      tags: byField('tags'),
      key_stages_or_info: scopeIn('key_stages_or_info'),
      key_dates: scopeIn('key_dates'),
      background_text: description,
    }
  }

  // "Search" — searches EXISTING groups by criteria (regular groups: ranked
  // tag-overlap score, thresholded by Match Precision; Timeline groups: exact
  // match, precision ignored) — this is deliberately NOT candidate-user
  // matching (that lives inside a group's own page as "Find candidates" now).
  const runSearch = useCallback(async () => {
    setSearchLoading(true); setError('')
    try {
      const res = await fetch('/api/groups/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          criteria: criteriaFromPanel(),
          group_type: groupType === 'timeline' ? 'timeline' : '',
          precision,
          max_age_days: CUTOFF_STEPS[cutoffIdx].days,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Search failed')
      setResults(data.groups || [])
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setSearchLoading(false); setSearched(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tags, description, groupType, precision, cutoffIdx, scopeValues])

  // The generated name/description, refreshed whenever the criteria that feed
  // them change. Keyed on the tags and scope values only — the "situation"
  // textarea is part of the criteria but has no bearing on the name, and
  // keying on it would fire a request per keystroke.
  const previewKey = JSON.stringify([
    groupType,
    tags.map((t) => `${t.field}:${t.code}`).sort(),
    Object.entries(scopeValues).filter(([, v]) => v).sort(),
  ])
  useEffect(() => {
    if (groupType !== 'timeline') { setPreview({ name: '', description: '' }); return }
    let cancelled = false
    fetch('/api/groups/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ criteria: criteriaFromPanel(), group_type: 'timeline' }),
    })
      .then((r) => (r.ok ? r.json() : { name: '', description: '' }))
      .then((p) => { if (!cancelled) setPreview({ name: p.name || '', description: p.description || '' }) })
      // A failed preview is cosmetic — never surface it as a page error.
      .catch(() => { if (!cancelled) setPreview({ name: '', description: '' }) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey])

  // Fill the blurb in for them, until they make it their own.
  useEffect(() => {
    if (!descriptionEdited) setGroupDescription(preview.description)
  }, [preview.description, descriptionEdited])

  async function joinResult(groupId: string) {
    setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/join`, {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not join')
      if (data.group_id) router.push(`/groups/${encodeURIComponent(data.group_id)}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not join') }
  }

  // "Create a group" — for when nothing found matches. The acting user is
  // automatically added and becomes the group's admin (find_or_create_group()
  // already does this — matching.py's created_by/is_admin, unchanged).
  async function createGroup() {
    setError(''); setCreating(true)
    try {
      const res = await fetch('/api/groups', {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          criteria_text: description, criteria: criteriaFromPanel(), members: [],
          group_type: groupType === 'timeline' ? 'timeline' : '',
          description: groupType === 'timeline' ? groupDescription : '',
          validity,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not create group')
      if (data.group_id) router.push(`/groups/${encodeURIComponent(data.group_id)}`)
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create group') }
    finally { setCreating(false) }
  }

  // --- browse ---
  const loadAllGroups = useCallback(async () => {
    setBrowseLoading(true); setError('')
    try {
      const res = await fetch('/api/groups/all', { headers: userHeaders() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not load groups')
      setAllGroups(data.groups || [])
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load groups') }
    finally { setBrowseLoading(false) }
    // Invitations load alongside the browse list — failing to fetch them must
    // never blank the group list, so this is deliberately not in the try above.
    try {
      const r = await fetch('/api/groups/invitations', { headers: userHeaders() })
      const d = await r.json()
      if (r.ok) setInvitations(d.invitations || [])
    } catch { /* non-fatal */ }
  }, [])

  async function acceptInvitation(inv: Invitation, group: BrowseGroup) {
    // A group that will demand the attribute form can't be accepted in place —
    // send them to the group page, where the form lives.
    if (inv.requires_attributes) { router.push(`/groups/${encodeURIComponent(inv.group_id)}`); return }
    setRespondingTo(inv.group_id); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(inv.group_id)}/invitations/accept`, {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ values: {}, notes: '' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not accept')
      setInvitations((prev) => prev.filter((p) => p.invitation.group_id !== inv.group_id))
      loadAllGroups()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not accept')
      // The most likely failure is a required attribute — the group page has the form.
      router.push(`/groups/${encodeURIComponent(group.group_id)}`)
    } finally { setRespondingTo('') }
  }

  async function declineInvitation(groupId: string) {
    setRespondingTo(groupId); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/invitations/decline`, {
        method: 'POST', headers: userHeaders(),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not decline')
      setInvitations((prev) => prev.filter((p) => p.invitation.group_id !== groupId))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not decline')
    } finally { setRespondingTo('') }
  }

  // `activeId` is a DEV-ONLY signal (only ever set by the demo-user picker,
  // gated off in production — see DEMO_PICKER_ENABLED). Gating on it alone
  // meant a real signed-in production user (identified via `authUser`, never
  // `activeId`) landed on the Groups tab and this effect never fired at
  // all — the list was never fetched, not empty, so a just-created group
  // looked like it had vanished. Fire once EITHER a real session or a demo
  // user is resolved.
  useEffect(() => {
    if (tab === 'browse' && (authUser || activeId)) loadAllGroups()
  }, [tab, activeId, authUser, loadAllGroups])

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
        <h1 className="text-headline-md text-on-surface">Find groups in the same boat</h1>
        {authUser ? (
          /* Firebase-authenticated — the demo picker is inert (the uid wins), so show
             identity instead. Never the real Firebase displayName/email — `handle` is
             the anonymized handle (same pattern as TopAppBar.tsx). */
          <span className="flex items-center gap-2 text-label-md text-on-surface-variant">
            <span className="material-symbols-outlined text-[20px]">account_circle</span>
            Signed in as {handle || 'Anonymous'}
          </span>
        ) : DEMO_PICKER_ENABLED ? (
          <label className="flex items-center gap-2 text-label-md text-on-surface-variant">
            <span className="material-symbols-outlined text-[20px]">switch_account</span>
            Demo user:
            <select value={activeId} onChange={(e) => switchUser(e.target.value)}
              className="bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 text-body-md focus:outline-none focus:border-primary">
              {users.map((u) => <option key={u.id} value={u.id}>{u.label || u.username}</option>)}
            </select>
          </label>
        ) : null}
      </div>

      {/* tabs — the groups list is the landing view */}
      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setTab('browse')} className={`pill ${tab === 'browse' ? 'pill-active' : ''}`}>Groups</button>
        <button onClick={() => setTab('find')} className={`pill ${tab === 'find' ? 'pill-active' : ''}`}>Find / create group</button>
      </div>

      {error && <div className="card text-error mb-4">{error}</div>}

      {tab === 'find' ? (
        <div className="space-y-4">
          {/* Search and create are two modes over the SAME criteria, not two
              routes — so "searched, found nothing, create it" carries
              everything you just typed straight into the new group. */}
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="text-label-md font-semibold text-on-surface">
              {createMode
                ? `New ${groupType === 'timeline' ? 'Timeline' : 'Regular'} group`
                : 'Find a group'}
            </h1>
            {createMode ? (
              <button onClick={() => setCreateMode(false)}
                className="text-label-md text-on-surface-variant hover:text-primary inline-flex items-center gap-1 whitespace-nowrap">
                <span className="material-symbols-outlined text-[18px]">arrow_back</span>
                Back to search
              </button>
            ) : (
              <button onClick={() => setCreateMode(true)}
                className="text-label-md text-primary hover:underline inline-flex items-center gap-1 whitespace-nowrap">
                <span className="material-symbols-outlined text-[18px]">group_add</span>
                Create a {groupType === 'timeline' ? 'Timeline' : 'Regular'} Group
              </button>
            )}
          </div>

          {/* The name this group will get, generated server-side from the
              criteria — shown before you commit because it is not editable
              afterwards for a Timeline group (the rename lock) and because it
              is what dedup keys on: seeing it is how you tell "a new cohort"
              from "the one that already exists". */}
          {createMode && groupType === 'timeline' && preview.name && (
            <div className="card border-l-4 border-l-primary">
              <p className="text-caption uppercase tracking-wide text-on-surface-variant mb-0.5">
                Group name
              </p>
              <p className="text-title-md text-on-surface break-words" data-testid="preview-name">{preview.name}</p>
              <p className="text-caption text-on-surface-variant mt-1">
                Generated from your criteria. A Timeline group can&apos;t be renamed after it&apos;s created.
              </p>
            </div>
          )}

          {/* Two panels: the criteria that define what you're looking for on
              the left (deliberately narrow — it's a form, not content), the
              results or the create fields on the right. */}
          <div className="grid gap-6 lg:grid-cols-[minmax(0,19rem)_1fr] items-start">
            {/* LEFT — what you're looking for. */}
            <div className="space-y-4">
            <div className="card space-y-3">
              <h2 className="text-label-md font-semibold text-on-surface">Search criteria</h2>

              <div className="pb-2 border-b border-outline-variant">
                <div className="flex items-center gap-2 mb-1.5">
                  <button onClick={() => setGroupType('regular')} className={`pill ${groupType === 'regular' ? 'pill-active' : ''}`}>Regular</button>
                  <button onClick={() => setGroupType('timeline')} className={`pill ${groupType === 'timeline' ? 'pill-active' : ''}`}>Timeline</button>
                </div>
                <p className="text-caption text-on-surface-variant">
                  {groupType === 'timeline'
                    ? 'Timeline groups match EXACTLY — every category you fill in below must match the group exactly.'
                    : 'Regular groups are ranked by how much they overlap with what you fill in below.'}
                </p>
              </div>

              {/* Timeline-only, shown first: which process this group is
                  for. Adds the picked type itself to the right criteria
                  field (visa vs. generic tag) and drives the Cycle/Year
                  fields further down. */}
              {groupType === 'timeline' && (
                <div className="pb-2 border-b border-outline-variant">
                  <label htmlFor="processing-type" className="text-caption uppercase tracking-wide text-on-surface-variant mb-1 block">Processing type</label>
                  <select id="processing-type" aria-label="Processing type" value={processingType}
                    onChange={(e) => selectProcessingType(e.target.value)}
                    className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary">
                    <option value="">Select…</option>
                    {vocab.processing_types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>

                  {/* Which category under that type. For EAD these are the
                      8 CFR 274a.12 classes that actually file an I-765 — see
                      features/ead-eligibility-5/; for H-1B they are the three
                      application types. The heading comes from the config so
                      it can be right for both. Hidden for a type that
                      configures no categories at all. */}
                  {!!selectedType?.eligibility_categories.length && (
                    <div className="mt-2">
                      <label htmlFor="eligibility-category" className="text-caption uppercase tracking-wide text-on-surface-variant mb-1 block">
                        {selectedType.category_label || 'Eligibility category'}
                      </label>
                      <select id="eligibility-category" aria-label={selectedType.category_label || 'Eligibility category'} value={eligibility}
                        onChange={(e) => selectEligibility(e.target.value)}
                        className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary">
                        <option value="">Select…</option>
                        {/* The TAG is what the group is named after, what the
                            criteria carry and what a posting would be tagged
                            with — so it's what the picker shows. The CFR label
                            and code stay as the option's title for anyone who
                            needs to know which class it maps to. */}
                        {selectedType.eligibility_categories.map((c) => (
                          <option key={c.tag} value={c.tag} title={`${c.label} · ${c.code}`}>{c.tag}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              )}

              {tags.length === 0 && revealedFields.size === 0 && (
                <p className="text-caption text-on-surface-variant">Add criteria below, then click Search.</p>
              )}

              {categoryFieldsFor(groupType)
                .filter((c) => isShown(c.field)).map((c) => {
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

              {(() => {
                const hidden = categoryFieldsFor(groupType)
                  .filter((c) => !isShown(c.field))
                return hidden.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {hidden.map((c) => (
                      <button key={c.field} onClick={() => reveal(c.field)} className="pill">+ Add {c.label}</button>
                    ))}
                  </div>
                )
              })()}

              {/* Cycle/Year — the only entry fields left for a selected
                  Processing type (the rest moved to a separate page shown
                  after joining the group). Each row writes straight into
                  key_stages_or_info. */}
              {groupType === 'timeline' && scopeRows.length > 0 && (
                <div className="pt-2 border-t border-outline-variant">
                  {/* The period rows are the filing date the cohort is built
                      around — unlabelled, a bare Month/Year pair reads as
                      "some date, unclear which". */}
                  <p className="text-caption uppercase tracking-wide text-on-surface-variant mb-2">Date Applied</p>
                  <div className="space-y-2">
                    {scopeRows.map((row) => {
                      const set = (v: string) => v
                        ? setScopeValues((prev) => ({ ...prev, [row.key]: v }))
                        : removeScopeValue(row.key)
                      const cls = 'w-40 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary'
                      return (
                        <div key={row.key} className="flex items-center gap-2">
                          <label htmlFor={`stage-${row.key}`} className="text-caption text-on-surface-variant flex-1">{row.label}</label>
                          {row.kind === 'date' ? (
                            <input id={`stage-${row.key}`} type="date" className={cls}
                              value={scopeValues[row.key] || ''} onChange={(e) => set(e.target.value)} />
                          ) : (
                            <select id={`stage-${row.key}`} value={scopeValues[row.key] || ''}
                              onChange={(e) => set(e.target.value)} className={cls}>
                              <option value="">—</option>
                              {(row.kind === 'select' ? row.options : yearOptions).map((o) => (
                                <option key={o} value={o}>{o}</option>
                              ))}
                            </select>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Match Precision only applies to Regular groups — Timeline
                  search is exact-match, which has no threshold to tune. */}
              {groupType === 'regular' && (
                <div className="pt-2 border-t border-outline-variant space-y-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[18px] text-secondary">tune</span>
                    <span className="text-label-md text-on-surface font-medium">Match precision</span>
                  </div>
                  <input type="range" min={0} max={2} step={1}
                    value={['broad', 'balanced', 'strict'].indexOf(precision)}
                    onChange={(e) => setPrecision((['broad', 'balanced', 'strict'] as Precision[])[Number(e.target.value)])}
                    className="w-full accent-primary cursor-pointer" aria-label="Match precision" />
                  <div className="flex justify-between text-caption text-on-surface-variant">
                    <span className={precision === 'broad' ? 'text-primary font-medium' : ''}>Broad</span>
                    <span className={precision === 'balanced' ? 'text-primary font-medium' : ''}>Balanced</span>
                    <span className={precision === 'strict' ? 'text-primary font-medium' : ''}>Strict</span>
                  </div>
                </div>
              )}

              {/* Cutoff period only applies to Regular groups — Timeline
                  groups don't filter on group-creation recency. */}
              {groupType === 'regular' && (
                <div className="pt-2 border-t border-outline-variant">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[18px] text-secondary">schedule</span>
                    <span className="text-label-md text-on-surface font-medium">Cutoff period</span>
                  </div>
                  <input type="range" min={0} max={CUTOFF_STEPS.length - 1} step={1}
                    value={cutoffIdx} onChange={(e) => setCutoffIdx(Number(e.target.value))}
                    className="w-full accent-primary cursor-pointer" aria-label="Cutoff period" />
                  <div className="flex justify-between text-caption text-on-surface-variant">
                    {CUTOFF_STEPS.map((s, i) => (
                      <span key={s.days} className={i === cutoffIdx ? 'text-primary font-medium' : ''}>{s.label}</span>
                    ))}
                  </div>
                </div>
              )}

              {!createMode && (
                <button onClick={runSearch} disabled={searchLoading} className="btn-primary w-full mt-2 disabled:opacity-50">
                  {searchLoading ? 'Searching…' : 'Search'}
                </button>
              )}
            </div>
            </div>

            {/* RIGHT — results while searching, the create fields while creating. */}
            <div className="space-y-4">

            {/* Results */}
            {!createMode && searched && (
              <div className="card">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-label-md font-semibold text-on-surface">
                    {results.length > 0 ? `${results.length} group${results.length === 1 ? '' : 's'} found` : 'No groups found'}
                  </h2>
                </div>
                {results.length === 0 ? (
                  <p className="text-body-md text-on-surface-variant">
                    No existing {groupType === 'timeline' ? 'Timeline' : ''} group matched — create one below.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {results.map((g) => (
                      <div key={g.group_id} className="bg-surface-container-low rounded-lg p-3 flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-label-md font-semibold text-on-surface">{g.name}</p>
                          {g.criteria_text && <p className="text-caption text-on-surface-variant mt-0.5">{g.criteria_text}</p>}
                          <p className="text-caption text-on-surface-variant mt-1">
                            {g.members.length} member{g.members.length === 1 ? '' : 's'}
                            {groupType === 'regular' && ` · score ${g.score}`}
                          </p>
                        </div>
                        {g.group_type === 'timeline' ? (
                          <Link href={`/groups/${encodeURIComponent(g.group_id)}`}
                            className="btn-secondary text-label-md whitespace-nowrap shrink-0">View</Link>
                        ) : (
                          <button onClick={() => joinResult(g.group_id)} className="btn-secondary text-label-md whitespace-nowrap shrink-0">Join</button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {createMode && groupType === 'timeline' && (
              <div className="card">
                <div className="flex items-baseline justify-between gap-3 mb-1">
                  <label htmlFor="group-description" className="text-label-md font-semibold text-on-surface">
                    Group description
                  </label>
                  {/* Only offered once they've diverged — a "reset" that does
                      nothing is just noise. */}
                  {descriptionEdited && preview.description && (
                    <button type="button"
                      onClick={() => { setDescriptionEdited(false); setGroupDescription(preview.description) }}
                      className="text-caption text-primary hover:underline whitespace-nowrap">
                      Reset to generated
                    </button>
                  )}
                </div>
                <p className="text-caption text-on-surface-variant mb-2">
                  Written for you from the criteria — edit it if you want. Shown to anyone browsing before they join.
                </p>
                <textarea id="group-description" value={groupDescription}
                  onChange={(e) => { setDescriptionEdited(true); setGroupDescription(e.target.value) }}
                  placeholder="What's this group for?"
                  rows={3}
                  className="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 text-body-md focus:outline-none focus:border-primary resize-none" />
              </div>
            )}

            {createMode && (
              <div className="card">
{/* Group validity — how long the group stays active before it's
                    auto-archived. Applies to both group types; Timeline offers
                    fewer, shorter options (see validityOptionsFor()). */}
                <div className="pt-2 border-t border-outline-variant">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-[18px] text-secondary">event_available</span>
                    <span className="text-label-md text-on-surface font-medium">Group validity</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {validityOptionsFor(groupType).map((o) => (
                      <button key={o.value} onClick={() => setValidity(o.value)}
                        className={`pill ${validity === o.value ? 'pill-active' : ''}`}>{o.label}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {createMode && (
              <button onClick={createGroup} disabled={creating}
                className="btn-primary w-full disabled:opacity-50">
                {creating ? 'Creating…' : `Create a ${groupType === 'timeline' ? 'Timeline ' : ''}group`}
              </button>
            )}
            </div>
          </div>
        </div>
      ) : (
        /* GROUPS (landing) — two panels: groups you've joined, and every group */
        <div>
          <div className="flex items-center justify-between flex-wrap gap-3 mb-4">
            <p className="text-body-md text-on-surface-variant">
              Browse groups you&apos;ve joined, or every group that exists — or create your own.
            </p>
            <button onClick={() => setTab('find')} className="btn-primary whitespace-nowrap inline-flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[20px]">group_add</span> Create Group
            </button>
          </div>

          {/* Pending invitations — the only place someone learns they've been
              invited. Pinned above the panels so it can't be missed. */}
          {invitations.length > 0 && (
            <div className="space-y-3 mb-6" data-testid="pending-invitations">
              <h2 className="text-label-md font-semibold text-on-surface">
                Pending invitations ({invitations.length})
              </h2>
              {invitations.map(({ invitation, group }) => (
                <div key={invitation.invitation_id} className="card flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-label-md font-semibold text-on-surface">{group.name}</p>
                    <p className="text-caption text-on-surface-variant mt-0.5">
                      Invited by {invitation.invited_by_username || 'a member'}
                      {group.members.length > 0 && ` · ${group.members.length} member${group.members.length === 1 ? '' : 's'}`}
                    </p>
                    {invitation.requires_attributes && (
                      <p className="text-caption text-on-surface-variant mt-0.5">
                        Joining asks for a few dates first.
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button onClick={() => acceptInvitation(invitation, group)}
                      disabled={respondingTo === invitation.group_id}
                      className="btn-primary text-label-md disabled:opacity-50">
                      Accept
                    </button>
                    <button onClick={() => declineInvitation(invitation.group_id)}
                      disabled={respondingTo === invitation.group_id}
                      className="text-label-md text-on-surface-variant hover:underline disabled:opacity-50">
                      Decline
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2 items-start">
            {/* LEFT — groups I've joined */}
            <div className="space-y-3">
              <h2 className="text-label-md font-semibold text-on-surface">Your groups</h2>
              {browseLoading ? (
                <div className="card text-on-surface-variant">Loading groups…</div>
              ) : myGroups.length === 0 ? (
                <div className="card text-on-surface-variant">You haven&apos;t joined any group yet — see all groups on the right, or create your own.</div>
              ) : (
                myGroups.map((g) => <GroupRow key={g.group_id} g={g} />)
              )}
            </div>

            {/* RIGHT — the groups still open to you. Deliberately excludes
                anything already on the left: a joined group listed twice on
                one screen reads as two different groups. */}
            <div className="space-y-3">
              <h2 className="text-label-md font-semibold text-on-surface">All groups</h2>
              {browseLoading ? (
                <div className="card text-on-surface-variant">Loading groups…</div>
              ) : otherGroups.length === 0 ? (
                <div className="card text-on-surface-variant">
                  {allGroups.length === 0
                    ? 'No groups yet — be the first to create one.'
                    : 'You’ve joined every group there is — create one to start another cohort.'}
                </div>
              ) : (
                otherGroups.map((g) => <GroupRow key={g.group_id} g={g} />)
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * This page reads the query string — FindPageInner (or a hook it calls, e.g.
 * useRequireUser's ?next= round-trip) uses useSearchParams(). Next 14 refuses
 * to prerender such a page unless it sits under a Suspense boundary, and
 * fails the PRODUCTION build with "useSearchParams() should be wrapped in a
 * suspense boundary" — an error `next dev`, tsc and vitest never surface.
 */
export default function FindPage() {
  return (
    <Suspense fallback={null}>
      <FindPageInner />
    </Suspense>
  )
}
