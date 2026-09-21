import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
  Alert,
  ActivityIndicator,
  Share,
  TouchableWithoutFeedback,
  Switch,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius } from '../constants/theme';
import { GroupChat, MatchCard, AppText, Badge, AuthorCard } from '../components';
import {
  getGroup,
  leaveGroup,
  inviteToGroup,
  renameGroup,
  deleteGroup,
  archiveGroup,
  joinGroup,
  saveMemberAttributes,
  getMemberAttributes,
  getGroupInvitations,
  findCandidates,
  addMembers,
  getTagVocab,
  getActiveUserId,
  CHECKBOX_ON,
  requiredAttributeKeys,
  GroupInfo,
  Invitation,
  MatchData,
  MemberAttributes,
  PostJoinAttributeRow,
  TagVocab,
} from '../services/apiService';

// Matches the website's find/page.tsx and backend/api.py's APP_BASE_URL
// default — the public route a shared group link resolves to.
const APP_BASE_URL = 'https://meridianjourney.ai';

// How many members the sheet shows before collapsing the rest.
const MEMBER_PREVIEW_COUNT = 5;

type RouteParams = {
  GroupChat: {
    groupId: string;
    groupName?: string;
  };
};

// Relative "X ago" for data-freshness (mirrors GroupChat/PostingCard).
function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (isNaN(t)) return '';
  const sec = Math.floor((Date.now() - t) / 1000);
  if (sec < 60) return 'just now';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

function TypeBadge({ groupType }: { groupType: string }) {
  return <Badge variant={groupType === 'timeline' ? 'secondary' : 'outline'}>{groupType === 'timeline' ? 'Timeline' : 'Regular'}</Badge>;
}

function StatusBadge({ status }: { status?: string }) {
  if (!status || status === 'active') return null;
  const label = status === 'archived' ? 'Archived' : status === 'deleted' ? 'Deleted' : status;
  return <Badge variant="warning">{label}</Badge>;
}

