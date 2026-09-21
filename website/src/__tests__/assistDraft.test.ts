import { describe, it, expect, beforeEach } from 'vitest'
import { POST_DRAFT_KEY, writePostDraft, readAndClearPostDraft } from '@/lib/assistDraft'

/**
 * AI-Assist Phase 4 — the sessionStorage draft hand-off contract (Q11/C2).
 * The AiAssist surface writes a draft; /post reads it once on mount and clears it.
 * Pure lib (no React) so the contract is locked without mounting the page.
 */
const G = {
  visa_applying_for: ['H-1B'],
  current_visa_or_greencard_category: [],
  primary_consulate: '',
  consulates: [],
  tags: ['timeline'],
  concerns_or_questions_tags: [],
}
const base = { title: 'T', description: 'D', groups: G, key_stages_or_info: { a: 'b' }, key_dates: { c: 'd' } }

describe('assistDraft sessionStorage contract', () => {
  beforeEach(() => sessionStorage.clear())

  it('uses the versioned key', () => {
    expect(POST_DRAFT_KEY).toBe('aiAssist.postDraft.v1')
  })

  it('writes then reads the same draft (with source + createdAt stamped)', () => {
    writePostDraft(base)
    const d = readAndClearPostDraft()
    expect(d).toBeTruthy()
    expect(d!.title).toBe('T')
    expect(d!.description).toBe('D')
    expect(d!.groups).toEqual(G)
    expect(d!.key_stages_or_info).toEqual({ a: 'b' })
    expect(d!.key_dates).toEqual({ c: 'd' })
    expect(d!.source).toBe('ai-assist')
    expect(typeof d!.createdAt).toBe('string')
  })

  it('is read-once: a second read returns null and the key is gone', () => {
    writePostDraft(base)
    expect(readAndClearPostDraft()).toBeTruthy()
    expect(readAndClearPostDraft()).toBeNull()
    expect(sessionStorage.getItem(POST_DRAFT_KEY)).toBeNull()
  })

  it('returns null when no draft is present (normal /post visit)', () => {
    expect(readAndClearPostDraft()).toBeNull()
  })

  it('returns null AND clears the key on corrupt JSON', () => {
    sessionStorage.setItem(POST_DRAFT_KEY, 'not json {')
    expect(readAndClearPostDraft()).toBeNull()
    expect(sessionStorage.getItem(POST_DRAFT_KEY)).toBeNull()
  })

  it('ignores a stored object not tagged source="ai-assist"', () => {
    sessionStorage.setItem(POST_DRAFT_KEY, JSON.stringify({ title: 'x', source: 'other' }))
    expect(readAndClearPostDraft()).toBeNull()
  })
})
