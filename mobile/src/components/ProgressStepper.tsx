import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { FadeIn, ZoomIn, Layout } from 'react-native-reanimated';
import { colors, borderRadius, spacing } from '../constants/theme';

interface Step {
  label: string;
  completed?: boolean;
}

interface ProgressStepperProps {
  steps: Step[];
  currentStep: number;
}

export function ProgressStepper({ steps, currentStep }: ProgressStepperProps) {
  return (
    <View style={styles.container}>
      {steps.map((step, index) => {
        const isCompleted = index < currentStep;
        const isCurrent = index === currentStep;
        const isLast = index === steps.length - 1;

        return (
          <View key={index} style={styles.stepContainer}>
            <View style={styles.stepContent}>
              <Animated.View
                layout={Layout.springify().damping(15).stiffness(120)}
                style={[
                  styles.stepCircle,
                  isCompleted && styles.stepCompleted,
                  isCurrent && styles.stepCurrent,
                ]}
              >
                <Text
                  style={[
                    styles.stepNumber,
                    (isCompleted || isCurrent) && styles.stepNumberActive,
                  ]}
                >
                  {isCompleted ? '✓' : index + 1}
                </Text>
              </Animated.View>
              <Text
                numberOfLines={1}
                style={[
                  styles.stepLabel,
                  (isCompleted || isCurrent) && styles.stepLabelActive,
                ]}
              >
                {step.label}
              </Text>
            </View>
            {!isLast && (
              <Animated.View
                layout={Layout.springify().damping(15).stiffness(120)}
                style={[
                  styles.connector,
                  isCompleted && styles.connectorCompleted,
                ]}
              />
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  stepContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  stepContent: {
    alignItems: 'center',
    // Wide enough for the longest step label ("Experiences") at 12px so it
    // stays on one line instead of wrapping/cutting off.
    width: 92,
  },
  stepCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.surfaceContainerHigh,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: colors.outlineVariant,
  },
  stepCompleted: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  stepCurrent: {
    backgroundColor: colors.surfaceContainerLowest,
    borderColor: colors.primary,
    borderWidth: 2,
  },
  stepNumber: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.outline,
  },
  stepNumberActive: {
    color: colors.primary,
  },
  stepLabel: {
    marginTop: spacing.xs,
    fontSize: 12,
    color: colors.outline,
    textAlign: 'center',
  },
  stepLabelActive: {
    color: colors.onSurface,
    fontWeight: '500',
  },
  connector: {
    flex: 1,
    height: 2,
    backgroundColor: colors.outlineVariant,
    marginTop: 15,
    marginHorizontal: -10,
  },
  connectorCompleted: {
    backgroundColor: colors.primary,
  },
});

export default ProgressStepper;
