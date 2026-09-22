import {
  filingPeriodFromDate,
  totalDays,
  stemOptSummary,
  isStemOptTimeline,
  stemOptBuckets,
  stemOptCohortParams,
  STEM_OPT_TIMELINE_FIELDS,
} from '../stemOptTimeline';

// STEM OPT unified-timeline lib — Phase 4 (mobile parity). Mirrors the website
// suite (website/src/components/__tests__/StemOptTimelineCard.test.tsx) so the
// two clients derive identical cohorts from the same inputs.

describe('stemOptTimeline (mobile lib)', () => {
  it('filingPeriodFromDate derives month/year from a strict ISO date; else null', () => {
    expect(filingPeriodFromDate('2026-03-18')).toEqual({ filing_month: 'Mar', filing_year: '2026' });
    expect(filingPeriodFromDate('2025-12-31')).toEqual({ filing_month: 'Dec', filing_year: '2025' });
    expect(filingPeriodFromDate('')).toBeNull();
    expect(filingPeriodFromDate('March 18, 2026')).toBeNull();
    expect(filingPeriodFromDate('2026-13-01')).toBeNull();
    expect(filingPeriodFromDate('2026-3-8')).toBeNull();
  });

  it('totalDays counts filed→approved, or null when missing/negative', () => {
    expect(totalDays({ ead_filed_date: '2026-03-01', ead_approved_date: '2026-03-31' })).toBe(30);
    expect(totalDays({ ead_filed_date: '2026-03-01' })).toBeNull();
    expect(totalDays({ ead_filed_date: '2026-03-31', ead_approved_date: '2026-03-01' })).toBeNull();
  });

  it('stemOptSummary reads like a timeline and degrades gracefully', () => {
    expect(
      stemOptSummary({ ead_filed_date: '2026-03-01', ead_approved_date: '2026-03-31' }, { premium_processing: 'yes' }),
    ).toBe('Filed Mar 2026 · approved in 30 days · PP');
    expect(stemOptSummary({}, {})).toBe('Filing date not set · no PP');
    expect(stemOptSummary({ ead_filed_date: '2026-03-01' }, { application_status: 'pending' })).toBe(
      'Filed Mar 2026 · pending · no PP',
    );
  });

  it('isStemOptTimeline detects the stem-opt-extension tag', () => {
    expect(isStemOptTimeline({ tags: ['EAD', 'stem-opt-extension'] })).toBe(true);
    expect(isStemOptTimeline({ tags: ['h1b-petition'] })).toBe(false);
    expect(isStemOptTimeline(null)).toBe(false);
  });

  it('stemOptCohortParams builds the Timeline FindScreen params from ead_filed_date, else null', () => {
    expect(stemOptCohortParams({ ead_filed_date: '2026-03-18' })).toEqual({
      type: 'timeline',
      processing_type: 'EAD',
      eligibility: 'stem-opt-extension',
      filing_month: 'Mar',
      filing_year: '2026',
    });
    expect(stemOptCohortParams({})).toBeNull();
    expect(stemOptCohortParams({ ead_filed_date: 'March 2026' })).toBeNull();
  });

  it('stemOptBuckets splits a member value bag into key_dates/key_stages, dropping unknown keys', () => {
    expect(
      stemOptBuckets({
        ead_filed_date: '2026-03-18',
        ead_approved_date: '2026-09-17',
        application_status: 'approved',
        premium_processing: 'yes',
        some_unknown_key: 'x',
      }),
    ).toEqual({
      key_dates: { ead_filed_date: '2026-03-18', ead_approved_date: '2026-09-17' },
      key_stages_or_info: { application_status: 'approved', premium_processing: 'yes' },
    });
    expect(stemOptBuckets({})).toEqual({ key_dates: {}, key_stages_or_info: {} });
    expect(stemOptBuckets(null)).toEqual({ key_dates: {}, key_stages_or_info: {} });
  });

  it('the canonical field schema matches the website (anchor + buckets)', () => {
    const byKey = Object.fromEntries(STEM_OPT_TIMELINE_FIELDS.map((f) => [f.key, f]));
    expect(byKey.ead_filed_date.bucket).toBe('key_dates');
    expect(byKey.ead_filed_date.kind).toBe('date');
    expect(byKey.application_status.bucket).toBe('key_stages_or_info');
    expect(byKey.premium_processing.kind).toBe('checkbox');
  });
});
