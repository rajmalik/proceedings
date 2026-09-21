'use client'

import { useMemo, useState } from 'react'

interface TagAutocompleteProps {
  placeholder: string
  options: string[] // already-resolved, displayable label list to filter
  onPick: (value: string) => void
  maxSuggestions?: number
}

// A type-to-filter picker over an already-fetched controlled-vocabulary list —
// replaces a native <input list>+<datalist> (inconsistent cross-browser
// rendering, especially Safari, and doesn't match the app's pill visual
// language). Purely client-side filtering, no network calls: every
// clickable suggestion is by construction a member of `options`, so there's
// no "invalid entry" path to handle (mirrors mobile's TagPicker).
export default function TagAutocomplete({ placeholder, options, onPick, maxSuggestions = 8 }: TagAutocompleteProps) {
  const [text, setText] = useState('')
  const matches = useMemo(() => {
    const q = text.trim().toLowerCase()
    if (!q) return []
    return options.filter((o) => o.toLowerCase().includes(q)).slice(0, maxSuggestions)
  }, [text, options, maxSuggestions])

  return (
    <div>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-3 py-1.5 text-body-md focus:outline-none focus:border-primary"
      />
      {matches.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-1.5">
          {matches.map((m) => (
            <button key={m} type="button" onClick={() => { onPick(m); setText('') }} className="pill">
              {m}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
