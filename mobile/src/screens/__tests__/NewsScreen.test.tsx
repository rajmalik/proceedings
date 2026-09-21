import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { NewsScreen } from '../NewsScreen';
import { searchPostings } from '../../services/apiService';

const TEST_METRICS = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } };
function renderNews(navigation: { navigate: jest.Mock } = { navigate: jest.fn() }) {
  return renderScreen(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <NewsScreen navigation={navigation} />
    </SafeAreaProvider>
  );
}

jest.mock('../../services/apiService', () => ({ searchPostings: jest.fn() }));

const ITEM = {
  case_id: 'gov_news-uscis-2026-07-27-a37a68da', title: 'USCIS policy update', description: 'desc',
  visa: [], consulates: [], outcome: '', subreddit: '', channel: 'gov_news',
  tags: ['news-update', 'USCIS'], url: 'https://uscis.gov/x', date: '2026-07-27',
  author_id: '',
};

function mockNews(results: typeof ITEM[], nextPageToken = '') {
  (searchPostings as jest.Mock).mockResolvedValue({ results, next_page_token: nextPageToken, suggested_filters: [] });
}

beforeEach(() => jest.clearAllMocks());

// Phase 2.8 rewrite (features/ui-changes-1): NewsScreen went from mock data
// (mockData.newsArticles) to real gov-news postings via the doc_kind:gov_news
// hard facet, reusing SearchScreen's PostingCard/pagination pattern exactly.
describe('NewsScreen', () => {
  it('loads real gov-news postings on mount via the doc_kind:gov_news facet, not mock data', async () => {
    mockNews([ITEM]);
    const screen = await renderNews();

    expect(await screen.findByText('USCIS policy update')).toBeOnTheScreen();
    expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({ facets: ['doc_kind:gov_news'] }));
  });

  it('shows the empty state when there are no news items', async () => {
    mockNews([]);
    const screen = await renderNews();

    expect(await screen.findByText('No news updates yet')).toBeOnTheScreen();
  });

  it('shows an error state with retry on failure', async () => {
    (searchPostings as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const screen = await renderNews();

    expect(await screen.findByText('network down')).toBeOnTheScreen();

    mockNews([ITEM]);
    await fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('USCIS policy update')).toBeOnTheScreen();
  });

  it('tapping a card navigates to CaseDetails with the right caseId', async () => {
    mockNews([ITEM]);
    const navigation = { navigate: jest.fn() };
    const screen = await renderNews(navigation);

    const card = await screen.findByText('USCIS policy update');
    await fireEvent.press(card);
    expect(navigation.navigate).toHaveBeenCalledWith('CaseDetails', { caseId: ITEM.case_id });
  });

  it('"Load more" appends the next page using the returned page token', async () => {
    mockNews([ITEM], 'token-2');
    const screen = await renderNews();
    await screen.findByText('USCIS policy update');

    const item2 = { ...ITEM, case_id: 'gov_news-uscis-2026-07-20-bbbb', title: 'Older USCIS update' };
    (searchPostings as jest.Mock).mockResolvedValueOnce({ results: [item2], next_page_token: '', suggested_filters: [] });

    await fireEvent.press(screen.getByText('Load more'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenLastCalledWith(
        '',
        expect.objectContaining({ facets: ['doc_kind:gov_news'], pageToken: 'token-2' })
      )
    );
    expect(await screen.findByText('Older USCIS update')).toBeOnTheScreen();
    // Both pages' items stay visible — appended, not replaced.
    expect(screen.getByText('USCIS policy update')).toBeOnTheScreen();
  });
});
