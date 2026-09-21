import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { Header, Card, Button, Select, ProgressStepper } from '../components';
import { colors, spacing, borderRadius } from '../constants/theme';
import { pathwayOptions, stageOptions } from '../data/mockData';

const steps = [
  { label: 'Situation' },
  { label: 'Origin' },
  { label: 'Timeline' },
];

export function OnboardingScreen() {
  const [currentStep, setCurrentStep] = useState(0);
  const [pathway, setPathway] = useState('');
  const [stage, setStage] = useState('');

  const handleContinue = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    }
  };

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <Header showLogo showSearch />

      <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
        {/* Progress Stepper */}
        <ProgressStepper steps={steps} currentStep={currentStep} />

        {/* Main Card */}
        <Card style={styles.mainCard}>
          <Text style={styles.title}>Personalize your journey</Text>
          <Text style={styles.subtitle}>
            Tell us about your current status so we can provide the most relevant guidance and deadlines.
          </Text>

          <Select
            label="Immigration Pathway"
            placeholder="Select your pathway"
            options={pathwayOptions}
            value={pathway}
            onChange={setPathway}
            containerStyle={styles.selectContainer}
          />

          <Select
            label="Current Stage"
            placeholder="Where are you in the process?"
            options={stageOptions}
            value={stage}
            onChange={setStage}
            containerStyle={styles.selectContainer}
          />

          <Button
            onPress={handleContinue}
            fullWidth
            style={styles.continueButton}
            icon={<Ionicons name="arrow-forward" size={18} color={colors.onPrimary} />}
          >
            Continue
          </Button>

          <Button variant="link" style={styles.skipButton}>
            Skip for now
          </Button>
        </Card>

        {/* Privacy Card */}
        <Card style={styles.privacyCard} elevation={0}>
          <View style={styles.privacyHeader}>
            <View style={styles.privacyIcon}>
              <Ionicons name="shield-checkmark" size={20} color={colors.secondary} />
            </View>
            <Text style={styles.privacyTitle}>Your privacy is our priority</Text>
          </View>
          <Text style={styles.privacyText}>
            All information is encrypted and stored securely. We never share your data with government agencies without your explicit consent.
          </Text>
        </Card>

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={styles.footerText}>
Not legal advice. Meridian is not a law firm or government agency.
          </Text>
          <View style={styles.footerLinks}>
            <Text style={styles.footerLink}>Terms of Service</Text>
            <Text style={styles.footerDivider}>•</Text>
            <Text style={styles.footerLink}>Privacy Policy</Text>
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  content: {
    flex: 1,
  },
  mainCard: {
    marginHorizontal: spacing.marginMobile,
    marginTop: spacing.md,
    marginBottom: spacing.md,
  },
  title: {
    fontSize: 24,
    fontWeight: '600',
    color: colors.onSurface,
    marginBottom: spacing.base,
  },
  subtitle: {
    fontSize: 15,
    color: colors.onSurfaceVariant,
    lineHeight: 22,
    marginBottom: spacing.md,
  },
  selectContainer: {
    marginBottom: spacing.md,
  },
  continueButton: {
    marginTop: spacing.sm,
  },
  skipButton: {
    marginTop: spacing.sm,
    alignSelf: 'center',
  },
  privacyCard: {
    marginHorizontal: spacing.marginMobile,
    backgroundColor: colors.surfaceContainer,
    borderWidth: 0,
  },
  privacyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.base,
  },
  privacyIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.secondaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm,
  },
  privacyTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.onSurface,
    flex: 1,
  },
  privacyText: {
    fontSize: 13,
    color: colors.onSurfaceVariant,
    lineHeight: 19,
  },
  footer: {
    alignItems: 'center',
    paddingVertical: spacing.lg,
    paddingHorizontal: spacing.marginMobile,
  },
  footerText: {
    fontSize: 12,
    color: colors.outline,
    textAlign: 'center',
    marginBottom: spacing.base,
  },
  footerLinks: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  footerLink: {
    fontSize: 12,
    color: colors.primary,
    textDecorationLine: 'underline',
  },
  footerDivider: {
    fontSize: 12,
    color: colors.outline,
    marginHorizontal: spacing.base,
  },
});

export default OnboardingScreen;
