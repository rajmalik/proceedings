import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Switch,
  Image,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, FadeOut, Layout } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { Alert, ActivityIndicator } from 'react-native';
import { colors, spacing, borderRadius, typography } from '../constants/theme';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { OnboardingIntro } from '../components/OnboardingIntro';
import { ProgressStepper } from '../components/ProgressStepper';
import {
  MILESTONES,
  JourneyEntry,
  OnboardingProfile,
  toBackendProfile,
  createEmptyProfile,
} from '../constants/onboardingData';
import { useAuth } from '../contexts/AuthContext';
import Markdown from '../components/Markdown';
import { updateProfile, onboardTurn, getActiveUserId } from '../services/apiService';
import { useExperienceFacets } from '../hooks/useExperienceFacets';

type RouteParams = {
  ExperiencesOnboarding: {
    profile: OnboardingProfile;
    journey?: JourneyEntry[];
    skipped?: boolean;
  };
};

type Turn = { id: string; role: 'user' | 'ai'; content: string };

// Same fallback greeting as the website's stage-2 opener.
const GREETING_EXPERIENCES =
  "Your basic profile is saved ✓. Now let's capture your experiences at the milestones you've already " +
  "crossed - these help others going through the same steps (and aren't tagged to your current status).";

export function ExperiencesOnboardingScreen() {
  // Step opens on its illustration + headline; the form appears after Next.
  const [showIntro, setShowIntro] = useState(true);
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const route = useRoute<RouteProp<RouteParams, 'ExperiencesOnboarding'>>();
  const { completeOnboarding } = useAuth();

  const { profile, journey: savedJourney, skipped } = route.params || {};

  // Start from the user's EXISTING journey so edits never wipe published experiences.
  const [experiences, setExperiences] = useState<JourneyEntry[]>(savedJourney || []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedMilestone, setSelectedMilestone] = useState('');
  const [experienceDate, setExperienceDate] = useState('');
  const [experienceText, setExperienceText] = useState('');
  const [shareExperience, setShareExperience] = useState(true);

  // AI experiences chat (website parity: POST /api/onboard, stage 'experiences').
  const [messages, setMessages] = useState<Turn[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);

  const draftForBot = () => toBackendProfile(profile || createEmptyProfile(), experiences);

  // Generated facets for each shared/published experience (website parity).
  const expFacets = useExperienceFacets(experiences);

  // Website parity: the bot opens stage 2 by inferring crossed milestones from
  // the saved profile (fallback greeting offline / for dev users).
  React.useEffect(() => {
    if (!getActiveUserId()) {
      setMessages([{ id: 's2', role: 'ai', content: GREETING_EXPERIENCES }]);
      return;
    }
    setChatLoading(true);
    onboardTurn('experiences', [], draftForBot())
      .then((data) => {
        setMessages([{ id: 's2', role: 'ai', content: data.reply || GREETING_EXPERIENCES }]);
        if (data.profile?.journey) setExperiences(data.profile.journey as JourneyEntry[]);
      })
      .catch(() => setMessages([{ id: 's2', role: 'ai', content: GREETING_EXPERIENCES }]))
      .finally(() => setChatLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sendChat = async () => {
    const t = chatInput.trim();
    if (!t || chatLoading) return;
    setChatInput('');
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, role: 'user', content: t }]);
    setChatLoading(true);
    try {
      const data = await onboardTurn(
        'experiences',
        [...history, { role: 'user', content: t }],
        draftForBot()
      );
      setMessages((prev) => [...prev, { id: `${Date.now()}-a`, role: 'ai', content: data.reply }]);
      // The bot extracts journey entries from the conversation.
      if (data.profile?.journey) setExperiences(data.profile.journey as JourneyEntry[]);
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-x`, role: 'ai', content: e instanceof Error ? e.message : 'Assistant error' },
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  const addExperience = () => {
    if (selectedMilestone && experienceText.trim()) {
      const newEntry: JourneyEntry = {
        milestone: selectedMilestone,
        date: experienceDate,
        experience: experienceText.trim(),
        shared: shareExperience,
      };
      setExperiences([...experiences, newEntry]);
      resetForm();
    }
  };

  const resetForm = () => {
    setSelectedMilestone('');
    setExperienceDate('');
    setExperienceText('');
    setShareExperience(true);
    setShowAddForm(false);
  };

  const removeExperience = (index: number) => {
    setExperiences(experiences.filter((_, i) => i !== index));
  };

  const [saving, setSaving] = useState(false);

  const handleComplete = async () => {
    if (saving) return;
    setSaving(true);

    let saveSucceeded = false;
    try {
      // Persist the collected profile + experiences to the backend (same
      // PUT /api/profile contract as the website; the backend validates the
      // controlled-vocab values and publishes shared experiences).
      // Only attempt if we have a user ID (skip in dev mode to avoid errors).
      if (getActiveUserId()) {
        await updateProfile({
          current_visa_or_greencard_category: profile?.currentStatus || [],
          visa_applying_for: profile?.applyingFor || [],
          consulates: profile?.consulates || [],
          primary_consulate: profile?.consulates?.[0] || '',
          tags: profile?.tags || [],
          key_stages_or_info: profile?.keyStages || {},
          key_dates: profile?.keyDates || {},
          background_text: profile?.backgroundText || '',
          journey: experiences,
        });
      }
      saveSucceeded = true;
    } catch (e) {
      console.warn('Could not save profile:', e);
      // In dev mode or on network failure, still allow completing onboarding
      // but warn the user their data may not have persisted.
      Alert.alert(
        'Profile not saved',
        'Your profile could not be saved to the server, but you can still continue using the app.',
        [{ text: 'OK' }]
      );
      saveSucceeded = true; // Still allow proceeding
    }

    if (saveSucceeded) {
      try {
        await completeOnboarding();
        // During first-run onboarding the navigator switches automatically.
        // When editing from within the app (tab stacks), popToTop returns to the tab root.
        // Use try/catch because the navigation state may have changed.
        try {
          navigation.popToTop?.();
        } catch {
          // Navigation state changed (e.g., onboarding completed and switched navigator)
          // This is expected during first-run onboarding, ignore.
        }
      } catch (e) {
        console.error('Error completing onboarding:', e);
      }
    }

    setSaving(false);
  };

  const handleBack = () => {
    navigation.goBack();
  };

  const getMilestoneLabel = (key: string) => {
    return MILESTONES.find((m) => m.key === key)?.label || key;
  };

  if (showIntro) {
    return (
      <OnboardingIntro
        image={ONBOARDING_IMAGE}
        imageRatio={ONBOARDING_IMAGE_RATIO}
        title="Share your experiences"
        subtitle={"Help others by sharing what you've been through. Your experiences can guide someone in a similar situation."}
        steps={[{ label: 'Background' }, { label: 'Experiences' }]}
        currentStep={1}
        onNext={() => setShowIntro(false)}
      />
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {/* Header */}
          <Animated.View style={styles.header} entering={FadeInDown.delay(100).duration(400)}>
            <AnimatedPressable style={styles.backButton} onPress={handleBack} haptics="light">
              <Ionicons name="arrow-back" size={24} color={colors.onSurface} />
            </AnimatedPressable>
            {/* Step 2 of 2 */}
            <ProgressStepper steps={[{ label: 'Background' }, { label: 'Experiences' }]} currentStep={1} />
            <Text style={styles.title}>Share your experiences</Text>
            <Text style={styles.subtitle}>
              Help others by sharing what you've been through. Your experiences can guide
              someone in a similar situation.
            </Text>
          </Animated.View>

          {/* AI assistant chat (website parity: tell the bot your stories, it builds the timeline) */}
          <View style={styles.chatCard}>
            <View style={styles.chatHeader}>
              <Ionicons name="sparkles-outline" size={16} color={colors.secondary} />
              <Text style={styles.chatTitle}>AI assistant</Text>
            </View>
            <ScrollView
              style={styles.chatThreadScroll}
              showsVerticalScrollIndicator={false}
              nestedScrollEnabled={true}
            >
              <View style={styles.chatThread}>
                {messages.map((m) =>
                  m.role === 'user' ? (
                    <View key={m.id} style={styles.chatBubbleUserWrap}>
                      <View style={styles.chatBubbleUser}>
                        <Text style={styles.chatBubbleUserText}>{m.content}</Text>
                      </View>
                    </View>
                  ) : (
                    <View key={m.id} style={styles.chatBubbleAi}>
                      <Markdown>{m.content}</Markdown>
                    </View>
                  )
                )}
                {chatLoading && (
                  <ActivityIndicator size="small" color={colors.primary} style={{ alignSelf: 'flex-start' }} />
                )}
              </View>
            </ScrollView>
            <View style={styles.chatInputRow}>
              <TextInput
                style={styles.chatInput}
                value={chatInput}
                onChangeText={setChatInput}
                placeholder="Share your experience…"
                placeholderTextColor={colors.onSurfaceVariant}
                onSubmitEditing={sendChat}
                returnKeyType="send"
              />
              <TouchableOpacity
                style={[styles.chatSend, (!chatInput.trim() || chatLoading) && styles.chatSendDisabled]}
                onPress={sendChat}
                disabled={!chatInput.trim() || chatLoading}
              >
                <Ionicons name="send" size={16} color={colors.onPrimary} />
              </TouchableOpacity>
            </View>
          </View>

          {/* Existing experiences */}
          {experiences.length > 0 && (
            <View style={styles.experiencesList}>
              <Text style={styles.sectionLabel}>Your experiences ({experiences.length})</Text>
              {experiences.map((exp, index) => (
                <View key={index} style={styles.experienceCard}>
                  <View style={styles.experienceHeader}>
                    <View style={styles.milestoneBadge}>
                      <Text style={styles.milestoneBadgeText}>
                        {getMilestoneLabel(exp.milestone)}
                      </Text>
                    </View>
                    {exp.date && (
                      <Text style={styles.experienceDate}>{exp.date}</Text>
                    )}
                    <TouchableOpacity
                      style={styles.removeButton}
                      onPress={() => removeExperience(index)}
                    >
                      <Ionicons name="close-circle" size={22} color={colors.error} />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.experienceText} numberOfLines={3}>
                    {exp.experience}
                  </Text>
                  {exp.shared && (
                    <View style={styles.sharedBadge}>
                      <Ionicons name="people" size={14} color={colors.secondary} />
                      <Text style={styles.sharedBadgeText}>Shared with community</Text>
                    </View>
                  )}
                  {/* Generated facets - only for shared/published experiences */}
                  {exp.experience_case_id && expFacets[exp.experience_case_id] && (
                    <View style={styles.facetRow}>
                      {expFacets[exp.experience_case_id].visa.map((v) => (
                        <View key={`v${v}`} style={[styles.facetBadge, styles.facetVisa]}>
                          <Text style={styles.facetVisaText}>{v}</Text>
                        </View>
                      ))}
                      {expFacets[exp.experience_case_id].consulates.map((c) => (
                        <View key={`c${c}`} style={[styles.facetBadge, styles.facetConsulate]}>
                          <Text style={styles.facetConsulateText}>{c}</Text>
                        </View>
                      ))}
                      {!!expFacets[exp.experience_case_id].outcome && (
                        <View style={[styles.facetBadge, styles.facetConsulate]}>
                          <Text style={styles.facetConsulateText}>
                            {expFacets[exp.experience_case_id].outcome}
                          </Text>
                        </View>
                      )}
                      {expFacets[exp.experience_case_id].tags.slice(0, 5).map((t) => (
                        <View key={`t${t}`} style={[styles.facetBadge, styles.facetTag]}>
                          <Text style={styles.facetTagText}>{t}</Text>
                        </View>
                      ))}
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}

          {/* Add experience form */}
          {showAddForm ? (
            <View style={styles.addForm}>
              <Text style={styles.sectionLabel}>Add an experience</Text>

              {/* Milestone selection */}
              <Text style={styles.inputLabel}>What milestone?</Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={styles.milestoneScroll}
              >
                {MILESTONES.map((milestone) => (
                  <TouchableOpacity
                    key={milestone.key}
                    style={[
                      styles.milestoneChip,
                      selectedMilestone === milestone.key && styles.milestoneChipSelected,
                    ]}
                    onPress={() => setSelectedMilestone(milestone.key)}
                  >
                    <Text
                      style={[
                        styles.milestoneChipText,
                        selectedMilestone === milestone.key && styles.milestoneChipTextSelected,
                      ]}
                    >
                      {milestone.label}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>

              {/* Date input */}
              <Text style={styles.inputLabel}>When? (optional)</Text>
              <TextInput
                style={styles.input}
                value={experienceDate}
                onChangeText={setExperienceDate}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.onSurfaceVariant}
                autoComplete="off"
                textContentType="none"
              />

              {/* Experience text */}
              <Text style={styles.inputLabel}>What happened?</Text>
              <TextInput
                style={styles.textArea}
                value={experienceText}
                onChangeText={setExperienceText}
                placeholder="Share your experience... What went well? What would you do differently? Any tips for others?"
                placeholderTextColor={colors.onSurfaceVariant}
                multiline
                numberOfLines={5}
                maxLength={4000}
                textAlignVertical="top"
                autoComplete="off"
                textContentType="none"
              />
              <Text style={styles.charCount}>{experienceText.length}/4000</Text>

              {/* Share toggle */}
              <View style={styles.shareToggle}>
                <View style={styles.shareToggleText}>
                  <Ionicons name="people-outline" size={20} color={colors.onSurface} />
                  <Text style={styles.shareLabel}>Share with community</Text>
                </View>
                <Switch
                  value={shareExperience}
                  onValueChange={setShareExperience}
                  trackColor={{ false: colors.outlineVariant, true: colors.primaryContainer }}
                  thumbColor={shareExperience ? colors.primary : colors.surfaceContainerHigh}
                />
              </View>
              <Text style={styles.shareHint}>
                Shared experiences help others find people with similar journeys
              </Text>

              {/* Form buttons */}
              <View style={styles.formButtons}>
                <TouchableOpacity
                  style={[
                    styles.addButton,
                    (!selectedMilestone || !experienceText.trim()) && styles.addButtonDisabled,
                  ]}
                  onPress={addExperience}
                  disabled={!selectedMilestone || !experienceText.trim()}
                >
                  <Ionicons name="add" size={20} color={colors.onPrimary} />
                  <Text style={styles.addButtonText}>Add Experience</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.cancelButton} onPress={resetForm}>
                  <Text style={styles.cancelButtonText}>Cancel</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={styles.addExperienceButton}
              onPress={() => setShowAddForm(true)}
            >
              <Ionicons name="add-circle-outline" size={24} color={colors.primary} />
              <Text style={styles.addExperienceButtonText}>Add an experience</Text>
            </TouchableOpacity>
          )}

          {/* Suggested milestones */}
          {!showAddForm && experiences.length === 0 && (
            <View style={styles.suggestions}>
              <Text style={styles.suggestionsTitle}>Popular milestones to share:</Text>
              <View style={styles.suggestionChips}>
                {['visa_interview', 'h1b_approval', 'i140_approval', 'biometrics', 'green_card'].map(
                  (key) => (
                    <TouchableOpacity
                      key={key}
                      style={styles.suggestionChip}
                      onPress={() => {
                        setSelectedMilestone(key);
                        setShowAddForm(true);
                      }}
                    >
                      <Text style={styles.suggestionChipText}>{getMilestoneLabel(key)}</Text>
                    </TouchableOpacity>
                  )
                )}
              </View>
            </View>
          )}

          {/* Complete button */}
          <Animated.View style={styles.buttonContainer} entering={FadeInUp.delay(300).duration(400)}>
            <AnimatedPressable
              style={styles.primaryButton}
              onPress={handleComplete}
              haptics="medium"
              scaleTo={0.97}
            >
              <Text style={styles.primaryButtonText}>Complete Setup</Text>
              <Ionicons name="checkmark-circle" size={20} color={colors.onPrimary} />
            </AnimatedPressable>

            {experiences.length === 0 && (
              <AnimatedPressable style={styles.skipButton} onPress={handleComplete} haptics="light">
                <Text style={styles.skipButtonText}>Skip for now</Text>
              </AnimatedPressable>
            )}
          </Animated.View>

          {/* Info text */}
          <Text style={styles.infoText}>
            You can always add or edit your experiences later from your profile.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

// The illustration's own proportions, read from the asset, so the layout box can
// never squash it or reserve dead space around it.
const ONBOARDING_IMAGE = require('../../assets/onboardingimage2.png');
const { width: IMAGE_W, height: IMAGE_H } = Image.resolveAssetSource(ONBOARDING_IMAGE);
const ONBOARDING_IMAGE_RATIO = IMAGE_W / IMAGE_H;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.marginMobile,
    paddingBottom: spacing.xl,
  },
  chatCard: {
    backgroundColor: colors.surfaceContainerLow,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  chatHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.base },
  chatTitle: { fontSize: 13, fontWeight: '600', color: colors.onSurface },
  chatThreadScroll: { maxHeight: 280 },
  chatThread: { gap: spacing.base },
  chatBubbleUserWrap: { alignItems: 'flex-end' },
  chatBubbleUser: {
    backgroundColor: colors.primaryContainer,
    borderRadius: borderRadius.md,
    borderTopRightRadius: 4,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    maxWidth: '85%',
  },
  chatBubbleUserText: { fontSize: 14, color: colors.onPrimaryContainer },
  chatBubbleAi: {
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.md,
    borderTopLeftRadius: 4,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
    maxWidth: '90%',
    alignSelf: 'flex-start',
  },
  chatBubbleAiText: { fontSize: 14, color: colors.onSurface, lineHeight: 20 },
  chatInputRow: { flexDirection: 'row', gap: spacing.base, marginTop: spacing.md },
  chatInput: {
    flex: 1,
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    fontSize: 14,
    color: colors.onSurface,
  },
  chatSend: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatSendDisabled: { opacity: 0.4 },
  header: {
    marginBottom: spacing.md,
  },
  backButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surfaceContainerHigh,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  title: {
    ...typography.headlineLg,
    color: colors.onSurface,
    marginBottom: spacing.base,
  },
  subtitle: {
    ...typography.bodyMd,
    color: colors.onSurfaceVariant,
    lineHeight: 24,
  },
  experiencesList: {
    marginBottom: spacing.md,
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onSurface,
    marginBottom: spacing.sm,
  },
  experienceCard: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  experienceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: spacing.base,
    gap: 8,
  },
  milestoneBadge: {
    backgroundColor: colors.primaryContainer,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
  },
  milestoneBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.primary,
  },
  experienceDate: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    flex: 1,
  },
  removeButton: {
    padding: 4,
  },
  experienceText: {
    fontSize: 14,
    color: colors.onSurface,
    lineHeight: 20,
  },
  sharedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.base,
    gap: 4,
  },
  sharedBadgeText: {
    fontSize: 12,
    color: colors.secondary,
  },
  facetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: spacing.base },
  facetBadge: { borderRadius: borderRadius.full, paddingVertical: 2, paddingHorizontal: 8 },
  facetVisa: { backgroundColor: colors.primaryContainer },
  facetVisaText: { fontSize: 11, color: colors.onPrimaryContainer, fontWeight: '500' },
  facetConsulate: { backgroundColor: colors.secondaryContainer },
  facetConsulateText: { fontSize: 11, color: colors.onSecondaryContainer, fontWeight: '500' },
  facetTag: { backgroundColor: colors.surfaceContainerHigh },
  facetTagText: { fontSize: 11, color: colors.onSurfaceVariant },
  addForm: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  inputLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onSurface,
    marginBottom: spacing.base,
    marginTop: spacing.sm,
  },
  milestoneScroll: {
    marginBottom: spacing.sm,
  },
  milestoneChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceContainerHigh,
    marginRight: spacing.base,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  milestoneChipSelected: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  milestoneChipText: {
    fontSize: 13,
    color: colors.onSurface,
  },
  milestoneChipTextSelected: {
    color: colors.onPrimary,
    fontWeight: '500',
  },
  input: {
    backgroundColor: colors.surfaceContainerHigh,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.default,
    padding: spacing.sm,
    fontSize: 14,
    color: colors.onSurface,
  },
  textArea: {
    backgroundColor: colors.surfaceContainerHigh,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.default,
    padding: spacing.sm,
    fontSize: 14,
    color: colors.onSurface,
    minHeight: 120,
  },
  charCount: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    textAlign: 'right',
    marginTop: 4,
  },
  shareToggle: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.md,
  },
  shareToggleText: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  shareLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onSurface,
  },
  shareHint: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    marginTop: 4,
  },
  formButtons: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  addButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 12,
    borderRadius: borderRadius.default,
    gap: 6,
  },
  addButtonDisabled: {
    opacity: 0.5,
  },
  addButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  cancelButton: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceContainerHigh,
    paddingVertical: 12,
    borderRadius: borderRadius.default,
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onSurface,
  },
  addExperienceButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.primary,
    borderStyle: 'dashed',
    borderRadius: borderRadius.lg,
    paddingVertical: spacing.md,
    gap: 8,
    marginBottom: spacing.md,
  },
  addExperienceButtonText: {
    fontSize: 16,
    fontWeight: '500',
    color: colors.primary,
  },
  suggestions: {
    marginBottom: spacing.md,
  },
  suggestionsTitle: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
    marginBottom: spacing.sm,
  },
  suggestionChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  suggestionChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: colors.secondaryContainer,
    marginRight: spacing.base,
    marginBottom: spacing.base,
  },
  suggestionChipText: {
    fontSize: 13,
    color: colors.onSecondaryContainer,
  },
  buttonContainer: {
    marginTop: spacing.lg,
    gap: spacing.sm,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    paddingVertical: 16,
    borderRadius: borderRadius.default,
    gap: 8,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  skipButton: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  skipButtonText: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
  },
  infoText: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 18,
  },
});

export default ExperiencesOnboardingScreen;
