import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Card } from './Card';
import { AnimatedPressable } from './AnimatedPressable';
import { ContentActionsMenu } from './ContentActionsMenu';
import { AppText } from './AppText';
import { colors, spacing, borderRadius, typography } from '../constants/theme';
import { getOutcomeBadgeStyle } from '../utils/outcome';

export type PostingCardData = {
  case_id: string;
  title: string;
  description: string;
  visa: string[];
  consulates: string[];
  outcome: string;
  subreddit: string;
  channel: string;
  tags: string[];
  url: string;
  date: string;
  timestamp?: string; // full ingestion timestamp (for relative "X ago")
};

interface PostingCardProps {
  posting: PostingCardData;
  onPress?: () => void;
  // When provided, a "..." overflow appears on the card so users can report the
  // posting or block its author without opening the detail view (App Store 1.2).
  authorId?: string;
  authorHandle?: string;
  onActioned?: (action: 'reported' | 'blocked') => void;
}

// Relative "X ago" for data-freshness (mirrors ReplyItem/GroupChat).
function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

export function PostingCard({ posting, onPress, authorId, authorHandle, onActioned }: PostingCardProps) {
  const outcomeStyle = posting.outcome ? getOutcomeBadgeStyle(posting.outcome) : null;

  return (
    <AnimatedPressable onPress={onPress} scaleTo={0.97} haptics="light">
      <Card style={styles.card}>
        {/* Report/block overflow — rendered on top-right; no-ops on own content. */}
        {onActioned ? (
          <ContentActionsMenu
            contentId={posting.case_id}
            contentType="posting"
            authorId={authorId}
            authorHandle={authorHandle}
            onActioned={onActioned}
            style={styles.overflow}
          />
        ) : null}

        {/* Badges row */}
        <View style={[styles.badgesRow, onActioned && styles.badgesRowWithOverflow]}>
          {posting.tags.includes('news-update') && (
            <View style={[styles.badge, styles.accentBadge]}>
              <AppText variant="overline" color="onAccentContainer">News</AppText>
            </View>
          )}
          {posting.tags.includes('discussion') && (
            <View style={[styles.badge, styles.accentBadge]}>
              <AppText variant="overline" color="onAccentContainer">Discussion</AppText>
            </View>
          )}
          {posting.tags.includes('blog') && (
            <View style={[styles.badge, styles.accentBadge]}>
              <AppText variant="overline" color="onAccentContainer">Blog</AppText>
            </View>
          )}
          {posting.outcome && (
            <View style={[styles.badge, { backgroundColor: outcomeStyle?.backgroundColor }]}>
              <Text style={[styles.badgeText, { color: outcomeStyle?.color }]}>
                {posting.outcome}
              </Text>
            </View>
          )}
          {posting.visa.slice(0, 2).map((v) => (
            <View key={v} style={[styles.badge, styles.primaryBadge]}>
              <Text style={[styles.badgeText, styles.primaryBadgeText]}>{v}</Text>
            </View>
          ))}
          {/* Fallback: if there's no visa/status to show, surface the first
              general tag instead — every card should carry at least one
              relevant tag badge (features/ui-changes-1/changes-2-.md item 2). */}
          {posting.visa.length === 0 && posting.tags.filter((t) => !['news-update', 'discussion', 'blog'].includes(t))[0] && (
            <View style={[styles.badge, styles.primaryBadge]}>
              <AppText variant="overline" color="onPrimaryContainer">
                {posting.tags.filter((t) => !['news-update', 'discussion', 'blog'].includes(t))[0]}
              </AppText>
            </View>
          )}
          {posting.consulates.slice(0, 2).map((c) => (
            <View key={c} style={[styles.badge, styles.locationBadge]}>
              <Ionicons name="location-outline" size={12} color={colors.onSurfaceVariant} />
              <Text style={[styles.badgeText, styles.locationBadgeText]}>{c}</Text>
            </View>
          ))}
        </View>

        {/* Title */}
        <Text style={styles.title} numberOfLines={2}>
          {posting.title}
        </Text>

        {/* Description */}
        {posting.description ? (
          <Text style={styles.description} numberOfLines={2}>
            {posting.description}
          </Text>
        ) : null}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.source}>
            {posting.subreddit ? `r/${posting.subreddit}` : posting.channel} ·{' '}
            {timeAgo(posting.timestamp || posting.date) || posting.date}
          </Text>
          <View style={styles.viewMore}>
            <Text style={styles.viewMoreText}>View experience</Text>
            <Ionicons name="arrow-forward" size={14} color={colors.primary} />
          </View>
        </View>
      </Card>
    </AnimatedPressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: spacing.sm,
  },
  overflow: {
    position: 'absolute',
    top: 4,
    right: 4,
    zIndex: 2,
  },
  badgesRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: spacing.base,
  },
  badgesRowWithOverflow: {
    paddingRight: 28, // leave room for the "..." overflow
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: borderRadius.full,
    gap: 4,
  },
  badgeText: {
    fontFamily: 'NunitoSans_600SemiBold',
    fontSize: 11,
  },
  primaryBadge: {
    backgroundColor: colors.primaryContainer,
  },
  primaryBadgeText: {
    color: colors.onPrimaryContainer,
  },
  accentBadge: {
    backgroundColor: colors.accentContainer,
  },
  locationBadge: {
    backgroundColor: colors.surfaceContainerHigh,
  },
  locationBadgeText: {
    color: colors.onSurfaceVariant,
  },
  title: {
    ...typography.titleMd,
    color: colors.onSurface,
    marginBottom: spacing.base,
  },
  description: {
    fontFamily: 'NunitoSans_400Regular',
    fontSize: 14,
    color: colors.onSurfaceVariant,
    lineHeight: 20,
    marginBottom: spacing.sm,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.outlineVariant,
  },
  source: {
    ...typography.caption,
    color: colors.onSurfaceVariant,
  },
  viewMore: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  viewMoreText: {
    fontFamily: 'NunitoSans_600SemiBold',
    fontSize: 12,
    color: colors.primary,
  },
});

export default PostingCard;
