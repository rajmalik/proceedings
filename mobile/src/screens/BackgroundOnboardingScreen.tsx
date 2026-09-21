import React, { useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Image,
  Dimensions,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, Layout } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius, typography } from '../constants/theme';
import { AnimatedPressable } from '../components/AnimatedPressable';
import { ChipSelector } from '../components/ChipSelector';
import { ProgressStepper } from '../components/ProgressStepper';
import Markdown from '../components/Markdown';
import {
  VISA_CATEGORIES,
  CONSULATE_OPTIONS,
  TAGS,
  KEY_STAGES,
  STAGE_OUTCOMES,
  KEY_DATE_TYPES,
  OnboardingProfile,
  JourneyEntry,
  createEmptyProfile,
  toBackendProfile,
  fromBackendProfile,
} from '../constants/onboardingData';
import {
  getTagVocab,
  getProfile,
  onboardTurn,
  getActiveUserId,
  TagVocab,
  ConsulateCountry,
} from '../services/apiService';
import { ActivityIndicator, Alert } from 'react-native';

type Turn = { id: string; role: 'user' | 'ai'; content: string };

// Same greetings as the website's onboarding chat.
const GREETING_SETUP =
  "Hi! Let's set up the basics of your immigration profile - your current situation, journey and key dates. " +
  'Tell me about your situation (or fill in the sections below) and I\'ll turn it into tags. ' +
  "Please don't share personal details like your name, date of birth, or passport number.";

const GREETING_RETURNING =
  'Welcome back! Your current tags are below. Update them directly, edit your background and tap ' +
  '"Re-generate tags", or just tell me what changed (e.g. "my I-140 was approved on March 1") and ' +
  "I'll update the tags for you.";