function TagRow({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return (
    <Text style={styles.groupDates}>
      {label}: {value}
    </Text>
  );
}

type PostJoinRow = PostJoinAttributeRow;

/**
 * One control per template row, chosen by the row's `kind` — the template is
 * the single source of truth for both the control and the server-side rules.
 * A missing `kind` means 'date' (the shape every row had originally).
 *
 * Exported so the find/create panel renders the identical controls.
 */
export function AttributeControl({
  row, value, onChange,
}: {
  row: PostJoinRow;
  value: string;
  onChange: (v: string) => void;
}) {
  if (row.kind === 'checkbox') {
    return (
      <View style={styles.postJoinDateInput}>
        <Switch
          value={Boolean(value)}
          onValueChange={(on) => onChange(on ? CHECKBOX_ON : '')}
          trackColor={{ false: colors.outlineVariant, true: colors.primaryContainer }}
          thumbColor={value ? colors.primary : colors.surface}
          accessibilityLabel={row.label}
        />
      </View>
    );
  }
  if (row.kind === 'select') {
    // RN has no <select>; the chip row is this app's established picker
    // (FindScreen's Processing type / Cycle use the same idiom).
    return (
      <View style={styles.optionChips}>
        {(row.options || []).map((o) => (
          <TouchableOpacity
            key={o}
            onPress={() => onChange(value === o ? '' : o)}
            style={[styles.optionChip, value === o && styles.optionChipActive]}
          >
            <AppText variant="caption" color={value === o ? 'onPrimaryContainer' : 'onSurfaceVariant'}>
              {o}
            </AppText>
          </TouchableOpacity>
        ))}
      </View>
    );
  }
  return (
    <TextInput
      style={styles.postJoinDateInput}
      value={value}
      onChangeText={onChange}
      placeholder="YYYY-MM-DD"
      placeholderTextColor={colors.onSurfaceVariant}
      keyboardType="numbers-and-punctuation"
      accessibilityLabel={row.label}
    />
  );
}

// Shared attribute-entry form: required field (template row 0) + optional
// rows + a free-text notes field. Used both for the non-member join preview
// and the member-view mandatory gate.
function AttributeForm({
  rows, values, onChange, notes, onNotesChange, required,
}: {
  rows: PostJoinRow[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  notes: string;
  onNotesChange: (v: string) => void;
  required: string[];
}) {
  return (
    <>
      {rows.map((row) => (
        <View key={row.key} style={row.kind === 'select' ? styles.postJoinRowStacked : styles.postJoinRow}>
          <AppText variant="caption" color="onSurfaceVariant" style={styles.postJoinLabel}>
            {row.label}{required.includes(row.key) ? ' *' : ''}
          </AppText>
          <AttributeControl row={row} value={values[row.key] || ''} onChange={(v) => onChange(row.key, v)} />
        </View>
      ))}
      <View style={styles.postJoinRow}>
        <AppText variant="caption" color="onSurfaceVariant" style={styles.postJoinLabel}>Notes</AppText>
        <TextInput
          style={[styles.postJoinDateInput, styles.postJoinNotesInput]}
          value={notes}
          onChangeText={onNotesChange}
          placeholder="Anything else worth sharing with the cohort?"
          placeholderTextColor={colors.onSurfaceVariant}
          multiline
        />
      </View>
    </>
  );
}

// Every non-empty criteria_tags field, labeled — the "all the tags used to
// create this group" breakdown for the Group Info modal.
function CriteriaBreakdown({ c }: { c?: GroupInfo['criteria_tags'] }) {
  if (!c) return null;
  // Both criteria maps, not just key_stages_or_info — a scope row lands in
  // whichever its `field` names, and a date-kind one (I-485's priority date)
  // goes to key_dates. Leaving those out hid part of what the group IS.
  const scoped = [...Object.entries(c.key_stages_or_info || {}), ...Object.entries(c.key_dates || {})];
  return (
    <>
      <TagRow label="Current status" value={(c.current_visa_or_greencard_category || []).join(', ')} />
      <TagRow label="Applying for" value={(c.visa_applying_for || []).join(', ')} />
      <TagRow label="Consulate(s)" value={(c.consulates || []).join(', ') || c.primary_consulate || ''} />
      <TagRow label="Tags" value={(c.tags || []).join(', ')} />
      {scoped.map(([k, v]) => (
        <TagRow key={k} label={k.replace(/_/g, ' ')} value={v} />
      ))}
    </>
  );
}

export function GroupChatScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const route = useRoute<RouteProp<RouteParams, 'GroupChat'>>();
  const { groupId, groupName } = route.params;
  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [showMembersModal, setShowMembersModal] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [archiving, setArchiving] = useState(false);

  // rename (admin only)
  const [editing, setEditing] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [descDraft, setDescDraft] = useState('');
  const [saving, setSaving] = useState(false);

  // invite (any member)
  const [inviteHandle, setInviteHandle] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState('');

  // join preview (non-members, e.g. arriving via a shared link)
  const [joining, setJoining] = useState(false);
  const [joinValues, setJoinValues] = useState<Record<string, string>>({});
  const [joinNotes, setJoinNotes] = useState('');

  // Mandatory post-join attribute gate (features/timeline-notifications-3/
  // timeline-posting-stem-opt.md) — driven by the server-computed
  // needs_attributes flag (Timeline group + a registered processing-type
  // template + the viewer is a member + no submission yet), not a one-shot
  // client event, so it correctly blocks a member added via invite too.
  // Saves to BOTH the member's own profile (key_dates) and the group's
  // shared member_attributes store.
  const [vocab, setVocab] = useState<TagVocab | null>(null);
  const [gateValues, setGateValues] = useState<Record<string, string>>({});
  const [gateNotes, setGateNotes] = useState('');
  const [savingGate, setSavingGate] = useState(false);

  // Cohort attributes — every member's submitted post-join attributes,
  // shared with the whole group. Feeds both the member sheet and the
  // full attributes screen.
  const [cohortAttrs, setCohortAttrs] = useState<MemberAttributes[]>([]);
  // Correcting your own answers after the fact — the same form, prefilled.
  const [editingAttrs, setEditingAttrs] = useState(false);
  // Tapping a member opens a sheet with their group attributes AND their
  // profile. Mobile has no hover, so the two collapse into one surface.
  const [sheetMember, setSheetMember] = useState<{ user_id: string; username: string } | null>(null);
  // People invited who haven't answered yet — NOT members.
  const [pendingInvites, setPendingInvites] = useState<Invitation[]>([]);
  // A long roster pushes the Invite / Find candidates / group actions below
  // it off the sheet, so only the first few show until asked.
  const [showAllMembers, setShowAllMembers] = useState(false);

  // find candidates (member-only) — the relocated counterpart of the old
  // top-level chat-based candidate matching, now scoped to this group
  const [candidates, setCandidates] = useState<MatchData[]>([]);
  const [candidatesSearched, setCandidatesSearched] = useState(false);
  const [findingCandidates, setFindingCandidates] = useState(false);
  const [selectedCandidates, setSelectedCandidates] = useState<Set<string>>(new Set());
  const [addingCandidates, setAddingCandidates] = useState(false);

  const loadGroup = () => {
    getGroup(groupId)
      .then((g) => {
        setGroup(g);
        setNameDraft(g.name);
        setDescDraft(g.description || '');
      })
      .catch(() => {});
  };

  // Group composition at a glance (website parity: members shown beside the chat).
  useEffect(() => {
    loadGroup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupId]);

  useEffect(() => {
    getTagVocab().then((v) => setVocab(v)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!group || !group.is_member) {
      setCohortAttrs([]);
      return;
    }
    getMemberAttributes(groupId).then((d) => setCohortAttrs(d.attributes || [])).catch(() => {});
    getGroupInvitations(groupId).then((d) => setPendingInvites(d.invitations || [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.group_id, group?.is_member, group?.needs_attributes]);

  // Your own submitted attributes, if any — what the Edit path prefills from.
  const myAttrs = cohortAttrs.find((a) => a.user_id === getActiveUserId());

  const allMembers = group?.members || [];
  const visibleMembers = showAllMembers ? allMembers : allMembers.slice(0, MEMBER_PREVIEW_COUNT);
  const hiddenMemberCount = allMembers.length - visibleMembers.length;

  // The Processing type registered in this group's own criteria (its tags
  // OR current status — mirrors selectProcessingType()'s visa-vs-tag
  // routing on the find/create panel) that has a post-join attribute
  // template, if any. Timeline-only, matching backend's
  // _matched_post_join_type() exactly.
  const matchedType = (() => {
    if (!group || group.group_type !== 'timeline' || !vocab) return '';
    const c = group.criteria_tags;
    if (!c) return '';
    const candidates = [...(c.tags || []), ...(c.current_visa_or_greencard_category || [])];
    return candidates.find((t) => t in vocab.post_join_attribute_templates) || '';
  })();
  const templateRows: PostJoinRow[] = matchedType && vocab ? vocab.post_join_attribute_templates[matchedType] || [] : [];
  const required = requiredAttributeKeys(templateRows);

  const submitGateAttrs = async () => {
    setSavingGate(true);
    try {
      const updated = await saveMemberAttributes(groupId, gateValues, gateNotes);
      setGroup(updated);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not save your attributes');
    } finally {
      setSavingGate(false);
    }
  };

  const handleLeaveGroup = () => {
    Alert.alert(
      'Leave Group',
      'Are you sure you want to leave this group?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Leave',
          style: 'destructive',
          onPress: async () => {
            setLeaving(true);
            try {
              await leaveGroup(groupId);
              navigation.goBack();
            } catch (e) {
              Alert.alert('Error', e instanceof Error ? e.message : 'Failed to leave group');
            } finally {
              setLeaving(false);
            }
          },
        },
      ]
    );
  };

  const handleDeleteGroup = () => {
    Alert.alert(
      'Delete Group',
      'Delete this group for everyone? This can’t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteGroup(groupId);
              navigation.goBack();
            } catch (e) {
              Alert.alert('Error', e instanceof Error ? e.message : 'Failed to delete group');
            } finally {
              setDeleting(false);
            }
          },
        },
      ]
    );
  };

  const toggleArchive = async () => {
    if (!group) return;
    setArchiving(true);
    try {
      const updated = await archiveGroup(groupId, group.status !== 'archived');
      setGroup(updated);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not update group status');
    } finally {
      setArchiving(false);
    }
  };

  // Mobile has no hover, so a member's group attributes and their profile
  // share one bottom sheet rather than the website's hover-card + modal pair.
  const handleMemberPress = (member: { user_id: string; username: string }) => {
    setSheetMember(member);
  };

  const saveRename = async () => {
    const isTimeline = group?.group_type === 'timeline';
    if (!isTimeline && !nameDraft.trim()) return;
    setSaving(true);
    try {
      const updated = await renameGroup(
        groupId,
        isTimeline ? { description: descDraft.trim() } : { name: nameDraft.trim(), description: descDraft.trim() }
      );
      setGroup(updated);
      setEditing(false);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not rename group');
    } finally {
      setSaving(false);
    }
  };

  const submitInvite = async () => {
    if (!inviteHandle.trim()) return;
    setInviting(true);
    setInviteMsg('');
    try {
      // Returns an invitation, NOT a group — nobody joins until they accept,
      // so the group card is unchanged and must not be overwritten here.
      const inv = await inviteToGroup(groupId, inviteHandle.trim());
      setPendingInvites((prev) =>
        prev.some((p) => p.user_id === inv.user_id) ? prev : [...prev, inv]
      );
      setInviteHandle('');
      setInviteMsg('Invitation sent — they’ll join once they accept.');
    } catch (e) {
      setInviteMsg(e instanceof Error ? e.message : 'Could not invite that handle');
    } finally {
      setInviting(false);
    }
  };

  const joinThisGroup = async () => {
    setJoining(true);
    try {
      const updated = await joinGroup(groupId, joinValues, joinNotes);
      setGroup(updated);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not join');
    } finally {
      setJoining(false);
    }
  };

  const shareGroupLink = async () => {
    try {
      await Share.share({
        message: `Join "${group?.name || groupName || 'my group'}" on Meridian: ${APP_BASE_URL}/groups/${groupId}`,
        url: `${APP_BASE_URL}/groups/${groupId}`,
      });
    } catch {
      // user cancelled or share failed — no-op
    }
  };

  // "Find candidates" — ranks other users against THIS group's own stored
  // criteria (matching.py's find_matches(), relocated from the old top-level
  // chat flow to a group-scoped action for growing membership after creation).
  const handleFindCandidates = async () => {
    setFindingCandidates(true);
    try {
      const data = await findCandidates(groupId);
      setCandidates(data.matches || []);
      setSelectedCandidates(new Set());
      setCandidatesSearched(true);
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not find candidates');
    } finally {
      setFindingCandidates(false);
    }
  };

  const toggleCandidate = (userId: string) => {
    setSelectedCandidates((prev) => {
      const n = new Set(prev);
      n.has(userId) ? n.delete(userId) : n.add(userId);
      return n;
    });
  };

  const handleAddCandidates = async () => {
    if (selectedCandidates.size === 0) return;
    setAddingCandidates(true);
    try {
      const res = await addMembers(groupId, Array.from(selectedCandidates));
      setGroup(res.group);
      setPendingInvites((prev) => {
        const seen = new Set(prev.map((p) => p.user_id));
        return [...prev, ...(res.invited || []).filter((i) => !seen.has(i.user_id))];
      });
      setCandidates((prev) => prev.filter((c) => !selectedCandidates.has(c.user_id)));
      setSelectedCandidates(new Set());
      if (res.invited?.length) {
        Alert.alert(
          'Invitations sent',
          `${res.invited.length} invited — they'll join once they accept.`
        );
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not invite candidates');
    } finally {
      setAddingCandidates(false);
    }
  };

  // Join preview — reached via a shared link or a browse listing without
  // joining first. getGroup() already returns full details to any
  // authenticated user regardless of membership, so this needs no backend
  // change, only a client-side gate.
  if (group && !group.is_member) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
            <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
          </TouchableOpacity>
          <View style={styles.headerCenter}>
            <Text style={styles.title} numberOfLines={1}>
              {group.name}
            </Text>
          </View>
          <TouchableOpacity style={styles.leaveButton} onPress={shareGroupLink} accessibilityLabel="Share group link">
            <Ionicons name="share-outline" size={22} color={colors.onSurfaceVariant} />
          </TouchableOpacity>
        </View>
        <View style={styles.joinPreview}>
          <View style={styles.metaBadgeRow}>
            <TypeBadge groupType={group.group_type} />
            <StatusBadge status={group.status} />
          </View>
          <AppText variant="bodyMd" color="onSurfaceVariant" style={styles.joinPreviewMembers}>
            {group.members.length} member{group.members.length === 1 ? '' : 's'}
          </AppText>
          {!!group.criteria_text && (
            <AppText variant="bodyMd" color="onSurfaceVariant" style={styles.joinPreviewCriteria}>
              {group.criteria_text}
            </AppText>
          )}
          {group.status === 'archived' ? (
            <AppText variant="caption" color="error" style={styles.joinPreviewMembers}>
              This group is archived and no longer accepting new members.
            </AppText>
          ) : (
            <>
              {!!matchedType && templateRows.length > 0 && (
                <View style={styles.postJoinCard}>
                  <AppText variant="labelMd" color="onSurface" style={styles.postJoinTitle}>
                    Your {matchedType} attributes
                  </AppText>
                  {/* A template can be entirely optional (I-485 asks only for
                      a priority date), so don't claim otherwise. */}
                  <AppText variant="caption" color="onSurfaceVariant" style={styles.postJoinHint}>
                    {required.length > 0
                      ? 'Required to join — shared with the rest of the cohort.'
                      : 'Optional — shared with the rest of the cohort. You can fill these in later.'}
                  </AppText>
                  <AttributeForm rows={templateRows} values={joinValues}
                    onChange={(k, v) => setJoinValues((prev) => ({ ...prev, [k]: v }))}
                    notes={joinNotes} onNotesChange={setJoinNotes} required={required} />
                </View>
              )}
              <TouchableOpacity
                style={[styles.joinPreviewButton, (joining || required.some((k) => !joinValues[k]?.trim())) && styles.buttonDisabled]}
                onPress={joinThisGroup}
                disabled={joining || required.some((k) => !joinValues[k]?.trim())}
              >
                <AppText variant="labelMd" color="onPrimary">
                  {joining ? 'Joining…' : 'Join group'}
                </AppText>
              </TouchableOpacity>
            </>
          )}
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.headerCenter}
          onPress={() => setShowMembersModal(true)}
          activeOpacity={0.7}
        >
          <Text style={styles.title} numberOfLines={1}>
            {group?.name || groupName || 'Group Chat'}
          </Text>
          {!!group?.members?.length && (
            <Text style={styles.membersLink}>
              {group.members.length} member{group.members.length === 1 ? '' : 's'} · Tap to view
            </Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity style={styles.leaveButton} onPress={shareGroupLink} accessibilityLabel="Share group link">
          <Ionicons name="share-outline" size={22} color={colors.onSurfaceVariant} />
        </TouchableOpacity>
        {group?.is_member && (
          <TouchableOpacity
            style={styles.leaveButton}
            onPress={handleLeaveGroup}
            disabled={leaving}
            accessibilityLabel="Leave Group"
          >
            {leaving ? (
              <ActivityIndicator size="small" color={colors.error} />
            ) : (
              <Ionicons name="exit-outline" size={22} color={colors.error} />
            )}
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.chatContainer}>
        {group?.needs_attributes && !!matchedType && templateRows.length > 0 ? (
          <View style={styles.postJoinCard}>
            <AppText variant="labelMd" color="onSurface" style={styles.postJoinTitle}>
              Add your {matchedType} attributes
            </AppText>
            {/* This card is the only entry point for a member who hasn't
                submitted yet, so it shows even when nothing is required — but
                then it's a prompt, not a toll gate, and Save with everything
                blank is a legitimate answer. */}
            <AppText variant="caption" color="onSurfaceVariant" style={styles.postJoinHint}>
              {required.length > 0
                ? 'Required to access this group — shared with the rest of the cohort.'
                : 'Optional — shared with the rest of the cohort. Save to continue, and add them any time.'}
            </AppText>
            <AttributeForm rows={templateRows} values={gateValues}
              onChange={(k, v) => setGateValues((prev) => ({ ...prev, [k]: v }))}
              notes={gateNotes} onNotesChange={setGateNotes} required={required} />
            <View style={styles.postJoinActions}>
              <TouchableOpacity
                onPress={submitGateAttrs}
                disabled={savingGate || required.some((k) => !gateValues[k]?.trim())}
                style={[styles.saveButton, (savingGate || required.some((k) => !gateValues[k]?.trim())) && styles.buttonDisabled]}
              >
                <Text style={styles.saveButtonText}>{savingGate ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : editingAttrs && !!matchedType && templateRows.length > 0 ? (
          /* Already submitted? Same form, prefilled, same upsert endpoint. */
          <ScrollView contentContainerStyle={styles.postJoinCard}>
            <AppText variant="labelMd" color="onSurface" style={styles.postJoinTitle}>
              Edit your {matchedType} attributes
            </AppText>
            <AppText variant="caption" color="onSurfaceVariant" style={styles.postJoinHint}>
              Shared with the rest of the cohort.
            </AppText>
            <AttributeForm rows={templateRows} values={gateValues}
              onChange={(k, v) => setGateValues((prev) => ({ ...prev, [k]: v }))}
              notes={gateNotes} onNotesChange={setGateNotes} required={required} />
            <View style={styles.postJoinActions}>
              <TouchableOpacity
                onPress={async () => { await submitGateAttrs(); setEditingAttrs(false); }}
                disabled={savingGate || required.some((k) => !gateValues[k]?.trim())}
                style={[styles.saveButton, (savingGate || required.some((k) => !gateValues[k]?.trim())) && styles.buttonDisabled]}
              >
                <Text style={styles.saveButtonText}>{savingGate ? 'Saving…' : 'Save'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setEditingAttrs(false)} style={styles.cancelEditButton}>
                <AppText variant="labelMd" color="onSurfaceVariant">Cancel</AppText>
              </TouchableOpacity>
            </View>
          </ScrollView>
        ) : (
          <GroupChat groupId={groupId} />
        )}
      </View>

      {/* Members Modal — also group metadata, rename (admin), invite (any member) */}
      <Modal
        visible={showMembersModal}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowMembersModal(false)}
      >
        <SafeAreaView style={styles.modalContainer}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Group Info</Text>
            <TouchableOpacity
              style={styles.modalClose}
              onPress={() => setShowMembersModal(false)}
            >
              <Ionicons name="close" size={24} color={colors.onSurface} />
            </TouchableOpacity>
          </View>
          <ScrollView style={styles.membersList}>
            <View style={styles.metaSection}>
              <View style={styles.metaBadgeRow}>
                <TypeBadge groupType={group?.group_type || ''} />
                <StatusBadge status={group?.status} />
              </View>
              {editing ? (
                <>
                  {group?.group_type !== 'timeline' && (
                    <TextInput
                      value={nameDraft}
                      onChangeText={setNameDraft}
                      maxLength={100}
                      style={styles.editInput}
                    />
                  )}
                  <TextInput
                    value={descDraft}
                    onChangeText={setDescDraft}
                    maxLength={500}
                    placeholder="What's this group for?"
                    placeholderTextColor={colors.onSurfaceVariant}
                    multiline
                    style={[styles.editInput, styles.editTextarea]}
                  />
                  <View style={styles.editActions}>
                    <TouchableOpacity onPress={saveRename} disabled={saving || !nameDraft.trim()} style={styles.saveButton}>
                      <Text style={styles.saveButtonText}>{saving ? 'Saving…' : 'Save'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => { setEditing(false); setNameDraft(group?.name || ''); setDescDraft(group?.description || ''); }}
                      style={styles.cancelButton}
                    >
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                </>
              ) : (
                <>
                  <View style={styles.metaTitleRow}>
                    <Text style={styles.groupName}>{group?.name}</Text>
                    {group?.is_admin && (
                      <TouchableOpacity onPress={() => setEditing(true)}>
                        <Text style={styles.renameLink}>{group?.group_type === 'timeline' ? 'Edit description' : 'Rename'}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {!!group?.description && <Text style={styles.groupDescription}>{group.description}</Text>}
                </>
              )}
              {group?.created_at && (
                <Text style={styles.groupDates}>
                  Created {timeAgo(group.created_at) || group.created_at}
                  {group.last_activity_at ? ` · Last activity ${timeAgo(group.last_activity_at)}` : ''}
                </Text>
              )}
              {group?.expiration_date && (
                <Text style={styles.groupDates}>
                  {group.status === 'archived' ? 'Expired' : 'Expires'} {new Date(group.expiration_date).toLocaleDateString()}
                </Text>
              )}
              <CriteriaBreakdown c={group?.criteria_tags} />
            </View>

            {!group?.needs_attributes && (
              <>
                <Text style={styles.sectionLabel}>Members ({group?.members?.length || 0})</Text>
                {visibleMembers.map((member) => (
                  <TouchableOpacity
                    key={member.user_id}
                    style={styles.memberRow}
                    onPress={() => handleMemberPress(member)}
                  >
                    <View style={styles.memberAvatar}>
                      <Text style={styles.memberInitial}>
                        {member.username.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <Text style={styles.memberName}>{member.username}</Text>
                    {member.user_id === group?.created_by && (
                      <View style={styles.adminBadge}>
                        <Text style={styles.adminBadgeText}>Admin</Text>
                      </View>
                    )}
                    {cohortAttrs.some((a) => a.user_id === member.user_id) && (
                      <Ionicons name="calendar-outline" size={16} color={colors.onSurfaceVariant} />
                    )}
                    <Ionicons name="chevron-forward" size={20} color={colors.onSurfaceVariant} />
                  </TouchableOpacity>
                ))}
                {hiddenMemberCount > 0 && (
                  <TouchableOpacity style={styles.viewAllAttrsRow} onPress={() => setShowAllMembers(true)}>
                    <AppText variant="labelMd" color="primary">Show all members…</AppText>
                    <Ionicons name="chevron-down" size={18} color={colors.primary} />
                  </TouchableOpacity>
                )}
                {/* The whole cohort side by side — replaces the old "Cohort
                    attributes" block, which just re-listed the same names. */}
                {!!matchedType && (
                  <TouchableOpacity
                    style={styles.viewAllAttrsRow}
                    onPress={() => {
                      setShowMembersModal(false);
                      navigation.navigate('GroupAttributes', { groupId, groupName: group?.name || groupName });
                    }}
                  >
                    <AppText variant="labelMd" color="primary">View All Data</AppText>
                    <Ionicons name="chevron-forward" size={18} color={colors.primary} />
                  </TouchableOpacity>
                )}
                {!!matchedType && !!myAttrs && (
                  <TouchableOpacity
                    style={styles.viewAllAttrsRow}
                    onPress={() => {
                      setGateValues({ ...(myAttrs.values || {}) });
                      setGateNotes(myAttrs.notes || '');
                      setEditingAttrs(true);
                      setShowMembersModal(false);
                    }}
                  >
                    <AppText variant="labelMd" color="primary">Edit your attributes</AppText>
                    <Ionicons name="create-outline" size={18} color={colors.primary} />
                  </TouchableOpacity>
                )}
              </>
            )}

            {!group?.needs_attributes && pendingInvites.length > 0 && (
              <>
                <Text style={styles.sectionLabel}>Invited ({pendingInvites.length})</Text>
                {pendingInvites.map((inv) => (
                  <View key={inv.user_id} style={styles.memberRow}>
                    <Ionicons name="hourglass-outline" size={18} color={colors.onSurfaceVariant} />
                    <AppText variant="caption" color="onSurfaceVariant" style={styles.invitedName}>
                      {inv.username} · awaiting reply
                    </AppText>
                  </View>
                ))}
              </>
            )}

            {!group?.needs_attributes && (
              <View style={styles.inviteSection}>
                <Text style={styles.sectionLabel}>Invite someone</Text>
                <Text style={styles.inviteHint}>Know someone else in the same boat? Add them by handle.</Text>
                <View style={styles.inviteRow}>
                  <TextInput
                    value={inviteHandle}
                    onChangeText={setInviteHandle}
                    placeholder="their handle…"
                    placeholderTextColor={colors.onSurfaceVariant}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.inviteInput}
                  />
                  <TouchableOpacity onPress={submitInvite} disabled={inviting || !inviteHandle.trim()} style={styles.inviteButton}>
                    <Text style={styles.inviteButtonText}>{inviting ? '…' : 'Invite'}</Text>
                  </TouchableOpacity>
                </View>
                {!!inviteMsg && <Text style={styles.inviteMsg}>{inviteMsg}</Text>}
              </View>
            )}

            {!group?.needs_attributes && (
            <View style={styles.findCandidatesSection}>
              <AppText variant="labelMd" color="onSurfaceVariant" style={styles.findCandidatesLabel}>
                Find candidates
              </AppText>
              <AppText variant="caption" color="onSurfaceVariant" style={styles.findCandidatesHint}>
                Rank other users against this group&apos;s own criteria and invite them.
              </AppText>
              <TouchableOpacity
                onPress={handleFindCandidates}
                disabled={findingCandidates}
                style={styles.findCandidatesButton}
              >
                <AppText variant="labelMd" color="onSurface">
                  {findingCandidates ? 'Finding…' : 'Find candidates'}
                </AppText>
              </TouchableOpacity>
              {candidatesSearched && (
                candidates.length === 0 ? (
                  <AppText variant="caption" color="onSurfaceVariant" style={styles.findCandidatesHint}>
                    No candidates found for this group&apos;s criteria.
                  </AppText>
                ) : (
                  <View style={styles.candidatesList}>
                    {candidates.map((c) => (
                      <MatchCard key={c.user_id} match={c} checked={selectedCandidates.has(c.user_id)} onToggle={toggleCandidate} />
                    ))}
                    <TouchableOpacity
                      onPress={handleAddCandidates}
                      disabled={addingCandidates || selectedCandidates.size === 0}
                      style={styles.addCandidatesButton}
                    >
                      <AppText variant="labelMd" color="onPrimary">
                        {addingCandidates ? 'Inviting…' : selectedCandidates.size ? `Invite ${selectedCandidates.size} selected` : 'Invite selected'}
                      </AppText>
                    </TouchableOpacity>
                  </View>
                )
              )}
            </View>
            )}

            {group?.is_admin && (
              <View style={styles.deleteSection}>
                <TouchableOpacity onPress={toggleArchive} disabled={archiving} style={styles.archiveButton}>
                  <Text style={styles.archiveButtonText}>
                    {archiving ? 'Updating…' : group?.status === 'archived' ? 'Unarchive Group' : 'Archive Group'}
                  </Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleDeleteGroup} disabled={deleting} style={styles.deleteButton}>
                  <Text style={styles.deleteButtonText}>{deleting ? 'Deleting…' : 'Delete Group'}</Text>
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>

      {/* Member sheet. Mobile has no hover, so this one surface carries both
          halves of what the website splits between a hover card and a profile
          modal: this member's attributes for THIS group, then their profile.
          Hand-rolled per ContentActionsMenu — there is no sheet library. */}
      <Modal
        visible={!!sheetMember}
        transparent
        animationType="fade"
        onRequestClose={() => setSheetMember(null)}
      >
        <TouchableWithoutFeedback onPress={() => setSheetMember(null)}>
          <View style={styles.sheetOverlay}>
            <TouchableWithoutFeedback>
              <View style={styles.memberSheet}>
                <AppText variant="labelMd" color="onSurface" style={styles.memberSheetTitle}>
                  {sheetMember?.username}
                </AppText>
                <ScrollView>
                  {(() => {
                    const a = cohortAttrs.find((x) => x.user_id === sheetMember?.user_id);
                    const filled = a ? templateRows.filter((r) => a.values?.[r.key]) : [];
                    if (!a || (!filled.length && !a.notes)) {
                      return (
                        <AppText variant="caption" color="onSurfaceVariant">
                          Hasn&apos;t shared attributes with this group yet.
                        </AppText>
                      );
                    }
                    return (
                      <View style={styles.memberSheetAttrs}>
                        {!!a.processing_type && (
                          <AppText variant="caption" color="onSurfaceVariant">{a.processing_type}</AppText>
                        )}
                        {filled.map((r) => (
                          <AppText key={r.key} variant="caption" color="onSurface">
                            {r.label}: {a.values[r.key]}
                          </AppText>
                        ))}
                        {!!a.notes && (
                          <AppText variant="caption" color="onSurfaceVariant" style={styles.memberSheetNotes}>
                            &ldquo;{a.notes}&rdquo;
                          </AppText>
                        )}
                      </View>
                    );
                  })()}
                  {!!sheetMember && (
                    <AuthorCard
                      authorId={sheetMember.user_id}
                      channel="app"
                      full
                      onOpenPosting={(caseId) => {
                        setSheetMember(null);
                        navigation.navigate('CaseDetails', { caseId });
                      }}
                    />
                  )}
                </ScrollView>
                <TouchableOpacity style={styles.memberSheetClose} onPress={() => setSheetMember(null)}>
                  <AppText variant="labelMd" color="onSurfaceVariant">Close</AppText>
                </TouchableOpacity>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  backButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerCenter: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: 'Lora_600SemiBold',
    fontSize: 17,
    color: colors.onSurface,
  },
  membersLink: {
    fontSize: 13,
    color: colors.primary,
    marginTop: 2,
  },
  leaveButton: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatContainer: {
    flex: 1,
    padding: spacing.marginMobile,
  },
  modalContainer: {
    flex: 1,
    backgroundColor: colors.background,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: colors.onSurface,
  },
  modalClose: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  membersList: {
    flex: 1,
  },
  metaSection: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  metaTitleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  groupName: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.onSurface,
  },
  renameLink: {
    fontSize: 14,
    color: colors.primary,
  },
  groupDescription: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
    marginTop: 4,
  },
  groupDates: {
    fontSize: 12,
    color: colors.onSurfaceVariant,
    marginTop: 6,
  },
  editInput: {
    fontSize: 15,
    color: colors.onSurface,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    marginTop: spacing.xs,
  },
  editTextarea: {
    minHeight: 60,
    textAlignVertical: 'top',
  },
  editActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  saveButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.xs,
  },
  saveButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onPrimary,
  },
  cancelButton: {
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.xs,
  },
  cancelButtonText: {
    fontSize: 14,
    color: colors.onSurfaceVariant,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.onSurfaceVariant,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
    gap: spacing.sm,
  },
  memberAvatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.primaryContainer,
    alignItems: 'center',
    justifyContent: 'center',
  },
  memberInitial: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.onPrimaryContainer,
  },
  memberName: {
    flex: 1,
    fontSize: 15,
    fontWeight: '500',
    color: colors.onSurface,
  },
  adminBadge: {
    backgroundColor: colors.primaryContainer,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
  },
  adminBadgeText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.onPrimaryContainer,
  },
  inviteSection: {
    paddingBottom: spacing.lg,
  },
  inviteHint: {
    fontSize: 13,
    color: colors.onSurfaceVariant,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.xs,
  },
  inviteRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  inviteInput: {
    flex: 1,
    fontSize: 15,
    color: colors.onSurface,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.md,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  inviteButton: {
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.base,
    justifyContent: 'center',
  },
  inviteButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onSurface,
  },
  inviteMsg: {
    fontSize: 13,
    color: colors.onSurfaceVariant,
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
  },
  deleteSection: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.base,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
    gap: spacing.sm,
  },
  archiveButton: {
    alignSelf: 'flex-start',
  },
  archiveButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onSurfaceVariant,
  },
  deleteButton: {
    alignSelf: 'flex-start',
  },
  deleteButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.error,
  },
  joinPreview: {
    flex: 1,
    padding: spacing.marginMobile,
  },
  joinPreviewMembers: {
    marginTop: spacing.sm,
  },
  joinPreviewCriteria: {
    marginTop: spacing.sm,
  },
  joinPreviewButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  metaBadgeRow: {
    flexDirection: 'row',
    gap: 6,
    marginBottom: spacing.xs,
  },
  findCandidatesSection: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
    paddingTop: spacing.sm,
  },
  findCandidatesLabel: {
    marginBottom: spacing.xs,
  },
  findCandidatesHint: {
    marginBottom: spacing.sm,
  },
  findCandidatesButton: {
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.sm,
    alignItems: 'center',
  },
  candidatesList: {
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  postJoinCard: {
    backgroundColor: colors.surfaceContainerLow,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  postJoinTitle: {
    marginBottom: spacing.xs,
  },
  postJoinHint: {
    marginBottom: spacing.sm,
  },
  postJoinRow: {
    marginBottom: spacing.sm,
  },
  postJoinLabel: {
    marginBottom: spacing.xs,
  },
  postJoinDateInput: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.default,
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
    fontSize: 14,
    color: colors.onSurface,
    width: 160,
  },
  postJoinActions: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.xs,
  },
  addCandidatesButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  postJoinNotesInput: {
    width: '100%',
    minHeight: 60,
    textAlignVertical: 'top',
  },
  postJoinRowStacked: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
  },
  optionChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 4,
  },
  optionChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
  },
  optionChipActive: {
    backgroundColor: colors.primaryContainer,
    borderColor: colors.primary,
  },
  viewAllAttrsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  invitedName: {
    flex: 1,
    marginLeft: spacing.sm,
  },
  cancelEditButton: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    justifyContent: 'center',
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: colors.scrim,
    justifyContent: 'flex-end',
  },
  memberSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: borderRadius.lg,
    borderTopRightRadius: borderRadius.lg,
    padding: spacing.md,
    maxHeight: '80%',
  },
  memberSheetTitle: {
    marginBottom: spacing.sm,
  },
  memberSheetAttrs: {
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
    marginBottom: spacing.sm,
  },
  memberSheetNotes: {
    fontStyle: 'italic',
    marginTop: 2,
  },
  memberSheetClose: {
    alignItems: 'center',
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
});

export default GroupChatScreen;
