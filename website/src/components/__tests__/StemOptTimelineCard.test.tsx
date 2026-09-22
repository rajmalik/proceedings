import { describe, it } from 'vitest'

/**
 * Acceptance criteria for the STEM OPT unified-timeline feature (website side),
 * written BEFORE implementation (TDD) — features/stem-opt-timeline-9/.
 *
 * Scope: STEM OPT only (`EAD → stem-opt-extension`). These are `it.todo`
 * pending specs (CI-safe: they neither import the unbuilt component nor fail the
 * suite). During Phase 2/3 each `todo` converts 1:1 into a real test against the
 * component/helpers it names — do NOT delete a criterion, implement it.
 *
 * The cohort deep-link TARGET (/find reading
 * ?type=timeline&processing_type=EAD&eligibility=stem-opt-extension&filing_month=..&filing_year=..)
 * already exists and is covered in app/find/__tests__/page.test.tsx — the specs
 * below cover the NEW capture card, the /post prefill, and building that link
 * from a posting's ead_filed_date.
 */

describe('StemOptTimelineCard — shared capture component', () => {
  it.todo('renders the canonical STEM OPT fields from the stem-opt-extension template (filed/biometrics/approved dates, status, service center, PP, RFE/NOID)')
  it.todo('prefills every field from the posting key_dates/key_stages it is given')
  it.todo('leaves unparsed fields blank and visibly flags them as needing input (never fabricates a value)')
  it.todo('computes and displays derived total days from ead_filed_date → ead_approved_date')
  it.todo('shows a human-readable timeline summary (e.g. "Filed Mar 2026 · approved in 190 days · no PP"), not just a raw form')
  it.todo('editing a field updates the underlying key_dates/key_stages passed back to the parent')
  it.todo('validates dates as YYYY-MM-DD and keeps status/service-center within their vocab options')
})

describe('StemOptTimelineCard — /post integration (free-text on-ramp)', () => {
  it.todo('after Preview, when tag-suggest detects STEM OPT (stem-opt-extension/EAD), the card appears prefilled from the extracted key_dates/key_stages')
  it.todo('does NOT appear for a non-STEM-OPT posting')
  it.todo('a partial extraction still lets the posting submit (the card is not a blocking gate)')
  it.todo('on submit, the posting carries BOTH the narrative description and the confirmed structured fields')
  it.todo('the confirmed card is the source of truth when it disagrees with the raw extraction')
})

describe('STEM OPT posting ⇄ cohort cross-link (bidirectional)', () => {
  it.todo('derives {filing_month, filing_year} from ead_filed_date to build the cohort deep-link')
  it.todo('offers "join / create your EAD · stem-opt cohort" after a STEM OPT posting, linking to /find?type=timeline&processing_type=EAD&eligibility=stem-opt-extension&filing_month=..&filing_year=..')
  it.todo('prompts only for ead_filed_date at the bridge step when it is missing (rather than blocking the post)')
  it.todo('never auto-joins — the cohort join/create is user-confirmed')
  it.todo('from a stem-opt cohort membership, offers "Share as a posting" that prefills a post draft from the member attributes')
})

describe('StemOptTimelineCard — Timeline group form', () => {
  it.todo('renders as the join/attribute form for stem-opt-extension (same card as /post)')
  it.todo('optionally accepts pasted free-text timeline → tag-suggest → prefills the card')
})
