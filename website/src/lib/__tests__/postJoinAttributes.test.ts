import { describe, it, expect } from 'vitest'
import {
  CHECKBOX_ON, isChecked, displayValue, requiredKeys, type PostJoinRow,
} from '@/lib/postJoinAttributes'

// The client half of backend/posting.py's POST_JOIN_ATTRIBUTE_TEMPLATES
// contract. Every rule here has a server-side twin (posting.required_keys,
// posting.CHECKBOX_ON, matching._validate_attribute_values); if these drift,
// the UI and the 422s stop agreeing.

const row = (key: string, extra: Partial<PostJoinRow> = {}): PostJoinRow =>
  ({ label: key, field: 'key_dates', key, ...extra })

describe('CHECKBOX_ON', () => {
  it('is the exact literal the backend stores', () => {
    // posting.CHECKBOX_ON — a ticked box is this string, never true/"true"/"on".
    expect(CHECKBOX_ON).toBe('yes')
  })
})

describe('requiredKeys — the three resolution modes', () => {
  it('falls back to row 0 when no row declares anything', () => {
    // The convention every template predating the flag was written to.
    expect(requiredKeys([row('a'), row('b'), row('c')])).toEqual(['a'])
  })

  it('honours an explicit required:true instead of row 0', () => {
    expect(requiredKeys([row('a'), row('b', { required: true })])).toEqual(['b'])
  })

  it('supports more than one required row', () => {
    expect(requiredKeys([
      row('a', { required: true }), row('b'), row('c', { required: true }),
    ])).toEqual(['a', 'c'])
  })

  it('treats a declared required:false as "nothing is mandatory", not row 0', () => {
    // The I-485 case. Without literal-mode resolution the row-0 fallback
    // would make the one optional field mandatory and block joining.
    expect(requiredKeys([row('priority_date', { required: false })])).toEqual([])
  })

  it('once ANY row declares, undeclared rows are optional — not row-0 fallback', () => {
    // Mixed declaration is the subtle case: 'a' is row 0 but says nothing,
    // so it must NOT be required just because it is first.
    expect(requiredKeys([row('a'), row('b', { required: false }), row('c', { required: true })]))
      .toEqual(['c'])
  })

  it('requires nothing for an empty template', () => {
    expect(requiredKeys([])).toEqual([])
  })

  it('preserves template order rather than sorting', () => {
    expect(requiredKeys([
      row('z', { required: true }), row('a', { required: true }),
    ])).toEqual(['z', 'a'])
  })
})

describe('isChecked', () => {
  it('reads a stored CHECKBOX_ON as on', () => {
    expect(isChecked(CHECKBOX_ON)).toBe(true)
  })

  it('reads absent and empty as off — an unticked box stores nothing at all', () => {
    expect(isChecked(undefined)).toBe(false)
    expect(isChecked('')).toBe(false)
  })
})

describe('displayValue', () => {
  const checkbox = row('premium_processing', { kind: 'checkbox' })
  const date = row('ead_filed_date', { kind: 'date' })

  it('renders a ticked checkbox as Yes', () => {
    expect(displayValue(checkbox, CHECKBOX_ON)).toBe('Yes')
  })

  it('renders an unticked checkbox as blank, never "No"', () => {
    // Unticked and never-answered are deliberately indistinguishable, so the
    // cell must not assert a negative the user never gave.
    expect(displayValue(checkbox, undefined)).toBe('')
    expect(displayValue(checkbox, '')).toBe('')
  })

  it('passes a non-checkbox value through unchanged', () => {
    expect(displayValue(date, '2026-03-01')).toBe('2026-03-01')
  })

  it('renders a missing non-checkbox value as blank', () => {
    expect(displayValue(date, undefined)).toBe('')
  })

  it('treats a row with no kind as a plain value (date is the default)', () => {
    expect(displayValue(row('x'), '2026-03-01')).toBe('2026-03-01')
  })
})
