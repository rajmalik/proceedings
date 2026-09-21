import { colors } from '../constants/theme';

/**
 * Single source of truth for outcome-badge colors so a posting's outcome reads the
 * same in the feed and on the detail screen (UI_AUDIT §1 — they had diverged: green
 * in the feed vs gray on detail). Approved/issued → success, denied/refused/rejected
 * → error, everything else → neutral.
 */
export function getOutcomeBadgeStyle(outcome: string): { backgroundColor: string; color: string } {
  const o = (outcome || '').toLowerCase();
  if (o === 'approved' || o === 'issued') {
    return { backgroundColor: colors.successContainer, color: colors.onSuccessContainer };
  }
  if (o === 'denied' || o === 'refused' || o === 'rejected') {
    return { backgroundColor: colors.errorContainer, color: colors.onErrorContainer };
  }
  return { backgroundColor: colors.surfaceContainerHigh, color: colors.onSurfaceVariant };
}
