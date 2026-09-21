'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { userHeaders } from '@/lib/activeUser'
import { useRequireUser } from '@/lib/useRequireUser'
import type { MemberAttributes } from '@/components/MemberHoverCard'
import { displayValue, type PostJoinRow } from '@/lib/postJoinAttributes'

type Group = {
  group_id: string
  name: string
  group_type?: string
  criteria_tags?: { tags?: string[]; current_visa_or_greencard_category?: string[] }
  members: { user_id: string; username: string }[]
  is_member: boolean
}

/**
 * Every member's submitted attributes for one group, as a real table — the
 * wide view the 16rem sidebar could never give. First nested page under a
 * dynamic segment in this app (the API tree does this; the page tree hadn't),
 * and the first <table>, so the styling is composed from existing tokens
 * rather than a new primitive.
 */
export default function GroupMembersPage() {
  useRequireUser()
  const params = useParams<{ id: string }>()
  const id = params?.id || ''

  const [group, setGroup] = useState<Group | null>(null)
  const [attrs, setAttrs] = useState<MemberAttributes[]>([])
  const [templates, setTemplates] = useState<Record<string, PostJoinRow[]>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(() => {
    if (!id) return
    setLoading(true)
    Promise.all([
      fetch(`/api/groups/${encodeURIComponent(id)}`, { headers: { ...userHeaders() } })
        .then(async (r) => {
          const j = await r.json()
          if (!r.ok) throw new Error(j.detail || 'Could not load group')
          return j as Group
        }),
      fetch(`/api/groups/${encodeURIComponent(id)}/attributes`, { headers: { ...userHeaders() } })
        .then((r) => (r.ok ? r.json() : { attributes: [] })),
      fetch('/api/tag-vocab').then((r) => (r.ok ? r.json() : {}))
        .then((v) => (v as { post_join_attribute_templates?: Record<string, PostJoinRow[]> })),
    ])
      .then(([g, a, v]) => {
        setGroup(g)
        setAttrs(a.attributes || [])
        setTemplates(v.post_join_attribute_templates || {})
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load group'))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { load() }, [load])

  const rows: PostJoinRow[] = useMemo(() => {
    const c = group?.criteria_tags
    if (!group || group.group_type !== 'timeline' || !c) return []
    const candidates = [...(c.tags || []), ...(c.current_visa_or_greencard_category || [])]
    const matched = candidates.find((t) => t in templates) || ''
    return matched ? templates[matched] || [] : []
  }, [group, templates])

  const byUser = useMemo(
    () => Object.fromEntries(attrs.map((a) => [a.user_id, a])),
    [attrs],
  )

  // One filter per column, keyed by row key ('' = Member, '_notes' = Notes).
  // Every column is filterable rather than the three the brief named, because
  // the columns ARE configuration — hardcoding "service center, status, dates"
  // would silently stop covering a column added from Firestore tomorrow.
  const [filters, setFilters] = useState<Record<string, string>>({})
  const setFilter = (key: string, value: string) =>
    setFilters((f) => ({ ...f, [key]: value }))
  const activeCount = Object.values(filters).filter(Boolean).length

  // A select's own options are the domain; everything else matches on
  // substring, so a date column filters by year ("2026") or by month
  // ("2026-03") without needing a range picker.
  const visibleMembers = useMemo(() => {
    const active = Object.entries(filters).filter(([, v]) => v)
    if (!group || !active.length) return group?.members || []
    return group.members.filter((m) => {
      const a = byUser[m.user_id]
      return active.every(([key, want]) => {
        const cell = key === ''
          ? m.username
          : key === '_notes'
            ? a?.notes || ''
            : (() => {
                const row = rows.find((r) => r.key === key)
                return row ? displayValue(row, a?.values?.[key]) : ''
              })()
        return cell.toLowerCase().includes(want.toLowerCase())
      })
    })
  }, [group, byUser, rows, filters])

  const inputClass =
    'w-full bg-surface-container-lowest border border-outline-variant rounded px-1.5 py-1 ' +
    'text-caption text-on-surface focus:outline-none focus:border-primary'

  return (
    <div className="max-w-5xl mx-auto px-4 py-6">
      <Link href={`/groups/${encodeURIComponent(id)}`}
        className="inline-flex items-center gap-1 text-label-md text-on-surface-variant hover:text-primary mb-4 transition-colors">
        <span className="material-symbols-outlined text-[20px]">arrow_back</span>
        Back to group
      </Link>

      {loading && <div className="card text-on-surface-variant">Loading…</div>}
      {error && <div className="card text-error mb-4">{error}</div>}

      {group && !loading && (
        <>
          <h1 className="text-headline-md text-on-surface mb-1">{group.name}</h1>
          <p className="text-body-md text-on-surface-variant mb-4">
            What everyone in this group has shared. {group.members.length} member
            {group.members.length === 1 ? '' : 's'}.
          </p>

          {!group.is_member ? (
            <div className="card text-on-surface-variant">Only members can see this.</div>
          ) : rows.length === 0 ? (
            <div className="card text-on-surface-variant">
              This group doesn&apos;t collect timeline attributes.
            </div>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 mb-2">
                <p className="text-caption text-on-surface-variant">
                  {activeCount === 0
                    ? `${group.members.length} member${group.members.length === 1 ? '' : 's'}`
                    : `${visibleMembers.length} of ${group.members.length} shown · ${activeCount} filter${activeCount === 1 ? '' : 's'}`}
                </p>
                {activeCount > 0 && (
                  <button onClick={() => setFilters({})}
                    className="text-caption text-primary hover:underline whitespace-nowrap">
                    Clear filters
                  </button>
                )}
              </div>

              <div className="card overflow-x-auto">
                {/* Bordered on every cell, not just row rules: this is a wide
                    grid of short values, and without verticals the eye loses
                    which column a date belongs to halfway across. */}
                <table className="w-full text-left border-collapse border border-outline-variant">
                  <thead>
                    <tr className="bg-surface-container-low">
                      <th className="text-caption uppercase tracking-wide text-on-surface-variant text-left align-bottom p-2 w-32 border border-outline-variant">
                        Member
                      </th>
                      {/* The clamp lives on an inner span, not the th:
                          line-clamp sets display:-webkit-box, which on a cell
                          would drop table-cell layout and misalign the column.
                          title= keeps the full label reachable when it clips. */}
                      {rows.map((r) => (
                        <th key={r.key} title={r.label}
                          className="text-caption uppercase tracking-wide text-on-surface-variant text-left align-bottom p-2 border border-outline-variant">
                          <span className="max-w-[7.5rem] leading-tight line-clamp-2">{r.label}</span>
                        </th>
                      ))}
                      <th className="text-caption uppercase tracking-wide text-on-surface-variant text-left align-bottom p-2 min-w-[8rem] border border-outline-variant">
                        Notes
                      </th>
                    </tr>
                    {/* Filter row. A select column offers its own configured
                        options; a checkbox is Yes/No; everything else is a
                        substring box, which is what makes a date column
                        filterable by year or by year-month without a range
                        picker nobody asked for. */}
                    <tr className="bg-surface-container-lowest">
                      <th className="p-1 border border-outline-variant">
                        <input aria-label="Filter Member" value={filters[''] || ''}
                          onChange={(e) => setFilter('', e.target.value)}
                          placeholder="Filter…" className={inputClass} />
                      </th>
                      {rows.map((r) => (
                        <th key={r.key} className="p-1 border border-outline-variant">
                          {r.kind === 'select' || r.kind === 'checkbox' ? (
                            <select aria-label={`Filter ${r.label}`} value={filters[r.key] || ''}
                              onChange={(e) => setFilter(r.key, e.target.value)} className={inputClass}>
                              <option value="">All</option>
                              {(r.kind === 'checkbox' ? ['Yes'] : r.options || []).map((o) => (
                                <option key={o} value={o}>{o}</option>
                              ))}
                            </select>
                          ) : (
                            <input aria-label={`Filter ${r.label}`} value={filters[r.key] || ''}
                              onChange={(e) => setFilter(r.key, e.target.value)}
                              placeholder="Filter…" className={inputClass} />
                          )}
                        </th>
                      ))}
                      <th className="p-1 border border-outline-variant">
                        <input aria-label="Filter Notes" value={filters['_notes'] || ''}
                          onChange={(e) => setFilter('_notes', e.target.value)}
                          placeholder="Filter…" className={inputClass} />
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleMembers.map((m) => {
                      const a = byUser[m.user_id]
                      return (
                        <tr key={m.user_id}>
                          <td className="text-body-md text-on-surface p-2 whitespace-nowrap border border-outline-variant">{m.username}</td>
                          {rows.map((r) => (
                            <td key={r.key} className="text-body-md text-on-surface-variant p-2 whitespace-nowrap border border-outline-variant">
                              {r.kind === 'checkbox'
                                ? (a?.values?.[r.key]
                                    ? <span className="material-symbols-outlined text-[18px] text-primary" title="Yes">check</span>
                                    : <span className="text-on-surface-variant/40">—</span>)
                                : (displayValue(r, a?.values?.[r.key]) || <span className="text-on-surface-variant/40">—</span>)}
                            </td>
                          ))}
                          <td className="text-caption text-on-surface-variant p-2 border border-outline-variant">
                            {a?.notes || <span className="text-on-surface-variant/40">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                    {visibleMembers.length === 0 && (
                      <tr>
                        <td colSpan={rows.length + 2}
                          className="text-body-md text-on-surface-variant p-4 text-center border border-outline-variant">
                          No members match these filters.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
