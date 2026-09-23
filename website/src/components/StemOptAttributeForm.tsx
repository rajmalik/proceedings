'use client'

import { useState } from 'react'
import StemOptTimelineCard from './StemOptTimelineCard'
import { stemOptBuckets, STEM_OPT_TIMELINE_FIELDS } from '@/lib/stemOptTimeline'

// The STEM OPT join/attribute form (features/stem-opt-timeline-9/ Phase 6):
// the SAME structured card used in /post, adapted to the group page's flat
// `values` + `onChange(key, value)` contract so it drops in for the generic
// AttributeForm at the join / mandatory-gate / edit call sites. Adds the
// optional "paste your timeline" on-ramp (free text → tag-suggest → prefill),
// giving the structured side the same low-friction entry the posting flow has.
// Scope: stem-opt-extension only.

const CANON_KEYS = STEM_OPT_TIMELINE_FIELDS.map((f) => f.key)

type KV = Record<string, string>

export default function StemOptAttributeForm({
  values,
  onChange,
  notes,
  onNotesChange,
}: {
  values: KV
  onChange: (key: string, value: string) => void
  notes: string
  onNotesChange: (v: string) => void
}) {
  const [paste, setPaste] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [pasteMsg, setPasteMsg] = useState('')

  const { key_dates, key_stages_or_info } = stemOptBuckets(values)

  // The card hands back the full next buckets; translate that into the
  // per-key onChange the form contract expects (only canonical keys move).
  const applyNext = (nextDates: KV, nextStages: KV) => {
    const next: KV = { ...nextDates, ...nextStages }
    for (const k of CANON_KEYS) {
      const nv = next[k] || ''
      if ((values[k] || '') !== nv) onChange(k, nv)
    }
  }

  const extractFromPaste = async () => {
    const text = paste.trim()
    if (!text) return
    setExtracting(true)
    setPasteMsg('')
    try {
      const res = await fetch('/api/tag-suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'STEM OPT timeline', description: text }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.detail || 'Could not read that timeline')
      const merged: KV = { ...(data.key_dates || {}), ...(data.key_stages_or_info || {}) }
      let filled = 0
      for (const k of CANON_KEYS) {
        if (merged[k]) {
          onChange(k, String(merged[k]))
          filled += 1
        }
      }
      setPasteMsg(filled ? `Filled ${filled} field${filled === 1 ? '' : 's'} — review below.` : 'No timeline fields found — enter them below.')
    } catch (e) {
      setPasteMsg(e instanceof Error ? e.message : 'Could not read that timeline')
    } finally {
      setExtracting(false)
    }
  }

  const box =
    'w-full text-body-md bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-2 focus:outline-none focus:border-primary'

  return (
    <div className="space-y-3">
      {/* Optional free-text on-ramp — paste a timeline, extract the fields. */}
      <div className="space-y-1">
        <label htmlFor="stem-opt-paste" className="text-caption text-on-surface-variant">
          Paste your timeline (optional)
        </label>
        <textarea
          id="stem-opt-paste"
          data-testid="stem-opt-paste"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={2}
          placeholder="e.g. Filed I-765 on 2026-03-18, biometrics done 2026-04-06, approved 2026-09-17"
          className={box}
        />
        <button
          type="button"
          data-testid="stem-opt-extract"
          onClick={extractFromPaste}
          disabled={extracting || !paste.trim()}
          className="text-caption text-primary hover:underline disabled:opacity-50 disabled:no-underline"
        >
          {extracting ? 'Reading…' : 'Fill from timeline'}
        </button>
        {pasteMsg && (
          <p className="text-caption text-on-surface-variant" data-testid="stem-opt-paste-msg">
            {pasteMsg}
          </p>
        )}
      </div>

      <StemOptTimelineCard keyDates={key_dates} keyStages={key_stages_or_info} onChange={applyNext} />

      <div>
        <label htmlFor="stem-opt-notes" className="text-caption text-on-surface-variant">
          Notes
        </label>
        <textarea
          id="stem-opt-notes"
          value={notes}
          onChange={(e) => onNotesChange(e.target.value)}
          maxLength={1000}
          placeholder="Anything else worth sharing with the cohort?"
          rows={2}
          className={`mt-1 ${box}`}
        />
      </div>
    </div>
  )
}
