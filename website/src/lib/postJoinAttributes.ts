// The client-side half of backend/posting.py's POST_JOIN_ATTRIBUTE_TEMPLATES
// contract. Lives in lib/ rather than in a page because three surfaces need
// it — the group page's join/edit form, the find page's create form, and the
// members table — and a Next.js page may not export anything but the page.

export type PostJoinRow = {
  label: string
  field: string
  key: string
  /** 'date' (default) | 'select' | 'checkbox' — drives the control AND the
   *  server-side validation, so the two can't drift. */
  kind?: string
  /** Allowed values for kind:'select'. The server rejects anything else. */
  options?: string[]
  /** Must be supplied to join. Configured per template server-side. */
  required?: boolean
}

/**
 * Which rows a member must fill in to join. Mirrors posting.required_keys():
 * if ANY row declares `required` the declarations are taken literally — the
 * only way to say "nothing here is mandatory" — and a template that declares
 * nothing falls back to row 0, the convention every template predating the
 * flag was written to.
 */
export function requiredKeys(rows: PostJoinRow[]): string[] {
  if (rows.some((r) => r.required !== undefined)) {
    return rows.filter((r) => r.required).map((r) => r.key)
  }
  return rows.length ? [rows[0].key] : []
}

/**
 * A ticked checkbox is stored as this exact string; an unticked one is stored
 * as nothing at all — never "no". Keeps `values` sparse and makes unticked
 * indistinguishable from never-answered, which is what the backend's
 * _validate_attribute_values() also does (posting.CHECKBOX_ON).
 */
export const CHECKBOX_ON = 'yes'

/** True when a row's stored value counts as "on"/answered. */
export function isChecked(value?: string): boolean {
  return Boolean(value)
}

/** How a row's stored value should read in a table cell. */
export function displayValue(row: PostJoinRow, value?: string): string {
  if (row.kind === 'checkbox') return value ? 'Yes' : ''
  return value || ''
}
