// The reconcile-and-apply merge used by /post — extracted from preview() into a
// pure function so both preview() (tag-suggest path) and the AI-draft mount
// effect run the SAME profile-reconcile merge (D1/D3), and so the behavior is
// unit-testable without mounting the page.

import type { Groups, KV } from './assistDraft'

export type { Groups, KV } from './assistDraft'

export type Conflict = {
  field: string
  message_value: unknown
  profile_value?: unknown
  message?: string
}

export type ReconcileResponse = {
  merged?: Partial<Groups> & { key_stages_or_info?: KV; key_dates?: KV }
  conflicts?: Conflict[]
  explainer?: string
  prefilled?: string[]
}

export type ReconcileApplied = {
  groups: Groups
  stages: KV
  dates: KV
  conflicts: Conflict[]
  explainer: string
  prefilled: string[]
}

export const EMPTY_GROUPS: Groups = {
  visa_applying_for: [],
  current_visa_or_greencard_category: [],
  primary_consulate: '',
  consulates: [],
  tags: [],
  concerns_or_questions_tags: [],
}

// Merge the reconcile response `rd` onto the message-derived groups/stages/dates.
// Profile-reconciled values win for the structured fields; the free-form `tags`
// and `concerns_or_questions_tags` are ALWAYS the message's (never pulled from
// the profile). Mirrors the original preview() merge exactly.
export function mergeReconcile(g: Groups, st: KV, dt: KV, rd: ReconcileResponse): ReconcileApplied {
  const m = rd.merged || {}
  return {
    groups: {
      ...EMPTY_GROUPS,
      current_visa_or_greencard_category: m.current_visa_or_greencard_category ?? g.current_visa_or_greencard_category,
      visa_applying_for: m.visa_applying_for ?? g.visa_applying_for,
      primary_consulate: m.primary_consulate ?? g.primary_consulate,
      consulates: m.consulates ?? g.consulates,
      tags: g.tags,
      concerns_or_questions_tags: g.concerns_or_questions_tags,
    },
    stages: m.key_stages_or_info ?? st,
    dates: m.key_dates ?? dt,
    conflicts: rd.conflicts || [],
    explainer: rd.explainer || '',
    prefilled: rd.prefilled || [],
  }
}
