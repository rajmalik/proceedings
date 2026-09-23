// /post hand-off draft (Q11/C2).
//
// A surface assembles a post draft and stashes it in sessionStorage; /post
// reads it once on mount and clears it. Two producers today: the AI-Assist
// router (`source: 'ai-assist'`) and the STEM OPT cohort → posting reverse
// cross-link (`source: 'cohort'`, features/stem-opt-timeline-9/ Phase 3).
// sessionStorage (not URL params / not a server draft) keeps it ephemeral and
// off the URL (no PII in query strings). All access is wrapped in try/catch:
// the hand-off is best-effort and must never throw (private mode, blocked
// storage), and /post falls back to an empty composer when there's no draft.

export type Groups = {
  visa_applying_for: string[]
  current_visa_or_greencard_category: string[]
  primary_consulate: string
  consulates: string[]
  tags: string[]
  concerns_or_questions_tags: string[]
}
export type KV = Record<string, string>

export type DraftSource = 'ai-assist' | 'cohort'

export type PostDraft = {
  title: string
  description: string
  groups: Groups
  key_stages_or_info: KV
  key_dates: KV
  source: DraftSource
  createdAt: string
}

export const POST_DRAFT_KEY = 'aiAssist.postDraft.v1'

type DraftInput = Omit<PostDraft, 'source' | 'createdAt'>

export function writePostDraft(input: DraftInput, source: DraftSource = 'ai-assist'): void {
  try {
    const draft: PostDraft = { ...input, source, createdAt: new Date().toISOString() }
    sessionStorage.setItem(POST_DRAFT_KEY, JSON.stringify(draft))
  } catch {
    /* sessionStorage unavailable — the hand-off is best-effort, so do nothing */
  }
}

export function readAndClearPostDraft(): PostDraft | null {
  try {
    const raw = sessionStorage.getItem(POST_DRAFT_KEY)
    if (!raw) return null
    sessionStorage.removeItem(POST_DRAFT_KEY) // read-once, even if parsing fails
    const d = JSON.parse(raw)
    if (!d || typeof d !== 'object' || (d.source !== 'ai-assist' && d.source !== 'cohort')) return null
    return d as PostDraft
  } catch {
    return null
  }
}
