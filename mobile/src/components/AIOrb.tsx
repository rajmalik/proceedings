import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Circle, Ellipse } from 'react-native-svg';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  withSequence,
  Easing,
  SharedValue,
} from 'react-native-reanimated';
import { colors } from '../constants/theme';

interface AIorbProps {
  /** Animated size value (controlled externally via scroll) */
  animatedSize?: SharedValue<number>;
  /** Static size when not using animated size */
  size?: number;
  /** Whether to show the pulsing animation */
  pulse?: boolean;
}

export function AIOrb({ animatedSize, size = 140, pulse = true }: AIorbProps) {
  const pulseScale = useSharedValue(1);
  const glowOpacity = useSharedValue(0.4);

  useEffect(() => {
    if (pulse) {
      // Smooth pulsing animation
      pulseScale.value = withRepeat(
        withSequence(
          withTiming(1.06, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
          withTiming(1, { duration: 2000, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );

      // Glow intensity animation
      glowOpacity.value = withRepeat(
        withSequence(
          withTiming(0.6, { duration: 2000, easing: Easing.inOut(Easing.ease) }),
          withTiming(0.4, { duration: 2000, easing: Easing.inOut(Easing.ease) })
        ),
        -1,
        true
      );
    }
  }, [pulse]);

  const containerStyle = useAnimatedStyle(() => {
    const currentSize = animatedSize?.value ?? size;
    return {
      width: currentSize,
      height: currentSize,
      transform: [{ scale: pulseScale.value }],
    };
  });

  const glowStyle = useAnimatedStyle(() => {
    const currentSize = animatedSize?.value ?? size;
    return {
      width: currentSize * 1.3,
      height: currentSize * 1.3,
      borderRadius: (currentSize * 1.3) / 2,
      opacity: glowOpacity.value,
    };
  });

  return (
    <View style={styles.wrapper}>
      {/* Outer glow effect */}
      <Animated.View style={[styles.glow, glowStyle]} />

      {/* Main glossy orb */}
      <Animated.View style={containerStyle}>
        <Svg width="100%" height="100%" viewBox="0 0 140 140">
          <Defs>
            {/* Main radial gradient - red to dark */}
            <RadialGradient id="orbGradient" cx="35%" cy="35%" rx="60%" ry="60%">
              <Stop offset="0%" stopColor={colors.orb.redBright} stopOpacity={1} />
              <Stop offset="40%" stopColor={colors.orb.red} stopOpacity={1} />
              <Stop offset="100%" stopColor={colors.orb.redDeep} stopOpacity={1} />
            </RadialGradient>

            {/* Highlight gradient for glossy 3D effect */}
            <RadialGradient id="highlight" cx="30%" cy="25%" rx="40%" ry="35%">
              <Stop offset="0%" stopColor={colors.onPrimary} stopOpacity={0.6} />
              <Stop offset="100%" stopColor={colors.onPrimary} stopOpacity={0} />
            </RadialGradient>

            {/* Secondary inner glow */}
            <RadialGradient id="innerGlow" cx="50%" cy="60%" rx="50%" ry="40%">
              <Stop offset="0%" stopColor={colors.orb.redGlow} stopOpacity={0.3} />
              <Stop offset="100%" stopColor={colors.orb.red} stopOpacity={0} />
            </RadialGradient>
          </Defs>

          {/* Main blob circle */}
          <Circle cx="70" cy="70" r="65" fill="url(#orbGradient)" />

          {/* Inner glow for depth */}
          <Circle cx="70" cy="75" r="50" fill="url(#innerGlow)" />

          {/* Top highlight for 3D glossy effect */}
          <Ellipse cx="55" cy="45" rx="30" ry="22" fill="url(#highlight)" />

          {/* Small specular highlight */}
          <Circle cx="45" cy="38" r="8" fill={colors.onPrimary} opacity={0.5} />

          {/* Tiny sparkle highlight */}
          <Circle cx="50" cy="32" r="3" fill={colors.onPrimary} opacity={0.7} />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  glow: {
    position: 'absolute',
    backgroundColor: colors.primary,
    // Blur effect via shadow
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.5,
    shadowRadius: 30,
    elevation: 10,
  },
});

export default AIOrb;
