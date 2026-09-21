'use client'

import { useState } from 'react'

export type PostJoinRow = { label: string; field: string; key: string }
export type MemberAttributes = {
  user_id: string
  username: string
  processing_type: string
  values: Record<string, string>
  notes: string
  submitted_at: string
  updated_at: string
}

/**
 * Hovering a member shows the attributes they submitted for THIS group.
 *
 * Uses the `relative` parent + `absolute z-50` panel idiom established by
 * TopAppBar's user menu — the codebase has no popover/tooltip primitive. The
 * data comes from the group page's already-fetched cohort attributes, so
 * hovering costs no request.
 *
 * Hover is a pointer-only affordance, so the same content has to be reachable
 * another way: the row is also a button that opens the member's full profile,
 * and the whole cohort is on the group's members table page. Mobile, which
 * has no hover at all, surfaces this in a bottom sheet instead.
 */
export default function MemberHoverCard({
  attrs, rows, children,
}: {
  attrs?: MemberAttributes
  rows: PostJoinRow[]
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const filled = attrs ? rows.filter((r) => attrs.values?.[r.key]) : []
  const hasContent = Boolean(attrs && (filled.length || attrs.notes))

  return (
    <div
      className="relative"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && hasContent && (
        <div
          role="tooltip"
          data-testid="member-hover-card"
          className="absolute left-0 top-full z-50 mt-1 w-60 rounded-lg border border-outline-variant bg-surface-container-lowest p-2.5 shadow-lg"
        >
          <p className="text-caption uppercase tracking-wide text-on-surface-variant mb-1">
            {attrs?.processing_type || 'Attributes'}
          </p>
          {filled.map((r) => (
            <p key={r.key} className="text-caption text-on-surface-variant">
              <span className="text-on-surface-variant/70">{r.label}:</span> {attrs!.values[r.key]}
            </p>
          ))}
          {attrs?.notes && (
            <p className="text-caption text-on-surface-variant mt-1 italic">&ldquo;{attrs.notes}&rdquo;</p>
          )}
        </div>
      )}
    </div>
  )
}
