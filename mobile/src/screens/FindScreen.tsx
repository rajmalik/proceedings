import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, TextInput, Alert } from 'react-native';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing, borderRadius } from '../constants/theme';
import {
  Header,
  Skeleton,
  EmptyState,
  AnimatedListItem,
  AnimatedPressable,
  FilterChip,
  TagPicker,
  AppText,
  Badge,
} from '../components';
import { AttributeControl } from './GroupChatScreen';
import {
  getTagVocab,
  getAllGroups,
  createGroup,
  previewGroup,
  searchGroups,
  joinGroup,
  getActiveUserId,
  setActiveUserId,
  loadActiveUser,
  TagVocab,
  TagAttributeRow,
  AttributeField,
  ProcessingTypeOption,
  Criteria,
  GroupInfo,
  Invitation,
  getMyInvitations,
  acceptInvitation,
  declineInvitation,
  Strictness,
} from '../services/apiService';

type TagField = 'current_visa_or_greencard_category' | 'visa_applying_for' | 'consulates' | 'tags';
type Tag = { field: TagField; code: string; label: string };
type GroupType = 'regular' | 'timeline';

// Group validity, chosen at creation time — value strings match backend
// matching.py's _VALIDITY_DAYS exactly. Timeline groups only offer the
// short-lived options; Regular groups add the long-lived ones too.
const VALIDITY_OPTIONS: { value: string; label: string }[] = [
  { value: '1_month', label: '1 month' },
  { value: '3_months', label: '3 months' },
  { value: '6_months', label: '6 months' },
  { value: '1_year', label: '1 year' },
  { value: '3_years', label: '3 years' },
  { value: '5_years', label: '5 years' },
  { value: '10_years', label: '10 years' },
];
const TIMELINE_VALIDITY_VALUES = new Set(['1_month', '3_months', '6_months', '1_year']);
function validityOptionsFor(groupType: GroupType) {
  return groupType === 'timeline' ? VALIDITY_OPTIONS.filter((o) => TIMELINE_VALIDITY_VALUES.has(o.value)) : VALIDITY_OPTIONS;
}

function TypeBadge({ groupType }: { groupType: string }) {
  return <Badge variant={groupType === 'timeline' ? 'secondary' : 'outline'}>{groupType === 'timeline' ? 'Timeline' : 'Regular'}</Badge>;
}

function StatusBadge({ status }: { status?: string }) {
  if (!status || status === 'active') return null;
  const label = status === 'archived' ? 'Archived' : status === 'deleted' ? 'Deleted' : status;
  return <Badge variant="warning">{label}</Badge>;
}

const CATEGORY_FIELDS: { field: TagField; label: string; kind: 'visa' | 'consulate' | 'tag' }[] = [
  { field: 'current_visa_or_greencard_category', label: 'Current status', kind: 'visa' },
  { field: 'visa_applying_for', label: 'Applying for', kind: 'visa' },
  { field: 'consulates', label: 'Consulate(s)', kind: 'consulate' },
  { field: 'tags', label: 'Tags', kind: 'tag' },
];
// Timeline groups drop Consulate (Regular-only) AND Tags — the Processing
// type row is the only tag entry point for Timeline (it writes straight
// into `tags` or `current_visa_or_greencard_category` itself; see
// selectProcessingType()).
function categoryFieldsFor(groupType: GroupType) {
  return groupType === 'timeline' ? [] : CATEGORY_FIELDS;
}

// A very brief "tags used" summary for a browse-list card.
function tagSummary(g: GroupInfo): string {
  const c = g.criteria_tags || {};
  const cycle = c.key_stages_or_info?.stem_opt_cycle;
  const year = c.key_stages_or_info?.stem_opt_year;
  const parts = [
    ...(c.current_visa_or_greencard_category || []),
    ...(c.visa_applying_for || []),
    ...(c.consulates || []),
    ...(c.tags || []),
    ...(cycle ? [cycle] : []),
    ...(year ? [year] : []),
  ];
  return parts.slice(0, 4).join(' · ');
}

// Unified group-list card — used for both the "Your groups" and "All
// groups" sections so every card shows the same content: name, type/status
// badges, tag summary, description, member count. Tapping navigates
// straight into the group's own page — joining happens there, not from
// this card (mirrors the website's "select a group → view → join" flow).
function GroupListCard({ g, onPress }: { g: GroupInfo; onPress: () => void }) {
  return (
    <AnimatedPressable style={styles.groupCard} scaleTo={0.97} haptics="light" onPress={onPress}>
      <View style={styles.groupHeader}>
        {g.is_member && <Ionicons name="checkmark-circle" size={18} color={colors.primary} />}
        <AppText variant="labelMd" color="onSurface" style={styles.groupName}>
          {g.name}
        </AppText>
        <TypeBadge groupType={g.group_type} />
        <StatusBadge status={g.status} />
      </View>
      <AppText variant="caption" color="onSurfaceVariant">
        {tagSummary(g) || 'No tags yet.'}
      </AppText>
      {g.description ? (
        <AppText variant="caption" color="onSurfaceVariant">
          {g.description}
        </AppText>
      ) : null}
      <AppText variant="caption" color="onSurfaceVariant">
        {g.members.length} member{g.members.length !== 1 ? 's' : ''}
      </AppText>
    </AnimatedPressable>
  );
}

