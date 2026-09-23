import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { colors, spacing, borderRadius } from '../constants/theme';
import { AppText } from './AppText';
import { StemOptTimelineCard } from './StemOptTimelineCard';
import { stemOptBuckets, STEM_OPT_TIMELINE_FIELDS } from '../lib/stemOptTimeline';
import { suggestTags } from '../services/apiService';

// The STEM OPT join/attribute form (features/stem-opt-timeline-9/ Phase 6b —
// mobile parity for the website StemOptAttributeForm). The SAME structured card
// used in PostScreen, adapted to the group form's flat `values` +
// `onChange(key, value)` contract, plus the optional paste-your-timeline
// on-ramp (free text → tag-suggest → prefill). Scope: stem-opt-extension only.

const CANON_KEYS = STEM_OPT_TIMELINE_FIELDS.map((f) => f.key);

type KV = Record<string, string>;

export function StemOptAttributeForm({
  values,
  onChange,
  notes,
  onNotesChange,
}: {
  values: KV;
  onChange: (key: string, value: string) => void;
  notes: string;
  onNotesChange: (v: string) => void;
}) {
  const [paste, setPaste] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [pasteMsg, setPasteMsg] = useState('');

  const { key_dates, key_stages_or_info } = stemOptBuckets(values);

  // The card hands back full next buckets; translate to the per-key onChange
  // the form contract expects (only canonical keys move).
  const applyNext = (nextDates: KV, nextStages: KV) => {
    const next: KV = { ...nextDates, ...nextStages };
    for (const k of CANON_KEYS) {
      const nv = next[k] || '';
      if ((values[k] || '') !== nv) onChange(k, nv);
    }
  };

  const extractFromPaste = async () => {
    const text = paste.trim();
    if (!text) return;
    setExtracting(true);
    setPasteMsg('');
    try {
      const data = await suggestTags('STEM OPT timeline', text);
      const merged: KV = { ...(data.key_dates || {}), ...(data.key_stages_or_info || {}) };
      let filled = 0;
      for (const k of CANON_KEYS) {
        if (merged[k]) {
          onChange(k, String(merged[k]));
          filled += 1;
        }
      }
      setPasteMsg(filled ? `Filled ${filled} field${filled === 1 ? '' : 's'} — review below.` : 'No timeline fields found — enter them below.');
    } catch {
      setPasteMsg('Could not read that timeline — enter the fields below.');
    } finally {
      setExtracting(false);
    }
  };

  return (
    <View style={styles.container}>
      {/* Optional free-text on-ramp — paste a timeline, extract the fields. */}
      <View style={styles.pasteBlock}>
        <AppText variant="caption" color="onSurfaceVariant">Paste your timeline (optional)</AppText>
        <TextInput
          testID="stem-opt-paste"
          style={styles.pasteInput}
          value={paste}
          onChangeText={setPaste}
          placeholder="e.g. Filed I-765 on 2026-03-18, approved 2026-09-17"
          placeholderTextColor={colors.onSurfaceVariant}
          multiline
        />
        <TouchableOpacity
          testID="stem-opt-extract"
          onPress={extractFromPaste}
          disabled={extracting || !paste.trim()}
          style={[styles.extractButton, (extracting || !paste.trim()) && styles.extractButtonDisabled]}
        >
          <AppText variant="labelMd" color="primary">
            {extracting ? 'Reading…' : 'Fill from timeline'}
          </AppText>
        </TouchableOpacity>
        {!!pasteMsg && (
          <AppText variant="caption" color="onSurfaceVariant" testID="stem-opt-paste-msg">
            {pasteMsg}
          </AppText>
        )}
      </View>

      <StemOptTimelineCard keyDates={key_dates} keyStages={key_stages_or_info} onChange={applyNext} />

      <View style={styles.notesBlock}>
        <AppText variant="caption" color="onSurfaceVariant">Notes</AppText>
        <TextInput
          testID="stem-opt-notes"
          style={styles.notesInput}
          value={notes}
          onChangeText={onNotesChange}
          placeholder="Anything else worth sharing with the cohort?"
          placeholderTextColor={colors.onSurfaceVariant}
          multiline
          maxLength={1000}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.sm,
  },
  pasteBlock: {
    gap: spacing.xs,
  },
  pasteInput: {
    minHeight: 56,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.onSurface,
    textAlignVertical: 'top',
  },
  extractButton: {
    alignSelf: 'flex-start',
    paddingVertical: spacing.xs,
  },
  extractButtonDisabled: {
    opacity: 0.5,
  },
  notesBlock: {
    gap: spacing.xs,
  },
  notesInput: {
    minHeight: 56,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.onSurface,
    textAlignVertical: 'top',
  },
});
