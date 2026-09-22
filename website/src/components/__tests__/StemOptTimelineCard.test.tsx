import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import StemOptTimelineCard from '@/components/StemOptTimelineCard'
import {
  filingPeriodFromDate,
  totalDays,
  stemOptSummary,
  isStemOptTimeline,
  stemOptCohortUrl,
  STEM_OPT_TIMELINE_FIELDS,
} from '@/lib/stemOptTimeline'

/**
 * STEM OPT unified-timeline — Phase 2 (features/stem-opt-timeline-9/).
 * Scope: STEM OPT only. The cross-link + Timeline-form specs stay `it.todo`
 * for Phase 3.
 */

describe('stemOptTimeline (lib)', () => {
  it('filingPeriodFromDate derives month/year from a strict ISO date; else null', () => {
    expect(filingPeriodFromDate('2026-03-18')).toEqual({ filing_month: 'Mar', filing_year: '2026' })
    expect(filingPeriodFromDate('2025-12-31')).toEqual({ filing_month: 'Dec', filing_year: '2025' })
    expect(filingPeriodFromDate('')).toBeNull()
    expect(filingPeriodFromDate('March 18, 2026')).toBeNull()
    expect(filingPeriodFromDate('2026-13-01')).toBeNull()
    expect(filingPeriodFromDate('2026-3-8')).toBeNull()
  })

  it('totalDays counts filed→approved, or null when missing/negative', () => {
    expect(totalDays({ ead_filed_date: '2026-03-01', ead_approved_date: '2026-03-31' })).toBe(30)
    expect(totalDays({ ead_filed_date: '2026-03-01' })).toBeNull()
    expect(totalDays({ ead_filed_date: '2026-03-31', ead_approved_date: '2026-03-01' })).toBeNull()
  })

  it('stemOptSummary reads like a timeline and degrades gracefully', () => {
    expect(stemOptSummary({ ead_filed_date: '2026-03-01', ead_approved_date: '2026-03-31' }, { premium_processing: 'yes' }))
      .toBe('Filed Mar 2026 · approved in 30 days · PP')
    expect(stemOptSummary({}, {})).toBe('Filing date not set · no PP')
    expect(stemOptSummary({ ead_filed_date: '2026-03-01' }, { application_status: 'pending' }))
      .toBe('Filed Mar 2026 · pending · no PP')
  })

  it('isStemOptTimeline detects the stem-opt-extension tag', () => {
    expect(isStemOptTimeline({ tags: ['EAD', 'stem-opt-extension'] })).toBe(true)
    expect(isStemOptTimeline({ tags: ['h1b-petition'] })).toBe(false)
    expect(isStemOptTimeline(null)).toBe(false)
  })

  it('stemOptCohortUrl builds the Timeline /find deep-link from ead_filed_date, else null', () => {
    expect(stemOptCohortUrl({ ead_filed_date: '2026-03-18' }))
      .toBe('/find?type=timeline&processing_type=EAD&eligibility=stem-opt-extension&filing_month=Mar&filing_year=2026')
    expect(stemOptCohortUrl({})).toBeNull()
    expect(stemOptCohortUrl({ ead_filed_date: 'March 2026' })).toBeNull()
  })
})

describe('StemOptTimelineCard — shared capture component', () => {
  const noop = () => {}

  it('renders the canonical STEM OPT fields from the template', () => {
    render(<StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={noop} />)
    for (const f of STEM_OPT_TIMELINE_FIELDS) {
      expect(screen.getByLabelText(f.label)).toBeInTheDocument()
    }
  })

  it('prefills every field from the key_dates/key_stages it is given', () => {
    render(
      <StemOptTimelineCard
        keyDates={{ ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' }}
        keyStages={{ application_status: 'approved', premium_processing: 'yes' }}
        onChange={noop}
      />
    )
    expect((screen.getByLabelText('Date applied (I-765 filed)') as HTMLInputElement).value).toBe('2026-03-18')
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('approved')
    expect((screen.getByLabelText('Premium processing') as HTMLInputElement).checked).toBe(true)
  })

  it('leaves unparsed fields blank and flags the missing filing-date anchor (never fabricates)', () => {
    const { rerender } = render(<StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={noop} />)
    // blank, not fabricated
    expect((screen.getByLabelText('Date applied (I-765 filed)') as HTMLInputElement).value).toBe('')
    // anchor flagged as needed
    expect(screen.getByTestId('needs-ead_filed_date')).toBeInTheDocument()
    // once provided, the flag is gone
    rerender(<StemOptTimelineCard keyDates={{ ead_filed_date: '2026-03-18' }} keyStages={{}} onChange={noop} />)
    expect(screen.queryByTestId('needs-ead_filed_date')).toBeNull()
  })

  it('computes and displays the derived total days and a readable summary', () => {
    render(
      <StemOptTimelineCard
        keyDates={{ ead_filed_date: '2026-03-01', ead_approved_date: '2026-03-31' }}
        keyStages={{ premium_processing: 'yes' }}
        onChange={noop}
      />
    )
    const summary = screen.getByTestId('stem-opt-summary')
    expect(summary).toHaveTextContent('Filed Mar 2026')
    expect(summary).toHaveTextContent('approved in 30 days')
    expect(summary).toHaveTextContent('30 days total')
  })

  it('editing a field updates the underlying key_dates/key_stages passed back', () => {
    const onChange = vi.fn()
    render(<StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={onChange} />)

    fireEvent.change(screen.getByLabelText('Date applied (I-765 filed)'), { target: { value: '2026-03-18' } })
    expect(onChange).toHaveBeenLastCalledWith({ ead_filed_date: '2026-03-18' }, {})

    onChange.mockClear()
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'approved' } })
    expect(onChange).toHaveBeenLastCalledWith({}, { application_status: 'approved' })

    onChange.mockClear()
    fireEvent.click(screen.getByLabelText('Premium processing'))
    expect(onChange).toHaveBeenLastCalledWith({}, { premium_processing: 'yes' })
  })

  it('keeps status/service-center within their vocab options', () => {
    render(<StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={noop} />)
    const status = screen.getByLabelText('Status') as HTMLSelectElement
    const opts = Array.from(status.options).map((o) => o.value)
    expect(opts).toEqual(['', 'approved', 'pending', 'denied', 'RFE', 'NOID'])
  })
})

// posting → cohort (Phase 3, DONE): the /post success-screen bridge is covered
// in app/post/__tests__/page.test.tsx ("STEM OPT posting → cohort bridge") plus
// the stemOptCohortUrl unit test above. The reverse direction remains:
describe('STEM OPT cohort → posting (reverse cross-link) [Phase 3b]', () => {
  it.todo('from a stem-opt cohort membership, offers "Share as a posting" that prefills a post draft from the member attributes')
})

describe('StemOptTimelineCard — Timeline group form [Phase 3]', () => {
  it.todo('renders as the join/attribute form for stem-opt-extension (same card as /post)')
  it.todo('optionally accepts pasted free-text timeline → tag-suggest → prefills the card')
})
