import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  FlatList,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  AppState,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius } from '../constants/theme';
import { ContentActionsMenu } from './ContentActionsMenu';
import { useAuth } from '../contexts/AuthContext';
import {
  getGroupMessages,
  sendGroupMessage,
  deleteGroupMessage,
  getActiveUserId,
  joinGroup,
} from '../services/apiService';

export type ChatMessage = {
  id: string;
  author_handle: string;
  author_id?: string;
  text: string;
  created_at: string;
  deleted: boolean;
  is_author: boolean;
};

interface GroupChatProps {
  groupId: string;
}

function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(t).toLocaleDateString();
}

const POLL_MS = 1500;

export function GroupChat({ groupId }: GroupChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [denied, setDenied] = useState(false);
  const [joining, setJoining] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const sinceRef = useRef<string>('');
  const hasUser = !!getActiveUserId();
  const { isBlocked } = useAuth();

  // Merge messages with deduplication (dropping blocked authors instantly).
  const merge = useCallback((incoming: ChatMessage[], advance: boolean) => {
    incoming = incoming.filter((m) => !isBlocked(m.author_id));
    if (incoming.length === 0) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      return [...prev, ...incoming.filter((m) => !seen.has(m.id))];
    });
    if (advance && incoming.length > 0) {
      const last = incoming[incoming.length - 1];
      if (last.created_at > sinceRef.current) {
        sinceRef.current = last.created_at;
      }
    }
  }, [isBlocked]);

  // Load initial messages
  const loadInitial = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getGroupMessages(groupId);
      if (data.denied) {
        setDenied(true);
        return;
      }
      const all = data.messages || [];
      // Advance the poll cursor past ALL messages (even blocked ones), but only
      // render non-blocked authors' messages.
      sinceRef.current = all.length ? all[all.length - 1].created_at : '';
      setMessages(all.filter((m) => !isBlocked(m.author_id)));
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load messages');
    } finally {
      setLoading(false);
    }
  }, [groupId, isBlocked]);

  // Poll for new messages
  const poll = useCallback(async () => {
    try {
      const since = sinceRef.current;
      const data = await getGroupMessages(groupId, since);
      merge(data.messages || [], true);
    } catch {
      // Transient error, next tick retries
    }
  }, [groupId, merge]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // Pause polling while the app is backgrounded (website parity: it skips the
  // poll on `document.hidden`). On returning to the foreground, poll once
  // immediately so the user sees new messages without waiting a full interval.
  const appActiveRef = useRef(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      const active = state === 'active';
      const wasActive = appActiveRef.current;
      appActiveRef.current = active;
      if (active && !wasActive && !denied) poll();
    });
    return () => sub.remove();
  }, [poll, denied]);

  useEffect(() => {
    const id = setInterval(() => {
      if (!denied && appActiveRef.current) poll();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [poll, denied]);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  const handleSend = async () => {
    const t = text.trim();
    if (!t || sending) return;

    setSending(true);
    setError('');
    try {
      const newMsg = await sendGroupMessage(groupId, t);
      setText('');
      merge([newMsg], false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send');
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async (id: string) => {
    const prev = messages;
    setMessages((cur) =>
      cur.map((m) => (m.id === id ? { ...m, deleted: true, text: '' } : m))
    );
    try {
      await deleteGroupMessage(groupId, id);
    } catch (e) {
      setMessages(prev);
      Alert.alert('Error', e instanceof Error ? e.message : 'Delete failed');
    }
  };

  const handleHide = (id: string) => {
    setMessages((cur) => cur.filter((m) => m.id !== id));
  };

  const renderMessage = ({ item }: { item: ChatMessage }) => {
    if (item.is_author) {
      // User's own message (right side)
      return (
        <View style={styles.ownMessageRow}>
          <View style={styles.ownMessageBubble}>
            {item.deleted ? (
              <Text style={styles.deletedText}>message deleted</Text>
            ) : (
              <Text style={styles.ownMessageText}>{item.text}</Text>
            )}
          </View>
          <View style={styles.ownMessageMeta}>
            <Text style={styles.metaTime}>{timeAgo(item.created_at)}</Text>
            {!item.deleted && (
              <TouchableOpacity onPress={() => handleDelete(item.id)}>
                <Ionicons name="trash-outline" size={14} color={colors.onSurfaceVariant} />
              </TouchableOpacity>
            )}
          </View>
        </View>
      );
    }

    // Other user's message (left side)
    return (
      <View style={styles.otherMessageRow}>
        <View style={styles.otherAuthorRow}>
          <Text style={styles.otherAuthor}>
            {item.author_handle} · {timeAgo(item.created_at)}
          </Text>
          {!item.deleted && (
            <ContentActionsMenu
              contentId={item.id}
              contentType="message"
              containerId={groupId}
              authorId={item.author_id}
              authorHandle={item.author_handle}
              isAuthor={item.is_author}
              onActioned={() => handleHide(item.id)}
              size={14}
            />
          )}
        </View>
        <View style={styles.otherMessageBubble}>
          {item.deleted ? (
            <Text style={styles.deletedText}>message deleted</Text>
          ) : (
            <Text style={styles.otherMessageText}>{item.text}</Text>
          )}
        </View>
      </View>
    );
  };

  if (!hasUser) {
    return (
      <View style={styles.noUserCard}>
        <Text style={styles.noUserText}>
          Select a user in onboarding to open this chat.
        </Text>
      </View>
    );
  }

  const handleJoinGroup = async () => {
    setJoining(true);
    setError('');
    try {
      await joinGroup(groupId);
      setDenied(false);
      loadInitial();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not join group');
    } finally {
      setJoining(false);
    }
  };

  if (denied) {
    return (
      <View style={styles.deniedContainer}>
        <Ionicons name="lock-closed-outline" size={48} color={colors.onSurfaceVariant} />
        <Text style={styles.deniedTitle}>Members Only</Text>
        <Text style={styles.deniedText}>
          You're not a member of this group yet.
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <TouchableOpacity
          style={[styles.joinButton, joining && styles.joinButtonDisabled]}
          onPress={handleJoinGroup}
          disabled={joining}
        >
          {joining ? (
            <ActivityIndicator size="small" color={colors.onPrimary} />
          ) : (
            <Text style={styles.joinButtonText}>Join Group</Text>
          )}
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={100}
    >
      {loading ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading messages…</Text>
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={messages}
          renderItem={renderMessage}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messageList}
          ListEmptyComponent={
            <Text style={styles.emptyText}>
              No messages yet - say hello to your group.
            </Text>
          }
        />
      )}

      {error ? <Text style={styles.error}>{error}</Text> : null}

      <View style={styles.inputRow}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder="Message your group…"
          placeholderTextColor={colors.onSurfaceVariant}
          maxLength={4000}
          style={styles.input}
        />
        <TouchableOpacity
          onPress={handleSend}
          disabled={!text.trim() || sending}
          style={[styles.sendButton, (!text.trim() || sending) && styles.sendDisabled]}
        >
          <Text style={styles.sendText}>{sending ? '…' : 'Send'}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surfaceContainerLow,
    borderRadius: borderRadius.xl,
    padding: spacing.sm,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.sm,
  },
  loadingText: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
  },
  messageList: {
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  emptyText: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
  ownMessageRow: {
    alignItems: 'flex-end',
  },
  ownMessageBubble: {
    backgroundColor: colors.primaryContainer,
    borderRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
    maxWidth: '85%',
  },
  ownMessageText: {
    fontSize: 14,
    color: colors.onPrimaryContainer,
    lineHeight: 20,
  },
  ownMessageMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  otherMessageRow: {
    alignItems: 'flex-start',
    maxWidth: '90%',
  },
  otherAuthorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 2,
  },
  otherAuthor: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
  },
  otherMessageBubble: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: borderRadius.lg,
    borderTopLeftRadius: borderRadius.sm,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  otherMessageText: {
    fontSize: 14,
    color: colors.onSurface,
    lineHeight: 20,
  },
  deletedText: {
    fontSize: 14,
    fontStyle: 'italic',
    color: colors.onSurfaceVariant,
    opacity: 0.7,
  },
  metaTime: {
    fontSize: 11,
    color: colors.onSurfaceVariant,
  },
  error: {
    fontSize: 14,
    color: colors.error,
    marginVertical: spacing.base,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
    marginTop: spacing.sm,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.full,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 14,
    color: colors.onSurface,
  },
  sendButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: borderRadius.full,
  },
  sendDisabled: {
    opacity: 0.4,
  },
  sendText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onPrimary,
  },
  noUserCard: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
  },
  noUserText: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
  },
  deniedContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    backgroundColor: colors.surfaceContainerLow,
    borderRadius: borderRadius.xl,
  },
  deniedTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.onSurface,
    marginTop: spacing.md,
  },
  deniedText: {
    fontSize: 15,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    marginTop: spacing.base,
    marginBottom: spacing.lg,
  },
  joinButton: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: borderRadius.full,
    minWidth: 120,
    alignItems: 'center',
  },
  joinButtonDisabled: {
    opacity: 0.7,
  },
  joinButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.onPrimary,
  },
});

export default GroupChat;
