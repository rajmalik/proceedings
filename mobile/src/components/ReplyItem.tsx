import React from 'react';
import { View, StyleSheet, TouchableOpacity, TextInput, Alert } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AppText } from './AppText';
import { VoteControl } from './VoteControl';
import { ContentActionsMenu } from './ContentActionsMenu';
import { colors, spacing, borderRadius, typography } from '../constants/theme';

export type ReplyCardData = {
  id: string;
  parent_case_id: string;
  parent_reply_id?: string; // empty/absent = top-level; else the reply this answers
  body: string;
  author_handle: string;
  author_id?: string;
  created_at: string;
  deleted: boolean;
  up: number;
  down: number;
  score: number;
  your_vote: number;
  is_author: boolean;
};

// Visual nesting: indent one step per level, capped so the text column stays
// readable on narrow screens (deeper replies attach logically but stop
// indenting past the cap — see UI-SPEC §2). Each level draws a thin thread line.
export const INDENT_STEP = 12;
export const VISUAL_DEPTH_CAP = 6;

interface ReplyItemProps {
  reply: ReplyCardData;
  depth: number;
  descendantCount: number;
  hasChildren: boolean;
  collapsed: boolean;
  onToggleCollapse: (id: string) => void;
  canReply: boolean;
  isReplying: boolean;
  replyText: string;
  replySubmitting: boolean;
  onStartReply: (id: string) => void;
  onChangeReplyText: (text: string) => void;
  onSubmitReply: (parentReplyId: string) => void;
  onCancelReply: () => void;
  onDelete?: (id: string) => void;
  // Called after the viewer reports or blocks — the parent removes it from view.
  onHide?: (id: string) => void;
}

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

