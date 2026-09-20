import { describe, it, expect, vi } from 'vitest'
import { ASSIST_OPEN_EVENT, openAssist } from '@/lib/assistLauncher'

// The global AiAssist panel is opened from a different component (the Home
// search-row launcher) via a window event, since there is no shared open-state
// provider. openAssist() must fire that event.
describe('assistLauncher', () => {
  it('exposes a stable event name', () => {
    expect(ASSIST_OPEN_EVENT).toBe('aiassist:open')
  })

  it('openAssist() dispatches the ASSIST_OPEN_EVENT on window', () => {
    const onOpen = vi.fn()
    window.addEventListener(ASSIST_OPEN_EVENT, onOpen)
    openAssist()
    expect(onOpen).toHaveBeenCalledTimes(1)
    window.removeEventListener(ASSIST_OPEN_EVENT, onOpen)
  })
})
