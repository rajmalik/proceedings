import React, { useState, useEffect } from 'react';
import { View, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSequence,
  withSpring,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '../constants/theme';
import { textStyle } from './AppText';
import { castVote, getActiveUserId } from '../services/apiService';

interface VoteControlProps {
  contentId: string;
  score: number;
  yourVote?: number; // -1 | 0 | 1
  orientation?: 'vertical' | 'horizontal';
  onScoreChange?: (score: number) => void;
}

export function VoteControl({
  contentId,
  score,
  yourVote = 0,
  orientation = 'vertical',
  onScoreChange,
}: VoteControlProps) {
  const [currentScore, setCurrentScore] = useState(score);
  const [currentVote, setCurrentVote] = useState(yourVote);
  const [busy, setBusy] = useState(false);

  // Count bounce on vote (A4 motion policy: state changes get feedback).
  const scoreScale = useSharedValue(1);
  const scoreStyle = useAnimatedStyle(() => ({ transform: [{ scale: scoreScale.value }] }));

  // Resync when props change
  useEffect(() => {
    setCurrentScore(score);
    setCurrentVote(yourVote);
  }, [score, yourVote, contentId]);

  async function handleVote(dir: 1 | -1) {
    if (busy) return;

    const userId = getActiveUserId();
    if (!userId) {
      Alert.alert('Select User', 'Please select a user in onboarding to vote.');
      return;
    }

    // Medium haptic: voting is a state-changing action (see AGENTS.md policy).
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    scoreScale.value = withSequence(
      withSpring(1.25, { damping: 12, stiffness: 400 }),
      withSpring(1, { damping: 14, stiffness: 320 })
    );

    const target = currentVote === dir ? 0 : dir;
    const optimisticScore = currentScore - currentVote + target;
    const prevState = { score: currentScore, vote: currentVote };

    // Optimistic update
    setCurrentScore(optimisticScore);
    setCurrentVote(target);
    setBusy(true);
    onScoreChange?.(optimisticScore);

    try {
      const result = await castVote(contentId, target);
      setCurrentScore(result.score);
      setCurrentVote(result.your_vote);
      onScoreChange?.(result.score);
    } catch (error) {
      // Revert on error
      setCurrentScore(prevState.score);
      setCurrentVote(prevState.vote);
      onScoreChange?.(prevState.score);
      Alert.alert('Vote Failed', error instanceof Error ? error.message : 'Could not vote');
    } finally {
      setBusy(false);
    }
  }

  const isVertical = orientation === 'vertical';

  const getUpColor = () => (currentVote === 1 ? colors.primary : colors.onSurfaceVariant);
  const getDownColor = () => (currentVote === -1 ? colors.error : colors.onSurfaceVariant);
  const getScoreColor = () => {
    if (currentVote === 1) return colors.primary;
    if (currentVote === -1) return colors.error;
    return colors.onSurface;
  };

  return (
    <View style={[styles.container, isVertical ? styles.vertical : styles.horizontal]}>
      <TouchableOpacity
        onPress={() => handleVote(1)}
        disabled={busy}
        style={[styles.button, busy && styles.disabled]}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityLabel="Upvote"
        accessibilityRole="button"
      >
        <Ionicons name="arrow-up" size={20} color={getUpColor()} />
      </TouchableOpacity>

      <Animated.Text style={[textStyle('labelBold'), styles.score, { color: getScoreColor() }, scoreStyle]}>
        {currentScore}
      </Animated.Text>

      <TouchableOpacity
        onPress={() => handleVote(-1)}
        disabled={busy}
        style={[styles.button, busy && styles.disabled]}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        accessibilityLabel="Downvote"
        accessibilityRole="button"
      >
        <Ionicons name="arrow-down" size={20} color={getDownColor()} />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    gap: 2,
  },
  vertical: {
    flexDirection: 'column',
  },
  horizontal: {
    flexDirection: 'row',
  },
  button: {
    padding: 4,
  },
  disabled: {
    opacity: 0.4,
  },
  score: {
    // Type comes from the `labelBold` token (textStyle); only layout here.
    minWidth: 24,
    textAlign: 'center',
  },
});

export default VoteControl;
