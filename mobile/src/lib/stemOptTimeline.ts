// STEM OPT unified-timeline helpers (features/stem-opt-timeline-9/, Phase 4 —
// mobile parity). Faithful port of the website lib
// (website/src/lib/stemOptTimeline.ts). Scope: STEM OPT only
// (EAD → stem-opt-extension). The field list mirrors the `stem-opt-extension`
// post-join template in backend/config/timeline_attributes.default.json — that
// config is the source of truth; keep this in sync with it and the website copy.

export type Bucket = 'key_dates' | 'key_stages_or_info';

export type StemOptField =
  | { key: string; label: string; bucket: Bucket; kind: 'date' }
  | { key: string; label: string; bucket: Bucket; kind: 'checkbox' }
  | { key: string; label: string; bucket: Bucket; kind: 'select'; options: string[] };

// The canonical STEM OPT timeline fields (plan §4), in milestone order. The
// cohort key (filing_month/filing_year) is derived from ead_filed_date, so it is
// not a user-entered field here.
export const STEM_OPT_TIMELINE_FIELDS: StemOptField[] = [
  { key: 'ead_filed_date', label: 'Date applied (I-765 filed)', bucket: 'key_dates', kind: 'date' },
  { key: 'biometrics_requested', label: 'Biometrics requested', bucket: 'key_stages_or_info', kind: 'checkbox' },
  { key: 'biometrics_completed_date', label: 'Biometrics completed', bucket: 'key_dates', kind: 'date' },
  { key: 'premium_processing', label: 'Premium processing', bucket: 'key_stages_or_info', kind: 'checkbox' },
  { key: 'service_center', label: 'Service center', bucket: 'key_stages_or_info', kind: 'select', options: ['PSC', 'SRC', 'LIN', 'VSC'] },
  { key: 'rfe_date', label: 'RFE issued', bucket: 'key_dates', kind: 'date' },
  { key: 'noid_issued', label: 'NOID issued', bucket: 'key_stages_or_info', kind: 'checkbox' },
  { key: 'application_status', label: 'Status', bucket: 'key_stages_or_info', kind: 'select', options: ['approved', 'pending', 'denied', 'RFE', 'NOID'] },
  { key: 'ead_approved_date', label: 'Date approved', bucket: 'key_dates', kind: 'date' },
  { key: 'ead_card_produced_date', label: 'Card produced', bucket: 'key_dates', kind: 'date' },
  { key: 'ead_card_received_date', label: 'Card received', bucket: 'key_dates', kind: 'date' },
];

// The one field required to bridge a posting to its cohort (needs the filed
// date to derive month/year). Everything else is optional.
export const STEM_OPT_ANCHOR_KEY = 'ead_filed_date';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Client mirror of backend posting.filing_period(): strict ISO date →
 *  {filing_month, filing_year}, else null. Used by the posting→cohort link. */
export function filingPeriodFromDate(
  iso: string | undefined | null,
): { filing_month: string; filing_year: string } | null {
  const m = ISO_RE.exec((iso || '').trim());
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { filing_month: MONTHS[month - 1], filing_year: String(year) };
}

/** Whole days from ead_filed_date → ead_approved_date, or null if either is
 *  missing/invalid or the range is negative. */
export function totalDays(keyDates: Record<string, string>): number | null {
  const a = ISO_RE.test(keyDates?.ead_filed_date || '') ? new Date(keyDates.ead_filed_date + 'T00:00:00Z') : null;
  const b = ISO_RE.test(keyDates?.ead_approved_date || '') ? new Date(keyDates.ead_approved_date + 'T00:00:00Z') : null;
  if (!a || !b) return null;
  const days = Math.round((b.getTime() - a.getTime()) / 86400000);
  return days >= 0 ? days : null;
}

const truthy = (v: string | undefined) => v === 'yes' || v === 'true' || v === '1' || v === 'on';

/** A human-readable one-liner, e.g. "Filed Mar 2026 · approved in 190 days · no PP".
 *  Degrades gracefully when fields are missing. */
export function stemOptSummary(keyDates: Record<string, string>, keyStages: Record<string, string>): string {
  const parts: string[] = [];
  const p = filingPeriodFromDate(keyDates?.ead_filed_date);
  parts.push(p ? `Filed ${p.filing_month} ${p.filing_year}` : 'Filing date not set');
  const days = totalDays(keyDates);
  const status = keyStages?.application_status;
  if (days != null) parts.push(`approved in ${days} days`);
  else if (status) parts.push(status);
  parts.push(truthy(keyStages?.premium_processing) ? 'PP' : 'no PP');
  return parts.join(' · ');
}

/** Does this posting's tags mark it as a STEM OPT extension experience? */
export function isStemOptTimeline(groups: { tags?: string[] } | null | undefined): boolean {
  return !!groups?.tags?.includes('stem-opt-extension');
}

/** How many of the canonical timeline fields are populated — drives the
 *  partial-parse "N of M captured" hint so a thin auto-parse is legible and the
 *  user knows there's more to fill. Counts only non-empty values. */
export function stemOptCaptureCount(
  keyDates: Record<string, string>,
  keyStages: Record<string, string>,
): { captured: number; total: number } {
  let captured = 0;
  for (const f of STEM_OPT_TIMELINE_FIELDS) {
    const v = f.bucket === 'key_dates' ? keyDates?.[f.key] : keyStages?.[f.key];
    if (v) captured += 1;
  }
  return { captured, total: STEM_OPT_TIMELINE_FIELDS.length };
}

/** Split a flat stem-opt attribute map (as a cohort member stores it under one
 *  `values` bag) back into the posting's key_dates / key_stages_or_info buckets,
 *  per the canonical field schema. Unknown keys are dropped — never guessed into
 *  a bucket. Used by the cohort → posting (reverse) cross-link. */
export function stemOptBuckets(
  values: Record<string, string> | null | undefined,
): { key_dates: Record<string, string>; key_stages_or_info: Record<string, string> } {
  const key_dates: Record<string, string> = {};
  const key_stages_or_info: Record<string, string> = {};
  for (const f of STEM_OPT_TIMELINE_FIELDS) {
    const v = values?.[f.key];
    if (!v) continue;
    if (f.bucket === 'key_dates') key_dates[f.key] = v;
    else key_stages_or_info[f.key] = v;
  }
  return { key_dates, key_stages_or_info };
}

export type StemOptCohortParams = {
  type: 'timeline';
  processing_type: 'EAD';
  eligibility: 'stem-opt-extension';
  filing_month: string;
  filing_year: string;
};

/** The Timeline-mode FindScreen deep-link params for this posting's EAD·stem-opt
 *  cohort, derived from ead_filed_date. Null when the filed date is
 *  missing/invalid (the caller then asks for just that date). The RN analog of
 *  the website's stemOptCohortUrl() — FindScreen reads exactly these params. */
export function stemOptCohortParams(keyDates: Record<string, string>): StemOptCohortParams | null {
  const p = filingPeriodFromDate(keyDates?.ead_filed_date);
  if (!p) return null;
  return {
    type: 'timeline',
    processing_type: 'EAD',
    eligibility: 'stem-opt-extension',
    filing_month: p.filing_month,
    filing_year: p.filing_year,
  };
}
