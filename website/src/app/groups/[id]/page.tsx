'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import GroupChat from '@/components/GroupChat'
import MatchCard, { MatchData } from '@/components/MatchCard'
import Modal from '@/components/Modal'
import MemberHoverCard from '@/components/MemberHoverCard'
import AuthorSection from '@/components/AuthorSection'
import { DEMO_PICKER_ENABLED, getActiveUser, userHeaders } from '@/lib/activeUser'
import { CHECKBOX_ON, requiredKeys, type PostJoinRow } from '@/lib/postJoinAttributes'
import { loginHref, useRequireUser } from '@/lib/useRequireUser'
import { useAuth } from '@/contexts/AuthContext'

type Criteria = {
  current_visa_or_greencard_category?: string[]
  visa_applying_for?: string[]
  primary_consulate?: string
  consulates?: string[]
  tags?: string[]
  key_stages_or_info?: Record<string, string>
  key_dates?: Record<string, string>
  background_text?: string
}

type Group = {
  group_id: string
  name: string
  description: string
  group_type?: string
  criteria_text?: string
  criteria_tags?: Criteria
  members: { user_id: string; username: string }[]
  created_by: string
  created_by_username?: string
  is_admin: boolean
  is_member: boolean
  status?: string
  expiration_date?: string
  created_at: string
  last_activity_at: string
  needs_attributes?: boolean
}

// How many members the sidebar shows before collapsing the rest.
const MEMBER_PREVIEW_COUNT = 5
type Vocab = { post_join_attribute_templates: Record<string, PostJoinRow[]> }
const EMPTY_VOCAB: Vocab = { post_join_attribute_templates: {} }

type MemberAttributes = {
  user_id: string
  username: string
  processing_type: string
  values: Record<string, string>
  notes: string
  submitted_at: string
  updated_at: string
}

// Shared attribute-entry form: the template's required field(s) + optional
// rows + a free-text notes field. Used both for the non-member join preview
// and the member-view mandatory gate — same shape, different submit action.
function AttributeForm({
  rows, values, onChange, notes, onNotesChange, required,
}: {
  rows: PostJoinRow[]
  values: Record<string, string>
  onChange: (key: string, value: string) => void
  notes: string
  onNotesChange: (v: string) => void
  required: string[]
}) {
  // One control per row, chosen by the row's `kind` — the template is the
  // single source of truth for both the control and the server-side rules.
  const control = (row: PostJoinRow) => {
    const id = `attr-${row.key}`
    const box = 'w-40 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary'
    if (row.kind === 'checkbox') {
      return (
        <input id={id} type="checkbox" checked={Boolean(values[row.key])}
          onChange={(e) => onChange(row.key, e.target.checked ? CHECKBOX_ON : '')}
          className="w-5 h-5 accent-primary cursor-pointer" />
      )
    }
    if (row.kind === 'select') {
      return (
        <select id={id} value={values[row.key] || ''}
          onChange={(e) => onChange(row.key, e.target.value)} className={box}>
          <option value="">—</option>
          {(row.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    return (
      <input id={id} type="date" value={values[row.key] || ''}
        onChange={(e) => onChange(row.key, e.target.value)} className={box} />
    )
  }

  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <label htmlFor={`attr-${row.key}`} className="text-caption text-on-surface-variant flex-1">
            {row.label}{required.includes(row.key) && <span className="text-error"> *</span>}
          </label>
          {row.kind === 'checkbox' ? <div className="w-40">{control(row)}</div> : control(row)}
        </div>
      ))}
      <div>
        <label className="text-caption text-on-surface-variant">Notes</label>
        <textarea value={notes} onChange={(e) => onNotesChange(e.target.value)} maxLength={1000}
          placeholder="Anything else worth sharing with the cohort?"
          className="w-full mt-1 text-body-md bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 focus:outline-none focus:border-primary" rows={2} />
      </div>
    </div>
  )
}

// Relative "X ago" for data-freshness (mirrors GroupChat/ReplyItem).
function timeAgo(iso: string): string {
  const t = Date.parse(iso)
  if (isNaN(t)) return ''
  const sec = Math.floor((Date.now() - t) / 1000)
  if (sec < 60) return 'just now'
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(t).toLocaleDateString()
}

