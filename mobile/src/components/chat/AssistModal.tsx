import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  FlatList,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
  Linking,
} from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  interpolate,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { colors, typography, spacing, borderRadius, shadows } from '../../constants/theme';
import { ChatMessage } from './ChatMessage';
import { ChatInput } from './ChatInput';
import { AnimatedPressable } from '../AnimatedPressable';
import Markdown from '../Markdown';
import {
  assistTurn,
  getAssistSessionId,
  AssistResponse,
  AssistCommunityCard,
  AssistCitation,
} from '../../services/apiService';
import { AIConsentError } from '../../services/aiConsent';
import { navigateNested } from '../../navigation/navigationRef';

const CONVO_KEY = 'assistConversation.v1';
const DISCLAIMER = 'This is general information about U.S. immigration, not legal advice.';

let _seq = 0;
const _id = (p: string) => `${p}-${Date.now()}-${_seq++}`;

type Turn =
  | { id: string; role: 'user'; content: string }
  | { id: string; role: 'ai'; content: string; data: AssistResponse; q: string };

export interface AssistModalProps {
  visible: boolean;
  onClose: () => void;
}

// "/find?type=timeline&processing_type=EAD&…" -> { type, processing_type, … }
function parseQuery(url: string): Record<string, string> {
  const out: Record<string, string> = {};
  const qs = url.split('?')[1] || '';
  for (const pair of qs.split('&')) {
    if (!pair) continue;
    const [k, v = ''] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' '));
  }
  return out;
}

