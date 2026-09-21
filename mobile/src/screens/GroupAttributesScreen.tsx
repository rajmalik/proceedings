import React, { useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation, useRoute, RouteProp } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { colors, spacing } from '../constants/theme';
import { AppText, Skeleton, EmptyState, ErrorState } from '../components';
import {
  PostJoinAttributeRow,
  getGroup,
  getMemberAttributes,
  getTagVocab,
  GroupInfo,
  MemberAttributes,
} from '../services/apiService';

type RouteParams = {
  GroupAttributes: { groupId: string; groupName?: string };
};

// Two-line headers let each column be narrower, so more attributes fit
// before the row needs scrolling — the whole point of this screen.
const COL_WIDTH = 96;
const HEADER_LINES = 2;

/**
 * Every member's submitted attributes for one group, side by side — the wide
 * view the group screen's narrow member rows can't give, and the mobile
 * counterpart of the website's /groups/[id]/members table page.
 *
 * React Native has no <table>, so this is the divider-row list idiom inside a
 * horizontal ScrollView: one fixed-width column per template row, so columns
 * stay aligned between the header and every member row.
 */
export function GroupAttributesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const route = useRoute<RouteProp<RouteParams, 'GroupAttributes'>>();
  const { groupId, groupName } = route.params;

  const [group, setGroup] = useState<GroupInfo | null>(null);
  const [attrs, setAttrs] = useState<MemberAttributes[]>([]);
  const [rows, setRows] = useState<PostJoinAttributeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getGroup(groupId),
      getMemberAttributes(groupId).catch(() => ({ attributes: [] as MemberAttributes[] })),
      getTagVocab().catch(() => null),
    ])
      .then(([g, a, v]) => {
        if (cancelled) return;
        setGroup(g);
        setAttrs(a.attributes || []);
        // Same matched-template lookup as GroupChatScreen and the backend's
        // _matched_post_join_type() — the columns ARE the template.
        const templates = v?.post_join_attribute_templates || {};
        const c = g.criteria_tags;
        const candidates =
          g.group_type === 'timeline' && c
            ? [...(c.tags || []), ...(c.current_visa_or_greencard_category || [])]
            : [];
        const matched = candidates.find((t) => t in templates) || '';
        setRows(matched ? templates[matched] || [] : []);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load attributes');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [groupId]);

  const byUser: Record<string, MemberAttributes> = {};
  attrs.forEach((a) => {
    byUser[a.user_id] = a;
  });

  // One filter per column, keyed by row key ('' = Member, '_notes' = Notes).
  // Every column, not just dates/status/service centre: the columns ARE
  // configuration, so a hardcoded subset would stop covering a column added
  // from Firestore tomorrow. Substring matching means a date column filters
  // by year ("2026") or year-month ("2026-03") with no range picker.
  const [filters, setFilters] = useState<Record<string, string>>({});
  const setFilter = (key: string, value: string) =>
    setFilters((f) => ({ ...f, [key]: value }));
  const activeCount = Object.values(filters).filter(Boolean).length;

  const cellText = (m: { user_id: string; username: string }, key: string): string => {
    const a = byUser[m.user_id];
    if (key === '') return m.username;
    if (key === '_notes') return a?.notes || '';
    const row = rows.find((r) => r.key === key);
    if (row?.kind === 'checkbox') return a?.values?.[key] ? 'Yes' : '';
    return a?.values?.[key] || '';
  };

  const visibleMembers = (group?.members || []).filter((m) =>
    Object.entries(filters)
      .filter(([, v]) => v)
      .every(([key, want]) => cellText(m, key).toLowerCase().includes(want.toLowerCase())));

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} accessibilityLabel="Back">
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <AppText variant="titleMd" color="onSurface" style={styles.headerTitle} numberOfLines={1}>
          {group?.name || groupName || 'Attributes'}
        </AppText>
        {activeCount > 0 && (
          <TouchableOpacity onPress={() => setFilters({})} accessibilityLabel="Clear filters">
            <AppText variant="caption" color="primary">
              Clear ({activeCount})
            </AppText>
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.body}>
          <Skeleton style={styles.skeletonRow} />
          <Skeleton style={styles.skeletonRow} />
          <Skeleton style={styles.skeletonRow} />
        </View>
      ) : error ? (
        <ErrorState body={error} />
      ) : !group?.is_member ? (
        <EmptyState icon="lock-closed-outline" title="Members only" body="Only members can see this." />
      ) : rows.length === 0 ? (
        <EmptyState
          title="Nothing to compare"
          body="This group doesn't collect timeline attributes."
        />
      ) : (
        <ScrollView horizontal>
          <ScrollView>
            <View style={styles.headerRow}>
              <AppText variant="caption" color="onSurfaceVariant" style={styles.memberCol} numberOfLines={HEADER_LINES}>
                MEMBER
              </AppText>
              {rows.map((r) => (
                <AppText
                  key={r.key}
                  variant="caption"
                  color="onSurfaceVariant"
                  style={styles.headerCell}
                  numberOfLines={HEADER_LINES}
                >
                  {r.label.toUpperCase()}
                </AppText>
              ))}
              <AppText variant="caption" color="onSurfaceVariant" style={styles.headerCell} numberOfLines={HEADER_LINES}>
                NOTES
              </AppText>
            </View>
            {/* Filter row, aligned to the same fixed-width columns. There is
                no <select> in RN, so a select/checkbox column cycles through
                its configured options on tap rather than opening a picker for
                a two-to-four-item domain. */}
            <View style={styles.filterRow}>
              <TextInput
                style={[styles.filterInput, styles.memberCol]}
                value={filters[''] || ''}
                onChangeText={(t) => setFilter('', t)}
                placeholder="Filter"
                placeholderTextColor={colors.onSurfaceVariant}
                accessibilityLabel="Filter Member"
              />
              {rows.map((r) => {
                const domain = r.kind === 'checkbox' ? ['Yes'] : r.kind === 'select' ? r.options || [] : null;
                if (domain) {
                  const current = filters[r.key] || '';
                  const next = domain[(domain.indexOf(current) + 1) % (domain.length + 1)] ?? '';
                  return (
                    <TouchableOpacity
                      key={r.key}
                      style={[styles.filterInput, styles.cell]}
                      onPress={() => setFilter(r.key, next)}
                      accessibilityLabel={`Filter ${r.label}`}
                    >
                      <AppText variant="caption" color={current ? 'primary' : 'onSurfaceVariant'} numberOfLines={1}>
                        {current || 'All'}
                      </AppText>
                    </TouchableOpacity>
                  );
                }
                return (
                  <TextInput
                    key={r.key}
                    style={[styles.filterInput, styles.cell]}
                    value={filters[r.key] || ''}
                    onChangeText={(t) => setFilter(r.key, t)}
                    placeholder="Filter"
                    placeholderTextColor={colors.onSurfaceVariant}
                    accessibilityLabel={`Filter ${r.label}`}
                  />
                );
              })}
              <TextInput
                style={[styles.filterInput, styles.cell]}
                value={filters['_notes'] || ''}
                onChangeText={(t) => setFilter('_notes', t)}
                placeholder="Filter"
                placeholderTextColor={colors.onSurfaceVariant}
                accessibilityLabel="Filter Notes"
              />
            </View>
            {visibleMembers.length === 0 && (
              <View style={styles.dataRow}>
                <AppText variant="bodyMd" color="onSurfaceVariant">
                  No members match these filters.
                </AppText>
              </View>
            )}
            {visibleMembers.map((m) => {
              const a = byUser[m.user_id];
              return (
                <View key={m.user_id} style={styles.dataRow}>
                  <AppText variant="bodyMd" color="onSurface" style={styles.memberCol} numberOfLines={1}>
                    {m.username}
                  </AppText>
                  {rows.map((r) => (
                    r.kind === 'checkbox' ? (
                      <View key={r.key} style={styles.cell}>
                        {a?.values?.[r.key]
                          ? <Ionicons name="checkmark" size={18} color={colors.primary} />
                          : <AppText variant="bodyMd" color="onSurfaceVariant">—</AppText>}
                      </View>
                    ) : (
                      <AppText key={r.key} variant="bodyMd" color="onSurfaceVariant" style={styles.cell}>
                        {a?.values?.[r.key] || '—'}
                      </AppText>
                    )
                  ))}
                  <AppText variant="caption" color="onSurfaceVariant" style={styles.cell}>
                    {a?.notes || '—'}
                  </AppText>
                </View>
              );
            })}
          </ScrollView>
        </ScrollView>
      )}
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
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  headerTitle: {
    flex: 1,
  },
  body: {
    padding: spacing.md,
  },
  skeletonRow: {
    height: 24,
    marginBottom: spacing.sm,
  },
  headerCell: {
    width: COL_WIDTH,
    paddingRight: spacing.sm,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  filterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
    backgroundColor: colors.surfaceContainerLowest,
  },
  filterInput: {
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: 4,
    paddingHorizontal: spacing.xs,
    paddingVertical: 2,
    marginRight: spacing.xs,
    fontSize: 12,
    color: colors.onSurface,
    minHeight: 26,
    justifyContent: 'center',
  },
  dataRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.outlineVariant,
  },
  memberCol: {
    width: COL_WIDTH,
    paddingRight: spacing.sm,
  },
  cell: {
    width: COL_WIDTH,
    paddingRight: spacing.sm,
  },
});

export default GroupAttributesScreen;
