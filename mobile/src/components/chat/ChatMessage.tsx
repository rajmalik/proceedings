import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';
import { colors, typography, spacing, borderRadius } from '../../constants/theme';

export interface ChatMessageProps {
  content: string;
  role: 'user' | 'assistant';
  timestamp?: Date;
  isLoading?: boolean;
}

export function ChatMessage({ content, role, timestamp, isLoading }: ChatMessageProps) {
  const isUser = role === 'user';

  if (isLoading) {
    return (
      <Animated.View
        style={[styles.container, styles.assistantContainer]}
        entering={FadeInUp.duration(200)}
      >
        <View style={styles.avatarWrap}>
          <View style={styles.aiAvatar}>
            <Text style={styles.aiAvatarText}>AI</Text>
          </View>
        </View>
        <View style={[styles.bubble, styles.assistantBubble]}>
          <View style={styles.loadingDots}>
            <View style={[styles.dot, styles.dot1]} />
            <View style={[styles.dot, styles.dot2]} />
            <View style={[styles.dot, styles.dot3]} />
          </View>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      style={[styles.container, isUser ? styles.userContainer : styles.assistantContainer]}
      entering={FadeInUp.duration(200)}
    >
      {!isUser && (
        <View style={styles.avatarWrap}>
          <View style={styles.aiAvatar}>
            <Text style={styles.aiAvatarText}>AI</Text>
          </View>
        </View>
      )}
      <View style={styles.messageContent}>
        <View style={[styles.bubble, isUser ? styles.userBubble : styles.assistantBubble]}>
          <Text style={[styles.text, isUser ? styles.userText : styles.assistantText]}>
            {content}
          </Text>
        </View>
        {timestamp && (
          <Text style={[styles.timestamp, isUser ? styles.userTimestamp : styles.assistantTimestamp]}>
            {formatTime(timestamp)}
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    marginVertical: spacing.base,
    paddingHorizontal: spacing.marginMobile,
  },
  userContainer: {
    justifyContent: 'flex-end',
  },
  assistantContainer: {
    justifyContent: 'flex-start',
  },
  avatarWrap: {
    marginRight: spacing.base,
    alignSelf: 'flex-start',
  },
  aiAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  aiAvatarText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.onPrimary,
  },
  messageContent: {
    maxWidth: '75%',
  },
  bubble: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.lg,
  },
  userBubble: {
    // Unified "you" bubble token pair, matching GroupChat/FindScreen (UI_AUDIT §1 —
    // was solid primary+white here vs primaryContainer+dark elsewhere).
    backgroundColor: colors.primaryContainer,
    borderBottomRightRadius: borderRadius.sm,
  },
  assistantBubble: {
    backgroundColor: colors.surfaceContainer,
    borderBottomLeftRadius: borderRadius.sm,
  },
  text: {
    ...typography.bodyMd,
    lineHeight: 22,
  },
  userText: {
    color: colors.onPrimaryContainer,
  },
  assistantText: {
    color: colors.onSurface,
  },
  timestamp: {
    ...typography.caption,
    marginTop: spacing.xs,
    opacity: 0.7,
  },
  userTimestamp: {
    color: colors.onSurfaceVariant,
    textAlign: 'right',
  },
  assistantTimestamp: {
    color: colors.onSurfaceVariant,
    textAlign: 'left',
  },
  loadingDots: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.primary,
    marginHorizontal: 3,
    opacity: 0.4,
  },
  dot1: {
    opacity: 0.4,
  },
  dot2: {
    opacity: 0.6,
  },
  dot3: {
    opacity: 0.9,
  },
});
