import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { DiscussionsScreen } from '../DiscussionsScreen';
import { searchPostings } from '../../services/apiService';

const TEST_METRICS = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } };
function renderDiscussions(navigation: { navigate: jest.Mock } = { navigate: jest.fn() }) {
  return renderScreen(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <DiscussionsScreen navigation={navigation} />
    </SafeAreaProvider>
  );
}

jest.mock('../../services/apiService', () => ({ searchPostings: jest.fn() }));

const ITEM = {
  case_id: 'app-2026-07-27-a37a68da', title: 'Group chat for June PP delay', description: 'desc',
  visa: [], consulates: [], outcome: '', subreddit: '', channel: 'app',
  tags: ['discussion', 'h1b-petition'], url: '', date: '2026-07-27',
  author_id: '',
};

function mockDiscussions(results: typeof ITEM[], nextPageToken = '') {
  (searchPostings as jest.Mock).mockResolvedValue({ results, next_page_token: nextPageToken, suggested_filters: [] });
}

beforeEach(() => jest.clearAllMocks());

// Phase D (features/ui-changes-1/changes-2-.md follow-up): DiscussionsScreen
// mirrors NewsScreen's structure exactly, just filtered on tags:discussion/
// tags:blog instead of doc_kind:gov_news — non-personal content (general
// topics, shared articles, how-to guides), not tied to one person's case.
describe('DiscussionsScreen', () => {
  it('loads discussion/blog postings on mount via the tags:discussion/tags:blog facets', async () => {
    mockDiscussions([ITEM]);
    const screen = await renderDiscussions();

    expect(await screen.findByText('Group chat for June PP delay')).toBeOnTheScreen();
    expect(searchPostings).toHaveBeenCalledWith(
      '',
      expect.objectContaining({ facets: ['tags:discussion', 'tags:blog'] })
    );
  });

  it('shows the empty state when there are no discussions', async () => {
    mockDiscussions([]);
    const screen = await renderDiscussions();

    expect(await screen.findByText('No discussions yet')).toBeOnTheScreen();
  });

  it('shows an error state with retry on failure', async () => {
    (searchPostings as jest.Mock).mockRejectedValueOnce(new Error('network down'));
    const screen = await renderDiscussions();

    expect(await screen.findByText('network down')).toBeOnTheScreen();

    mockDiscussions([ITEM]);
    await fireEvent.press(screen.getByText('Try again'));
    expect(await screen.findByText('Group chat for June PP delay')).toBeOnTheScreen();
  });

  it('tapping a card navigates to CaseDetails with the right caseId', async () => {
    mockDiscussions([ITEM]);
    const navigation = { navigate: jest.fn() };
    const screen = await renderDiscussions(navigation);

    const card = await screen.findByText('Group chat for June PP delay');
    await fireEvent.press(card);
    expect(navigation.navigate).toHaveBeenCalledWith('CaseDetails', { caseId: ITEM.case_id });
  });

  it('"Load more" appends the next page using the returned page token', async () => {
    mockDiscussions([ITEM], 'token-2');
    const screen = await renderDiscussions();
    await screen.findByText('Group chat for June PP delay');

    const item2 = { ...ITEM, case_id: 'app-2026-07-20-bbbb', title: 'A shared H-1B lottery guide' };
    (searchPostings as jest.Mock).mockResolvedValueOnce({ results: [item2], next_page_token: '', suggested_filters: [] });

    await fireEvent.press(screen.getByText('Load more'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenLastCalledWith(
        '',
        expect.objectContaining({ facets: ['tags:discussion', 'tags:blog'], pageToken: 'token-2' })
      )
    );
    expect(await screen.findByText('A shared H-1B lottery guide')).toBeOnTheScreen();
    // Both pages' items stay visible — appended, not replaced.
    expect(screen.getByText('Group chat for June PP delay')).toBeOnTheScreen();
  });
});

describe('DiscussionsScreen — create entry', () => {
  it('"Start a discussion" navigates to the Post composer in discussion mode', async () => {
    (searchPostings as jest.Mock).mockResolvedValue({ results: [], next_page_token: '', suggested_filters: [] });
    const navigation = { navigate: jest.fn() };
    const screen = await renderDiscussions(navigation);
    await waitFor(() => expect(searchPostings).toHaveBeenCalled());
    await fireEvent.press(screen.getByText('Start a discussion'));
    expect(navigation.navigate).toHaveBeenCalledWith('Post', { kind: 'discussion' });
  });
});
