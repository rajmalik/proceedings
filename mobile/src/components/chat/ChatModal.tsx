import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  SafeAreaView,
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
import { askQuestion } from '../../services/apiService';
import { AIConsentError } from '../../services/aiConsent';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
}

export interface ChatModalProps {
  visible: boolean;
  onClose: () => void;
}

interface ChatItem {
  id: string;
  type: 'message';
  message?: Message;
  isLoading?: boolean;
}

const WELCOME_MESSAGE: Message = {
  role: 'assistant',
content: `Hi! I'm your Meridian AI assistant. I can help you:

• Search for visa interview experiences
• Draft posts about your immigration journey
• Answer general immigration questions

How can I help you today?`,
  timestamp: new Date(),
};

export function ChatModal({ visible, onClose }: ChatModalProps) {
  const [chatItems, setChatItems] = useState<ChatItem[]>([
    { id: '0', type: 'message', message: WELCOME_MESSAGE },
  ]);
  const [isLoading, setIsLoading] = useState(false);
  const flatListRef = useRef<FlatList>(null);
  const slideProgress = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      slideProgress.value = withSpring(1, { damping: 15, stiffness: 120 });
    } else {
      slideProgress.value = withTiming(0, { duration: 200 });
    }
  }, [visible]);

  const containerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: interpolate(slideProgress.value, [0, 1], [600, 0]) },
    ],
  }));

  const scrollToBottom = () => {
    setTimeout(() => {
      flatListRef.current?.scrollToEnd({ animated: true });
    }, 100);
  };

  const handleSend = async (text: string) => {
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

    // Add user message and loading indicator
    setChatItems(prev => [
      ...prev,
      userItem,
      { id: `loading-${Date.now()}`, type: 'message', isLoading: true },
    ]);
    setIsLoading(true);
    scrollToBottom();

    try {
      // Send question to backend API
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

  return (
    <Modal
      visible={visible}
      animationType="none"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <AnimatedPressable
          style={styles.overlayTouchable}
          onPress={onClose}
          scaleTo={1}
          haptics="none"
        />
        <Animated.View style={[styles.container, containerAnimatedStyle]}>
          <SafeAreaView style={styles.safeArea}>
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
              style={styles.keyboardView}
            >
              {/* Header */}
              <View style={styles.header}>
                <View style={styles.headerLeft}>
                  <View style={styles.aiIcon}>
                    <Ionicons name="sparkles" size={20} color={colors.onPrimary} />
                  </View>
<Text style={styles.headerTitle}>Meridian AI</Text>
                </View>
                <AnimatedPressable onPress={onClose} style={styles.closeButton} scaleTo={0.9} haptics="light">
                  <Ionicons name="close" size={24} color={colors.onSurface} />
                </AnimatedPressable>
              </View>

              {/* Chat Messages */}
              <FlatList
                ref={flatListRef}
                data={chatItems}
                renderItem={renderItem}
                keyExtractor={item => item.id}
                contentContainerStyle={styles.chatList}
                showsVerticalScrollIndicator={false}
                onContentSizeChange={scrollToBottom}
              />

              {/* Input */}
              <ChatInput
                onSend={handleSend}
                disabled={isLoading}
                placeholder="Ask about USA visits/migration journey..."
              />
            </KeyboardAvoidingView>
          </SafeAreaView>
        </Animated.View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
  },
  overlayTouchable: {
    flex: 1,
  },
  container: {
    height: '85%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: borderRadius.xl,
    borderTopRightRadius: borderRadius.xl,
    ...shadows.level2,
  },
  safeArea: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.marginMobile,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  aiIcon: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.full,
    // Brand the AI chip (was gray secondary → looked disabled) — UI_AUDIT §10.
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: {
    ...typography.headlineMd,
    fontSize: 18,
    color: colors.onSurface,
  },
  closeButton: {
    padding: spacing.base,
  },
  chatList: {
    paddingVertical: spacing.sm,
  },
});
