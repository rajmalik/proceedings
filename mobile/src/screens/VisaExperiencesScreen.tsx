import React, { useCallback, useEffect, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
} from 'react-native';
import Animated, { FadeIn, FadeInDown, FadeInUp, Layout } from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { PostingCard, AnimatedPressable, AnimatedListItem, Skeleton, ErrorState } from '../components';
import { useAuth } from '../contexts/AuthContext';
import { colors, spacing, borderRadius, typography } from '../constants/theme';
import {
  searchPostings,
  browsePostings,
  facetId,
  SearchResultItem,
  SuggestedFilterGroup,
  Strictness,
} from '../services/apiService';

const EXAMPLES = ['B1/B2 Mumbai', 'H-1B RFE', 'F-1 to H-1B'];

const STRICTNESS_LEVELS: { value: Strictness; label: string }[] = [
  { value: 'broad', label: 'Broad' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'strict', label: 'Strict' },
];

// Clear the floating tab bar (~70pt) so the last cards and "Load more" stay reachable.
const TAB_BAR_CLEARANCE = 96;

export function VisaExperiencesScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<any>>();
  const { isBlocked } = useAuth();
  const [query, setQuery] = useState('');
  const [strictness, setStrictness] = useState<Strictness>('balanced');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  // Case ids the viewer just reported/blocked — hidden instantly (App Store 1.2).
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [suggested, setSuggested] = useState<SuggestedFilterGroup[]>([]);
  const [selectedFacets, setSelectedFacets] = useState<Set<string>>(new Set());
  const [nextPageToken, setNextPageToken] = useState('');
  const [searched, setSearched] = useState(false);
  // 'browse' = the default recent feed (empty query); 'search' = a typed/faceted
  // relevance query. Drives which source "Load more" pages from.
  const [mode, setMode] = useState<'browse' | 'search'>('browse');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // Default view: the most-recent visa postings, auto-loaded (no empty prompt).
  const loadFeed = useCallback(async () => {
    setLoading(true);
    setError('');
    setMode('browse');
    setSelectedFacets(new Set());
    setSuggested([]);
    try {
      const data = await browsePostings({ sort: 'recent' });
      setResults(data.results);
      setNextPageToken(data.next_page_token);
      setSearched(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load experiences');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  const runSearch = useCallback(
    async (q: string, facets: Set<string>, level: Strictness) => {
      setLoading(true);
      setError('');
      setMode('search');
      try {
        const data = await searchPostings(q, {
          strictness: level,
          facets: Array.from(facets),
        });
        setResults(data.results);
        setNextPageToken(data.next_page_token);
        setSuggested(data.suggested_filters);
        setSearched(true);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Search failed');
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const loadMore = async () => {
    if (!nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const data =
        mode === 'browse'
          ? await browsePostings({ sort: 'recent', pageToken: nextPageToken })
          : await searchPostings(query, {
              strictness,
              facets: Array.from(selectedFacets),
              pageToken: nextPageToken,
            });
      setResults((prev) => [...prev, ...data.results]);
      setNextPageToken(data.next_page_token);
    } catch {
      // keep what we have
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleFacet = (field: string, code: string) => {
    const id = facetId(field, code);
    const next = new Set(selectedFacets);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedFacets(next);
    runSearch(query, next, strictness);
  };

  const changeStrictness = (level: Strictness) => {
    setStrictness(level);
    // Precision only applies to a relevance search — don't turn the recent
    // browse into one.
    if (mode === 'search') runSearch(query, selectedFacets, level);
  };

  const submit = (q?: string) => {
    const text = (q ?? query).trim();
    if (q !== undefined) setQuery(q);
    setSelectedFacets(new Set());
    if (!text) {
      loadFeed(); // empty search reverts to the recent browse
      return;
    }
    runSearch(text, new Set(), strictness);
  };

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safeArea} edges={['top']}>
        {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => navigation.goBack()}>
          <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>USA Visits/Migration Journey</Text>
        <View style={styles.backButton} />
      </View>

      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
      >
        {/* Search box */}
        <View style={styles.searchRow}>
          <View style={styles.searchInputWrap}>
            <Ionicons name="search" size={18} color={colors.onSurfaceVariant} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search USA visits/migration journey..."
              placeholderTextColor={colors.onSurfaceVariant}
              returnKeyType="search"
              onSubmitEditing={() => submit()}
            />
          </View>
          <AnimatedPressable
            style={[styles.searchButton, loading && { opacity: 0.7 }]}
            onPress={() => submit()}
            disabled={loading}
            haptics="medium"
          >
            {loading ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={styles.searchButtonText}>Search</Text>
            )}
          </AnimatedPressable>
        </View>

        {/* Strictness */}
        <View style={styles.strictnessRow}>
          <Text style={styles.strictnessLabel}>Precision</Text>
          <View style={styles.segmented}>
            {STRICTNESS_LEVELS.map((l) => (
              <TouchableOpacity
                key={l.value}
                style={[styles.segment, strictness === l.value && styles.segmentActive]}
                onPress={() => changeStrictness(l.value)}
              >
                <Text style={[styles.segmentText, strictness === l.value && styles.segmentTextActive]}>
                  {l.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Suggested filters */}
        {suggested.length > 0 && (
          <View style={styles.filtersBlock}>
            <View style={styles.filtersHeader}>
              <Ionicons name="filter" size={16} color={colors.primary} />
              <Text style={styles.filtersTitle}>Refine by</Text>
            </View>
            {suggested.map((g) => (
              <View key={g.key} style={styles.filterGroup}>
                <Text style={styles.filterGroupLabel}>{g.label}</Text>
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  {g.values.map((v) => {
                    const active = selectedFacets.has(facetId(g.field, v.code));
                    return (
                      <TouchableOpacity
                        key={v.code}
                        style={[styles.facetChip, active && styles.facetChipActive]}
                        onPress={() => toggleFacet(g.field, v.code)}
                      >
                        <Text style={[styles.facetChipText, active && styles.facetChipTextActive]}>
                          {v.label} ({v.count})
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              </View>
            ))}
          </View>
        )}

        {/* Loading skeleton — matches the results layout so the screen doesn't
            flash blank while searching (UI_AUDIT §8). */}
        {loading && <Skeleton.Card count={4} style={styles.results} />}

        {error && !loading ? (
          <ErrorState body={error} onRetry={() => submit(query)} style={styles.results} />
        ) : null}

        {/* Empty state with example prompts */}
        {!searched && !loading && !error && (
          <Animated.View style={styles.emptyState} entering={FadeInUp.delay(200).duration(400)}>
            <Ionicons name="search" size={40} color={colors.onSurfaceVariant} />
            <Text style={styles.emptyTitle}>Search real USA visits/migration journey</Text>
            <Text style={styles.emptyText}>
              Find postings from applicants in the same situation - by visa, consulate, or what happened.
            </Text>
            <View style={styles.exampleRow}>
              {EXAMPLES.map((ex) => (
                <AnimatedPressable
                  key={ex}
                  style={styles.exampleChip}
                  onPress={() => submit(ex)}
                  haptics="light"
                >
                  <Text style={styles.exampleChipText}>{ex}</Text>
                </AnimatedPressable>
              ))}
            </View>
          </Animated.View>
        )}

        {/* Results */}
        {searched && !loading && !error && (() => {
          // Hide postings from blocked authors instantly (server also filters).
          const visible = results.filter((r) => !isBlocked(r.author_id) && !hiddenIds.has(r.case_id));
          return (
          <Animated.View style={styles.results} entering={FadeIn.duration(300)}>
            <Text style={styles.resultsCount}>
              {visible.length === 0
                ? 'No results - try broadening your search.'
                : `${visible.length} result${visible.length === 1 ? '' : 's'}`}
            </Text>
            {visible.map((r, index) => (
              // Stagger capped at 6 (A4 policy) so long feeds appear promptly.
              <AnimatedListItem key={r.case_id} index={Math.min(index, 6)} staggerDelay={60}>
                <PostingCard
                  posting={r}
                  authorId={r.author_id}
                  onActioned={() => setHiddenIds((prev) => new Set(prev).add(r.case_id))}
                  onPress={() => navigation.navigate('CaseDetails', { caseId: r.case_id })}
                />
              </AnimatedListItem>
            ))}
            {nextPageToken ? (
              <AnimatedPressable style={styles.loadMore} onPress={loadMore} disabled={loadingMore} haptics="light">
                <Text style={styles.loadMoreText}>{loadingMore ? 'Loading...' : 'Load more'}</Text>
              </AnimatedPressable>
            ) : null}
          </Animated.View>
          );
        })()}

        </ScrollView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.surface },
  safeArea: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
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
  headerTitle: {
    fontFamily: 'Lora_600SemiBold',
    fontSize: 17,
    color: colors.onSurface,
  },
  content: { flex: 1, paddingHorizontal: spacing.md },
  searchRow: { flexDirection: 'row', gap: spacing.base, marginTop: spacing.md },
  searchInputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
    backgroundColor: colors.surfaceContainerLowest,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
  },
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 15, color: colors.onSurface, fontFamily: 'NunitoSans_400Regular' },
  searchButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minWidth: 76,
    alignItems: 'center',
  },
  searchButtonText: { color: colors.onPrimary, fontSize: 14, fontFamily: 'NunitoSans_600SemiBold' },
  strictnessRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  strictnessLabel: { fontSize: 13, color: colors.onSurfaceVariant, fontFamily: 'NunitoSans_500Medium' },
  segmented: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    padding: 3,
  },
  segment: { paddingVertical: 6, paddingHorizontal: spacing.md, borderRadius: borderRadius.full },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: 13, color: colors.onSurfaceVariant, fontFamily: 'NunitoSans_400Regular' },
  segmentTextActive: { color: colors.onPrimary, fontFamily: 'NunitoSans_600SemiBold' },
  filtersBlock: { marginTop: spacing.md },
  filtersHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.base },
  filtersTitle: { fontSize: 13, fontWeight: '600', color: colors.onSurface },
  filterGroup: { marginBottom: spacing.base },
  filterGroupLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    color: colors.onSurfaceVariant,
    marginBottom: 4,
  },
  facetChip: {
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    marginRight: spacing.base,
  },
  facetChipActive: { backgroundColor: colors.primaryContainer },
  facetChipText: { fontSize: 12, color: colors.onSurfaceVariant },
  facetChipTextActive: { color: colors.onPrimaryContainer, fontWeight: '600' },
  error: { color: colors.error, marginTop: spacing.md },
  emptyState: { alignItems: 'center', marginTop: spacing.xl * 1.5, paddingHorizontal: spacing.lg },
  emptyTitle: {
    fontFamily: 'Lora_700Bold',
    fontSize: 22,
    lineHeight: 28,
    color: colors.onSurface,
    marginTop: spacing.md,
    textAlign: 'center',
  },
  emptyText: {
    fontFamily: 'NunitoSans_400Regular',
    fontSize: 15,
    lineHeight: 22,
    color: colors.onSurfaceVariant,
    textAlign: 'center',
    marginTop: spacing.base,
  },
  exampleRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.base,
    marginTop: spacing.md,
    justifyContent: 'center',
  },
  exampleChip: {
    backgroundColor: colors.primaryContainer,
    borderRadius: borderRadius.full,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
  },
  exampleChipText: { fontSize: 13, color: colors.onPrimaryContainer },
  results: { marginTop: spacing.md },
  resultsCount: { fontSize: 13, color: colors.onSurfaceVariant, marginBottom: spacing.base },
  loadMore: {
    alignSelf: 'center',
    paddingVertical: spacing.base,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    marginTop: spacing.base,
  },
  loadMoreText: { fontSize: 14, color: colors.onSurface, fontWeight: '500' },
});

export default VisaExperiencesScreen;
