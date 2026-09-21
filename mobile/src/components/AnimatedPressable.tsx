import React, { useCallback } from 'react';
import { ViewStyle, StyleProp } from 'react-native';
import Animated, { runOnJS } from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useAnimatedPressable } from '../hooks/animations';

type HapticType = 'light' | 'medium' | 'heavy' | 'none';

export interface AnimatedPressableProps {
  children?: React.ReactNode;
  /** React key for list rendering */
  key?: React.Key;
  /** Press handler */
  onPress?: () => void;
  /** Long press handler */
  onLongPress?: () => void;
  /** Container style */
  style?: StyleProp<ViewStyle>;
  /** Scale factor when pressed (default: 0.96) */
  scaleTo?: number;
  /** Haptic feedback intensity (default: 'light') */
  haptics?: HapticType;
  /** Disable interactions */
  disabled?: boolean;
  /** Test ID for testing */
  testID?: string;
  /** Accessibility label announced by screen readers / queried in tests */
  accessibilityLabel?: string;
}

/**
 * Animated pressable component with scale + haptic feedback.
 * Uses Gesture Handler for smooth 60fps interactions.
 *
 * @example
 * <AnimatedPressable onPress={handlePress} haptics="medium">
 *   <Text>Press me</Text>
 * </AnimatedPressable>
 */
export function AnimatedPressable({
  children,
  onPress,
  onLongPress,
  style,
  scaleTo = 0.96,
  haptics = 'light',
  disabled = false,
  testID,
  accessibilityLabel,
}: AnimatedPressableProps) {
  const { animatedStyle, onPressIn, onPressOut } = useAnimatedPressable({
    scaleTo,
    haptics: disabled ? 'none' : haptics,
  });

  const handlePress = useCallback(() => {
    if (!disabled && onPress) {
      onPress();
    }
  }, [disabled, onPress]);

  const handleLongPress = useCallback(() => {
    if (!disabled && onLongPress) {
      onLongPress();
    }
  }, [disabled, onLongPress]);

  const tap = Gesture.Tap()
    .enabled(!disabled)
    .onBegin(() => {
      'worklet';
      onPressIn();
    })
    .onEnd(() => {
      'worklet';
      onPressOut();
      if (onPress) {
        runOnJS(handlePress)();
      }
    })
    .onFinalize(() => {
      'worklet';
      onPressOut();
    });

  const longPress = Gesture.LongPress()
    .enabled(!disabled && !!onLongPress)
    .minDuration(500)
    .onStart(() => {
      'worklet';
      onPressOut();
      if (onLongPress) {
        runOnJS(handleLongPress)();
      }
    });

  const composed = onLongPress
    ? Gesture.Race(tap, longPress)
    : tap;

  return (
    <GestureDetector gesture={composed}>
      <Animated.View
        style={[style, animatedStyle, disabled && { opacity: 0.5 }]}
        testID={testID}
        accessible={!!accessibilityLabel}
        accessibilityLabel={accessibilityLabel}
      >
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

export default AnimatedPressable;
