// A stable per-browser id used only as the AI-Assist anonymous rate-limit key +
// analytics correlator (Q7) — never security-sensitive. Persisted in
// localStorage so it survives reloads; all access is try/catch'd (private mode /
// blocked storage) and degrades to a per-call random id rather than throwing.

const KEY = 'aiAssist.sessionId.v1'

function _random(): string {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID()
  } catch {
    /* fall through */
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function getAssistSessionId(): string {
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = _random()
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return _random()
  }
}
