import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  TouchableOpacity,
  RefreshControl,
  Linking,
  Alert,
  Switch,
  TextInput,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { Header, Card, Badge, Button, Markdown } from '../components';
import { colors, spacing, borderRadius, typography } from '../constants/theme';
import { useAuth } from '../contexts/AuthContext';
import { useAIConsent } from '../contexts/AIConsentContext';
import { getProfile, getCachedProfile, clearProfileCache, getActiveUserId, deleteAccount, updateProfile } from '../services/apiService';
import { useExperienceFacets } from '../hooks/useExperienceFacets';
import { ProfileActivity } from '../components/ProfileActivity';

// Profile data interface matching backend
interface JourneyEntry {
  milestone: string;
  date: string;
  experience: string;
  shared: boolean;
  experience_case_id?: string;
}

interface UserProfile {
  username?: string;
  current_visa_or_greencard_category?: string[];
  visa_applying_for?: string[];
  primary_consulate?: string;
  consulates?: string[];
  tags?: string[];
  key_stages_or_info?: Record<string, string>;
  key_dates?: Record<string, string>;
  background_text?: string;
  journey?: JourneyEntry[];
  created_at?: string;
  updated_at?: string;
}

export function ProfileScreen() {
  const navigation = useNavigation();
  // Hidden when Profile is a bottom-tab root (nothing to go back to); shown when
  // pushed from another stack via the header profile icon.
    const { signOut } = useAuth();
  const { hasAIConsent, grantAIConsent, declineAIConsent } = useAIConsent();

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [expandedMilestones, setExpandedMilestones] = useState<Set<number>>(new Set());
  const [signingOut, setSigningOut] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Username (anonymous handle) editing.
  const [editingUsername, setEditingUsername] = useState(false);
  const [usernameDraft, setUsernameDraft] = useState('');
  const [savingUsername, setSavingUsername] = useState(false);

  const startEditUsername = () => {
    setUsernameDraft(profile?.username || '');
    setEditingUsername(true);
  };

  const saveUsername = async () => {
    const next = usernameDraft.trim().slice(0, 40);
    if (!next || next.includes('@')) {
      Alert.alert('Invalid handle', 'Pick a handle with no email address (up to 40 characters).');
      return;
    }
    if (next === profile?.username) {
      setEditingUsername(false);
      return;
    }
    setSavingUsername(true);
    try {
      // Send the full profile so the backend's full-overwrite save keeps every
      // other field; only the username changes.
      await updateProfile({ ...(profile || {}), username: next });
      setProfile((p) => (p ? { ...p, username: next } : p));
      setEditingUsername(false);
    } catch (e) {
      Alert.alert('Could not update', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setSavingUsername(false);
    }
  };

  // Generated facets for each shared/published experience (website parity).
  const expFacets = useExperienceFacets(profile?.journey);

  // Load profile with cache-first approach for faster initial display
  const loadProfile = useCallback(async (showRefreshing = false) => {
    setError('');
    if (showRefreshing) {
      setRefreshing(true);
    }
    try {
      const data = await getProfile();
      setProfile(data as UserProfile);
    } catch (e) {
      // Only show error if we don't have cached data
      if (!profile) {
        setError(e instanceof Error ? e.message : 'Could not load profile');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [profile]);

  useEffect(() => {
    let mounted = true;

    const initProfile = async () => {
      // First, try to show cached data immediately
      const cached = await getCachedProfile();
      if (cached && mounted) {
        setProfile(cached as UserProfile);
        setLoading(false);
      }

      // Then fetch fresh data in background
      try {
        const fresh = await getProfile();
        if (mounted) {
          setProfile(fresh as UserProfile);
        }
      } catch (e) {
        // Only show error if we don't have any data
        if (mounted && !cached) {
          setError(e instanceof Error ? e.message : 'Could not load profile');
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    initProfile();

    return () => {
      mounted = false;
    };
  }, []);

  const onRefresh = useCallback(() => {
    loadProfile(true);
  }, [loadProfile]);

  const toggleMilestone = (index: number) => {
    setExpandedMilestones((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleSignOut = async () => {
    setSigningOut(true);
    try {
      // Clear cached profile data
      await clearProfileCache();
      await signOut();
      // Navigation will auto-redirect to auth screen via MainNavigator
    } catch (e) {
      setError('Failed to sign out');
      setSigningOut(false);
    }
  };

  const handleDeleteAccount = () => {
    Alert.alert(
      'Delete Account',
      'Are you sure you want to delete your account? This action cannot be undone. All your data, posts, replies, and group memberships will be permanently removed.',
      [
        {
          text: 'Cancel',
          style: 'cancel',
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: confirmDeleteAccount,
        },
      ]
    );
  };

  const confirmDeleteAccount = async () => {
    setDeleting(true);
    setError('');
    try {
      await deleteAccount();
      // Clear local data
      await clearProfileCache();
      // Sign out (this clears auth state and navigates to signup)
      await signOut();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete account');
      setDeleting(false);
    }
  };

  const formatDate = (dateStr: string | undefined) => {
    if (!dateStr) return '';
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const formatLabel = (key: string) => {
    return key
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const hasData = (arr?: string[] | unknown[]) => arr && arr.length > 0;
  const hasObject = (obj?: Record<string, unknown>) => obj && Object.keys(obj).length > 0;

  if (loading) {
    return (
      <View style={styles.container}>
        <Header
          title="Profile"
          showLogo={false}
          transparent
                  />
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={styles.loadingText}>Loading profile...</Text>
        </View>
      </View>
    );
  }

  if (error && !profile) {
    return (
      <View style={styles.container}>
        <Header
          title="Profile"
          showLogo={false}
          transparent
                  />
        <View style={styles.errorContainer}>
          <Ionicons name="alert-circle" size={48} color={colors.error} />
          <Text style={styles.errorText}>{error}</Text>
          <Button variant="secondary" onPress={loadProfile}>
            Try Again
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Header
        title="Profile"
        showLogo={false}
        transparent
      />
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} />
        }
      >
        {/* Account Section */}
        <Card style={styles.section}>
          <View style={styles.accountHeader}>
            <View style={styles.avatarContainer}>
              <Ionicons name="person-circle" size={64} color={colors.primary} />
            </View>
            <View style={styles.accountInfo}>
              {editingUsername ? (
                <>
                  <View style={styles.usernameEditRow}>
                    <TextInput
                      style={styles.usernameInput}
                      value={usernameDraft}
                      onChangeText={setUsernameDraft}
                      autoCapitalize="none"
                      autoCorrect={false}
                      maxLength={40}
                      placeholder="Pick a handle"
                      placeholderTextColor={colors.onSurfaceVariant}
                      editable={!savingUsername}
                    />
                    <TouchableOpacity
                      onPress={saveUsername}
                      disabled={savingUsername}
                      hitSlop={8}
                      accessibilityLabel="Save handle"
                    >
                      {savingUsername ? (
                        <ActivityIndicator size="small" color={colors.primary} />
                      ) : (
                        <Ionicons name="checkmark" size={22} color={colors.primary} />
                      )}
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => setEditingUsername(false)}
                      disabled={savingUsername}
                      hitSlop={8}
                      accessibilityLabel="Cancel"
                    >
                      <Ionicons name="close" size={22} color={colors.onSurfaceVariant} />
                    </TouchableOpacity>
                  </View>
                  <Text style={styles.usernameHint}>
                    This is public — don't use your real name.
                  </Text>
                </>
              ) : (
                <View style={styles.usernameRow}>
                  <Text style={styles.username}>
                    {profile?.username || 'Anonymous User'}
                  </Text>
                  <TouchableOpacity
                    onPress={startEditUsername}
                    hitSlop={8}
                    accessibilityLabel="Edit handle"
                  >
                    <Ionicons name="pencil" size={16} color={colors.onSurfaceVariant} />
                  </TouchableOpacity>
                </View>
              )}
              {profile?.created_at && (
                <Text style={styles.memberSince}>
                  Member since {formatDate(profile.created_at)}
                </Text>
              )}
            </View>
          </View>
          {/* Edit affordance (website parity: "Edit Profile" → onboarding) */}
          <TouchableOpacity
            style={styles.editButton}
            onPress={() => (navigation as any).navigate('BackgroundOnboarding')}
          >
            <Ionicons name="create-outline" size={16} color={colors.onPrimary} />
            <Text style={styles.editButtonText}>Edit Profile</Text>
          </TouchableOpacity>
        </Card>

        {/* Empty state (website parity) */}
        {!profile?.current_visa_or_greencard_category?.length &&
          !profile?.visa_applying_for?.length &&
          !profile?.consulates?.length &&
          !profile?.tags?.length &&
          !Object.keys(profile?.key_stages_or_info || {}).length &&
          !Object.keys(profile?.key_dates || {}).length &&
          !profile?.background_text &&
          !profile?.journey?.length && (
            <Card style={styles.section}>
              <View style={styles.emptyState}>
                <Ionicons name="person-add-outline" size={48} color={colors.onSurfaceVariant} />
                <Text style={styles.emptyTitle}>No profile set up yet</Text>
                <Text style={styles.emptyStateText}>
                  Tell us about your immigration journey to get personalized help and connect with
                  others in similar situations.
                </Text>
                <TouchableOpacity
                  style={styles.editButton}
                  onPress={() => (navigation as any).navigate('BackgroundOnboarding')}
                >
                  <Text style={styles.editButtonText}>Set Up Your Profile</Text>
                </TouchableOpacity>
              </View>
            </Card>
          )}

        {/* Visa Status Section */}
        <Card style={styles.section}>
          <Text style={styles.sectionTitle}>Visa Status</Text>

          {hasData(profile?.current_visa_or_greencard_category) ? (
            <View style={styles.subsection}>
              <Text style={styles.subsectionTitle}>Current Status</Text>
              <View style={styles.badgeRow}>
                {profile!.current_visa_or_greencard_category!.map((visa, idx) => (
                  <Badge key={idx} variant="primary" style={styles.badge}>
                    {visa}
                  </Badge>
                ))}
              </View>
            </View>
          ) : null}

          {hasData(profile?.visa_applying_for) ? (
            <View style={styles.subsection}>
              <Text style={styles.subsectionTitle}>Applying For</Text>
              <View style={styles.badgeRow}>
                {profile!.visa_applying_for!.map((visa, idx) => (
                  <Badge key={idx} variant="info" style={styles.badge}>
                    {visa}
                  </Badge>
                ))}
              </View>
            </View>
          ) : null}

          {!hasData(profile?.current_visa_or_greencard_category) &&
           !hasData(profile?.visa_applying_for) && (
            <Text style={styles.emptyText}>No visa status set</Text>
          )}
        </Card>

        {/* Consulates Section */}
        <Card style={styles.section}>
          <Text style={styles.sectionTitle}>Consulates</Text>

          {profile?.primary_consulate ? (
            <View style={styles.subsection}>
              <View style={styles.consulate}>
                <Ionicons name="location" size={18} color={colors.primary} />
                <Text style={styles.primaryConsulate}>
                  {profile.primary_consulate}
                </Text>
                <Badge variant="primary" style={styles.primaryBadge}>Primary</Badge>
              </View>
            </View>
          ) : null}

          {hasData(profile?.consulates) ? (
            <View style={styles.subsection}>
              <View style={styles.badgeRow}>
                {profile!.consulates!
                  .filter(c => c !== profile?.primary_consulate)
                  .map((consulate, idx) => (
                    <Badge key={idx} variant="outline" style={styles.badge}>
                      {consulate}
                    </Badge>
                  ))}
              </View>
            </View>
          ) : null}

          {!profile?.primary_consulate && !hasData(profile?.consulates) && (
            <Text style={styles.emptyText}>No consulates set</Text>
          )}
        </Card>

        {/* Key Information Section */}
        {hasObject(profile?.key_stages_or_info) && (
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Key Information</Text>
            {Object.entries(profile!.key_stages_or_info!).map(([key, value], idx) => (
              <View key={idx} style={styles.infoRow}>
                <Text style={styles.infoLabel}>{formatLabel(key)}</Text>
                <Badge variant="default">{value}</Badge>
              </View>
            ))}
          </Card>
        )}

        {/* Key Dates Section */}
        {hasObject(profile?.key_dates) && (
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Key Dates</Text>
            {Object.entries(profile!.key_dates!).map(([key, value], idx) => (
              <View key={idx} style={styles.infoRow}>
                <Text style={styles.infoLabel}>{formatLabel(key)}</Text>
                <Text style={styles.dateValue}>{formatDate(value)}</Text>
              </View>
            ))}
          </Card>
        )}

        {/* Tags Section */}
        {hasData(profile?.tags) && (
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Topics & Interests</Text>
            <View style={styles.badgeRow}>
              {profile!.tags!.map((tag, idx) => (
                <Badge key={idx} variant="outline" style={styles.badge}>
                  {tag}
                </Badge>
              ))}
            </View>
          </Card>
        )}

        {/* Background Section */}
        {profile?.background_text && (
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Background</Text>
            <Markdown>{profile.background_text}</Markdown>
          </Card>
        )}

        {/* Journey Timeline Section */}
        {hasData(profile?.journey) && (
          <Card style={styles.section}>
            <Text style={styles.sectionTitle}>Immigration Journey</Text>
            <View style={styles.timeline}>
              {profile!.journey!.map((entry, idx) => (
                <View key={idx} style={styles.timelineItem}>
                  <View style={styles.timelineDot} />
                  {idx < profile!.journey!.length - 1 && (
                    <View style={styles.timelineLine} />
                  )}
                  <TouchableOpacity
                    style={styles.timelineContent}
                    onPress={() => toggleMilestone(idx)}
                    activeOpacity={0.7}
                  >
                    <View style={styles.timelineHeader}>
                      <Text style={styles.milestoneName}>
                        {formatLabel(entry.milestone)}
                      </Text>
                      <Ionicons
                        name={expandedMilestones.has(idx) ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color={colors.outline}
                      />
                    </View>
                    {entry.date && (
                      <Text style={styles.milestoneDate}>
                        {formatDate(entry.date)}
                      </Text>
                    )}
                    {entry.shared && (
                      <Badge variant="success" style={styles.sharedBadge}>
                        Shared
                      </Badge>
                    )}
                    {expandedMilestones.has(idx) && entry.experience && (
                      <Text style={styles.experienceText}>{entry.experience}</Text>
                    )}
                    {/* Generated facets — only for shared/published experiences */}
                    {entry.experience_case_id && expFacets[entry.experience_case_id] && (
                      <View style={styles.facetRow}>
                        {expFacets[entry.experience_case_id].visa.map((v) => (
                          <View key={`v${v}`} style={[styles.facetBadge, styles.facetVisa]}>
                            <Text style={styles.facetVisaText}>{v}</Text>
                          </View>
                        ))}
                        {expFacets[entry.experience_case_id].consulates.map((c) => (
                          <View key={`c${c}`} style={[styles.facetBadge, styles.facetConsulate]}>
                            <Text style={styles.facetConsulateText}>{c}</Text>
                          </View>
                        ))}
                        {!!expFacets[entry.experience_case_id].outcome && (
                          <View style={[styles.facetBadge, styles.facetOutcome]}>
                            <Text style={styles.facetOutcomeText}>
                              {expFacets[entry.experience_case_id].outcome}
                            </Text>
                          </View>
                        )}
                        {expFacets[entry.experience_case_id].tags.slice(0, 5).map((t) => (
                          <View key={`t${t}`} style={[styles.facetBadge, styles.facetTag]}>
                            <Text style={styles.facetTagText}>{t}</Text>
                          </View>
                        ))}
                      </View>
                    )}
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          </Card>
        )}

        {/* The logged-in user's own activity on the portal */}
        <ProfileActivity
          uid={getActiveUserId() || ''}
          onOpenPosting={(cid) => (navigation as any).navigate('CaseDetails', { caseId: cid })}
          onOpenGroup={(gid, name) => (navigation as any).navigate('GroupChat', { groupId: gid, groupName: name })}
        />

        {/* Sign Out Button */}
        <View style={styles.signOutContainer}>
          <Button
            variant="secondary"
            fullWidth
            onPress={handleSignOut}
            loading={signingOut}
            icon={<Ionicons name="log-out-outline" size={20} color={colors.onSurface} />}
            iconPosition="left"
          >
            Sign Out
          </Button>
        </View>

        {/* Delete Account Button */}
        <View style={styles.deleteContainer}>
          <TouchableOpacity
            style={styles.deleteButton}
            onPress={handleDeleteAccount}
            disabled={deleting}
          >
            {deleting ? (
              <ActivityIndicator size="small" color={colors.error} />
            ) : (
              <>
                <Ionicons name="trash-outline" size={18} color={colors.error} />
                <Text style={styles.deleteButtonText}>Delete Account</Text>
              </>
            )}
          </TouchableOpacity>
        </View>

        {/* AI data-sharing consent (App Store 5.1.1(i)/5.1.2(i)) */}
        <View style={styles.aiRow}>
          <Ionicons name="sparkles-outline" size={18} color={colors.onSurfaceVariant} />
          <View style={styles.aiRowText}>
            <Text style={styles.legalRowText}>AI answers</Text>
            <Text style={styles.aiRowNote}>
              Send your questions and profile details to Google’s Gemini AI to generate answers.
            </Text>
          </View>
          <Switch
            value={hasAIConsent}
            onValueChange={(v) => (v ? grantAIConsent() : declineAIConsent())}
            trackColor={{ false: colors.outlineVariant, true: colors.primary }}
          />
        </View>

        {/* Legal */}
        <TouchableOpacity
          style={styles.legalRow}
          onPress={() => (navigation as any).navigate('Disclaimer')}
        >
          <Ionicons name="shield-outline" size={18} color={colors.onSurfaceVariant} />
          <Text style={styles.legalRowText}>Legal Disclaimer</Text>
          <Ionicons name="chevron-forward" size={18} color={colors.onSurfaceVariant} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.legalRow}
          onPress={() => Linking.openURL('https://meridianjourney.ai/privacy')}
        >
          <Ionicons name="lock-closed-outline" size={18} color={colors.onSurfaceVariant} />
          <Text style={styles.legalRowText}>Privacy Policy</Text>
          <Ionicons name="open-outline" size={16} color={colors.onSurfaceVariant} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.legalRow}
          onPress={() => Linking.openURL('https://meridianjourney.ai/terms')}
        >
          <Ionicons name="document-text-outline" size={18} color={colors.onSurfaceVariant} />
          <Text style={styles.legalRowText}>Terms of Service</Text>
          <Ionicons name="open-outline" size={16} color={colors.onSurfaceVariant} />
        </TouchableOpacity>
        <Text style={styles.legalNote}>
Not legal advice. Meridian is not a law firm or government agency.
        </Text>

        <View style={styles.bottomPadding} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    padding: spacing.marginMobile,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    marginTop: spacing.sm,
    color: colors.onSurfaceVariant,
    fontSize: typography.bodyMd.fontSize,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.md,
  },
  errorText: {
    marginTop: spacing.sm,
    marginBottom: spacing.md,
    color: colors.error,
    fontSize: typography.bodyMd.fontSize,
    textAlign: 'center',
  },
  section: {
    marginBottom: spacing.marginMobile,
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onSurface,
    marginBottom: spacing.sm,
  },
  subsection: {
    marginTop: spacing.base,
  },
  subsectionTitle: {
    fontSize: typography.labelMd.fontSize,
    fontWeight: '500',
    color: colors.onSurfaceVariant,
    marginBottom: spacing.xs,
  },
  editButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingVertical: 10,
    paddingHorizontal: spacing.md,
    marginTop: spacing.md,
  },
  editButtonText: { color: colors.onPrimary, fontWeight: '600', fontSize: 14 },
  aiRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  aiRowText: { flex: 1 },
  aiRowNote: {
    fontSize: typography.caption.fontSize,
    color: colors.onSurfaceVariant,
    marginTop: 2,
    lineHeight: 16,
  },
  legalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    marginTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  legalRowText: {
    flex: 1,
    fontSize: typography.bodyMd.fontSize,
    color: colors.onSurface,
    fontWeight: '500',
  },
  legalNote: {
    fontSize: typography.caption.fontSize,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    marginTop: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  emptyState: { alignItems: 'center', paddingVertical: spacing.md },
  emptyTitle: { fontSize: 17, fontWeight: '600', color: colors.onSurface, marginTop: spacing.base },
  emptyStateText: {
    fontSize: 13,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    marginTop: spacing.base,
  },
  accountHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  avatarContainer: {
    marginRight: spacing.sm,
  },
  accountInfo: {
    flex: 1,
  },
  username: {
    fontSize: 20,
    fontWeight: '600',
    color: colors.onSurface,
  },
  usernameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  usernameEditRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  usernameInput: {
    flex: 1,
    fontSize: 18,
    fontWeight: '600',
    color: colors.onSurface,
    borderBottomWidth: 1,
    borderBottomColor: colors.outline,
    paddingVertical: 2,
  },
  usernameHint: {
    fontSize: typography.caption.fontSize,
    color: colors.onSurfaceVariant,
    marginTop: 4,
  },
  memberSince: {
    fontSize: typography.caption.fontSize,
    color: colors.outline,
    marginTop: 4,
  },
  badgeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.base,
  },
  badge: {
    marginBottom: 4,
  },
  emptyText: {
    fontSize: typography.bodyMd.fontSize,
    color: colors.outline,
    fontStyle: 'italic',
  },
  consulate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
  },
  primaryConsulate: {
    fontSize: typography.bodyMd.fontSize,
    fontWeight: '500',
    color: colors.onSurface,
    flex: 1,
  },
  primaryBadge: {
    marginLeft: 'auto',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.base,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  infoLabel: {
    fontSize: typography.bodyMd.fontSize,
    color: colors.onSurfaceVariant,
    flex: 1,
  },
  dateValue: {
    fontSize: typography.bodyMd.fontSize,
    fontWeight: '500',
    color: colors.onSurface,
  },
  backgroundText: {
    fontSize: typography.bodyMd.fontSize,
    color: colors.onSurface,
    lineHeight: typography.bodyMd.lineHeight,
  },
  timeline: {
    marginTop: spacing.base,
  },
  timelineItem: {
    flexDirection: 'row',
    position: 'relative',
    paddingBottom: spacing.sm,
  },
  timelineDot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: colors.primary,
    marginTop: 4,
    marginRight: spacing.sm,
    zIndex: 1,
  },
  timelineLine: {
    position: 'absolute',
    left: 5,
    top: 16,
    bottom: 0,
    width: 2,
    backgroundColor: colors.outlineVariant,
  },
  timelineContent: {
    flex: 1,
    backgroundColor: colors.surfaceContainerLow,
    borderRadius: borderRadius.default,
    padding: spacing.sm,
  },
  timelineHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  milestoneName: {
    fontSize: typography.bodyMd.fontSize,
    fontWeight: '600',
    color: colors.onSurface,
    flex: 1,
  },
  milestoneDate: {
    fontSize: typography.caption.fontSize,
    color: colors.onSurfaceVariant,
    marginTop: 2,
  },
  sharedBadge: {
    marginTop: spacing.xs,
    alignSelf: 'flex-start',
  },
  facetRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: spacing.xs },
  facetBadge: { borderRadius: borderRadius.full, paddingVertical: 2, paddingHorizontal: 8 },
  facetVisa: { backgroundColor: colors.primaryContainer },
  facetVisaText: { fontSize: 11, color: colors.onPrimaryContainer, fontWeight: '500' },
  facetConsulate: { backgroundColor: colors.secondaryContainer },
  facetConsulateText: { fontSize: 11, color: colors.onSecondaryContainer, fontWeight: '500' },
  facetOutcome: { backgroundColor: colors.secondaryContainer },
  facetOutcomeText: { fontSize: 11, color: colors.onSecondaryContainer, fontWeight: '500' },
  facetTag: { backgroundColor: colors.surfaceContainerHigh },
  facetTagText: { fontSize: 11, color: colors.onSurfaceVariant },
  experienceText: {
    fontSize: typography.bodyMd.fontSize,
    color: colors.onSurface,
    marginTop: spacing.base,
    lineHeight: typography.bodyMd.lineHeight,
  },
  signOutContainer: {
    marginTop: spacing.md,
  },
  deleteContainer: {
    marginTop: spacing.md,
    alignItems: 'center',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  deleteButtonText: {
    color: colors.error,
    fontSize: 14,
    fontWeight: '500',
  },
  bottomPadding: {
    height: 100, // Extra padding to scroll past floating tab bar
  },
});

export default ProfileScreen;
