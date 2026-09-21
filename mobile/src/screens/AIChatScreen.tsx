import React, { useState, useRef, useLayoutEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  TouchableOpacity,
  Dimensions,
} from 'react-native';
import Animated, {
  FadeIn,
  FadeInUp,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { Orb } from 'react-native-magic-orb';
import { colors, typography, spacing, borderRadius } from '../constants/theme';
import { GlassCard, GlassButton } from '../components';
import { ChatMessage } from '../components/chat/ChatMessage';
import { ChatInput } from '../components/chat/ChatInput';
import { askQuestion } from '../services/apiService';
import { AIConsentError } from '../services/aiConsent';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Meridian red gradient colors for the orb (matching brand identity)
const ORB_COLORS: [string, string, string] = [colors.orb.red, colors.orb.pink, colors.orb.purple];

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

interface ChatItem {
  id: string;
  type: 'message';
  message?: Message;
  isLoading?: boolean;
}

// Suggestion cards for the home state - arranged as 2x2 grid
const SUGGESTION_CARDS = [
  {
    id: 'visa-exp',
    icon: 'document-text-outline' as const,
    title: 'USA visits/migration journey',
    subtitle: 'Find similar journeys',
  },
  {
    id: 'interview',
    icon: 'chatbubbles-outline' as const,
    title: 'Interview prep',
    subtitle: 'Common questions',
  },
  {
    id: 'timeline',
    icon: 'time-outline' as const,
    title: 'Processing times',
    subtitle: 'Current wait times',
  },
  {
    id: 'documents',
    icon: 'folder-outline' as const,
    title: 'Documents',
    subtitle: 'Required paperwork',
  },
];

export function AIChatScreen({ navigation }: any) {
  const [chatItems, setChatItems] = useState<ChatItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [hasStartedChat, setHasStartedChat] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  // Hide tab bar when this screen is active
  useLayoutEffect(() => {
    navigation.getParent()?.setOptions({
      tabBarStyle: { display: 'none' },
    });
    return () => {
      navigation.getParent()?.setOptions({
        tabBarStyle: {
          backgroundColor: colors.surfaceContainerLowest,
          borderTopWidth: 1,
          borderTopColor: colors.outlineVariant,
          paddingTop: spacing.base,
          paddingBottom: spacing.sm,
          height: 70,
        },
      });
    };
  }, [navigation]);

  const scrollToBottom = () => {
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  const handleSend = async (text: string) => {
    if (!hasStartedChat) {
      setHasStartedChat(true);
    }

    const userMessage: Message = {
      role: 'user',
      content: text,
      timestamp: new Date(),
    };

    const userItem: ChatItem = {
      id: Date.now().toString(),
      type: 'message',
      message: userMessage,
    };

    setChatItems(prev => [
      ...prev,
      userItem,
      { id: `loading-${Date.now()}`, type: 'message', isLoading: true },
    ]);
    setIsLoading(true);
    scrollToBottom();

    try {
      const apiResponse = await askQuestion(text);

      const assistantMessage: Message = {
        role: 'assistant',
        content: apiResponse.answer,
        timestamp: new Date(),
      };

      setChatItems(prev => {
        const filtered = prev.filter(item => !item.isLoading);
        return [
          ...filtered,
          { id: `resp-${Date.now()}`, type: 'message', message: assistantMessage },
        ];
      });
    } catch (error) {
      console.error('Chat error:', error);
      const errorMessage: Message = {
        role: 'assistant',
        content:
          error instanceof AIConsentError
            ? 'AI answers are turned off because AI data sharing hasn’t been enabled. You can turn it on in Profile → AI answers.'
            : 'I encountered an error processing your request. Please try again.',
        timestamp: new Date(),
      };

      setChatItems(prev => {
        const filtered = prev.filter(item => !item.isLoading);
        return [
          ...filtered,
          { id: `error-${Date.now()}`, type: 'message', message: errorMessage },
        ];
      });
    } finally {
      setIsLoading(false);
      scrollToBottom();
    }
  };

  const handleSuggestionPress = (card: typeof SUGGESTION_CARDS[0]) => {
    const queries: Record<string, string> = {
      'visa-exp': 'Show me recent visa interview experiences',
      'interview': 'What are common interview questions for visa interviews?',
      'timeline': 'What are the current processing times?',
      'documents': 'What documents do I need for my visa application?',
    };
    handleSend(queries[card.id] || card.title);
  };

  const handleNewChat = () => {
    setChatItems([]);
    setHasStartedChat(false);
  };

  const renderItem = ({ item }: { item: ChatItem }) => {
    if (item.isLoading) {
      return <ChatMessage content="" role="assistant" isLoading />;
    }

    if (item.message) {
      return (
        <ChatMessage
          content={item.message.content}
          role={item.message.role}
          timestamp={item.message.timestamp}
        />
      );
    }

    return null;
  };

  // Render a single grid cell for suggestion card
  const renderGridCell = (card: typeof SUGGESTION_CARDS[0]) => (
    <TouchableOpacity
      key={card.id}
      style={styles.gridCell}
      onPress={() => handleSuggestionPress(card)}
      activeOpacity={0.7}
    >
      <View style={styles.suggestionIconWrap}>
        <Ionicons name={card.icon} size={20} color={colors.primary} />
      </View>
      <Text style={styles.suggestionTitle}>{card.title}</Text>
      <Text style={styles.suggestionSubtitle}>{card.subtitle}</Text>
    </TouchableOpacity>
  );

  // Home state - shown when no conversation has started
  const renderHomeState = () => (
    <Animated.View style={styles.homeContainer} entering={FadeIn.duration(300)}>
      {/* Animated Orb - Red family gradient */}
      <Animated.View entering={FadeInUp.delay(50).duration(400)} style={styles.orbContainer}>
        <Orb
          colors={ORB_COLORS}
          size={150}
          speed={1.0}
          wobbleSpeed={0.5}
          intensity={0.4}
        />
      </Animated.View>

      {/* Greeting */}
      <Animated.View entering={FadeInUp.delay(100).duration(400)} style={styles.greetingContainer}>
        <Text style={styles.greetingMuted}>Hello</Text>
        <Text style={styles.greetingBold}>How can I assist you?</Text>
      </Animated.View>

      {/* Suggestions Panel - 2x2 Grid */}
      <Animated.View
        style={styles.suggestionsPanelWrapper}
        entering={FadeInUp.delay(200).duration(400)}
      >
        <GlassCard style={styles.suggestionsPanel} radius={24}>
          {/* 2x2 Grid */}
          <View style={styles.gridContainer}>
            {/* Top Row */}
            <View style={styles.gridRow}>
              {renderGridCell(SUGGESTION_CARDS[0])}
              <View style={styles.verticalDivider} />
              {renderGridCell(SUGGESTION_CARDS[1])}
            </View>

            <View style={styles.horizontalDivider} />

            {/* Bottom Row */}
            <View style={styles.gridRow}>
              {renderGridCell(SUGGESTION_CARDS[2])}
              <View style={styles.verticalDivider} />
              {renderGridCell(SUGGESTION_CARDS[3])}
            </View>
          </View>
        </GlassCard>
      </Animated.View>
    </Animated.View>
  );

  return (
    <View style={styles.container}>
      {/* Gradient Background */}
      <LinearGradient
        colors={[colors.glass.gradientTop, colors.glass.gradientBottom]}
        style={StyleSheet.absoluteFill}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
      />

      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        {/* Header - Back button + Title only (no + button) */}
        <View style={styles.header}>
          <GlassButton onPress={() => navigation.goBack()} size={44}>
            <Ionicons name="chevron-back" size={22} color={colors.onSurface} />
          </GlassButton>

          <Text style={styles.headerTitle}>Meridian AI</Text>

          {/* Spacer to keep title centered */}
          <View style={styles.headerSpacer} />
        </View>

        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          style={styles.keyboardView}
          keyboardVerticalOffset={0}
        >
          {!hasStartedChat ? (
            <View style={styles.homeWrapper}>
              {renderHomeState()}
            </View>
          ) : (
            <FlatList
              ref={flatListRef}
              data={chatItems}
              renderItem={renderItem}
              keyExtractor={item => item.id}
              contentContainerStyle={styles.chatList}
              showsVerticalScrollIndicator={false}
              onContentSizeChange={scrollToBottom}
            />
          )}

          <ChatInput
            onSend={handleSend}
            disabled={isLoading}
            placeholder="Ask anything..."
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  safeArea: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    height: 60,
  },
  headerTitle: {
    // Brand serif wordmark (Georgia was unloaded → system fallback).
    fontFamily: 'Lora_600SemiBold',
    fontSize: 18,
    color: colors.onSurface,
  },
  headerSpacer: {
    width: 44,
  },
  keyboardView: {
    flex: 1,
  },
  homeWrapper: {
    flex: 1,
    justifyContent: 'flex-start',
  },
  homeContainer: {
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xl,
  },
  orbContainer: {
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
  },
  greetingContainer: {
    alignItems: 'center',
    marginBottom: spacing.sm,
  },
  greetingMuted: {
    ...typography.bodyLg,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
  },
  greetingBold: {
    ...typography.headlineLg,
    color: colors.onSurface,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  suggestionsPanelWrapper: {
    width: '100%',
    maxWidth: SCREEN_WIDTH - spacing.md * 2,
    marginTop: spacing.sm,
    marginBottom: 48,
  },
  suggestionsPanel: {
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
    borderRadius: borderRadius.lg,
  },
  gridContainer: {
    paddingHorizontal: spacing.xs,
  },
  gridRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
  },
  gridCell: {
    flex: 1,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
    alignItems: 'flex-start',
  },
  verticalDivider: {
    width: 1,
    backgroundColor: colors.outlineVariant,
    opacity: 0.5,
  },
  horizontalDivider: {
    height: 1,
    backgroundColor: colors.outlineVariant,
    opacity: 0.5,
    marginHorizontal: spacing.sm,
  },
  suggestionIconWrap: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.full,
    // Was a hardcoded blue tint on a red-brand app (UI_AUDIT §1) → brand tonal surface.
    backgroundColor: colors.primaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.xs,
  },
  suggestionTitle: {
    ...typography.labelMd,
    fontWeight: '400',
    color: colors.onSurface,
  },
  suggestionSubtitle: {
    ...typography.caption,
    fontWeight: '400',
    color: colors.outline,
    marginTop: 2,
  },
  chatList: {
    paddingVertical: spacing.sm,
  },
});

export default AIChatScreen;
