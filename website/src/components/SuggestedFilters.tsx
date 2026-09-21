'use client'

export type FacetValue = { code: string; label: string; count: number }
export type SuggestedFilterGroup = {
  key: string
  label: string
  field: string
  values: FacetValue[]
}

// Helper: a selection id used in the `field:code` selected set + backend `facet` param.
export const facetId = (field: string, code: string) => `${field}:${code}`

export default function SuggestedFilters({
  groups,
  selected,
  onToggle,
  title = 'Refine by',
}: {
  groups?: SuggestedFilterGroup[]
  selected: Set<string>
  onToggle: (field: string, code: string, label?: string) => void
  title?: string
}) {
  if (!groups || groups.length === 0) return null
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="material-symbols-outlined text-[18px] text-secondary">filter_alt</span>
        <span className="text-label-md text-on-surface font-medium">{title}</span>
      </div>
      {groups.map((g) => (
        <div key={g.key}>
          <p className="text-caption text-on-surface-variant mb-1">{g.label}</p>
          <div className="flex flex-wrap gap-2">
            {g.values.map((v) => {
              const id = facetId(g.field, v.code)
              const on = selected.has(id)
              return (
                <button
                  key={id}
                  onClick={() => onToggle(g.field, v.code, v.label)}
                  className={on ? 'pill-active' : 'pill'}
                  title={`${v.code}`}
                >
                  {v.label} <span className="opacity-60">({v.count})</span>
                </button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