export function BackgroundOnboardingScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const [profile, setProfile] = useState<OnboardingProfile>(createEmptyProfile());
  // All collapsible panels start CLOSED on load.
  const [expandedSections, setExpandedSections] = useState<{ [key: string]: boolean }>({
    status: false,
    applying: false,
    consulates: false,
    tags: false,
    stages: false,
    dates: false,
  });
  const [selectedStageKey, setSelectedStageKey] = useState('');
  const [selectedDateKey, setSelectedDateKey] = useState('');
  // Two-part consulate picker: type-to-filter a country, then pick a city.
  const [consQuery, setConsQuery] = useState('');
  const [consCountry, setConsCountry] = useState<ConsulateCountry | null>(null);

  // Live controlled vocabulary (falls back to the baked constants offline).
  const [vocab, setVocab] = useState<TagVocab | null>(null);
  useEffect(() => {
    getTagVocab().then(setVocab);
  }, []);

  // AI onboarding chat (website parity: POST /api/onboard, stage 'basics').
  const [messages, setMessages] = useState<Turn[]>([
    { id: 'greet', role: 'ai', content: GREETING_SETUP },
  ]);
  const [chatLoading, setChatLoading] = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);
  const [regenNote, setRegenNote] = useState('');
  const [saving, setSaving] = useState(false);
  // Existing journey is carried through so edits never wipe published experiences.
  const [journey, setJourney] = useState<JourneyEntry[]>([]);

  // Prefill from the saved profile (returning users get the "welcome back" greeting).
  useEffect(() => {
    if (!getActiveUserId()) return;
    getProfile()
      .then((p) => {
        const mapped = fromBackendProfile(p as never);
        const hasData =
          mapped.currentStatus.length > 0 ||
          mapped.applyingFor.length > 0 ||
          mapped.consulates.length > 0 ||
          mapped.tags.length > 0 ||
          Object.keys(mapped.keyStages).length > 0 ||
          Object.keys(mapped.keyDates).length > 0 ||
          mapped.backgroundText.trim().length > 0;
        if (hasData) {
          setProfile(mapped);
          setMessages([{ id: 'greet', role: 'ai', content: GREETING_RETURNING }]);
        }
        const j = (p as { journey?: JourneyEntry[] }).journey;
        if (Array.isArray(j)) setJourney(j);
      })
      .catch(() => {
        // New/unregistered user - keep the empty form + setup greeting.
      });
  }, []);

  // One assistant turn: the AI updates the tags below from the conversation.
  // Driven by the single "Describe your situation" box (website parity - there
  // is no separate chat input in the basics stage).
  const send = async (raw: string) => {
    const t = raw.trim();
    if (!t || chatLoading) return;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, role: 'user', content: t }]);
    setChatLoading(true);
    try {
      const data = await onboardTurn(
        'basics',
        [...history, { role: 'user', content: t }],
        toBackendProfile(profile, journey)
      );
      setMessages((prev) => [...prev, { id: `${Date.now()}-a`, role: 'ai', content: data.reply }]);
      setProfile(fromBackendProfile(data.profile));
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { id: `${Date.now()}-x`, role: 'ai', content: e instanceof Error ? e.message : 'Assistant error' },
      ]);
    } finally {
      setChatLoading(false);
    }
  };
  const askAssistant = () => send(profile.backgroundText);

  // Re-derive the tags from the free-text background (one-shot; website parity).
  const regenTags = async () => {
    const text = profile.backgroundText.trim();
    if (text.length < 10 || regenLoading) return;
    setRegenLoading(true);
    setRegenNote('');
    try {
      const data = await onboardTurn(
        'basics',
        [{ role: 'user', content: text }],
        toBackendProfile(profile, journey)
      );
      const mapped = fromBackendProfile(data.profile);
      setProfile({ ...mapped, backgroundText: mapped.backgroundText || text });
      setRegenNote('Tags updated from your background ✓');
    } catch (e) {
      setRegenNote(e instanceof Error ? e.message : 'Could not re-generate tags');
    } finally {
      setRegenLoading(false);
    }
  };
  const visaOptions = vocab?.visa?.length ? vocab.visa : VISA_CATEGORIES;
  const outcomeOptions = vocab?.outcome?.length ? vocab.outcome : STAGE_OUTCOMES;
  // Consulates: display existing chips by code (prefer the live vocab so country
  // codes like "IN" render as "India (IN)"; fall back to the baked city list).
  const consulateLabelByCode = useMemo(() => {
    const m = new Map(CONSULATE_OPTIONS.map((o) => [o.code, o.label]));
    (vocab?.consulate_options || []).forEach((o) => m.set(o.code, o.label));
    return m;
  }, [vocab]);
  // Grouped country → cities for the two-part picker (offline: degrade gracefully).
  const consulateTree = vocab?.consulate_tree || [];
  const countryMatches =
    consQuery.trim().length === 0
      ? []
      : consulateTree
          .filter(
            (c) =>
              c.country.toLowerCase().includes(consQuery.trim().toLowerCase()) ||
              c.country_code.toLowerCase().includes(consQuery.trim().toLowerCase())
          )
          .slice(0, 8);
  const addConsulate = (code: string) => {
    if (!code) return;
    setProfile((p) =>
      p.consulates.includes(code) ? p : { ...p, consulates: [...p.consulates, code] }
    );
  };
  const removeConsulate = (code: string) =>
    setProfile((p) => ({ ...p, consulates: p.consulates.filter((c) => c !== code) }));
  // Selecting a CITY marks BOTH its country and the city, then closes the section.
  const selectCity = (country: ConsulateCountry, cityCode: string) => {
    setProfile((p) => {
      const next = [...p.consulates];
      for (const code of [country.country_code, cityCode]) {
        if (code && !next.includes(code)) next.push(code);
      }
      return { ...p, consulates: next };
    });
    setConsCountry(null);
    setConsQuery('');
    setExpandedSections((prev) => ({ ...prev, consulates: false }));
  };
  // Adding country-wide also closes the section.
  const selectCountryWide = (country: ConsulateCountry) => {
    addConsulate(country.country_code);
    setConsCountry(null);
    setConsQuery('');
    setExpandedSections((prev) => ({ ...prev, consulates: false }));
  };

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({ ...prev, [section]: !prev[section] }));
  };

  const updateProfile = <K extends keyof OnboardingProfile>(
    key: K,
    value: OnboardingProfile[K]
  ) => {
    setProfile((prev) => ({ ...prev, [key]: value }));
  };

  const addKeyStage = (key: string, outcome: string) => {
    if (key && outcome) {
      setProfile((prev) => ({
        ...prev,
        keyStages: { ...prev.keyStages, [key]: outcome },
      }));
      setSelectedStageKey('');
    }
  };

  const removeKeyStage = (key: string) => {
    setProfile((prev) => {
      const newStages = { ...prev.keyStages };
      delete newStages[key];
      return { ...prev, keyStages: newStages };
    });
  };

  const addKeyDate = (key: string, date: string) => {
    if (key && date) {
      setProfile((prev) => ({
        ...prev,
        keyDates: { ...prev.keyDates, [key]: date },
      }));
      setSelectedDateKey('');
    }
  };

  const removeKeyDate = (key: string) => {
    setProfile((prev) => {
      const newDates = { ...prev.keyDates };
      delete newDates[key];
      return { ...prev, keyDates: newDates };
    });
  };

  // Basics are carried forward in navigation params and persisted together with
  // experiences when onboarding COMPLETES (ExperiencesOnboardingScreen writes the
  // full profile, including these basics). We deliberately do NOT write a partial
  // profile here: doing so made a step-1-only user look fully onboarded, so a
  // force-quit after step 1 skipped the Experiences stage forever on relaunch
  // (audit P0). The backend now only has profile data once onboarding is finished.
  const handleContinue = () => {
    navigation.navigate('ExperiencesOnboarding', { profile, journey });
  };

  const handleSkip = () => {
    navigation.navigate('ExperiencesOnboarding', { profile, journey, skipped: true });
  };

  const SectionHeader = ({
    title,
    section,
    count,
  }: {
    title: string;
    section: string;
    count?: number;
  }) => (
    <TouchableOpacity
      style={styles.sectionHeader}
      onPress={() => toggleSection(section)}
      activeOpacity={0.7}
    >
      <View style={styles.sectionHeaderLeft}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {count !== undefined && count > 0 && (
          <View style={styles.countBadge}>
            <Text style={styles.countText}>{count}</Text>
          </View>
        )}
      </View>
      <Ionicons
        name={expandedSections[section] ? 'chevron-up' : 'chevron-down'}
        size={20}
        color={colors.onSurfaceVariant}
      />
    </TouchableOpacity>
  );

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
          {/* Onboarding Image */}
          <View style={styles.imageContainer}>
            <Image
              source={require('../../assets/onboardingimage1.png')}
              style={styles.onboardingImage}
              resizeMode="contain"
            />
          </View>

          {/* Header */}
          <Animated.View style={styles.header} entering={FadeInDown.delay(100).duration(400)}>
            {/* Step 1 of 2 — users can finally see how long onboarding is. */}
            <ProgressStepper steps={[{ label: 'Background' }, { label: 'Experiences' }]} currentStep={0} />
            <Text style={styles.title}>Tell us about your journey</Text>
            <Text style={styles.subtitle}>
              This helps us connect you with others in similar situations
            </Text>
          </Animated.View>

          {/* AI assistant chat (website parity: chat → tags update below) */}
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
                {chatLoading && <ActivityIndicator size="small" color={colors.primary} style={{ alignSelf: 'flex-start' }} />}
              </View>
            </ScrollView>
            <Text style={styles.chatHint}>
              Describe your situation in the box below, then “Ask the assistant” or “Re-generate tags”.
            </Text>
          </View>

          {/* Background Text */}
          <View style={styles.inputContainer}>
            <Text style={styles.label}>Describe your situation</Text>
            <TextInput
              style={styles.textArea}
              value={profile.backgroundText}
              onChangeText={(text) => updateProfile('backgroundText', text)}
              placeholder="E.g., On H-1B from India, EB-2 PERM certified, I-140 filed, waiting for priority date..."
              placeholderTextColor={colors.onSurfaceVariant}
              multiline
              numberOfLines={4}
              maxLength={2000}
              textAlignVertical="top"
              autoComplete="off"
              textContentType="none"
            />
            <Text style={styles.charCount}>
              {profile.backgroundText.length}/2000
            </Text>
            {/* Website parity: the single box drives both buttons. */}
            <View style={styles.regenRow}>
              <TouchableOpacity
                style={[styles.regenButton, (regenLoading || profile.backgroundText.trim().length < 10) && styles.chatSendDisabled]}
                onPress={regenTags}
                disabled={regenLoading || profile.backgroundText.trim().length < 10}
              >
                <Ionicons name="color-wand-outline" size={16} color={colors.onPrimary} />
                <Text style={styles.regenButtonText}>{regenLoading ? 'Analyzing…' : 'Re-generate tags'}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.askButton, (chatLoading || profile.backgroundText.trim().length < 1) && styles.chatSendDisabled]}
                onPress={askAssistant}
                disabled={chatLoading || profile.backgroundText.trim().length < 1}
              >
                <Ionicons name="sparkles-outline" size={16} color={colors.onSecondaryContainer} />
                <Text style={styles.askButtonText}>Ask the assistant</Text>
              </TouchableOpacity>
              {!!regenNote && <Text style={styles.regenNote}>{regenNote}</Text>}
            </View>
          </View>

          {/* Current Status */}
          <View style={styles.section}>
            <SectionHeader
              title="Current Status"
              section="status"
              count={profile.currentStatus.length}
            />
            {expandedSections.status && (
              <ChipSelector
                label=""
                options={visaOptions}
                selectedValues={profile.currentStatus}
                onSelectionChange={(values) => updateProfile('currentStatus', values)}
              />
            )}
          </View>

          {/* Applying For */}
          <View style={styles.section}>
            <SectionHeader
              title="Applying For"
              section="applying"
              count={profile.applyingFor.length}
            />
            {expandedSections.applying && (
              <ChipSelector
                label=""
                options={visaOptions}
                selectedValues={profile.applyingFor}
                onSelectionChange={(values) => updateProfile('applyingFor', values)}
              />
            )}
          </View>

          {/* Consulates - two-part: type a country, then pick a city */}
          <View style={styles.section}>
            <SectionHeader
              title="Consulate(s)"
              section="consulates"
              count={profile.consulates.length}
            />
            {expandedSections.consulates && (
              <View style={styles.consulateBody}>
                {/* Selected consulate chips (country-wide codes + city codes) */}
                {profile.consulates.length > 0 && (
                  <View style={styles.chipsWrap}>
                    {profile.consulates.map((code) => (
                      <TouchableOpacity
                        key={code}
                        style={styles.consChip}
                        onPress={() => removeConsulate(code)}
                      >
                        <Text style={styles.consChipText}>{consulateLabelByCode.get(code) || code}</Text>
                        <Ionicons name="close" size={14} color={colors.onSurfaceVariant} />
                      </TouchableOpacity>
                    ))}
                  </View>
                )}

                {consulateTree.length > 0 ? (
                  <>
                    {/* 1) Country: type-to-filter (large list) */}
                    <TextInput
                      style={styles.consInput}
                      value={consQuery}
                      onChangeText={(t) => {
                        setConsQuery(t);
                        setConsCountry(null);
                      }}
                      placeholder="Type a country…"
                      placeholderTextColor={colors.onSurfaceVariant}
                      autoCapitalize="words"
                      autoCorrect={false}
                    />
                    {!consCountry && countryMatches.length > 0 && (
                      <View style={styles.suggestWrap}>
                        {countryMatches.map((c) => (
                          <TouchableOpacity
                            key={c.country_code || c.country}
                            style={styles.suggestChip}
                            onPress={() => {
                              setConsCountry(c);
                              setConsQuery(`${c.country} (${c.country_code})`);
                            }}
                          >
                            <Text style={styles.suggestChipText}>
                              {c.country} ({c.country_code})
                            </Text>
                          </TouchableOpacity>
                        ))}
                      </View>
                    )}

                    {/* 2) Country-wide add + fixed city dropdown (no typing) */}
                    {consCountry && (
                      <View style={styles.cityBlock}>
                        {!!consCountry.country_code && (
                          <TouchableOpacity
                            style={styles.countryWideButton}
                            onPress={() => selectCountryWide(consCountry)}
                          >
                            <Ionicons name="globe-outline" size={14} color={colors.onSecondaryContainer} />
                            <Text style={styles.countryWideText}>
                              Add {consCountry.country} (country-wide)
                            </Text>
                          </TouchableOpacity>
                        )}
                        {consCountry.cities.length > 0 && (
                          <>
                            <Text style={styles.cityLabel}>Cities in {consCountry.country}</Text>
                            <View style={styles.chipsWrap}>
                              {consCountry.cities.map((city) => {
                                const active = profile.consulates.includes(city.code);
                                return (
                                  <TouchableOpacity
                                    key={city.code}
                                    style={[styles.cityChip, active && styles.cityChipActive]}
                                    onPress={() => selectCity(consCountry, city.code)}
                                  >
                                    <Text style={[styles.cityChipText, active && styles.cityChipTextActive]}>
                                      {city.city} ({city.code})
                                    </Text>
                                  </TouchableOpacity>
                                );
                              })}
                            </View>
                          </>
                        )}
                      </View>
                    )}
                  </>
                ) : (
                  /* Offline fallback: flat city list from the baked options */
                  <ChipSelector
                    label=""
                    options={CONSULATE_OPTIONS.map((o) => o.label)}
                    selectedValues={profile.consulates.map((c) => consulateLabelByCode.get(c) || c)}
                    onSelectionChange={(labels) => {
                      const codeByLabel = new Map(CONSULATE_OPTIONS.map((o) => [o.label, o.code]));
                      updateProfile('consulates', labels.map((l) => codeByLabel.get(l) || l));
                    }}
                  />
                )}
              </View>
            )}
          </View>

          {/* Tags */}
          <View style={styles.section}>
            <SectionHeader
              title="Tags"
              section="tags"
              count={profile.tags.length}
            />
            {expandedSections.tags && (
              <ChipSelector
                label=""
                options={TAGS}
                selectedValues={profile.tags}
                onSelectionChange={(values) => updateProfile('tags', values)}
              />
            )}
          </View>

          {/* Key Stages */}
          <View style={styles.section}>
            <SectionHeader
              title="Key Stages"
              section="stages"
              count={Object.keys(profile.keyStages).length}
            />
            {expandedSections.stages && (
              <View style={styles.keyValueSection}>
                {/* Existing stages */}
                {Object.entries(profile.keyStages).map(([key, value]) => (
                  <View key={key} style={styles.keyValueItem}>
                    <Text style={styles.keyValueText}>
                      {KEY_STAGES.find((s) => s.key === key)?.label || key}: {value}
                    </Text>
                    <TouchableOpacity onPress={() => removeKeyStage(key)}>
                      <Ionicons name="close-circle" size={20} color={colors.error} />
                    </TouchableOpacity>
                  </View>
                ))}

                {/* Add new stage */}
                <View style={styles.addKeyValueRow}>
                  <View style={styles.pickerWrapper}>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                      {KEY_STAGES.filter((s) => !profile.keyStages[s.key]).map((stage) => (
                        <TouchableOpacity
                          key={stage.key}
                          style={[
                            styles.miniChip,
                            selectedStageKey === stage.key && styles.miniChipSelected,
                          ]}
                          onPress={() => setSelectedStageKey(stage.key)}
                        >
                          <Text
                            style={[
                              styles.miniChipText,
                              selectedStageKey === stage.key && styles.miniChipTextSelected,
                            ]}
                          >
                            {stage.label}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </ScrollView>
                  </View>
                  {selectedStageKey && (
                    <View style={styles.outcomeRow}>
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        {outcomeOptions.map((outcome) => (
                          <TouchableOpacity
                            key={outcome}
                            style={styles.outcomeChip}
                            onPress={() => addKeyStage(selectedStageKey, outcome)}
                          >
                            <Text style={styles.outcomeChipText}>{outcome}</Text>
                          </TouchableOpacity>
                        ))}
                      </ScrollView>
                    </View>
                  )}
                </View>
              </View>
            )}
          </View>

          {/* Key Dates */}
          <View style={styles.section}>
            <SectionHeader
              title="Key Dates"
              section="dates"
              count={Object.keys(profile.keyDates).length}
            />
            {expandedSections.dates && (
              <View style={styles.keyValueSection}>
                {/* Existing dates */}
                {Object.entries(profile.keyDates).map(([key, value]) => (
                  <View key={key} style={styles.keyValueItem}>
                    <Text style={styles.keyValueText}>
                      {KEY_DATE_TYPES.find((d) => d.key === key)?.label || key}: {value}
                    </Text>
                    <TouchableOpacity onPress={() => removeKeyDate(key)}>
                      <Ionicons name="close-circle" size={20} color={colors.error} />
                    </TouchableOpacity>
                  </View>
                ))}

                {/* Add new date */}
                <View style={styles.addKeyValueRow}>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                    {KEY_DATE_TYPES.filter((d) => !profile.keyDates[d.key]).map((dateType) => (
                      <TouchableOpacity
                        key={dateType.key}
                        style={[
                          styles.miniChip,
                          selectedDateKey === dateType.key && styles.miniChipSelected,
                        ]}
                        onPress={() => setSelectedDateKey(dateType.key)}
                      >
                        <Text
                          style={[
                            styles.miniChipText,
                            selectedDateKey === dateType.key && styles.miniChipTextSelected,
                          ]}
                        >
                          {dateType.label}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </ScrollView>
                  {selectedDateKey && (
                    <TextInput
                      style={styles.dateInput}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={colors.onSurfaceVariant}
                      onSubmitEditing={(e) => {
                        const date = e.nativeEvent.text;
                        if (date.match(/^\d{4}-\d{2}-\d{2}$/)) {
                          addKeyDate(selectedDateKey, date);
                        }
                      }}
                      autoComplete="off"
                      textContentType="none"
                    />
                  )}
                </View>
              </View>
            )}
          </View>

          {/* Buttons */}
          <Animated.View style={styles.buttonContainer} entering={FadeInUp.delay(300).duration(400)}>
            <AnimatedPressable
              style={[styles.primaryButton, saving && { opacity: 0.6 }]}
              onPress={handleContinue}
              disabled={saving}
              haptics="medium"
              scaleTo={0.97}
            >
              <Text style={styles.primaryButtonText}>{saving ? 'Saving…' : 'Continue'}</Text>
              <Ionicons name="arrow-forward" size={20} color={colors.onPrimary} />
            </AnimatedPressable>

            <AnimatedPressable style={styles.skipButton} onPress={handleSkip} haptics="light">
              <Text style={styles.skipButtonText}>Skip for now</Text>
            </AnimatedPressable>
          </Animated.View>

          {/* Privacy notice */}
          <Text style={styles.privacyText}>
            Your information is private by default. You can choose to share specific
            experiences with the community later.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const { width: SCREEN_WIDTH } = Dimensions.get('window');

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
  imageContainer: {
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  onboardingImage: {
    width: SCREEN_WIDTH * 0.7,
    height: SCREEN_WIDTH * 0.5,
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
  regenRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.base, marginTop: spacing.base, flexWrap: 'wrap' },
  regenButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.secondary,
    borderRadius: borderRadius.full,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
  },
  regenButtonText: { color: colors.onPrimary, fontWeight: '600', fontSize: 13 },
  regenNote: { fontSize: 12, color: colors.primary },
  chatHint: { fontSize: 12, color: colors.onSurfaceVariant, marginTop: spacing.base, fontStyle: 'italic' },
  askButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: colors.secondaryContainer,
    borderRadius: borderRadius.full,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
  },
  askButtonText: { color: colors.onSecondaryContainer, fontWeight: '600', fontSize: 13 },
  consulateBody: { marginTop: spacing.base, gap: spacing.base },
  chipsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.base },
  consChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: colors.secondaryContainer,
    borderRadius: borderRadius.full,
    paddingVertical: 5,
    paddingHorizontal: spacing.md,
  },
  consChipText: { fontSize: 12, color: colors.onSecondaryContainer, fontWeight: '500' },
  consInput: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
    fontSize: 14,
    color: colors.onSurface,
  },
  suggestWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.base },
  suggestChip: {
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
  },
  suggestChipText: { fontSize: 13, color: colors.onSurface },
  cityBlock: { gap: spacing.base },
  countryWideButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    alignSelf: 'flex-start',
    backgroundColor: colors.secondaryContainer,
    borderRadius: borderRadius.full,
    paddingVertical: 7,
    paddingHorizontal: spacing.md,
  },
  countryWideText: { fontSize: 13, color: colors.onSecondaryContainer, fontWeight: '600' },
  cityLabel: { fontSize: 11, textTransform: 'uppercase', color: colors.onSurfaceVariant },
  cityChip: {
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
  },
  cityChipActive: { backgroundColor: colors.primary },
  cityChipText: { fontSize: 13, color: colors.onSurface },
  cityChipTextActive: { color: colors.onPrimary, fontWeight: '600' },
  header: {
    marginBottom: spacing.md,
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
  inputContainer: {
    marginBottom: spacing.md,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.onSurface,
    marginBottom: spacing.base,
  },
  textArea: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.lg,
    padding: spacing.sm,
    fontSize: 16,
    color: colors.onSurface,
    minHeight: 120,
  },
  charCount: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    textAlign: 'right',
    marginTop: 4,
  },
  section: {
    marginBottom: spacing.sm,
    backgroundColor: colors.surfaceContainerLowest,
    borderRadius: borderRadius.lg,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    overflow: 'hidden',
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.sm,
    backgroundColor: colors.surfaceContainerLow,
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.onSurface,
  },
  countBadge: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  countText: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  keyValueSection: {
    padding: spacing.sm,
  },
  keyValueItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: colors.surfaceContainerHigh,
    padding: spacing.sm,
    borderRadius: borderRadius.default,
    marginBottom: spacing.base,
  },
  keyValueText: {
    fontSize: 14,
    color: colors.onSurface,
    flex: 1,
  },
  addKeyValueRow: {
    marginTop: spacing.base,
  },
  pickerWrapper: {
    marginBottom: spacing.base,
  },
  miniChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceContainerHigh,
    marginRight: spacing.base,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  miniChipSelected: {
    backgroundColor: colors.primaryContainer,
    borderColor: colors.primary,
  },
  miniChipText: {
    fontSize: 13,
    color: colors.onSurface,
  },
  miniChipTextSelected: {
    color: colors.primary,
    fontWeight: '500',
  },
  outcomeRow: {
    marginTop: spacing.base,
  },
  outcomeChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: borderRadius.full,
    backgroundColor: colors.secondaryContainer,
    marginRight: spacing.base,
  },
  outcomeChipText: {
    fontSize: 13,
    color: colors.onSecondaryContainer,
  },
  dateInput: {
    backgroundColor: colors.surfaceContainerHigh,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.default,
    padding: spacing.sm,
    marginTop: spacing.base,
    fontSize: 14,
    color: colors.onSurface,
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
  privacyText: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    marginTop: spacing.md,
    lineHeight: 18,
  },
});

export default BackgroundOnboardingScreen;
