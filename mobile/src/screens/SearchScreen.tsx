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
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Header, PostingCard, Skeleton, EmptyState, ErrorState, AnimatedListItem, FilterChip, AppText } from '../components';
import { useAuth } from '../contexts/AuthContext';
import { colors, spacing, borderRadius } from '../constants/theme';
import { AI_ASSIST_ENABLED } from '../constants/flags';
import { openAssist } from '../utils/assistLauncher';
import {
  searchPostings,
  browsePostings,
  fetchQueryTags,
  facetId,
  SearchResultItem,
  SuggestedFilterGroup,
  QueryTag,
} from '../services/apiService';

// Same example prompts as the website's empty search state.
const EXAMPLES = ['B1/B2 Mumbai', 'H-1B RFE', 'F-1 to H-1B'];

// Fallback label for a facet id with no known display label yet (restored
// from state with none recorded) — turns "tags:change-of-status-COS" into
// "Change Of Status COS".
function humanizeFacetId(id: string): string {
  const code = id.includes(':') ? id.slice(id.indexOf(':') + 1) : id;
  return code.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Clear the absolutely-positioned floating tab bar (~70pt) so the last cards
// and the "Load more" button stay reachable.
const TAB_BAR_CLEARANCE = 96;

export function SearchScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const { isBlocked } = useAuth();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResultItem[]>([]);
  // Case ids the viewer just reported/blocked — hidden instantly (App Store 1.2).
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [suggested, setSuggested] = useState<SuggestedFilterGroup[]>([]);
  const [queryTags, setQueryTags] = useState<QueryTag[]>([]);
  const [selectedFacets, setSelectedFacets] = useState<Set<string>>(new Set());
  // Display labels for selectedFacets, keyed by facet id — independent of
  // `suggested`, which is recomputed from the CURRENT (already-filtered)
  // result set and can silently stop including a facet the user has
  // selected, leaving no affordance to remove it. This map is the client's
  // own record of what's active, so the "Active filters" chips below
  // always have something to render and remove.
  const [facetLabels, setFacetLabels] = useState<Record<string, string>>({});
  const [nextPageToken, setNextPageToken] = useState('');
  const [searched, setSearched] = useState(false);
  // 'browse' = default recent feed (empty query); 'search' = typed/faceted
  // relevance query. Drives which source "Load more" pages from.
  const [mode, setMode] = useState<'browse' | 'search'>('browse');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  // Default feed: the most-recent postings, auto-loaded (no empty prompt).
  const loadFeed = useCallback(async () => {
    setLoading(true);
    setError('');
    setMode('browse');
    setSelectedFacets(new Set());
    setFacetLabels({});
    setSuggested([]);
    setQueryTags([]);
    try {
      const data = await browsePostings({ sort: 'event' });
      setResults(data.results);
      setNextPageToken(data.next_page_token);
      setSearched(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load feed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  const runSearch = useCallback(
    async (q: string, facets: Set<string>) => {
      setLoading(true);
      setError('');
      setMode('search');
      try {
        const data = await searchPostings(q, {
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
          ? await browsePostings({ sort: 'event', pageToken: nextPageToken })
          : await searchPostings(query, {
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

  const toggleFacet = (field: string, code: string, label?: string) => {
    const id = facetId(field, code);
    const next = new Set(selectedFacets);
    const removing = next.has(id);
    if (removing) next.delete(id);
    else next.add(id);
    setSelectedFacets(next);
    if (!removing && label) setFacetLabels((prev) => ({ ...prev, [id]: label }));
    runSearch(query, next);
  };

  // Definitive fallback for clearing every active facet at once — separate
  // from removing them one at a time via toggleFacet.
  const clearFilters = () => {
    setSelectedFacets(new Set());
    runSearch(query, new Set());
  };

  const submit = (q?: string) => {
    const text = (q ?? query).trim();
    if (q !== undefined) setQuery(q);
    setSelectedFacets(new Set());
    if (!text) {
      loadFeed(); // empty search reverts to the recent feed
      return;
    }
    runSearch(text, new Set());
    // Query-derived tag chips (parallel, non-blocking — a real Gemini call,
    // so this fires once per submit, not per keystroke). Best-effort: a
    // slow/failed call just leaves the chip row empty.
    fetchQueryTags(text).then(setQueryTags).catch(() => {});
  };

  return (
    <View style={styles.container}>
      <Header
        showLogo
        transparent
        rightAction={
          <TouchableOpacity
            style={styles.postButton}
            onPress={() => navigation.navigate('Post')}
            accessibilityLabel="Post a new message"
          >
            <Ionicons name="create-outline" size={20} color={colors.onPrimary} />
          </TouchableOpacity>
        }
      />

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
              placeholder="Search USA visits/migration journey…"
              placeholderTextColor={colors.onSurfaceVariant}
              returnKeyType="search"
              onSubmitEditing={() => submit()}
            />
          </View>
          <TouchableOpacity style={styles.searchButton} onPress={() => submit()} disabled={loading}>
            {loading ? (
              <ActivityIndicator size="small" color={colors.onPrimary} />
            ) : (
              <Text style={styles.searchButtonText}>Search</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.advancedSearchButton}
            onPress={() => navigation.navigate('AdvancedSearch')}
            accessibilityLabel="Advanced Search"
          >
            <Ionicons name="options-outline" size={20} color={colors.onSurfaceVariant} />
          </TouchableOpacity>
        </View>

        {/* AI Assist launcher (flag-gated) — opens the global chat modal, which
            also handles posting. Website parity: the Home "Ask AI/Post" entry. */}
        {AI_ASSIST_ENABLED && (
          <TouchableOpacity style={styles.askAiButton} onPress={openAssist} accessibilityLabel="Ask AI or post a question">
            <Ionicons name="sparkles" size={16} color={colors.onPrimary} />
            <Text style={styles.askAiText}>Ask AI / Post</Text>
          </TouchableOpacity>
        )}

        {/* The client's own record of active facets — always shown and
            removable, independent of whether the next `suggested` response
            happens to echo these same facets back (a facet that narrows
            the result set enough can legitimately stop being suggested for
            that narrower set, which previously left no way to undo it). */}
        {selectedFacets.size > 0 && (
          <View style={styles.filtersBlock}>
            <View style={styles.activeFiltersHeader}>
              <AppText variant="labelMd" color="onSurface" style={styles.queryTagsTitle}>
                Active filters
              </AppText>
              <TouchableOpacity onPress={clearFilters}>
                <AppText variant="caption" color="primary">Clear all</AppText>
              </TouchableOpacity>
            </View>
            <View style={styles.queryTagsRow}>
              {Array.from(selectedFacets).map((id) => {
                const idx = id.indexOf(':');
                const field = idx >= 0 ? id.slice(0, idx) : id;
                const code = idx >= 0 ? id.slice(idx + 1) : '';
                return (
                  <FilterChip
                    key={id}
                    label={facetLabels[id] || humanizeFacetId(id)}
                    selected
                    onPress={() => toggleFacet(field, code)}
                  />
                );
              })}
            </View>
          </View>
        )}

        {/* Tags generated from the search text itself (Gemini, same tagging
            principles as posting composition) — a separate concept from the
            "Refine by" facets below, which are backend result-derived.
            Tapping one plugs into the same selectedFacets/toggleFacet
            mechanism. features/ui-changes-1/changes-2-.md item 4. */}
        {queryTags.length > 0 && (
          <View style={styles.filtersBlock}>
            <AppText variant="labelMd" color="onSurface" style={styles.queryTagsTitle}>
              Tags from your search
            </AppText>
            <View style={styles.queryTagsRow}>
              {queryTags.map((t) => (
                <FilterChip
                  key={facetId(t.field, t.code)}
                  label={t.label}
                  selected={selectedFacets.has(facetId(t.field, t.code))}
                  onPress={() => toggleFacet(t.field, t.code, t.label)}
                />
              ))}
            </View>
          </View>
        )}

        {/* Suggested filters from the search response (website parity) */}
        {suggested.length > 0 && (
          <View style={styles.filtersBlock}>
            <View style={styles.filtersHeader}>
              <Ionicons name="filter" size={16} color={colors.secondary} />
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
                        onPress={() => toggleFacet(g.field, v.code, v.label)}
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

        {error ? (
          <ErrorState body={error} onRetry={() => runSearch(query, selectedFacets)} />
        ) : null}

        {/* Loading — skeleton feed instead of a bare spinner */}
        {loading && <Skeleton.Card count={4} style={styles.results} />}

        {/* Empty state with example prompts (website parity) */}
        {!searched && !loading && (
          <View style={styles.emptyState}>
            <Ionicons name="search" size={40} color={colors.onSurfaceVariant} />
            <Text style={styles.emptyTitle}>Search real USA visits/migration journey</Text>
            <Text style={styles.emptyText}>
              Find postings from applicants in the same situation — by visa, consulate, or what happened.
            </Text>
            <View style={styles.exampleRow}>
              {EXAMPLES.map((ex) => (
                <TouchableOpacity key={ex} style={styles.exampleChip} onPress={() => submit(ex)}>
                  <Text style={styles.exampleChipText}>{ex}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {/* Results */}
        {searched && !loading && (() => {
          // Hide postings from blocked authors + just-reported cards instantly
          // (server also filters).
          const visible = results.filter((r) => !isBlocked(r.author_id) && !hiddenIds.has(r.case_id));
          if (visible.length === 0 && !error) {
            return (
              <EmptyState
                icon="search-outline"
                title="No results"
                body="Try broadening your search or removing a filter."
              />
            );
          }
          return (
          <View style={styles.results}>
            <Text style={styles.resultsCount}>
              {`${visible.length} result${visible.length === 1 ? '' : 's'}`}
            </Text>
            {visible.map((r, index) => (
              // Stagger capped at the first 6 items (A4 policy) so long feeds
              // don't feel slow to appear.
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
              <TouchableOpacity style={styles.loadMore} onPress={loadMore} disabled={loadingMore}>
                <Text style={styles.loadMoreText}>{loadingMore ? 'Loading…' : 'Load more'}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
          );
        })()}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
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
  searchInput: { flex: 1, paddingVertical: 10, fontSize: 15, color: colors.onSurface },
  searchButton: {
    backgroundColor: colors.primary,
    borderRadius: borderRadius.full,
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    minWidth: 76,
    alignItems: 'center',
  },
  searchButtonText: { color: colors.onPrimary, fontWeight: '600', fontSize: 14 },
  advancedSearchButton: {
    width: 40,
    height: 40,
    borderRadius: borderRadius.full,
    borderWidth: 1,
    borderColor: colors.outlineVariant,
    backgroundColor: colors.surfaceContainerLowest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  askAiButton: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing.base,
    marginTop: spacing.sm,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
  },
  askAiText: { color: colors.onPrimary, fontWeight: '600', fontSize: 14 },
  postButton: {
    width: 36,
    height: 36,
    borderRadius: borderRadius.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },
  filtersBlock: { marginTop: spacing.md },
  filtersHeader: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: spacing.base },
  activeFiltersHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  filtersTitle: { fontSize: 13, fontWeight: '600', color: colors.onSurface },
  queryTagsTitle: { marginBottom: spacing.base },
  queryTagsRow: { flexDirection: 'row', flexWrap: 'wrap' },
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
  emptyTitle: { fontSize: 18, fontWeight: '600', color: colors.onSurface, marginTop: spacing.md },
  emptyText: {
    fontSize: 14,
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
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    paddingVertical: 8,
    paddingHorizontal: spacing.md,
  },
  exampleChipText: { fontSize: 13, color: colors.onSurface },
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

export default SearchScreen;
