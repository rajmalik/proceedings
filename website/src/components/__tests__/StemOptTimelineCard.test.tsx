import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import StemOptTimelineCard from '@/components/StemOptTimelineCard'
import {
  filingPeriodFromDate,
  totalDays,
  stemOptSummary,
  isStemOptTimeline,
  stemOptCohortUrl,
  stemOptBuckets,
  stemOptCaptureCount,
  STEM_OPT_TIMELINE_FIELDS,
} from '@/lib/stemOptTimeline'

/**
 * STEM OPT unified-timeline (features/stem-opt-timeline-9/). Scope: STEM OPT
 * only. Cross-link (Phase 3) and Timeline-form reuse (Phase 6) are implemented;
 * see StemOptAttributeForm.test.tsx and the post/group page suites.
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

  it('stemOptBuckets splits a member value bag into key_dates/key_stages, dropping unknown keys', () => {
    expect(
      stemOptBuckets({
        ead_filed_date: '2026-03-18',
        ead_approved_date: '2026-09-17',
        application_status: 'approved',
        premium_processing: 'yes',
        some_unknown_key: 'x', // not in the canonical schema → dropped
      }),
    ).toEqual({
      key_dates: { ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' },
      key_stages_or_info: { application_status: 'approved', premium_processing: 'yes' },
    })
    expect(stemOptBuckets({})).toEqual({ key_dates: {}, key_stages_or_info: {} })
    expect(stemOptBuckets(null)).toEqual({ key_dates: {}, key_stages_or_info: {} })
  })

  it('stemOptCaptureCount counts populated canonical fields against the total', () => {
    expect(stemOptCaptureCount({}, {})).toEqual({ captured: 0, total: STEM_OPT_TIMELINE_FIELDS.length })
    expect(
      stemOptCaptureCount({ ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' }, { application_status: 'approved' }),
    ).toEqual({ captured: 3, total: STEM_OPT_TIMELINE_FIELDS.length })
    // an off-schema key is not counted
    expect(stemOptCaptureCount({ ead_filed_date: '2026-03-18', not_a_field: 'x' }, {})).toEqual({
      captured: 1,
      total: STEM_OPT_TIMELINE_FIELDS.length,
    })
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

  it('shows a partial-parse capture count that reflects how much was prefilled', () => {
    const { rerender } = render(
      <StemOptTimelineCard keyDates={{ ead_filed_date: '2026-03-18' }} keyStages={{}} onChange={noop} />
    )
    expect(screen.getByTestId('stem-opt-capture')).toHaveTextContent(`1 of ${STEM_OPT_TIMELINE_FIELDS.length} captured`)
    rerender(
      <StemOptTimelineCard
        keyDates={{ ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' }}
        keyStages={{ application_status: 'approved' }}
        onChange={noop}
      />
    )
    expect(screen.getByTestId('stem-opt-capture')).toHaveTextContent(`3 of ${STEM_OPT_TIMELINE_FIELDS.length} captured`)
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

  it('clearing a prefilled field removes it from the bucket (never keeps a blank)', () => {
    const onChange = vi.fn()
    render(<StemOptTimelineCard keyDates={{ ead_filed_date: '2026-03-18' }} keyStages={{}} onChange={onChange} />)
    // clearing the date deletes the key rather than storing ''
    fireEvent.change(screen.getByLabelText('Date applied (I-765 filed)'), { target: { value: '' } })
    expect(onChange).toHaveBeenLastCalledWith({}, {})
  })

  it('unchecking a checkbox removes its stage key', () => {
    const onChange = vi.fn()
    render(<StemOptTimelineCard keyDates={{}} keyStages={{ premium_processing: 'yes' }} onChange={onChange} />)
    fireEvent.click(screen.getByLabelText('Premium processing'))
    expect(onChange).toHaveBeenLastCalledWith({}, {})
  })

  it('keeps status/service-center within their vocab options', () => {
    render(<StemOptTimelineCard keyDates={{}} keyStages={{}} onChange={noop} />)
    const status = screen.getByLabelText('Status') as HTMLSelectElement
    const opts = Array.from(status.options).map((o) => o.value)
    expect(opts).toEqual(['', 'approved', 'pending', 'denied', 'RFE', 'NOID'])
  })
})

// Phase 3 cross-link — both directions DONE:
//  • posting → cohort: /post success-screen bridge, covered in
//    app/post/__tests__/page.test.tsx ("STEM OPT posting → cohort bridge")
//    + the stemOptCohortUrl unit test above.
//  • cohort → posting: the "Share your timeline as a posting" affordance on a
//    stem-opt group, covered in app/groups/[id]/__tests__/page.test.tsx
//    ("STEM OPT cohort → posting") + the stemOptBuckets unit test above.

// Phase 6 — Timeline-form reuse DONE: the same card is the stem-opt-extension
// join/attribute form (with a paste-your-timeline on-ramp), covered by
// StemOptAttributeForm.test.tsx + the group page's join/gate/edit specs
// (app/groups/[id]/__tests__/page.test.tsx).
