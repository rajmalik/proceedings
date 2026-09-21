import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  TouchableWithoutFeedback,
  Alert,
  ActivityIndicator,
  ViewStyle,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius, typography } from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { reportContent, ContentType, ReportReason } from '../services/apiService';

/**
 * The per-content "..." overflow that lets a user REPORT objectionable content
 * and BLOCK an abusive author (App Store Guideline 1.2). Rendered on postings,
 * replies, and group messages. Renders nothing on the viewer's own content.
 *
 * On success it calls `onActioned` so the parent can optimistically remove the
 * item from view ("remove it from the user's feed instantly").
 */

const REASONS: { key: ReportReason; label: string }[] = [
  { key: 'harassment', label: 'Harassment or bullying' },
  { key: 'hate', label: 'Hate speech or slurs' },
  { key: 'violence', label: 'Violence or threats' },
  { key: 'sexual', label: 'Sexual or explicit content' },
  { key: 'spam', label: 'Spam or scam' },
  { key: 'other', label: 'Something else' },
];

export function ContentActionsMenu({
  contentId,
  contentType,
  authorId,
  authorHandle,
  containerId = '',
  isAuthor = false,
  onActioned,
  color = colors.onSurfaceVariant,
  size = 20,
  style,
}: {
  contentId: string;
  contentType: ContentType;
  authorId?: string;
  authorHandle?: string;
  containerId?: string;
  isAuthor?: boolean;
  onActioned?: (action: 'reported' | 'blocked') => void;
  color?: string;
  size?: number;
  style?: ViewStyle;
}) {
  const { user, blockUser } = useAuth();
  const [open, setOpen] = useState(false);
  const [showReasons, setShowReasons] = useState(false);
  const [busy, setBusy] = useState(false);

  // Never let a user report/block their own content. `isAuthor` covers replies /
  // messages (where the backend blanks author_id on your own); the uid compare
  // covers postings (where author_id is present for first-party authors).
  const isOwn = isAuthor || (!!authorId && !!user && user.uid === authorId);
  const canBlock = !!authorId && !isOwn;
  if (isOwn) return null;

  const close = () => {
    setOpen(false);
    setShowReasons(false);
  };

  const submitReport = async (reason: ReportReason) => {
    setBusy(true);
    try {
      const res = await reportContent(contentId, contentType, reason, containerId);
      close();
      onActioned?.('reported');
      Alert.alert(
        'Thanks for reporting',
        res.hidden
          ? 'This content has been hidden and will be reviewed within 24 hours.'
          : 'Our team will review this content within 24 hours and take action if it violates our guidelines.'
      );
    } catch (e) {
      Alert.alert('Could not submit report', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const confirmBlock = () => {
    const who = authorHandle ? `@${authorHandle}` : 'this user';
    close();
    Alert.alert(
      `Block ${who}?`,
      "You won't see their posts, replies, or messages, and they'll be reported to our moderators.",
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block',
          style: 'destructive',
          onPress: async () => {
            if (!authorId) return;
            try {
              await blockUser(authorId);
              onActioned?.('blocked');
              Alert.alert('User blocked', `You will no longer see content from ${who}.`);
            } catch (e) {
              Alert.alert('Could not block user', e instanceof Error ? e.message : 'Please try again.');
            }
          },
        },
      ]
    );
  };

  return (
    <>
      <TouchableOpacity
        onPress={() => setOpen(true)}
        style={[styles.trigger, style]}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        accessibilityLabel="More actions"
      >
        <Ionicons name="ellipsis-horizontal" size={size} color={color} />
      </TouchableOpacity>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <TouchableWithoutFeedback onPress={close}>
          <View style={styles.overlay}>
            <TouchableWithoutFeedback>
              <View style={styles.sheet}>
                {!showReasons ? (
                  <>
                    <Text style={styles.sheetTitle}>
                      {contentType === 'message' ? 'Message' : contentType === 'reply' ? 'Reply' : 'Posting'}
                    </Text>
                    <TouchableOpacity style={styles.row} onPress={() => setShowReasons(true)}>
                      <Ionicons name="flag-outline" size={20} color={colors.onSurface} />
                      <Text style={styles.rowText}>Report content</Text>
                    </TouchableOpacity>
                    {canBlock ? (
                      <TouchableOpacity style={styles.row} onPress={confirmBlock}>
                        <Ionicons name="ban-outline" size={20} color={colors.error} />
                        <Text style={[styles.rowText, { color: colors.error }]}>
                          Block {authorHandle ? `@${authorHandle}` : 'user'}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                    <TouchableOpacity style={[styles.row, styles.cancelRow]} onPress={close}>
                      <Text style={styles.cancelText}>Cancel</Text>
                    </TouchableOpacity>
                  </>
                ) : (
                  <>
                    <Text style={styles.sheetTitle}>Why are you reporting this?</Text>
                    {busy ? (
                      <ActivityIndicator color={colors.primary} style={{ paddingVertical: spacing.md }} />
                    ) : (
                      REASONS.map((r) => (
                        <TouchableOpacity key={r.key} style={styles.row} onPress={() => submitReport(r.key)}>
                          <Text style={styles.rowText}>{r.label}</Text>
                        </TouchableOpacity>
                      ))
                    )}
                    <TouchableOpacity
                      style={[styles.row, styles.cancelRow]}
                      onPress={() => setShowReasons(false)}
                      disabled={busy}
                    >
                      <Text style={styles.cancelText}>Back</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  trigger: {
    padding: 4,
  },
  overlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    paddingHorizontal: spacing.base,
    paddingTop: spacing.base,
    paddingBottom: spacing.xl,
  },
  sheetTitle: {
    fontSize: typography.caption.fontSize,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    color: colors.onSurfaceVariant,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.xs,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 16,
    paddingHorizontal: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.outlineVariant,
  },
  rowText: {
    fontSize: 16,
    color: colors.onSurface,
  },
  cancelRow: {
    justifyContent: 'center',
    borderBottomWidth: 0,
    marginTop: spacing.xs,
  },
  cancelText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.onSurfaceVariant,
  },
});

export default ContentActionsMenu;
