import { describe, it, expect } from 'vitest'
import { mergeReconcile, EMPTY_GROUPS, type Groups, type KV } from '@/lib/postReconcile'

/**
 * AI-Assist Phase 4 — the reconcile-and-apply merge extracted from /post's
 * preview() into a pure helper, shared by preview() and the new AI-draft mount
 * effect (D1/D3). Locking the merge here means the refactor can't drift the
 * long-standing preview() behavior.
 */
const g: Groups = {
  visa_applying_for: ['H-1B'],
  current_visa_or_greencard_category: ['F-1'],
  primary_consulate: 'MUM',
  consulates: ['MUM'],
  tags: ['timeline'],
  concerns_or_questions_tags: ['q'],
}
const st: KV = { filing: 'receipt' }
const dt: KV = { filed: '2026-08-01' }

describe('mergeReconcile', () => {
  it('uses merged (profile-reconciled) values when present', () => {
    const rd = {
      merged: {
        visa_applying_for: ['H-1B', 'L-1'],
        key_stages_or_info: { filing: 'approved' },
        key_dates: { filed: '2026-09-01' },
      },
      conflicts: [{ field: 'visa_applying_for', message_value: ['H-1B'] }],
      explainer: 'why',
      prefilled: ['visa_applying_for'],
    }
    const a = mergeReconcile(g, st, dt, rd)
    expect(a.groups.visa_applying_for).toEqual(['H-1B', 'L-1'])
    expect(a.stages).toEqual({ filing: 'approved' })
    expect(a.dates).toEqual({ filed: '2026-09-01' })
    expect(a.conflicts.length).toBe(1)
    expect(a.explainer).toBe('why')
    expect(a.prefilled).toEqual(['visa_applying_for'])
  })

  it('falls back to the message groups when merged omits a field', () => {
    const a = mergeReconcile(g, st, dt, { merged: {} })
    expect(a.groups.visa_applying_for).toEqual(['H-1B'])
    expect(a.groups.primary_consulate).toBe('MUM')
    expect(a.stages).toEqual(st)
    expect(a.dates).toEqual(dt)
  })

  it('ALWAYS keeps message tags/concerns (never taken from the profile)', () => {
    const rd = { merged: { tags: ['FROM_PROFILE'], concerns_or_questions_tags: ['FROM_PROFILE'] } as Partial<Groups> }
    const a = mergeReconcile(g, st, dt, rd)
    expect(a.groups.tags).toEqual(['timeline'])
    expect(a.groups.concerns_or_questions_tags).toEqual(['q'])
  })

  it('handles an empty reconcile response safely', () => {
    const a = mergeReconcile(g, st, dt, {})
    expect(a.conflicts).toEqual([])
    expect(a.explainer).toBe('')
    expect(a.prefilled).toEqual([])
    expect(a.groups.visa_applying_for).toEqual(['H-1B'])
  })

  it('EMPTY_GROUPS has exactly the six group fields', () => {
    expect(Object.keys(EMPTY_GROUPS).sort()).toEqual([
      'concerns_or_questions_tags', 'consulates', 'current_visa_or_greencard_category',
      'primary_consulate', 'tags', 'visa_applying_for',
    ])
  })
})
