import React from 'react';
import { TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, shadows, borderRadius } from '../../constants/theme';

export interface FloatingChatButtonProps {
  onPress: () => void;
  isOpen?: boolean;
}

export function FloatingChatButton({ onPress, isOpen }: FloatingChatButtonProps) {
  return (
    <TouchableOpacity
      style={[styles.container, isOpen && styles.containerOpen]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <Ionicons
        name={isOpen ? 'close' : 'chatbubble-ellipses'}
        size={28}
        color={colors.onPrimary}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 100, // Above the tab bar
    right: 20,
    width: 60,
    height: 60,
    borderRadius: borderRadius.full,
    // Brand the primary AI entry point (was gray secondary) — UI_AUDIT §10.
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadows.level2,
    zIndex: 1000,
  },
  containerOpen: {
    backgroundColor: colors.tertiary,
  },
});