export function ReplyItem({
  reply,
  depth,
  descendantCount,
  hasChildren,
  collapsed,
  onToggleCollapse,
  canReply,
  isReplying,
  replyText,
  replySubmitting,
  onStartReply,
  onChangeReplyText,
  onSubmitReply,
  onCancelReply,
  onDelete,
  onHide,
}: ReplyItemProps) {
  const handleDelete = () => {
    Alert.alert('Delete Reply', 'Are you sure you want to delete this reply?', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => onDelete?.(reply.id) },
    ]);
  };

  const indentLevel = Math.min(depth, VISUAL_DEPTH_CAP);
  // Depth 0 keeps today's reply body size; nested replies drop one step (UI-SPEC §3).
  const bodyVariant = depth === 0 ? 'bodySm' : 'caption';
  const countLabel = `${descendantCount} ${descendantCount === 1 ? 'reply' : 'replies'}`;

  return (
    <View style={styles.row}>
      {/* Thread-line indent guides, one per nesting level */}
      {Array.from({ length: indentLevel }).map((_, i) => (
        <View key={i} style={styles.guide} />
      ))}

      <View style={styles.card}>
        {reply.deleted ? (
          // Tombstone: a deleted reply kept because it still has live descendants.
          <View style={styles.tombstoneRow}>
            {hasChildren && (
              <TouchableOpacity
                onPress={() => onToggleCollapse(reply.id)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={collapsed ? 'Expand thread' : 'Collapse thread'}
              >
                <Ionicons
                  name={collapsed ? 'chevron-forward' : 'chevron-down'}
                  size={16}
                  color={colors.onSurfaceVariant}
                />
              </TouchableOpacity>
            )}
            <AppText variant="caption" color="onSurfaceVariant" style={styles.deletedText}>
              [deleted]
            </AppText>
            {collapsed && hasChildren && (
              <TouchableOpacity onPress={() => onToggleCollapse(reply.id)}>
                <AppText variant="caption" color="primary">{`+ ${countLabel}`}</AppText>
              </TouchableOpacity>
            )}
          </View>
        ) : (
          <View style={styles.body}>
            <View style={styles.voteColumn}>
              <VoteControl contentId={reply.id} score={reply.score} yourVote={reply.your_vote} />
            </View>

            <View style={styles.content}>
              <View style={styles.header}>
                {hasChildren && (
                  <TouchableOpacity
                    onPress={() => onToggleCollapse(reply.id)}
                    hitSlop={{ top: 8, bottom: 8, left: 4, right: 4 }}
                    accessibilityLabel={collapsed ? 'Expand thread' : 'Collapse thread'}
                  >
                    <Ionicons
                      name={collapsed ? 'chevron-forward' : 'chevron-down'}
                      size={16}
                      color={colors.onSurfaceVariant}
                    />
                  </TouchableOpacity>
                )}
                <AppText variant="labelMd">{reply.author_handle}</AppText>
                <AppText variant="caption" color="onSurfaceVariant">·</AppText>
                <AppText variant="caption" color="onSurfaceVariant">{timeAgo(reply.created_at)}</AppText>
                {reply.is_author ? (
                  <TouchableOpacity onPress={handleDelete} style={styles.trailingAction}>
                    <Ionicons name="trash-outline" size={16} color={colors.onSurfaceVariant} />
                  </TouchableOpacity>
                ) : (
                  <ContentActionsMenu
                    contentId={reply.id}
                    contentType="reply"
                    authorId={reply.author_id}
                    authorHandle={reply.author_handle}
                    isAuthor={reply.is_author}
                    onActioned={() => onHide?.(reply.id)}
                    size={16}
                    style={styles.trailingAction}
                  />
                )}
              </View>

              {collapsed ? (
                <TouchableOpacity onPress={() => onToggleCollapse(reply.id)} style={styles.collapsedSummary}>
                  <AppText variant="caption" color="primary">{`+ ${countLabel}`}</AppText>
                </TouchableOpacity>
              ) : (
                <>
                  <AppText variant={bodyVariant} color="onSurface">{reply.body}</AppText>

                  {canReply && (
                    <View style={styles.actions}>
                      <TouchableOpacity
                        onPress={() => onStartReply(reply.id)}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                      >
                        <AppText variant="caption" color="onSurfaceVariant">Reply</AppText>
                      </TouchableOpacity>
                    </View>
                  )}

                  {isReplying && (
                    <View style={styles.composer}>
                      <TextInput
                        value={replyText}
                        onChangeText={onChangeReplyText}
                        placeholder={`Reply to ${reply.author_handle}…`}
                        placeholderTextColor={colors.onSurfaceVariant}
                        multiline
                        autoFocus
                        maxLength={5000}
                        style={styles.composerInput}
                      />
                      <View style={styles.composerFooter}>
                        <TouchableOpacity onPress={onCancelReply} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                          <AppText variant="caption" color="onSurfaceVariant">Cancel</AppText>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => onSubmitReply(reply.id)}
                          disabled={!replyText.trim() || replySubmitting}
                          style={[
                            styles.composerSubmit,
                            (!replyText.trim() || replySubmitting) && styles.composerSubmitDisabled,
                          ]}
                        >
                          <AppText variant="caption" color="onPrimary">
                            {replySubmitting ? 'Posting…' : 'Reply'}
                          </AppText>
                        </TouchableOpacity>
                      </View>
                    </View>
                  )}
                </>
              )}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  guide: {
    width: INDENT_STEP,
    borderLeftWidth: 1.5,
    borderLeftColor: colors.outlineVariant,
  },
  card: {
    flex: 1,
    minWidth: 0,
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
  },
  body: {
    flexDirection: 'row',
    gap: spacing.sm,
  },
  voteColumn: {
    paddingTop: 2,
  },
  content: {
    flex: 1,
    minWidth: 0,
    gap: 4,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  trailingAction: {
    marginLeft: 'auto',
    padding: 4,
  },
  collapsedSummary: {
    paddingVertical: 2,
  },
  tombstoneRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  deletedText: {
    fontStyle: 'italic',
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: 2,
  },
  composer: {
    marginTop: spacing.sm,
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.default,
    padding: spacing.sm,
  },
  composerInput: {
    ...typography.bodySm,
    color: colors.onSurface,
    minHeight: 44,
    textAlignVertical: 'top',
  },
  composerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: spacing.md,
    marginTop: spacing.base,
  },
  composerSubmit: {
    backgroundColor: colors.primary,
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: borderRadius.default,
  },
  composerSubmitDisabled: {
    opacity: 0.5,
  },
});

export default ReplyItem;
