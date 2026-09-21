import React, { useMemo, useState } from 'react';
import { View, StyleSheet } from 'react-native';
import { spacing } from '../constants/theme';
import { Input } from './Input';
import { FilterChip } from './FilterChip';

interface TagPickerProps {
  placeholder: string;
  options: string[]; // already-resolved, displayable label list to filter
  onPick: (value: string) => void;
  maxSuggestions?: number;
}

// A type-to-filter picker over an already-fetched controlled-vocabulary list
// — no autocomplete/datalist-equivalent existed anywhere on mobile before
// this (Find Groups has no manual-add UI for visa/consulate/tags at all).
// Purely client-side filtering, no network calls: every tappable suggestion
// is by construction a member of `options`, so there's no "invalid entry"
// path to handle here (unlike the website's free-typed <input>+Enter).
export function TagPicker({ placeholder, options, onPick, maxSuggestions = 8 }: TagPickerProps) {
  const [text, setText] = useState('');
  const matches = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!q) return [];
    return options.filter((o) => o.toLowerCase().includes(q)).slice(0, maxSuggestions);
  }, [text, options, maxSuggestions]);

  return (
    <View>
      <Input value={text} onChangeText={setText} placeholder={placeholder} autoCapitalize="none" autoCorrect={false} />
      {matches.length > 0 && (
        <View style={styles.suggestionsRow}>
          {matches.map((m) => (
            <FilterChip key={m} label={m} onPress={() => { onPick(m); setText(''); }} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  suggestionsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.sm,
  },
});

export default TagPicker;
