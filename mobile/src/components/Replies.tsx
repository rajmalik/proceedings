import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { View, StyleSheet, TextInput, TouchableOpacity, FlatList, Alert } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from './AppText';
import { ReplyItem, ReplyCardData } from './ReplyItem';
import { Skeleton } from './Skeleton';
import { colors, spacing, borderRadius, typography } from '../constants/theme';
import { getReplies, postReply, deleteReply, getActiveUserId } from '../services/apiService';
import { useAuth } from '../contexts/AuthContext';
import { flattenReplyTree, visibleRows, FlatReplyRow } from '../utils/replyTree';

type Tally = { up: number; down: number; score: number; your_vote: number };

interface RepliesProps {
  postingId: string;
  onPostingTally?: (tally: Tally) => void;
}

export function Replies({ postingId, onPostingTally }: RepliesProps) {
  const [replies, setReplies] = useState<ReplyCardData[]>([]);
  const [sort, setSort] = useState<'top' | 'new'>('new');
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  // Nesting UI state (local only, not persisted — reopening starts expanded).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [replySubmitting, setReplySubmitting] = useState(false);
  const hasUser = !!getActiveUserId();
  const { isBlocked } = useAuth();

  const loadReplies = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getReplies(postingId, sort);
      // Hide replies from blocked authors instantly (server also filters on load).
      setReplies((data.replies || []).filter((r) => !isBlocked(r.author_id)));
      if (data.posting) {
        onPostingTally?.(data.posting);
      }
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load replies');
    } finally {
      setLoading(false);
    }
  }, [postingId, sort, onPostingTally, isBlocked]);

  useEffect(() => {
    loadReplies();
  }, [loadReplies]);

  // Flatten the threaded hierarchy into a single display list for the FlatList,
  // then drop rows hidden under a collapsed ancestor.
  const rows = useMemo(() => flattenReplyTree(replies, sort), [replies, sort]);
  const shown = useMemo(() => visibleRows(rows, collapsed), [rows, collapsed]);

  const handleSubmit = async () => {
    const body = text.trim();
    if (!body || submitting) return;

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    setSubmitting(true);
    setError('');
    try {
      const newReply = await postReply(postingId, body);
      setText('');
      setReplies((prev) => [newReply, ...prev]);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not post reply');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleCollapse = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleStartReply = useCallback((id: string) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setReplyText('');
    setReplyingTo(id);
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyingTo(null);
    setReplyText('');
  }, []);

  const handleSubmitReply = useCallback(
    async (parentReplyId: string) => {
      const body = replyText.trim();
      if (!body || replySubmitting) return;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
      setReplySubmitting(true);
      try {
        const newReply = await postReply(postingId, body, parentReplyId);
        setReplies((prev) => [...prev, newReply]);
        // Make sure the new child is visible: expand its parent, close composer.
        setCollapsed((prev) => {
          if (!prev.has(parentReplyId)) return prev;
          const next = new Set(prev);
          next.delete(parentReplyId);
          return next;
        });
        setReplyText('');
        setReplyingTo(null);
      } catch (e) {
        Alert.alert('Reply failed', e instanceof Error ? e.message : 'Could not post reply');
      } finally {
        setReplySubmitting(false);
      }
    },
    [postingId, replyText, replySubmitting],
  );

  const handleDelete = async (id: string) => {
    const prevReplies = replies;
    setReplies((cur) => cur.filter((r) => r.id !== id));
    try {
      await deleteReply(postingId, id);
    } catch (e) {
      setReplies(prevReplies);
      Alert.alert('Error', e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const handleHide = (id: string) => {
    setReplies((cur) => cur.filter((r) => r.id !== id));
  };

  const renderReply = ({ item, index }: { item: FlatReplyRow; index: number }) => (
    <Animated.View entering={index < 6 ? FadeInDown.springify().delay(index * 40) : undefined}>
      <ReplyItem
        reply={item.reply}
        depth={item.depth}
        descendantCount={item.descendantCount}
        hasChildren={item.hasChildren}
        collapsed={collapsed.has(item.reply.id)}
        onToggleCollapse={handleToggleCollapse}
        canReply={hasUser}
        isReplying={replyingTo === item.reply.id}
        replyText={replyText}
        replySubmitting={replySubmitting}
        onStartReply={handleStartReply}
        onChangeReplyText={setReplyText}
        onSubmitReply={handleSubmitReply}
        onCancelReply={handleCancelReply}
        onDelete={handleDelete}
        onHide={handleHide}
      />
    </Animated.View>
  );

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Ionicons name="chatbubbles-outline" size={20} color={colors.secondary} />
          <AppText variant="headlineMd">
            Replies <AppText variant="headlineMd" color="onSurfaceVariant">({replies.length})</AppText>
          </AppText>
        </View>
        <View style={styles.sortButtons}>
          <TouchableOpacity
            onPress={() => setSort('top')}
            style={[styles.sortButton, sort === 'top' && styles.sortButtonActive]}
          >
            <AppText variant="caption" color={sort === 'top' ? 'onPrimaryContainer' : 'onSurfaceVariant'}>Top</AppText>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => setSort('new')}
            style={[styles.sortButton, sort === 'new' && styles.sortButtonActive]}
          >
            <AppText variant="caption" color={sort === 'new' ? 'onPrimaryContainer' : 'onSurfaceVariant'}>New</AppText>
          </TouchableOpacity>
        </View>
      </View>

      {/* Composer */}
      {hasUser ? (
        <View style={styles.composer}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Share your experience or ask a question…"
            placeholderTextColor={colors.onSurfaceVariant}
            multiline
            maxLength={5000}
            style={styles.input}
          />
          <View style={styles.composerFooter}>
            <AppText variant="caption" color="onSurfaceVariant">{text.length}/5000</AppText>
            <TouchableOpacity
              onPress={handleSubmit}
              disabled={!text.trim() || submitting}
              style={[styles.submitButton, (!text.trim() || submitting) && styles.submitDisabled]}
            >
              <AppText variant="caption" color="onPrimary">{submitting ? 'Posting…' : 'Post reply'}</AppText>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.noUserCard}>
          <AppText variant="bodySm" color="onSurfaceVariant">
            Select a user in onboarding to reply and vote.
          </AppText>
        </View>
      )}

      {/* Error */}
      {error ? <AppText variant="bodySm" color="error" style={styles.error}>{error}</AppText> : null}

      {/* Replies list */}
      {loading ? (
        <View style={styles.loader}>
          <Skeleton.Card count={2} />
        </View>
      ) : shown.length === 0 ? (
        <AppText variant="bodySm" color="onSurfaceVariant" style={styles.emptyText}>
          No replies yet - be the first to share.
        </AppText>
      ) : (
        <FlatList
          data={shown}
          renderItem={renderReply}
          keyExtractor={(item) => item.reply.id}
          contentContainerStyle={styles.list}
          scrollEnabled={false}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginTop: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sortButtons: {
    flexDirection: 'row',
    gap: 4,
  },
  sortButton: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceContainerHigh,
  },
  sortButtonActive: {
    backgroundColor: colors.primaryContainer,
  },
  composer: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  input: {
    ...typography.bodySm,
    color: colors.onSurface,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  composerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.base,
  },
  submitButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: borderRadius.default,
  },
  submitDisabled: {
    opacity: 0.5,
  },
  noUserCard: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  error: {
    marginBottom: spacing.sm,
  },
  loader: {
    marginVertical: spacing.md,
  },
  emptyText: {
    marginTop: spacing.sm,
  },
  list: {
    gap: spacing.sm,
  },
});

export default Replies;
