import { describe, it, expect, beforeEach } from 'vitest'
import { getAssistSessionId } from '@/lib/assistSession'

describe('getAssistSessionId', () => {
  beforeEach(() => localStorage.clear())

  it('returns a non-empty id', () => {
    expect(getAssistSessionId().length).toBeGreaterThan(0)
  })

  it('is stable across calls', () => {
    expect(getAssistSessionId()).toBe(getAssistSessionId())
  })

  it('persists under the versioned key', () => {
    const id = getAssistSessionId()
    expect(localStorage.getItem('aiAssist.sessionId.v1')).toBe(id)
  })
})