export function AssistModal({ visible, onClose }: AssistModalProps) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [nudge, setNudge] = useState(false);
  const listRef = useRef<FlatList>(null);
  const slide = useSharedValue(0);

  // Restore the conversation for the session (survives close/reopen).
  useEffect(() => {
    (async () => {
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        const raw = await AsyncStorage.getItem(CONVO_KEY);
        if (raw) setTurns(JSON.parse(raw));
      } catch {
        // start fresh
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
        await AsyncStorage.setItem(CONVO_KEY, JSON.stringify(turns));
      } catch {
        // ignore
      }
    })();
  }, [turns]);

  useEffect(() => {
    slide.value = visible
      ? withSpring(1, { damping: 15, stiffness: 120 })
      : withTiming(0, { duration: 200 });
  }, [visible]);

  const sheetStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: interpolate(slide.value, [0, 1], [600, 0]) }],
  }));

  const scrollToEnd = () => setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 80);

  const lastUserMessage = () => [...turns].reverse().find((t) => t.role === 'user')?.content || '';

  async function send(message: string, forceIntent = ''): Promise<AssistResponse | undefined> {
    const msg = message.trim();
    if (!msg || loading) return;
    setError('');
    setNudge(false);
    setLoading(true);
    const historyBefore = turns;
    if (!forceIntent) setTurns((t) => [...t, { id: _id('u'), role: 'user', content: msg }]);
    scrollToEnd();
    try {
      const sid = await getAssistSessionId();
      const history = historyBefore.map((t) => ({
        role: t.role,
        content: t.content,
        intent: t.role === 'ai' ? t.data?.intent || '' : '',
      }));
      const resp = await assistTurn(msg, history, sid, forceIntent);
      setTurns((t) => [...t, { id: _id('a'), role: 'ai', content: resp.answer || '', data: resp, q: msg }]);
      scrollToEnd();
      return resp;
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err?.status === 429) setNudge(true);
      else if (err instanceof AIConsentError)
        setError('AI answers are off. Turn on AI data sharing in Profile → AI answers.');
      else setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function startNew() {
    setTurns([]);
    setError('');
    setNudge(false);
    try {
      const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
      await AsyncStorage.removeItem(CONVO_KEY);
    } catch {
      // ignore
    }
  }

  // ---- handoffs (dismiss the modal, then navigate) ----
  const goToFind = (findUrl: string) => {
    onClose();
    navigateNested('Find', 'FindMain', parseQuery(findUrl));
  };
  const goToGroup = (groupId: string, groupName: string) => {
    onClose();
    navigateNested('Find', 'GroupChat', { groupId, groupName });
  };
  const searchCommunity = (q: string) => {
    onClose();
    navigateNested('Home', 'AdvancedSearch', { q });
  };
  const openUscis = (q: string) =>
    Linking.openURL(`https://www.uscis.gov/search?query=${encodeURIComponent(q)}`);
  async function handlePost(turn: Extract<Turn, { role: 'ai' }>) {
    let draft = turn.data.post_draft;
    if (!draft) {
      const resp = await send(lastUserMessage(), 'post');
      draft = resp?.post_draft || null;
    }
    if (draft) {
      onClose();
      navigateNested('Home', 'Post', { assistDraft: draft });
    }
  }

  function renderAi(turn: Extract<Turn, { role: 'ai' }>) {
    const d = turn.data;
    return (
      <View style={styles.aiCard}>
        {!!d.answer && <Markdown>{d.answer}</Markdown>}

        {d.clarify_questions?.length > 0 && (
          <View style={styles.block}>
            {!!d.rationale && <Text style={styles.subtle}>{d.rationale}</Text>}
            {d.clarify_questions.map((q, i) => (
              <Text key={i} style={styles.bullet}>
                • {q}
              </Text>
            ))}
          </View>
        )}

        {d.community_cards?.length > 0 && (
          <View style={styles.block}>
            <Text style={styles.subtle}>Based on community experiences:</Text>
            {d.community_cards.map((c: AssistCommunityCard) => (
              <TouchableOpacity
                key={c.case_id || c.url}
                style={styles.communityCard}
                onPress={() => c.url && Linking.openURL(c.url)}
              >
                <Text style={styles.cardTitle} numberOfLines={1}>
                  {c.title || 'Community posting'}
                </Text>
                {!!c.snippet && (
                  <Text style={styles.cardSnippet} numberOfLines={2}>
                    {c.snippet}
                  </Text>
                )}
                <Text style={styles.cardLink}>
                  View original{c.channel ? ` · ${c.channel}` : ''} →
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {d.citations?.length > 0 && (
          <View style={styles.block}>
            <Text style={styles.sourcesLabel}>Sources</Text>
            {d.citations.map((c: AssistCitation, i: number) => (
              <TouchableOpacity key={i} onPress={() => c.source && Linking.openURL(c.source)}>
                <Text style={styles.sourceLink}>
                  {c.title || c.source}
                  {c.as_of ? <Text style={styles.subtle}>{`  (as of ${c.as_of})`}</Text> : null}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {d.source_tier === 'web' && (
          <Text style={styles.subtle}>From a live search of official sources.</Text>
        )}

        {/* Timeline cohort */}
        {d.timeline &&
          (d.timeline.status === 'found' ? (
            <TouchableOpacity
              style={styles.primaryPill}
              onPress={() => goToGroup(d.timeline!.group_id, d.timeline!.group_name)}
            >
              <Text style={styles.primaryPillText}>
                Open your timeline group{d.timeline.group_name ? ` (${d.timeline.group_name})` : ''} →
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.primaryPill}
              onPress={() => goToFind(d.timeline!.find_url || '/find?type=timeline')}
            >
              <Text style={styles.primaryPillText}>Go to the timeline page →</Text>
            </TouchableOpacity>
          ))}

        {/* find-similar */}
        {d.can_find_similar && !!d.find_url && (
          <TouchableOpacity style={styles.primaryPill} onPress={() => goToFind(d.find_url)}>
            <Text style={styles.primaryPillText}>Find people in the same boat →</Text>
          </TouchableOpacity>
        )}

        {/* action row */}
        <View style={styles.actionRow}>
          {d.intent === 'post' && d.post_draft ? (
            <TouchableOpacity style={styles.primaryPill} onPress={() => handlePost(turn)}>
              <Text style={styles.primaryPillText}>Continue to your post →</Text>
            </TouchableOpacity>
          ) : (
            <>
              {d.can_post && (
                <TouchableOpacity style={styles.secondaryPill} onPress={() => handlePost(turn)}>
                  <Text style={styles.secondaryPillText}>Post this to the community</Text>
                </TouchableOpacity>
              )}
              {d.can_find_timeline && !d.timeline && (
                <TouchableOpacity
                  style={styles.secondaryPill}
                  onPress={() => send(lastUserMessage(), 'timeline-find')}
                >
                  <Text style={styles.secondaryPillText}>Find your EAD/H-1B group</Text>
                </TouchableOpacity>
              )}
            </>
          )}
        </View>

        {/* ungrounded — search further */}
        {d.source_tier === 'ungrounded' && (
          <View style={styles.searchFurther}>
            <Text style={styles.subtle}>Not from our sources — search further:</Text>
            <View style={styles.actionRow}>
              <TouchableOpacity style={styles.secondaryPill} onPress={() => searchCommunity(turn.q)}>
                <Text style={styles.secondaryPillText}>Search community forum</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.secondaryPill} onPress={() => openUscis(turn.q)}>
                <Text style={styles.secondaryPillText}>Search on USCIS.gov</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
      </View>
    );
  }

  const data: Array<Turn | { id: string; role: 'loading' }> = loading
    ? [...turns, { id: 'loading', role: 'loading' as const }]
    : turns;

  const renderItem = ({ item }: { item: Turn | { id: string; role: 'loading' } }) => {
    if (item.role === 'loading') return <ChatMessage content="" role="assistant" isLoading />;
    if (item.role === 'user') return <ChatMessage content={item.content} role="user" />;
    return renderAi(item);
  };

  return (
    <Modal visible={visible} animationType="none" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <AnimatedPressable style={styles.overlayTouchable} onPress={onClose} scaleTo={1} haptics="none" />
        <Animated.View style={[styles.sheet, sheetStyle]}>
          <SafeAreaView style={styles.safeArea}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.flex}
            >
              <View style={styles.header}>
                <View style={styles.headerLeft}>
                  <View style={styles.aiIcon}>
                    <Ionicons name="sparkles" size={18} color={colors.onPrimary} />
                  </View>
                  <Text style={styles.headerTitle}>Ask AI / Post</Text>
                </View>
                <View style={styles.headerActions}>
                  <AnimatedPressable onPress={startNew} style={styles.iconBtn} scaleTo={0.9} haptics="light">
                    <Ionicons name="create-outline" size={22} color={colors.onSurfaceVariant} />
                  </AnimatedPressable>
                  <AnimatedPressable onPress={onClose} style={styles.iconBtn} scaleTo={0.9} haptics="light">
                    <Ionicons name="close" size={24} color={colors.onSurface} />
                  </AnimatedPressable>
                </View>
              </View>

              {turns.length === 0 && !loading ? (
                <View style={styles.emptyWrap}>
                  <Text style={styles.emptyText}>
                    Ask an immigration question, or describe your situation and I&apos;ll help you post
                    it to the community.
                  </Text>
                </View>
              ) : (
                <FlatList
                  ref={listRef}
                  data={data}
                  renderItem={renderItem}
                  keyExtractor={(item) => item.id}
                  contentContainerStyle={styles.list}
                  showsVerticalScrollIndicator={false}
                  onContentSizeChange={scrollToEnd}
                />
              )}

              {error ? <Text style={styles.error}>{error}</Text> : null}
              {nudge ? (
                <Text style={styles.subtle}>
                  You&apos;ve reached the guest limit — sign in to keep asking.
                </Text>
              ) : null}

              <ChatInput
                onSend={(t) => send(t)}
                disabled={loading}
                placeholder="Ask a question, or describe your situation to post it…"
              />
              <Text style={styles.disclaimer}>{DISCLAIMER}</Text>
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' },
  overlayTouchable: { flex: 1 },
  sheet: {
    height: '88%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    ...shadows.level2,
  },
  safeArea: { flex: 1 },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.marginMobile,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.base },
  aiIcon: {
    width: 32,
    height: 32,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { ...typography.headlineMd, fontSize: 18, color: colors.onSurface },
  iconBtn: { padding: spacing.base },
  list: { paddingHorizontal: spacing.marginMobile, paddingVertical: spacing.sm, gap: spacing.sm },
  emptyWrap: { flex: 1, justifyContent: 'center', paddingHorizontal: spacing.lg },
  emptyText: { ...typography.bodyMd, color: colors.onSurfaceVariant, textAlign: 'center' },
  aiCard: {
    backgroundColor: colors.surfaceContainer,
    borderRadius: borderRadius.lg,
    borderTopLeftRadius: borderRadius.sm,
    padding: spacing.md,
    gap: spacing.base,
  },
  block: { gap: 4, marginTop: spacing.base },
  subtle: { ...typography.caption, color: colors.onSurfaceVariant },
  bullet: { ...typography.bodyMd, color: colors.onSurface },
  sourcesLabel: { ...typography.caption, color: colors.onSurfaceVariant, fontWeight: '600' },
  sourceLink: { ...typography.caption, color: colors.primary, marginTop: 2 },
  communityCard: {
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.md,
    padding: spacing.sm,
    marginTop: spacing.base,
  },
  cardTitle: { ...typography.labelMd, color: colors.onSurface },
  cardSnippet: { ...typography.caption, color: colors.onSurfaceVariant, marginTop: 2 },
  cardLink: { ...typography.caption, color: colors.primary, marginTop: 4 },
  actionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.base, marginTop: spacing.base },
  primaryPill: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    alignSelf: 'flex-start',
    marginTop: spacing.base,
  },
  primaryPillText: { ...typography.caption, color: colors.onPrimary, fontWeight: '600' },
  secondaryPill: {
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
  },
  secondaryPillText: { ...typography.caption, color: colors.onSurface },
  searchFurther: {
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  error: {
    ...typography.caption,
    color: colors.error,
    paddingHorizontal: spacing.marginMobile,
    paddingTop: spacing.base,
  },
  disclaimer: {
    ...typography.caption,
    fontSize: 10,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    paddingHorizontal: spacing.marginMobile,
    paddingBottom: spacing.base,
  },
});

export default AssistModal;
