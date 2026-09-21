import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AnimatedPressable } from './AnimatedPressable';
import { colors, spacing, borderRadius } from '../constants/theme';

export type MatchData = {
  user_id: string;
  username: string;
  score: number;
  shared: string[];
  summary: string;
  background?: string;
};

interface MatchCardProps {
  match: MatchData;
  checked: boolean;
  onToggle: (userId: string) => void;
}

export function MatchCard({ match, checked, onToggle }: MatchCardProps) {
  return (
    <AnimatedPressable
      onPress={() => onToggle(match.user_id)}
      scaleTo={0.97}
      haptics="medium"
      accessibilityLabel={`Include ${match.username}`}
      style={[
        styles.container,
        checked ? styles.containerChecked : styles.containerUnchecked,
      ]}
    >
      <View style={styles.checkbox}>
        {checked ? (
          <Ionicons name="checkbox" size={22} color={colors.primary} />
        ) : (
          <Ionicons name="square-outline" size={22} color={colors.outline} />
        )}
      </View>
      <View style={styles.content}>
        <View style={styles.header}>
          <Text style={styles.username}>{match.username}</Text>
          <Text style={styles.score}>match {match.score}</Text>
        </View>
        {match.summary ? (
          <Text style={styles.summary}>{match.summary}</Text>
        ) : null}
        {match.background ? (
          <Text style={styles.background} numberOfLines={3}>
            {match.background}
          </Text>
        ) : null}
        <View style={styles.sharedTags}>
          {match.shared.map((tag) => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      </View>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  containerChecked: {
    borderColor: colors.primary,
    backgroundColor: colors.primaryFixed + '40',
  },
  containerUnchecked: {
    borderColor: colors.outlineVariant,
    backgroundColor: colors.surfaceContainerLowest,
  },
  checkbox: {
    marginTop: 2,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.base,
  },
  username: {
    fontFamily: 'NunitoSans_700Bold',
    fontSize: 14,
    color: colors.onSurface,
  },
  score: {
    fontFamily: 'NunitoSans_400Regular',
    fontSize: 12,
    color: colors.onSurfaceVariant,
  },
  summary: {
    fontFamily: 'NunitoSans_600SemiBold',
    fontSize: 12,
    color: colors.onSurfaceVariant,
    marginTop: 2,
  },
  background: {
    fontFamily: 'NunitoSans_400Regular',
    fontSize: 12,
    color: colors.onSurfaceVariant,
    marginTop: 4,
    marginBottom: 8,
    lineHeight: 16,
  },
  sharedTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  tag: {
    backgroundColor: colors.secondaryContainer + '80',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: borderRadius.full,
  },
  tagText: {
    fontSize: 11,
    color: colors.secondary,
  },
});

export default MatchCard;