// "Cutoff period" — filters group SEARCH results by the group's own creation
// recency. 0 = "All" = no restriction, matching /api/groups/search's own
// default so leaving it untouched changes nothing.
const CUTOFF_STEPS: { days: number; label: string }[] = [
  { days: 0, label: 'All' },
  { days: 7, label: '7d' },
  { days: 30, label: '30d' },
  { days: 90, label: '90d' },
  { days: 182, label: '6mo' },
  { days: 365, label: '1yr' },
];

const PRECISION_LEVELS: { value: Strictness; label: string }[] = [
  { value: 'broad', label: 'Broad' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'strict', label: 'Strict' },
];

const TAB_BAR_CLEARANCE = 96;

export function FindScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  // Deep-link params from the AI Assist timeline / find-similar handoffs.
  const route = useRoute<
    RouteProp<
      Record<
        string,
        | {
            type?: string;
            processing_type?: string;
            eligibility?: string;
            filing_month?: string;
            filing_year?: string;
            q?: string;
            visa?: string;
          }
        | undefined
      >,
      string
    >
  >();
  const [tab, setTab] = useState<'find' | 'browse'>('browse');
  // Within the find tab: searching, or filling in the create form? A mode
  // rather than a route so the criteria you searched with carry into the
  // group you create from them.
  const [createMode, setCreateMode] = useState(false);
  const [activeId, setActiveId] = useState('');
  const [vocab, setVocab] = useState<TagVocab | null>(null);
  const [error, setError] = useState('');

  // search criteria panel
  // Timeline is the default — it's the group type this product is actually
  // organised around, and landing on Regular meant most users switched
  // immediately.
  const [groupType, setGroupType] = useState<GroupType>('timeline');
  const [tags, setTags] = useState<Tag[]>([]);
  const [revealedFields, setRevealedFields] = useState<Set<TagField>>(new Set());
  const [precision, setPrecision] = useState<Strictness>('balanced');
  const [cutoffIdx, setCutoffIdx] = useState(0);
  // Group validity, chosen at creation time — clamped to a valid option for
  // the current groupType whenever it changes (see the effect below).
  const [validity, setValidity] = useState('1_year');
  const [description, setDescription] = useState('');
  // Timeline-only: the group's own blurb (distinct from `description` above,
  // which is the searcher's "situation" text → criteria_text). Sent as the
  // group's `description` field on create only — Search doesn't use it.
  const [groupDescription, setGroupDescription] = useState('');
  // True once the creator edits the blurb themselves — after that the
  // generated one stops overwriting it, so changing a criterion never
  // silently discards what they wrote.
  const [descriptionEdited, setDescriptionEdited] = useState(false);
  // The name and description these criteria WOULD produce, from the server.
  // Not computed here: Timeline dedup is name-based, so a local guess that
  // drifted would promise a new cohort and deliver a join into an existing one.
  const [preview, setPreview] = useState<{ name: string; description: string }>({ name: '', description: '' });
  // Timeline-only: written exclusively by the scope rows the selected
  // Processing type / Eligibility category configures (no manual key-stage
  // entry point anymore). Held flat by row key and split into
  // key_stages_or_info vs key_dates at submit time by each row's `field` —
  // the keys are globally unique vocabulary entries, so one map is enough.
  const [scopeValues, setScopeValues] = useState<Record<string, string>>({});
  // Timeline-only: "Processing type" — picks which tag_attribute_templates
  // entry drives the Cycle/Year fields below, AND adds that value to the
  // right underlying criteria field (visa vocab -> current status, else ->
  // generic tag) — auto-detected via vocab.visa, never hardcoded.
  const [processingType, setProcessingType] = useState('');
  // Second picker: WHICH eligibility category under the processing type
  // (EAD → one of the 8 CFR 274a.12 classes). Its tag joins the criteria
  // alongside the type, and Cycle/Year hang off IT, not the type.
  const [eligibility, setEligibility] = useState('');
  // Required when the selected Processing type has a registered post-join
  // attribute template — matching.py's find_or_create_group() gates a
  // brand-new group's CREATOR the same as anyone joining an existing one
  // ("create" and "join" are the same membership action).

  // search results
  const [results, setResults] = useState<GroupInfo[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [creating, setCreating] = useState(false);

  // browse
  const [allGroups, setAllGroups] = useState<GroupInfo[]>([]);
  const [browseLoading, setBrowseLoading] = useState(false);
  // Invitations waiting on this user — the only place they learn they've
  // been invited, since a pending invitee is not yet a member anywhere.
  const [invitations, setInvitations] = useState<{ invitation: Invitation; group: GroupInfo }[]>([]);
  const [respondingTo, setRespondingTo] = useState('');

  useEffect(() => {
    async function init() {
      await loadActiveUser();
      const id = getActiveUserId();
      if (id) setActiveId(id);
      try {
        const v = await getTagVocab();
        setVocab(v);
      } catch {
        // Ignore init errors — TagPicker degrades to empty option lists.
      }
    }
    init();
  }, []);

  const loadGroups = useCallback(async () => {
    if (!activeId) return;
    setBrowseLoading(true);
    setError('');
    try {
      const data = await getAllGroups();
      setAllGroups(data.groups || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load groups');
    } finally {
      setBrowseLoading(false);
    }
    // Separate try: a failure here must not blank the group list above.
    try {
      const inv = await getMyInvitations();
      setInvitations(inv.invitations || []);
    } catch {
      setInvitations([]);
    }
  }, [activeId]);

  // Accepting is what joins the group. A group that will demand the
  // attribute form can't be accepted from here — send them to the group
  // screen, where the form lives, rather than firing a request that 422s.
  const respondToInvitation = useCallback(
    async (inv: Invitation, accept: boolean) => {
      if (accept && inv.requires_attributes) {
        navigation.navigate('GroupChat', { groupId: inv.group_id, groupName: inv.group_name });
        return;
      }
      setRespondingTo(inv.group_id);
      try {
        if (accept) {
          await acceptInvitation(inv.group_id);
        } else {
          await declineInvitation(inv.group_id);
        }
        setInvitations((prev) => prev.filter((p) => p.invitation.group_id !== inv.group_id));
        if (accept) loadGroups();
      } catch (e) {
        Alert.alert('Error', e instanceof Error ? e.message : 'Could not respond to the invitation');
      } finally {
        setRespondingTo('');
      }
    },
    [navigation, loadGroups]
  );

  useEffect(() => {
    if (tab === 'browse' && activeId) loadGroups();
  }, [tab, activeId, loadGroups]);

  // Timeline offers fewer validity options than Regular — clamp back to a
  // valid one whenever groupType changes and the current pick no longer fits.
  useEffect(() => {
    const opts = validityOptionsFor(groupType);
    if (!opts.some((o) => o.value === validity)) setValidity(opts[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupType]);

  // Previous/current/next year for the stem-opt-extension "Year" picker —
  // computed client-side (never baked into the backend template) so it's
  // always current without needing a server round-trip on Jan 1.
  // Five years back through next year. Timeline cohorts are routinely formed
  // long after filing — a 2022 priority-date crowd is still waiting — so a
  // last-year/this-year/next-year window couldn't express most real groups.
  const yearOptions = useMemo(() => {
    const y = new Date().getFullYear();
    return Array.from({ length: 7 }, (_, i) => String(y - 5 + i));
  }, []);
  const consulateByLabel = useMemo(
    () => new Map((vocab?.consulate_options || []).map((o) => [o.label, o.code])),
    [vocab]
  );
  const consulateByCode = useMemo(
    () => new Map((vocab?.consulate_options || []).map((o) => [o.code, o.label])),
    [vocab]
  );
  const visaSet = useMemo(() => new Set(vocab?.visa || []), [vocab]);
  function tagsFor(field: TagField): Tag[] {
    return tags.filter((t) => t.field === field);
  }
  function isShown(field: TagField): boolean {
    return revealedFields.has(field) || tags.some((t) => t.field === field);
  }
  function reveal(field: TagField) {
    setRevealedFields((prev) => new Set(prev).add(field));
  }
  function addTag(field: TagField, code: string) {
    reveal(field);
    setTags((prev) => (prev.some((t) => t.field === field && t.code === code) ? prev : [...prev, { field, code, label: code }]));
  }
  function removeTag(field: TagField, code: string) {
    setTags((prev) => prev.filter((t) => !(t.field === field && t.code === code)));
  }

  const selectedType = (vocab?.processing_types || []).find((t) => t.value === processingType);
  const selectedCategory = selectedType?.eligibility_categories.find((c) => c.tag === eligibility);
  // The backend resolves the scope rows onto the dropdown option itself, so a
  // category that configures an extra field (I-485's priority date) needs
  // nothing here; the tag-keyed registry is the fallback for a cached vocab
  // payload predating `scope_rows`.
  const attrTemplateKey =
    (eligibility && vocab?.tag_attribute_templates?.[eligibility] && eligibility) ||
    (!selectedType?.eligibility_categories.length && processingType
      && vocab?.tag_attribute_templates?.[processingType] && processingType) || '';
  const scopeRows: TagAttributeRow[] =
    (eligibility ? selectedCategory?.scope_rows : selectedType?.scope_rows)
    || (attrTemplateKey ? vocab!.tag_attribute_templates[attrTemplateKey] : [])
    || [];

  function processingTypeField(type: string): TagField {
    return visaSet.has(type) ? 'current_visa_or_greencard_category' : 'tags';
  }
  function selectProcessingType(next: string) {
    if (processingType) removeTag(processingTypeField(processingType), processingType);
    if (next) addTag(processingTypeField(next), next);
    setProcessingType(next);
    selectEligibility('');
  }

  function selectEligibility(next: string) {
    if (eligibility) removeTag(processingTypeField(eligibility), eligibility);
    if (next) addTag(processingTypeField(next), next);
    setEligibility(next);
    setScopeValues({});
  }

  // Used by the scope fields (below) to clear a row back to unset.
  function removeScopeValue(key: string) {
    setScopeValues((prev) => { const n = { ...prev }; delete n[key]; return n; });
  }

  // AI-Assist find-similar handoff: /find?type=regular&q=…&visa=… -> Regular
  // find tab, prefill the situation text + current-status tag. Runs once.
  const regularPrefilled = useRef(false);
  useEffect(() => {
    const p = route.params;
    if (regularPrefilled.current || p?.type !== 'regular') return;
    regularPrefilled.current = true;
    setTab('find');
    setGroupType('regular');
    if (p.q) setDescription(p.q);
    if (p.visa) addTag('current_visa_or_greencard_category', p.visa);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params]);

  // AI-Assist timeline handoff: /find?type=timeline&processing_type=…&eligibility=…
  // &filing_month=…&filing_year=… -> Timeline find tab with those prefilled.
  // Deferred until the processing-type vocab has loaded so select* resolve.
  const timelinePrefilled = useRef(false);
  useEffect(() => {
    const p = route.params;
    if (timelinePrefilled.current || p?.type !== 'timeline') return;
    if (!vocab?.processing_types?.length) return; // wait for the vocab
    timelinePrefilled.current = true;
    setTab('find');
    setGroupType('timeline');
    if (p.processing_type) {
      selectProcessingType(p.processing_type);
      if (p.eligibility) selectEligibility(p.eligibility);
    }
    if (p.filing_month || p.filing_year) {
      setScopeValues((prev) => ({
        ...prev,
        ...(p.filing_month ? { filing_month: p.filing_month } : {}),
        ...(p.filing_year ? { filing_year: p.filing_year } : {}),
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params, vocab?.processing_types]);

  function criteriaFromPanel(): Criteria {
    const byField = (f: TagField) => tags.filter((t) => t.field === f).map((t) => t.code);
    // Scope rows are Timeline-only — never leak into a Regular-group
    // search/create even if they were filled in before switching group type.
    const scopeIn = (field: AttributeField) => Object.fromEntries(
      groupType === 'timeline'
        ? scopeRows.filter((r) => r.field === field && scopeValues[r.key])
          .map((r) => [r.key, scopeValues[r.key]])
        : [],
    );
    return {
      current_visa_or_greencard_category: byField('current_visa_or_greencard_category'),
      visa_applying_for: byField('visa_applying_for'),
      primary_consulate: '',
      // Consulate is a Regular-only category — never leak a consulate picked
      // before switching to Timeline into a Timeline search/create.
      consulates: groupType === 'timeline' ? [] : byField('consulates'),
      tags: byField('tags'),
      key_stages_or_info: scopeIn('key_stages_or_info'),
      key_dates: scopeIn('key_dates'),
      background_text: description,
    };
  }

  // Refreshed whenever the criteria that feed the name change. Keyed on the
  // tags and scope values only — the "situation" text is part of the criteria
  // but has no bearing on the name, and keying on it would fire a request per
  // keystroke.
  const previewKey = JSON.stringify([
    groupType,
    tags.map((t) => `${t.field}:${t.code}`).sort(),
    Object.entries(scopeValues).filter(([, v]) => v).sort(),
  ]);
  useEffect(() => {
    if (groupType !== 'timeline') { setPreview({ name: '', description: '' }); return; }
    let cancelled = false;
    previewGroup(criteriaFromPanel(), 'timeline').then((p) => {
      if (!cancelled) setPreview(p);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  // Fill the blurb in for them, until they make it their own.
  useEffect(() => {
    if (!descriptionEdited) setGroupDescription(preview.description);
  }, [preview.description, descriptionEdited]);

  // "Search" — searches EXISTING groups by criteria (regular groups: ranked
  // tag-overlap score, thresholded by Precision; Timeline groups: exact
  // match, precision ignored) — NOT candidate-user matching (that lives
  // inside a group's own page as "Find candidates" now).
  async function runSearch() {
    setSearchLoading(true);
    setError('');
    try {
      const data = await searchGroups(
        criteriaFromPanel(),
        groupType === 'timeline' ? 'timeline' : '',
        precision,
        CUTOFF_STEPS[cutoffIdx].days
      );
      setResults(data.groups || []);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Search failed');
    } finally {
      setSearchLoading(false);
      setSearched(true);
    }
  }

  // Timeline results navigate straight into the group's own gated page
  // instead of joining directly — a Timeline join may require the required
  // post-join attribute, which this results list has no UI to collect.
  function joinResult(groupId: string, groupName: string, groupTypeOfResult: string) {
    if (groupTypeOfResult === 'timeline') {
      navigation.navigate('GroupChat', { groupId, groupName });
      return;
    }
    joinGroup(groupId)
      .then(() => navigation.navigate('GroupChat', { groupId, groupName }))
      .catch((e) => Alert.alert('Error', e instanceof Error ? e.message : 'Could not join'));
  }

  // "Create a group" — for when nothing found matches. The acting user is
  // automatically added and becomes the group's admin (createGroup() /
  // find_or_create_group() already does this).
  async function handleCreateGroup() {
    setCreating(true);
    try {
      const result = await createGroup(
        description, criteriaFromPanel(), [],
        groupType === 'timeline' ? 'timeline' : '',
        groupType === 'timeline' ? groupDescription : '',
        validity
      );
      if (result.group_id) {
        navigation.navigate('GroupChat', { groupId: result.group_id, groupName: result.name });
      }
    } catch (e) {
      Alert.alert('Error', e instanceof Error ? e.message : 'Could not create group');
    } finally {
      setCreating(false);
    }
  }

  // Website parity: the groups list shows ONLY the groups the user has joined.
  // The two sections partition the same list — a group belongs to exactly
  // one of them. A joined group listed twice on one screen reads as two
  // different groups.
  const myGroups = allGroups.filter((g) => g.is_member);
  const otherGroups = allGroups.filter((g) => !g.is_member);

  return (
    <View style={styles.container}>
      <Header title="Groups" showLogo={false} transparent />

      <View style={styles.tabs}>
        <TouchableOpacity onPress={() => setTab('browse')} style={[styles.tab, tab === 'browse' && styles.tabActive]}>
          <AppText variant="labelMd" color={tab === 'browse' ? 'onPrimaryContainer' : 'onSurfaceVariant'}>
            Groups
          </AppText>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setTab('find')} style={[styles.tab, tab === 'find' && styles.tabActive]}>
          <AppText variant="labelMd" color={tab === 'find' ? 'onPrimaryContainer' : 'onSurfaceVariant'}>
            Find / Create
          </AppText>
        </TouchableOpacity>
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <AppText variant="bodyMd" color="onErrorContainer">
            {error}
          </AppText>
        </View>
      ) : null}

      {tab === 'browse' ? (
        <ScrollView style={styles.content} contentContainerStyle={styles.scrollContent}>
          <TouchableOpacity style={styles.createGroupButton} onPress={() => setTab('find')}>
            <Ionicons name="people-outline" size={18} color={colors.onPrimary} />
            <AppText variant="labelMd" color="onPrimary">
              Create Group
            </AppText>
          </TouchableOpacity>

          {invitations.length > 0 && (
            <View testID="pending-invitations">
              <AppText variant="labelMd" color="onSurface" style={styles.sectionLabel}>
                Pending invitations ({invitations.length})
              </AppText>
              {invitations.map(({ invitation, group }) => (
                <View key={invitation.invitation_id} style={styles.groupCard}>
                  <AppText variant="labelMd" color="onSurface">{group.name}</AppText>
                  <AppText variant="caption" color="onSurfaceVariant">
                    Invited by {invitation.invited_by_username || 'a member'}
                  </AppText>
                  {invitation.requires_attributes && (
                    <AppText variant="caption" color="onSurfaceVariant">
                      Joining asks for a few dates first.
                    </AppText>
                  )}
                  <View style={styles.inviteActions}>
                    <TouchableOpacity
                      onPress={() => respondToInvitation(invitation, true)}
                      disabled={respondingTo === invitation.group_id}
                      style={styles.acceptButton}
                    >
                      <AppText variant="labelMd" color="onPrimary">Accept</AppText>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => respondToInvitation(invitation, false)}
                      disabled={respondingTo === invitation.group_id}
                      style={styles.declineButton}
                    >
                      <AppText variant="labelMd" color="onSurfaceVariant">Decline</AppText>
                    </TouchableOpacity>
                  </View>
                </View>
              ))}
            </View>
          )}

          <AppText variant="labelMd" color="onSurface" style={styles.sectionLabel}>
            Your groups
          </AppText>
          {browseLoading ? (
            <Skeleton.Card count={3} />
          ) : myGroups.length === 0 ? (
            <EmptyState
              icon="people-outline"
              title="No groups yet"
              body="See all groups below, or create your own."
              actionLabel="Find your group"
              onAction={() => setTab('find')}
            />
          ) : (
            myGroups.map((g, index) => (
              <AnimatedListItem key={g.group_id} index={Math.min(index, 6)} staggerDelay={60}>
                <GroupListCard g={g} onPress={() => navigation.navigate('GroupChat', { groupId: g.group_id, groupName: g.name })} />
              </AnimatedListItem>
            ))
          )}

          <AppText variant="labelMd" color="onSurface" style={[styles.sectionLabel, styles.criteriaHeading]}>
            All groups
          </AppText>
          {browseLoading ? (
            <Skeleton.Card count={2} />
          ) : otherGroups.length === 0 ? (
            <AppText variant="bodyMd" color="onSurfaceVariant" style={styles.hint}>
              {allGroups.length === 0
                ? 'No groups yet — be the first to create one.'
                : 'You’ve joined every group there is — create one to start another cohort.'}
            </AppText>
          ) : (
            otherGroups.map((g) => (
              <GroupListCard key={g.group_id} g={g} onPress={() => navigation.navigate('GroupChat', { groupId: g.group_id, groupName: g.name })} />
            ))
          )}
        </ScrollView>
      ) : (
        <ScrollView
          style={styles.content}
          contentContainerStyle={{ ...styles.scrollContent, paddingBottom: TAB_BAR_CLEARANCE }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Search and create are two modes over the SAME criteria, so
              "searched, found nothing, create it" keeps what you typed. */}
          <View style={styles.modeHeader}>
            <AppText variant="labelMd" color="onSurface">
              {createMode ? `New ${groupType === 'timeline' ? 'Timeline' : 'Regular'} group` : 'Find a group'}
            </AppText>
            <TouchableOpacity onPress={() => setCreateMode(!createMode)}>
              <AppText variant="labelMd" color="primary">
                {createMode
                  ? 'Back to search'
                  : `Create a ${groupType === 'timeline' ? 'Timeline' : 'Regular'} Group`}
              </AppText>
            </TouchableOpacity>
          </View>

          <AppText variant="labelMd" color="onSurface" style={styles.sectionLabel}>
            Group type
          </AppText>
          <View style={styles.segmented}>
            <TouchableOpacity
              style={[styles.segment, groupType === 'regular' && styles.segmentActive]}
              onPress={() => setGroupType('regular')}
            >
              <AppText variant="caption" color={groupType === 'regular' ? 'onPrimary' : 'onSurfaceVariant'}>
                Regular
              </AppText>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.segment, groupType === 'timeline' && styles.segmentActive]}
              onPress={() => setGroupType('timeline')}
            >
              <AppText variant="caption" color={groupType === 'timeline' ? 'onPrimary' : 'onSurfaceVariant'}>
                Timeline
              </AppText>
            </TouchableOpacity>
          </View>
          <AppText variant="caption" color="onSurfaceVariant" style={styles.hint}>
            {groupType === 'timeline'
              ? 'Timeline groups match EXACTLY — every category you fill in below must match the group exactly.'
              : 'Regular groups are ranked by how much they overlap with what you fill in below.'}
          </AppText>

          {groupType === 'regular' && (
            <>
              <AppText variant="labelMd" color="onSurface" style={styles.sectionLabel}>
                Describe your situation (optional)
              </AppText>
              <TextInput
                style={styles.textArea}
                value={description}
                onChangeText={setDescription}
                placeholder="e.g. Looking for H-1B folks filing EB-2 at the Mumbai consulate…"
                placeholderTextColor={colors.onSurfaceVariant}
                multiline
                numberOfLines={4}
              />
            </>
          )}

          {/* The name this group will get, generated server-side. Shown
              before you commit because a Timeline group can't be renamed
              afterwards, and because it is what dedup keys on: seeing it is
              how you tell "a new cohort" from "the one that already exists". */}
          {createMode && groupType === 'timeline' && !!preview.name && (
            <View style={styles.previewCard}>
              <AppText variant="caption" color="onSurfaceVariant">GROUP NAME</AppText>
              <AppText variant="titleMd" color="onSurface" style={styles.previewName}>
                {preview.name}
              </AppText>
              <AppText variant="caption" color="onSurfaceVariant">
                Generated from your criteria. A Timeline group can&apos;t be renamed after it&apos;s created.
              </AppText>
            </View>
          )}

          {createMode && groupType === 'timeline' && (
            <>
              <View style={styles.descriptionHeader}>
                <AppText variant="labelMd" color="onSurface" style={styles.sectionLabel}>
                  Group description
                </AppText>
                {/* Only offered once they've diverged — a reset that does
                    nothing is just noise. */}
                {descriptionEdited && !!preview.description && (
                  <TouchableOpacity onPress={() => {
                    setDescriptionEdited(false);
                    setGroupDescription(preview.description);
                  }}>
                    <AppText variant="caption" color="primary">Reset to generated</AppText>
                  </TouchableOpacity>
                )}
              </View>
              <TextInput
                style={styles.textArea}
                value={groupDescription}
                onChangeText={(t) => { setDescriptionEdited(true); setGroupDescription(t); }}
                placeholder="What's this group for? Shown to anyone browsing before they join."
                placeholderTextColor={colors.onSurfaceVariant}
                multiline
                numberOfLines={3}
              />
            </>
          )}

          <AppText variant="labelMd" color="onSurface" style={[styles.sectionLabel, styles.criteriaHeading]}>
            Search criteria
          </AppText>
          {tags.length === 0 && revealedFields.size === 0 && (
            <AppText variant="bodyMd" color="onSurfaceVariant" style={styles.hint}>
              Add criteria below, then tap Search.
            </AppText>
          )}

          {groupType === 'timeline' && (
            <View style={styles.category}>
              <AppText variant="caption" color="onSurfaceVariant" style={styles.categoryLabel}>PROCESSING TYPE</AppText>
              <View style={styles.chipRow}>
                {(vocab?.processing_types || []).map((t: ProcessingTypeOption) => (
                  <FilterChip key={t.value} label={t.label} selected={processingType === t.value}
                    onPress={() => selectProcessingType(processingType === t.value ? '' : t.value)} />
                ))}
              </View>
            </View>
          )}

          {/* Which category under that type. For EAD these are the 8 CFR
              274a.12 classes that actually file an I-765 — see
              features/ead-eligibility-5/; for H-1B they are the three
              application types. The heading comes from the config so it can be
              right for both. Hidden for a type that configures none. */}
          {groupType === 'timeline' && !!selectedType?.eligibility_categories.length && (
            <View style={styles.category}>
              <AppText variant="caption" color="onSurfaceVariant" style={styles.categoryLabel}>
                {(selectedType.category_label || 'Eligibility category').toUpperCase()}
              </AppText>
              <View style={styles.chipRow}>
                {/* The TAG, not the CFR label — it's what the group is named
                    after and what a posting carries. */}
                {selectedType.eligibility_categories.map((c) => (
                  <FilterChip key={c.tag} label={c.tag} selected={eligibility === c.tag}
                    onPress={() => selectEligibility(eligibility === c.tag ? '' : c.tag)} />
                ))}
              </View>
            </View>
          )}

          {categoryFieldsFor(groupType)
            .filter((c) => isShown(c.field)).map((c) => {
            const values = tagsFor(c.field);
            const options =
              c.kind === 'visa' ? vocab?.visa || []
                : c.kind === 'consulate' ? (vocab?.consulate_options || []).map((o) => o.label)
                  : vocab?.tag || [];
            return (
              <View key={c.field} style={styles.category}>
                <AppText variant="caption" color="onSurfaceVariant" style={styles.categoryLabel}>
                  {c.label.toUpperCase()}
                </AppText>
                <View style={styles.chipRow}>
                  {values.length === 0 && (
                    <AppText variant="caption" color="onSurfaceVariant">
                      None.
                    </AppText>
                  )}
                  {values.map((t) => (
                    <FilterChip
                      key={t.code}
                      label={c.kind === 'consulate' ? consulateByCode.get(t.code) || t.code : t.code}
                      selected
                      onPress={() => removeTag(c.field, t.code)}
                    />
                  ))}
                </View>
                <TagPicker
                  placeholder={c.kind === 'consulate' ? 'Add a consulate…' : `Add ${c.label.toLowerCase()}…`}
                  options={options}
                  onPick={(picked) => {
                    const code = c.kind === 'consulate' ? consulateByLabel.get(picked) || picked : picked;
                    addTag(c.field, code);
                  }}
                />
              </View>
            );
          })}

          {(() => {
            const hidden = categoryFieldsFor(groupType)
              .filter((c) => !isShown(c.field))
            return hidden.length > 0 && (
              <View style={styles.chipRow}>
                {hidden.map((c) => (
                  <FilterChip key={c.field} label={`+ Add ${c.label}`} onPress={() => reveal(c.field)} />
                ))}
              </View>
            )
          })()}

          {/* The scope rows the selected Processing type / Eligibility
              category configures — the only entry fields left on this panel
              (per-member facts moved to the group's own page, shown after
              joining). Each row writes into the criteria map its `field`
              names. */}
          {groupType === 'timeline' && scopeRows.length > 0 && (
            <View style={styles.stemOptSection}>
              {/* The period rows are the filing date the cohort is built
                  around — unlabelled, a bare Month/Year pair reads as
                  "some date, unclear which". */}
              <AppText variant="caption" color="onSurfaceVariant" style={styles.scopeSectionLabel}>
                Date Applied
              </AppText>
              {scopeRows.map((row: TagAttributeRow) => (
                <View key={row.key} style={styles.stemOptRow}>
                  <AppText variant="caption" color="onSurfaceVariant" style={styles.stemOptLabel}>{row.label}</AppText>
                  {row.kind === 'date' ? (
                    <TextInput
                      style={styles.scopeDateInput}
                      value={scopeValues[row.key] || ''}
                      onChangeText={(v) => (v ? setScopeValues((prev) => ({ ...prev, [row.key]: v })) : removeScopeValue(row.key))}
                      placeholder="YYYY-MM-DD"
                      placeholderTextColor={colors.onSurfaceVariant}
                      keyboardType="numbers-and-punctuation"
                      accessibilityLabel={row.label}
                    />
                  ) : (
                    <View style={styles.chipRow}>
                      {(row.kind === 'select' ? row.options : yearOptions).map((o) => (
                        <FilterChip key={o} label={o}
                          selected={scopeValues[row.key] === o}
                          onPress={() => (scopeValues[row.key] === o ? removeScopeValue(row.key) : setScopeValues((prev) => ({ ...prev, [row.key]: o })))} />
                      ))}
                    </View>
                  )}
                </View>
              ))}
            </View>
          )}

          {/* Group validity — how long the group stays active before it's
              auto-archived. A property of the group you're CREATING, so it
              has no place on the search form. */}
          {createMode && (
          <View style={styles.stemOptSection}>
            <AppText variant="caption" color="onSurfaceVariant" style={styles.categoryLabel}>GROUP VALIDITY</AppText>
            <View style={styles.chipRow}>
              {validityOptionsFor(groupType).map((o) => (
                <FilterChip key={o.value} label={o.label} selected={validity === o.value} onPress={() => setValidity(o.value)} />
              ))}
            </View>
          </View>
          )}

          {/* Precision only applies to Regular groups — Timeline search is
              exact-match, which has no threshold to tune. */}
          {groupType === 'regular' && (
            <View style={styles.strictnessRow}>
              <AppText variant="labelMd" color="onSurfaceVariant">
                Precision
              </AppText>
              <View style={styles.segmented}>
                {PRECISION_LEVELS.map((l) => (
                  <TouchableOpacity
                    key={l.value}
                    style={[styles.segment, precision === l.value && styles.segmentActive]}
                    onPress={() => setPrecision(l.value)}
                  >
                    <AppText variant="caption" color={precision === l.value ? 'onPrimary' : 'onSurfaceVariant'}>
                      {l.label}
                    </AppText>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {/* Cutoff period only applies to Regular groups — Timeline groups
              don't filter on group-creation recency. */}
          {groupType === 'regular' && (
            <View style={styles.cutoffRow}>
              <AppText variant="labelMd" color="onSurfaceVariant">
                Cutoff period
              </AppText>
              <View style={styles.segmented}>
                {CUTOFF_STEPS.map((s, i) => (
                  <TouchableOpacity
                    key={s.days}
                    style={[styles.cutoffSegment, i === cutoffIdx && styles.segmentActive]}
                    onPress={() => setCutoffIdx(i)}
                  >
                    <AppText variant="caption" color={i === cutoffIdx ? 'onPrimary' : 'onSurfaceVariant'}>
                      {s.label}
                    </AppText>
                  </TouchableOpacity>
                ))}
              </View>
            </View>
          )}

          {!createMode && (
            <TouchableOpacity style={styles.searchButton} onPress={runSearch} disabled={searchLoading}>
              <AppText variant="labelMd" color="onPrimary">
                {searchLoading ? 'Searching…' : 'Search'}
              </AppText>
            </TouchableOpacity>
          )}

          {!createMode && searchLoading && <Skeleton.Card count={2} style={styles.results} />}

          {!createMode && searched && !searchLoading && (
            results.length === 0 ? (
              <EmptyState
                icon="search-outline"
                title="No groups found"
                body={`No existing ${groupType === 'timeline' ? 'Timeline ' : ''}group matched — create one below.`}
              />
            ) : (
              <View style={styles.results}>
                {results.map((g) => (
                  <View key={g.group_id} style={styles.resultCard}>
                    <View style={styles.resultInfo}>
                      <AppText variant="labelMd" color="onSurface">
                        {g.name}
                      </AppText>
                      {g.criteria_text ? (
                        <AppText variant="caption" color="onSurfaceVariant">
                          {g.criteria_text}
                        </AppText>
                      ) : null}
                      <AppText variant="caption" color="onSurfaceVariant">
                        {g.members.length} member{g.members.length !== 1 ? 's' : ''}
                        {groupType === 'regular' ? ` · score ${g.score}` : ''}
                      </AppText>
                    </View>
                    <TouchableOpacity style={styles.joinButton} onPress={() => joinResult(g.group_id, g.name, g.group_type)}>
                      <AppText variant="labelMd" color="onSecondary">
                        {g.group_type === 'timeline' ? 'View' : 'Join'}
                      </AppText>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )
          )}

          {createMode && (
            <TouchableOpacity
              style={[styles.createButton, creating && styles.buttonDisabled]}
              onPress={handleCreateGroup}
              disabled={creating}
            >
              <AppText variant="labelMd" color="onPrimary">
                {creating ? 'Creating…' : `Create a ${groupType === 'timeline' ? 'Timeline ' : ''}group`}
              </AppText>
            </TouchableOpacity>
          )}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  tabs: {
    flexDirection: 'row',
    paddingHorizontal: spacing.marginMobile,
    gap: 8,
    marginBottom: spacing.sm,
  },
  tab: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: borderRadius.full,
    backgroundColor: colors.surfaceContainerHigh,
  },
  tabActive: {
    backgroundColor: colors.primaryContainer,
  },
  content: {
    flex: 1,
  },
  scrollContent: {
    padding: spacing.marginMobile,
    paddingBottom: spacing.lg,
  },
  errorCard: {
    marginHorizontal: spacing.marginMobile,
    padding: spacing.sm,
    backgroundColor: colors.errorContainer,
    borderRadius: borderRadius.default,
    marginBottom: spacing.sm,
  },
  groupCard: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  groupName: {
    flexShrink: 1,
  },
  createGroupButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.sm,
    marginBottom: spacing.sm,
  },
  inviteActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  acceptButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  declineButton: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  modeHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  sectionLabel: {
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  criteriaHeading: {
    marginTop: spacing.lg,
  },
  hint: {
    marginBottom: spacing.sm,
  },
  textArea: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.default,
    padding: spacing.sm,
    fontSize: 15,
    color: colors.onSurface,
    minHeight: 88,
    textAlignVertical: 'top',
  },
  previewCard: {
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderLeftWidth: 4,
    borderLeftColor: colors.primary,
    borderRadius: borderRadius.default,
    padding: spacing.sm,
    marginBottom: spacing.md,
  },
  previewName: {
    marginVertical: spacing.xs,
  },
  descriptionHeader: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: spacing.sm,
  },
  category: {
    marginBottom: spacing.md,
  },
  categoryLabel: {
    marginBottom: spacing.xs,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    padding: 3,
  },
  segment: {
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
  },
  // Narrower than the 3-option precision `segment` — six cutoff steps need
  // to fit the same row width.
  cutoffSegment: {
    paddingVertical: 6,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.full,
  },
  segmentActive: {
    backgroundColor: colors.primary,
  },
  strictnessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  cutoffRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  stemOptSection: {
    marginTop: spacing.md,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.outlineVariant,
  },
  stemOptRow: {
    marginBottom: spacing.sm,
  },
  stemOptLabel: {
    marginBottom: spacing.xs,
  },
  scopeSectionLabel: {
    marginBottom: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  // A date-kind scope row (I-485's priority date). Matches the group page's
  // postJoinDateInput — RN has no native date control on this surface.
  scopeDateInput: {
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
  searchButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.md,
  },
  results: {
    marginTop: spacing.md,
  },
  resultCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.sm,
    backgroundColor: colors.surfaceContainerLow,
    borderRadius: borderRadius.lg,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  resultInfo: {
    flex: 1,
    minWidth: 0,
  },
  joinButton: {
    backgroundColor: colors.secondary,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: borderRadius.default,
  },
  createButton: {
    backgroundColor: colors.primary,
    opacity: 0.9,
    borderRadius: borderRadius.default,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    marginTop: spacing.lg,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  createAttrInput: {
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
  createAttrNotesInput: {
    width: '100%',
    minHeight: 60,
    textAlignVertical: 'top',
  },
});

export default FindScreen;
