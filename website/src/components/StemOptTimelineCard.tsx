'use client'

import {
  STEM_OPT_TIMELINE_FIELDS,
  STEM_OPT_ANCHOR_KEY,
  stemOptSummary,
  stemOptCaptureCount,
  totalDays,
  type StemOptField,
} from '@/lib/stemOptTimeline'

type KV = Record<string, string>

// The shared STEM OPT timeline capture card (features/stem-opt-timeline-9/).
// Renders the canonical stem-opt-extension fields over the posting's
// key_dates/key_stages_or_info, prefilled from whatever was parsed; blanks stay
// blank (never fabricated), the filing-date anchor is flagged when missing.
export default function StemOptTimelineCard({
  keyDates,
  keyStages,
  onChange,
}: {
  keyDates: KV
  keyStages: KV
  onChange: (nextDates: KV, nextStages: KV) => void
}) {
  const valueOf = (f: StemOptField) => (f.bucket === 'key_dates' ? keyDates[f.key] : keyStages[f.key]) || ''

  const setField = (f: StemOptField, value: string) => {
    const bucket = f.bucket === 'key_dates' ? { ...keyDates } : { ...keyStages }
    if (value) bucket[f.key] = value
    else delete bucket[f.key]
    if (f.bucket === 'key_dates') onChange(bucket, keyStages)
    else onChange(keyDates, bucket)
  }

  const days = totalDays(keyDates)
  const { captured, total } = stemOptCaptureCount(keyDates, keyStages)

  return (
    <div className="card space-y-3" data-testid="stem-opt-timeline-card">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-secondary text-[20px]">timeline</span>
          <span className="text-label-md font-semibold text-on-surface">STEM OPT timeline</span>
        </div>
        <span className="text-caption text-on-surface-variant" data-testid="stem-opt-capture">
          {captured} of {total} captured
        </span>
      </div>

      <p className="text-caption text-on-surface-variant" data-testid="stem-opt-summary">
        {stemOptSummary(keyDates, keyStages)}
        {days != null ? <span className="text-on-surface"> · {days} days total</span> : null}
      </p>

      <div className="grid gap-2">
        {STEM_OPT_TIMELINE_FIELDS.map((f) => {
          const v = valueOf(f)
          const missingAnchor = f.key === STEM_OPT_ANCHOR_KEY && !v
          return (
            <div key={f.key} className="flex items-center justify-between gap-3">
              <label htmlFor={`stem-${f.key}`} className="text-caption text-on-surface-variant flex-1">
                {f.label}
                {missingAnchor && (
                  <span className="text-error ml-1" data-testid={`needs-${f.key}`}>
                    — needed to find your cohort
                  </span>
                )}
              </label>
              {f.kind === 'date' && (
                <input
                  id={`stem-${f.key}`}
                  type="date"
                  aria-label={f.label}
                  value={v}
                  onChange={(e) => setField(f, e.target.value)}
                  className="w-40 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary"
                />
              )}
              {f.kind === 'checkbox' && (
                <input
                  id={`stem-${f.key}`}
                  type="checkbox"
                  aria-label={f.label}
                  checked={v === 'yes'}
                  onChange={(e) => setField(f, e.target.checked ? 'yes' : '')}
                  className="accent-primary w-4 h-4"
                />
              )}
              {f.kind === 'select' && (
                <select
                  id={`stem-${f.key}`}
                  aria-label={f.label}
                  value={v}
                  onChange={(e) => setField(f, e.target.value)}
                  className="w-40 bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary"
                >
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
