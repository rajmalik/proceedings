import React, { useCallback, useEffect, useState } from 'react';
import { View, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Header,
  PostingCard,
  Skeleton,
  EmptyState,
  ErrorState,
  AnimatedListItem,
  AppText,
} from '../components';
import { colors, spacing, borderRadius } from '../constants/theme';
import { searchPostings, SearchResultItem } from '../services/apiService';

// doc_kind:gov_news is the hard filter that scopes results to News (real
// ingested government agency updates — see docs/ingestion/GOV-NEWS-*.md).
// Reuses searchPostings/PostingCard as-is: same shape as SearchScreen's
// feed, zero backend changes needed.
const NEWS_FACET = 'doc_kind:gov_news';
const PAGE_SIZE = 20;

// Clear the absolutely-positioned floating tab bar (~70pt) so the last cards
// and the "Load more" button stay reachable.
const TAB_BAR_CLEARANCE = 96;

export function NewsScreen({ navigation }: any) {
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<SearchResultItem[]>([]);
  const [nextPageToken, setNextPageToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await searchPostings('', { facets: [NEWS_FACET], pageSize: PAGE_SIZE });
      setItems(data.results);
      setNextPageToken(data.next_page_token);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load news');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadMore = async () => {
    if (!nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const data = await searchPostings('', {
        facets: [NEWS_FACET],
        pageSize: PAGE_SIZE,
        pageToken: nextPageToken,
      });
      setItems((prev) => [...prev, ...data.results]);
      setNextPageToken(data.next_page_token);
    } catch {
      // keep what we have
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <View style={styles.container}>
      <Header showLogo showSearch />

      <ScrollView
        style={styles.content}
        contentContainerStyle={{ paddingBottom: insets.bottom + TAB_BAR_CLEARANCE }}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.pageHeader}>
          <AppText variant="headlineLg" color="onSurface">
            News
          </AppText>
          <AppText variant="bodyMd" color="onSurfaceVariant" style={styles.pageSubtitle}>
            Official updates from government immigration agencies.
          </AppText>
        </View>

        {error ? <ErrorState body={error} onRetry={load} /> : null}

        {loading && <Skeleton.Card count={4} style={styles.results} />}

        {!loading && !error && items.length === 0 && (
          <EmptyState
            icon="newspaper-outline"
            title="No news updates yet"
            body="Check back soon for official immigration agency updates."
          />
        )}

        {!loading && items.length > 0 && (
          <View style={styles.results}>
            {items.map((item, index) => (
              // Stagger capped at the first 6 items (A4 policy), same as SearchScreen.
              <AnimatedListItem key={item.case_id} index={Math.min(index, 6)} staggerDelay={60}>
                <PostingCard
                  posting={item}
                  authorId={item.author_id}
                  onPress={() => navigation.navigate('CaseDetails', { caseId: item.case_id })}
                />
              </AnimatedListItem>
            ))}
            {nextPageToken ? (
              <TouchableOpacity style={styles.loadMore} onPress={loadMore} disabled={loadingMore}>
                <AppText variant="labelMd" color="onSurface">
                  {loadingMore ? 'Loading…' : 'Load more'}
                </AppText>
              </TouchableOpacity>
            ) : null}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { flex: 1, paddingHorizontal: spacing.md },
  pageHeader: {
    paddingTop: spacing.md,
    paddingBottom: spacing.sm,
  },
  pageSubtitle: {
    marginTop: spacing.xs,
  },
  results: { marginTop: spacing.md },
  loadMore: {
    alignSelf: 'center',
    paddingVertical: spacing.base,
    paddingHorizontal: spacing.lg,
    backgroundColor: colors.surfaceContainerHigh,
    borderRadius: borderRadius.full,
    marginTop: spacing.base,
  },
});

export default NewsScreen;
