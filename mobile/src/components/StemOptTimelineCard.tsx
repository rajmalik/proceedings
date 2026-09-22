import React from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius } from '../constants/theme';
import { AppText } from './AppText';
import { Select } from './Select';
import { Card } from './Card';
import {
  STEM_OPT_TIMELINE_FIELDS,
  STEM_OPT_ANCHOR_KEY,
  stemOptSummary,
  totalDays,
  type StemOptField,
} from '../lib/stemOptTimeline';

type KV = Record<string, string>;

// The shared STEM OPT timeline capture card (features/stem-opt-timeline-9/,
// Phase 4 — mobile parity for website/src/components/StemOptTimelineCard.tsx).
// Renders the canonical stem-opt-extension fields over the posting's
// key_dates/key_stages_or_info, prefilled from whatever was parsed; blanks stay
// blank (never fabricated), the filing-date anchor is flagged when missing.
export function StemOptTimelineCard({
  keyDates,
  keyStages,
  onChange,
}: {
  keyDates: KV;
  keyStages: KV;
  onChange: (nextDates: KV, nextStages: KV) => void;
}) {
  const valueOf = (f: StemOptField) => (f.bucket === 'key_dates' ? keyDates[f.key] : keyStages[f.key]) || '';

  const setField = (f: StemOptField, value: string) => {
    const bucket = f.bucket === 'key_dates' ? { ...keyDates } : { ...keyStages };
    if (value) bucket[f.key] = value;
    else delete bucket[f.key];
    if (f.bucket === 'key_dates') onChange(bucket, keyStages);
    else onChange(keyDates, bucket);
  };

  const days = totalDays(keyDates);

  return (
    <View testID="stem-opt-timeline-card">
      <Card style={styles.card}>
      <View style={styles.headerRow}>
        <Ionicons name="git-branch-outline" size={18} color={colors.secondary} />
        <AppText variant="labelMd" color="onSurface" style={styles.headerText}>
          STEM OPT timeline
        </AppText>
      </View>

      <AppText variant="caption" color="onSurfaceVariant" testID="stem-opt-summary">
        {stemOptSummary(keyDates, keyStages)}
        {days != null ? `  ·  ${days} days total` : ''}
      </AppText>

      <View style={styles.fields}>
        {STEM_OPT_TIMELINE_FIELDS.map((f) => {
          const v = valueOf(f);
          const missingAnchor = f.key === STEM_OPT_ANCHOR_KEY && !v;
          return (
            <View key={f.key} style={styles.fieldRow}>
              <View style={styles.labelWrap}>
                <AppText variant="caption" color="onSurfaceVariant">
                  {f.label}
                </AppText>
                {missingAnchor && (
                  <AppText variant="caption" color="error" testID={`needs-${f.key}`}>
                    {' '}— needed to find your cohort
                  </AppText>
                )}
              </View>

              {f.kind === 'date' && (
                <TextInput
                  style={styles.input}
                  accessibilityLabel={f.label}
                  value={v}
                  onChangeText={(t) => setField(f, t)}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.onSurfaceVariant}
                  autoCapitalize="none"
                  keyboardType="numbers-and-punctuation"
                />
              )}

              {f.kind === 'checkbox' && (
                <TouchableOpacity
                  accessibilityRole="checkbox"
                  accessibilityLabel={f.label}
                  accessibilityState={{ checked: v === 'yes' }}
                  onPress={() => setField(f, v === 'yes' ? '' : 'yes')}
                  style={styles.checkbox}
                >
                  <Ionicons
                    name={v === 'yes' ? 'checkbox' : 'square-outline'}
                    size={22}
                    color={v === 'yes' ? colors.primary : colors.outline}
                  />
                </TouchableOpacity>
              )}

              {f.kind === 'select' && (
                <View style={styles.selectWrap} accessibilityLabel={f.label}>
                  <Select
                    placeholder="—"
                    value={v}
                    options={f.options.map((o) => ({ label: o, value: o }))}
                    onChange={(next) => setField(f, next)}
                    containerStyle={styles.selectContainer}
                  />
                </View>
              )}
            </View>
          );
        })}
      </View>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
  },
  headerText: {
    marginLeft: spacing.xs,
  },
  fields: {
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  labelWrap: {
    flex: 1,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
  },
  input: {
    width: 150,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    color: colors.onSurface,
  },
  checkbox: {
    padding: spacing.xs,
  },
  selectWrap: {
    width: 150,
  },
  selectContainer: {
    marginBottom: 0,
  },
});