function TypeBadge({ groupType }: { groupType: string }) {
  return groupType === 'timeline'
    ? <span className="text-caption text-secondary bg-secondary-container/50 px-2 py-0.5 rounded-full">Timeline</span>
    : <span className="text-caption text-on-surface-variant bg-surface-container-high px-2 py-0.5 rounded-full">Regular</span>
}

function StatusBadge({ status }: { status?: string }) {
  if (!status || status === 'active') return null
  const label = status === 'archived' ? 'Archived' : status === 'deleted' ? 'Deleted' : status
  return <span className="text-caption text-error bg-error-container/50 px-2 py-0.5 rounded-full">{label}</span>
}

function TagRow({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return <p className="text-caption text-on-surface-variant"><span className="text-on-surface-variant/70">{label}:</span> {value}</p>
}

// Every non-empty criteria_tags field, labeled — the "all the tags used to
// create this group" breakdown for the metadata panel.
function CriteriaBreakdown({ c }: { c?: Criteria }) {
  if (!c) return null
  // Both criteria maps, not just key_stages_or_info — a scope row lands in
  // whichever its `field` names, and a date-kind one (I-485's priority date)
  // goes to key_dates. Leaving those out hid part of what the group IS.
  const scoped = [...Object.entries(c.key_stages_or_info || {}), ...Object.entries(c.key_dates || {})]
  return (
    <>
      <TagRow label="Current status" value={(c.current_visa_or_greencard_category || []).join(', ')} />
      <TagRow label="Applying for" value={(c.visa_applying_for || []).join(', ')} />
      <TagRow label="Consulate(s)" value={(c.consulates || []).join(', ') || c.primary_consulate || ''} />
      <TagRow label="Tags" value={(c.tags || []).join(', ')} />
      {scoped.map(([k, v]) => <TagRow key={k} label={k.replace(/_/g, ' ')} value={v} />)}
    </>
  )
}

export default function GroupPage() {
  useRequireUser()
  const router = useRouter()
  const { user: authUser, loading: authLoading } = useAuth()
  // A shared group link is the one URL a stranger reliably arrives at with no
  // identity. Without this the page fetched anyway, the API answered 400, and
  // we rendered its raw body — "X-User-Id header is required (pick a user)."
  // — which tells the recipient nothing and leaks an internal header name.
  const [needsIdentity, setNeedsIdentity] = useState(false)
  const params = useParams<{ id: string }>()
  const id = params?.id
  const [group, setGroup] = useState<Group | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // rename (admin only)
  const [editing, setEditing] = useState(false)
  const [nameDraft, setNameDraft] = useState('')
  const [descDraft, setDescDraft] = useState('')
  const [saving, setSaving] = useState(false)

  // invite (any member)
  const [inviteHandle, setInviteHandle] = useState('')
  const [inviting, setInviting] = useState(false)
  const [inviteMsg, setInviteMsg] = useState('')

  // delete (admin only)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // archive/unarchive (admin only)
  const [archiving, setArchiving] = useState(false)

  // join preview (non-members, e.g. arriving via a shared link)
  const [joining, setJoining] = useState(false)
  const [joinValues, setJoinValues] = useState<Record<string, string>>({})
  const [joinNotes, setJoinNotes] = useState('')

  // leave (any member)
  const [confirmingLeave, setConfirmingLeave] = useState(false)
  const [leaving, setLeaving] = useState(false)

  // A long roster pushes everything below it (Invited, Invite someone, Find
  // candidates, the group actions) off the screen, so the sidebar shows the
  // first few and hides the rest behind a link.
  const [showAllMembers, setShowAllMembers] = useState(false)

  // Mandatory post-join attribute gate (features/timeline-notifications-3/
  // timeline-posting-stem-opt.md) — driven by the server-computed
  // `needs_attributes` flag (Timeline group + a registered processing-type
  // template + the viewer is a member + no submission yet), not a one-shot
  // client event, so it correctly blocks a member added via invite too.
  // Saves to BOTH the member's own profile (key_dates) and the group's
  // shared member_attributes store.
  const [vocab, setVocab] = useState<Vocab>(EMPTY_VOCAB)
  const [gateValues, setGateValues] = useState<Record<string, string>>({})
  const [gateNotes, setGateNotes] = useState('')
  const [savingGate, setSavingGate] = useState(false)

  // Cohort attributes — every member's submitted post-join attributes.
  // Read by the per-member hover card and the members table page; the old
  // sidebar block that listed them was removed (it just re-listed Members).
  const [cohortAttrs, setCohortAttrs] = useState<MemberAttributes[]>([])

  // Member profile popup (click a member) + editing your own attributes.
  const [profileUid, setProfileUid] = useState('')
  const [editingAttrs, setEditingAttrs] = useState(false)

  // pending invitations this group has outstanding (members-only)
  const [pendingInvites, setPendingInvites] = useState<{ user_id: string; username: string }[]>([])

  // share link
  const [linkCopied, setLinkCopied] = useState(false)

  // find candidates (member-only) — the relocated counterpart of the old
  // top-level chat-based candidate matching, now scoped to this group
  const [candidates, setCandidates] = useState<MatchData[]>([])
  const [candidatesSearched, setCandidatesSearched] = useState(false)
  const [findingCandidates, setFindingCandidates] = useState(false)
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set())
  const [addingCandidates, setAddingCandidates] = useState(false)

  const load = useCallback(() => {
    if (!id) return
    // Firebase restores a session asynchronously — fetching before it settles
    // would look identity-less to a user who IS signed in.
    if (authLoading) return
    if (!getActiveUser()) {
      setNeedsIdentity(true)
      setLoading(false)
      return
    }
    setNeedsIdentity(false)
    setLoading(true)
    fetch(`/api/groups/${encodeURIComponent(id)}`, { headers: { ...userHeaders() } })
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.detail || 'Could not load group')
        return j
      })
      .then((g: Group) => { setGroup(g); setNameDraft(g.name); setDescDraft(g.description || '') })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load group'))
      .finally(() => setLoading(false))
  }, [id, authLoading, authUser])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    fetch('/api/tag-vocab').then((r) => r.json())
      .then((d) => setVocab({ post_join_attribute_templates: d.post_join_attribute_templates || {} }))
      .catch(() => {})
  }, [])

  // The Processing type registered in this group's own criteria (its tags
  // OR current status — mirrors selectProcessingType()'s visa-vs-tag
  // routing on the find/create panel) that has a post-join attribute
  // template, if any.
  const matchedType = useMemo(() => {
    if (!group || group.group_type !== 'timeline') return ''
    const c = group.criteria_tags
    if (!c) return ''
    const candidates = [...(c.tags || []), ...(c.current_visa_or_greencard_category || [])]
    return candidates.find((t) => t in vocab.post_join_attribute_templates) || ''
  }, [group, vocab])
  const templateRows = matchedType ? vocab.post_join_attribute_templates[matchedType] || [] : []
  const required = requiredKeys(templateRows)

  useEffect(() => {
    if (!group || !group.is_member || !id) { setCohortAttrs([]); setPendingInvites([]); return }
    fetch(`/api/groups/${encodeURIComponent(id)}/attributes`, { headers: { ...userHeaders() } })
      .then((r) => r.json())
      .then((d) => setCohortAttrs(d.attributes || []))
      .catch(() => {})
    fetch(`/api/groups/${encodeURIComponent(id)}/invitations`, { headers: { ...userHeaders() } })
      .then((r) => r.json())
      .then((d) => setPendingInvites(d.invitations || []))
      .catch(() => {})
  }, [group, id])

  // The viewer's own submitted attributes — drives the Edit affordance.
  // Resolved client-side only (getActiveUser touches localStorage/Firebase),
  // so it's computed in an effect rather than during render.
  const [myUserId, setMyUserId] = useState('')
  useEffect(() => { setMyUserId(getActiveUser()) }, [group])
  const myAttrs = useMemo(
    () => cohortAttrs.find((a) => a.user_id === myUserId),
    [cohortAttrs, myUserId],
  )

  const allMembers = useMemo(() => group?.members || [], [group])
  const visibleMembers = showAllMembers ? allMembers : allMembers.slice(0, MEMBER_PREVIEW_COUNT)
  const hiddenMemberCount = allMembers.length - visibleMembers.length

  async function saveRename() {
    if (!group) return
    setSaving(true); setError('')
    const isTimeline = group.group_type === 'timeline'
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}`, {
        method: 'PUT', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(isTimeline ? { description: descDraft } : { name: nameDraft, description: descDraft }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not rename group')
      setGroup(data)
      setEditing(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not rename group')
    } finally {
      setSaving(false)
    }
  }

  async function inviteMember() {
    if (!group || !inviteHandle.trim()) return
    setInviting(true); setInviteMsg(''); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}/invite`, {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ handle: inviteHandle.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not invite that handle')
      // This returns an InvitationCard now, NOT a group card — the group is
      // unchanged until they accept, so don't setGroup() with it.
      setPendingInvites((prev) => prev.some((p) => p.user_id === data.user_id)
        ? prev
        : [...prev, { user_id: data.user_id, username: data.username }])
      setInviteHandle('')
      setInviteMsg('Invitation sent — they’ll join once they accept.')
    } catch (e) {
      setInviteMsg(e instanceof Error ? e.message : 'Could not invite that handle')
    } finally {
      setInviting(false)
    }
  }

  async function deleteGroup() {
    if (!group) return
    setDeleting(true); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}`, {
        method: 'DELETE', headers: userHeaders(),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not delete group')
      router.push('/find')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete group')
      setDeleting(false)
      setConfirmingDelete(false)
    }
  }

  async function toggleArchive(archived: boolean) {
    if (!group) return
    setArchiving(true); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}/archive`, {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ archived }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not update group status')
      setGroup(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not update group status')
    } finally {
      setArchiving(false)
    }
  }

  async function joinThisGroup() {
    if (!group) return
    setJoining(true); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}/join`, {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ values: joinValues, notes: joinNotes }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not join')
      setGroup(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join')
    } finally {
      setJoining(false)
    }
  }

  async function leaveGroup() {
    if (!group) return
    setLeaving(true); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}/leave`, {
        method: 'POST', headers: userHeaders(),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not leave group')
      router.push('/find')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not leave group')
      setLeaving(false)
      setConfirmingLeave(false)
    }
  }

  async function submitGateAttrs() {
    if (!group) return
    setSavingGate(true); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}/attributes`, {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ values: gateValues, notes: gateNotes }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not save your attributes')
      setGroup(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save your attributes')
    } finally {
      setSavingGate(false)
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href)
      setLinkCopied(true)
      setTimeout(() => setLinkCopied(false), 2000)
    } catch { /* clipboard unavailable — silently no-op */ }
  }

  // "Find candidates" — ranks other users against THIS group's own stored
  // criteria (matching.py's find_matches(), relocated from the old top-level
  // chat flow to a group-scoped action for growing membership after creation).
  async function findCandidates() {
    if (!group) return
    setFindingCandidates(true); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}/find-candidates`, {
        method: 'POST', headers: userHeaders(),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not find candidates')
      setCandidates(data.matches || [])
      setSelectedCandidates(new Set())
      setCandidatesSearched(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not find candidates')
    } finally {
      setFindingCandidates(false)
    }
  }

  function toggleCandidate(userId: string) {
    setSelectedCandidates((prev) => { const n = new Set(prev); n.has(userId) ? n.delete(userId) : n.add(userId); return n })
  }

  async function addSelectedCandidates() {
    if (!group || selectedCandidates.size === 0) return
    setAddingCandidates(true); setError('')
    try {
      const res = await fetch(`/api/groups/${encodeURIComponent(group.group_id)}/add-members`, {
        method: 'POST', headers: userHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ user_ids: Array.from(selectedCandidates) }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not invite candidates')
      // Returns {group, invited, skipped} now — the candidates are invited,
      // not added, so the group card only changes via `group`.
      if (data.group) setGroup(data.group)
      setPendingInvites((prev) => [
        ...prev,
        ...(data.invited || [])
          .filter((i: { user_id: string }) => !prev.some((p) => p.user_id === i.user_id))
          .map((i: { user_id: string; username: string }) => ({ user_id: i.user_id, username: i.username })),
      ])
      setCandidates((prev) => prev.filter((c) => !selectedCandidates.has(c.user_id)))
      setSelectedCandidates(new Set())
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not invite candidates')
    } finally {
      setAddingCandidates(false)
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <Link href="/find" className="inline-flex items-center gap-1 text-label-md text-on-surface-variant hover:text-primary mb-4 transition-colors">
        <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        Back to groups
      </Link>

      {/* Arrived via a shared link with no identity. Prod sends them to
          /login?next=… (useRequireUser) and they land back here; dev has no
          Firebase, so point at the demo-user picker instead. Either way the
          group id is preserved, so the detour is invisible. */}
      {needsIdentity ? (
        <div className="card max-w-xl">
          <h1 className="text-headline-md text-on-surface mb-1">Sign in to view this group</h1>
          <p className="text-body-md text-on-surface-variant mb-4">
            Someone shared a private group with you. Groups are only visible to
            people with an account — you&apos;ll come straight back here.
          </p>
          {DEMO_PICKER_ENABLED ? (
            <Link href="/find" className="btn-primary text-label-md inline-flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[18px]">switch_account</span>
              Pick a demo user
            </Link>
          ) : (
            <Link href={loginHref(`/groups/${String(id || '')}`)}
              className="btn-primary text-label-md inline-flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[18px]">login</span>
              Sign in
            </Link>
          )}
        </div>
      ) : (
      <>
      {loading && <div className="card text-on-surface-variant">Loading group…</div>}
      {error && <div className="card text-error mb-4">{error}</div>}

      {group && (
        <>
          <div className="mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="material-symbols-outlined text-secondary">diversity_3</span>
              {editing && group.group_type !== 'timeline' ? (
                <input value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} maxLength={100}
                  className="text-headline-md text-on-surface bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1 focus:outline-none focus:border-primary" />
              ) : (
                <h1 className="text-headline-md text-on-surface">{group.name}</h1>
              )}
              {group.is_admin && !editing && (
                <button onClick={() => setEditing(true)} className="text-label-md text-primary hover:underline">
                  {group.group_type === 'timeline' ? 'Edit description' : 'Rename'}
                </button>
              )}
              <TypeBadge groupType={group.group_type || ''} />
              <StatusBadge status={group.status} />
              {/* Page-level actions, top right. "View All Data" used to sit
                  inside the Members box in the sidebar, where it read as a
                  property of that list rather than of the whole group. */}
              <div className="ml-auto flex items-center gap-3">
                {group.is_member && !group.needs_attributes && matchedType && (
                  <Link href={`/groups/${encodeURIComponent(group.group_id)}/members`}
                    className="text-label-md text-primary hover:underline inline-flex items-center gap-1 whitespace-nowrap">
                    <span className="material-symbols-outlined text-[18px]">table_rows</span>
                    View All Data
                  </Link>
                )}
                <button onClick={copyLink} className="text-label-md text-on-surface-variant hover:text-primary inline-flex items-center gap-1">
                  <span className="material-symbols-outlined text-[18px]">{linkCopied ? 'check' : 'link'}</span>
                  {linkCopied ? 'Copied!' : 'Copy link'}
                </button>
              </div>
            </div>
            {editing ? (
              <div className="mt-2 space-y-2 max-w-xl">
                <textarea value={descDraft} onChange={(e) => setDescDraft(e.target.value)} maxLength={500}
                  placeholder="What's this group for?"
                  className="w-full text-body-md bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 focus:outline-none focus:border-primary" rows={2} />
                <div className="flex gap-2">
                  <button onClick={saveRename} disabled={saving || !nameDraft.trim()} className="btn-primary text-label-md disabled:opacity-50">
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                  <button onClick={() => { setEditing(false); setNameDraft(group.name); setDescDraft(group.description || '') }}
                    className="btn-tertiary text-label-md">Cancel</button>
                </div>
              </div>
            ) : (
              group.description && <p className="text-body-md text-on-surface-variant mt-1">{group.description}</p>
            )}
            <p className="text-caption text-on-surface-variant mt-1">
              Created {timeAgo(group.created_at) || group.created_at}
              {group.last_activity_at && ` · Last activity ${timeAgo(group.last_activity_at)}`}
            </p>
          </div>

          {!group.is_member ? (
            // Join preview — reached via a shared link or a browse listing
            // without joining first. GET /api/groups/{id} already returns
            // full details to any authenticated user regardless of
            // membership, so this needs no backend change. If this group's
            // criteria match a registered post-join attribute template, the
            // required field must be filled in before Join is enabled — the
            // server enforces the same rule (422 otherwise), this is just
            // the client-side mirror of it.
            <div className="card max-w-xl">
              <p className="text-body-md text-on-surface-variant">
                {allMembers.length} member{allMembers.length === 1 ? '' : 's'}: {allMembers.map((m) => m.username).join(', ')}
              </p>
              {group.status === 'archived' ? (
                <p className="text-caption text-error mt-4">This group is archived and no longer accepting new members.</p>
              ) : (
                <>
                  {matchedType && templateRows.length > 0 && (
                    <div className="mt-4 pt-4 border-t border-outline-variant">
                      <h3 className="text-label-md font-semibold text-on-surface mb-1">Your {matchedType} attributes</h3>
                      {/* A template can be entirely optional (I-485 asks only
                          for a priority date), so don't claim otherwise. */}
                      <p className="text-caption text-on-surface-variant mb-3">
                        {required.length > 0
                          ? 'Required to join — shared with the rest of the cohort.'
                          : 'Optional — shared with the rest of the cohort. You can fill these in later.'}
                      </p>
                      <AttributeForm rows={templateRows} values={joinValues}
                        onChange={(k, v) => setJoinValues((prev) => ({ ...prev, [k]: v }))}
                        notes={joinNotes} onNotesChange={setJoinNotes} required={required} />
                    </div>
                  )}
                  <button onClick={joinThisGroup} disabled={joining || required.some((k) => !joinValues[k]?.trim())}
                    className="btn-primary mt-4 disabled:opacity-50">
                    {joining ? 'Joining…' : 'Join group'}
                  </button>
                </>
              )}
            </div>
          ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_16rem]">
            <div className="space-y-4">
              {group.needs_attributes && matchedType && templateRows.length > 0 && (
                <div className="card max-w-xl">
                  <h3 className="text-label-md font-semibold text-on-surface mb-1">Add your {matchedType} attributes</h3>
                  {/* This card is the only entry point for a member who hasn't
                      submitted yet, so it shows even when nothing is required
                      — but then it's a prompt, not a toll gate, and Save with
                      everything blank is a legitimate answer. */}
                  <p className="text-caption text-on-surface-variant mb-3">
                    {required.length > 0
                      ? 'Required to access this group — shared with the rest of the cohort.'
                      : 'Optional — shared with the rest of the cohort. Save to continue, and add them any time.'}
                  </p>
                  <AttributeForm rows={templateRows} values={gateValues}
                    onChange={(k, v) => setGateValues((prev) => ({ ...prev, [k]: v }))}
                    notes={gateNotes} onNotesChange={setGateNotes} required={required} />
                  <button onClick={submitGateAttrs}
                    disabled={savingGate || required.some((k) => !gateValues[k]?.trim())}
                    className="btn-primary text-label-md mt-3 disabled:opacity-50">
                    {savingGate ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
              {/* Already submitted? You can still correct your answers. Same
                  form, prefilled, POSTing to the same upsert endpoint. */}
              {!group.needs_attributes && matchedType && templateRows.length > 0 && myAttrs && (
                editingAttrs ? (
                  <div className="card max-w-xl">
                    <h3 className="text-label-md font-semibold text-on-surface mb-1">Edit your {matchedType} attributes</h3>
                    <p className="text-caption text-on-surface-variant mb-3">Shared with the rest of the cohort.</p>
                    <AttributeForm rows={templateRows} values={gateValues}
                      onChange={(k, v) => setGateValues((prev) => ({ ...prev, [k]: v }))}
                      notes={gateNotes} onNotesChange={setGateNotes} required={required} />
                    <div className="flex gap-2 mt-3">
                      <button onClick={async () => { await submitGateAttrs(); setEditingAttrs(false) }}
                        disabled={savingGate || required.some((k) => !gateValues[k]?.trim())}
                        className="btn-primary text-label-md disabled:opacity-50">
                        {savingGate ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => setEditingAttrs(false)} className="btn-tertiary text-label-md">Cancel</button>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setGateValues({ ...(myAttrs.values || {}) })
                      setGateNotes(myAttrs.notes || '')
                      setEditingAttrs(true)
                    }}
                    className="text-label-md text-primary hover:underline self-start"
                  >
                    Edit your {matchedType} attributes
                  </button>
                )
              )}
              {!group.needs_attributes && <GroupChat groupId={group.group_id} />}
            </div>
            <aside className="card h-fit space-y-3">
              <div>
                <h3 className="text-label-md font-semibold text-on-surface mb-2">Group details</h3>
                <div className="flex items-center gap-1.5 mb-1.5">
                  <TypeBadge groupType={group.group_type || ''} />
                  <StatusBadge status={group.status} />
                </div>
                {/* No "Created by" — the creator already carries the Admin
                    badge in the Members list right below, so naming them here
                    said the same thing twice. */}
                <p className="text-caption text-on-surface-variant">
                  Created {timeAgo(group.created_at) || group.created_at}
                </p>
                {group.expiration_date && (
                  <p className="text-caption text-on-surface-variant">
                    {group.status === 'archived' ? 'Expired' : 'Expires'} {new Date(group.expiration_date).toLocaleDateString()}
                  </p>
                )}
                {group.description && <p className="text-caption text-on-surface-variant mt-1">{group.description}</p>}
                <div className="mt-1 space-y-0.5">
                  <CriteriaBreakdown c={group.criteria_tags} />
                </div>
              </div>

              {/* Members. Hover shows that member's attributes for this group;
                  clicking opens their profile. The old "Cohort attributes"
                  block that re-listed the same names was removed — its content
                  lives here and on the members table page. */}
              {!group.needs_attributes && (
                <div className="pt-3 border-t border-outline-variant">
                  <h3 className="text-label-md font-semibold text-on-surface mb-2">Members ({group.members.length})</h3>
                  <ul className="space-y-1">
                    {visibleMembers.map((m) => {
                      const attrs = cohortAttrs.find((a) => a.user_id === m.user_id)
                      return (
                        <li key={m.user_id}>
                          <MemberHoverCard attrs={attrs} rows={templateRows}>
                            <button
                              onClick={() => setProfileUid(m.user_id)}
                              className="w-full text-left text-body-md text-on-surface-variant flex items-center gap-2 rounded hover:text-primary"
                            >
                              <span className="material-symbols-outlined text-[18px] text-on-surface-variant">account_circle</span>
                              {m.username}
                              {m.user_id === group.created_by && (
                                <span className="text-caption text-primary bg-primary-container px-1.5 py-0.5 rounded-full">Admin</span>
                              )}
                              {attrs && (
                                <span className="material-symbols-outlined text-[14px] text-on-surface-variant/60"
                                  title="Has submitted attributes">event_available</span>
                              )}
                            </button>
                          </MemberHoverCard>
                        </li>
                      )
                    })}
                  </ul>
                  {hiddenMemberCount > 0 && (
                    <button onClick={() => setShowAllMembers(true)}
                      className="text-caption text-primary hover:underline mt-1.5">
                      Show all members…
                    </button>
                  )}
                </div>
              )}

              {!group.needs_attributes && pendingInvites.length > 0 && (
                <div className="pt-3 border-t border-outline-variant">
                  <h3 className="text-label-md font-semibold text-on-surface mb-2">
                    Invited ({pendingInvites.length})
                  </h3>
                  <ul className="space-y-1">
                    {pendingInvites.map((i) => (
                      <li key={i.user_id} className="text-caption text-on-surface-variant flex items-center gap-1.5">
                        <span className="material-symbols-outlined text-[16px]">hourglass_empty</span>
                        {i.username} <span className="text-on-surface-variant/60">· awaiting reply</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!group.needs_attributes && (
                <div className="pt-3 border-t border-outline-variant">
                  <h3 className="text-label-md font-semibold text-on-surface mb-1">Invite someone</h3>
                  <p className="text-caption text-on-surface-variant mb-2">Know someone else in the same boat? Add them by handle.</p>
                  <div className="flex gap-1.5">
                    <input value={inviteHandle} onChange={(e) => setInviteHandle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); inviteMember() } }}
                      placeholder="their handle…"
                      className="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded-lg px-2 py-1.5 text-body-md focus:outline-none focus:border-primary" />
                    <button onClick={inviteMember} disabled={inviting || !inviteHandle.trim()} className="btn-secondary text-label-md disabled:opacity-50">
                      {inviting ? '…' : 'Invite'}
                    </button>
                  </div>
                  {inviteMsg && <p className="text-caption text-on-surface-variant mt-1">{inviteMsg}</p>}
                </div>
              )}

              {!group.needs_attributes && (
                <div className="pt-3 border-t border-outline-variant">
                  <h3 className="text-label-md font-semibold text-on-surface mb-1">Find candidates</h3>
                  <p className="text-caption text-on-surface-variant mb-2">
                    Rank other users against this group&apos;s own criteria and invite them.
                  </p>
                  <button onClick={findCandidates} disabled={findingCandidates} className="btn-secondary text-label-md w-full disabled:opacity-50">
                    {findingCandidates ? 'Finding…' : 'Find candidates'}
                  </button>
                  {candidatesSearched && (
                    <div className="mt-2 space-y-1.5">
                      {candidates.length === 0 ? (
                        <p className="text-caption text-on-surface-variant">No candidates found for this group&apos;s criteria.</p>
                      ) : (
                        <>
                          {candidates.map((c) => (
                            <MatchCard key={c.user_id} m={c} checked={selectedCandidates.has(c.user_id)} onToggle={toggleCandidate} />
                          ))}
                          <button onClick={addSelectedCandidates} disabled={addingCandidates || selectedCandidates.size === 0}
                            className="btn-primary text-label-md w-full disabled:opacity-50">
                            {addingCandidates ? 'Inviting…' : selectedCandidates.size ? `Invite ${selectedCandidates.size} selected` : 'Invite selected'}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}

              {group.criteria_text && (
                <p className="text-caption text-on-surface-variant pt-3 border-t border-outline-variant">{group.criteria_text}</p>
              )}

              <div className="pt-3 border-t border-outline-variant">
                {confirmingLeave ? (
                  <div className="space-y-2">
                    <p className="text-caption text-error">Leave this group? You can rejoin later if it&apos;s still open.</p>
                    <div className="flex gap-2">
                      <button onClick={leaveGroup} disabled={leaving} className="text-label-md text-error hover:underline disabled:opacity-50">
                        {leaving ? 'Leaving…' : 'Confirm leave'}
                      </button>
                      <button onClick={() => setConfirmingLeave(false)} disabled={leaving} className="text-label-md text-on-surface-variant hover:underline">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setConfirmingLeave(true)} className="text-label-md text-on-surface-variant hover:underline block">
                    Leave group
                  </button>
                )}
              </div>

              {group.is_admin && (
                <div className="pt-3 border-t border-outline-variant space-y-2">
                  <button onClick={() => toggleArchive(group.status !== 'archived')} disabled={archiving}
                    className="text-label-md text-on-surface-variant hover:underline disabled:opacity-50">
                    {archiving ? 'Updating…' : group.status === 'archived' ? 'Unarchive group' : 'Archive group'}
                  </button>
                  {confirmingDelete ? (
                    <div className="space-y-2">
                      <p className="text-caption text-error">Delete this group for everyone? This can&apos;t be undone.</p>
                      <div className="flex gap-2">
                        <button onClick={deleteGroup} disabled={deleting} className="text-label-md text-error hover:underline disabled:opacity-50">
                          {deleting ? 'Deleting…' : 'Confirm delete'}
                        </button>
                        <button onClick={() => setConfirmingDelete(false)} disabled={deleting} className="text-label-md text-on-surface-variant hover:underline">
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmingDelete(true)} className="text-label-md text-error hover:underline block">
                      Delete group
                    </button>
                  )}
                </div>
              )}
            </aside>
          </div>
          )}
        </>
      )}

      {/* Member profile popup — reuses AuthorSection, which already fetches
          the public profile + their postings from its own endpoints. */}
      </>
      )}

      <Modal open={Boolean(profileUid)} onClose={() => setProfileUid('')} title="Member profile">
        {profileUid && <AuthorSection authorId={profileUid} channel="app" compact={false} />}
      </Modal>
    </div>
  )
}
