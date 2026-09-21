import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { SearchScreen } from '../SearchScreen';
import { browsePostings, searchPostings, fetchQueryTags } from '../../services/apiService';

const TEST_METRICS = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } };
async function renderSearch(navigation: { navigate: jest.Mock } = { navigate: jest.fn() }) {
  const s = await renderScreen(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <SearchScreen navigation={navigation} />
    </SafeAreaProvider>
  );
  // Let the mount-time loadFeed() settle before interacting, so it doesn't
  // race with the search we're about to submit.
  await waitFor(() => expect(browsePostings).toHaveBeenCalled());
  return s;
}

jest.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ isBlocked: () => false }) }));
// Flag ON so the "Ask AI/Post" launcher renders; openAssist stubbed.
jest.mock('../../constants/flags', () => ({ AI_ASSIST_ENABLED: true }));
jest.mock('../../utils/assistLauncher', () => ({ openAssist: jest.fn() }));
jest.mock('../../services/apiService', () => {
  const actual = jest.requireActual('../../services/apiService');
  return {
    ...actual,
    browsePostings: jest.fn(),
    searchPostings: jest.fn(),
    fetchQueryTags: jest.fn(),
  };
});

const POSTING = {
  case_id: 'app-1', title: 'H-1B RFE experience', description: '', visa: ['H-1B'],
  consulates: [], outcome: '', subreddit: '', channel: 'app', tags: [], url: '',
  date: '2026-07-28',
};

beforeEach(() => {
  jest.clearAllMocks();
  (browsePostings as jest.Mock).mockResolvedValue({ results: [], next_page_token: '', suggested_filters: [] });
  (searchPostings as jest.Mock).mockResolvedValue({ results: [POSTING], next_page_token: '', suggested_filters: [] });
  (fetchQueryTags as jest.Mock).mockResolvedValue([]);
});

// features/ui-changes-1/changes-2-.md item 4: query-derived tag chips, fired
// once per search submit (not per keystroke) and toggled through the same
// selectedFacets mechanism as the "Refine by" backend facets.
describe('SearchScreen — query-derived tag chips', () => {
  it('fetches query tags on submit and renders them as toggleable chips', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValue([
      { field: 'tags', code: 'RFE', label: 'RFE' },
      { field: 'tags', code: 'POE', label: 'POE' },
    ]);

    const s = await renderSearch();
    await fireEvent.changeText(s.getByPlaceholderText('Search USA visits/migration journey…'), 'H1B RFE POE Boston');
    await fireEvent.press(s.getByText('Search'));

    await waitFor(() => expect(fetchQueryTags).toHaveBeenCalledWith('H1B RFE POE Boston'));
    expect(await s.findByText('RFE')).toBeOnTheScreen();
    expect(s.getByText('POE')).toBeOnTheScreen();
  });

  it('toggling a query-tag chip re-runs the search with that facet applied', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValue([{ field: 'tags', code: 'RFE', label: 'RFE' }]);

    const s = await renderSearch();
    await fireEvent.changeText(s.getByPlaceholderText('Search USA visits/migration journey…'), 'H1B RFE');
    await fireEvent.press(s.getByText('Search'));
    const chip = await s.findByText('RFE');

    await fireEvent.press(chip);

    await waitFor(() =>
      expect(searchPostings).toHaveBeenLastCalledWith(
        'H1B RFE',
        expect.objectContaining({ facets: ['tags:RFE'] })
      )
    );
  });

  it('does not show the query-tags row when there are none', async () => {
    const s = await renderSearch();
    await fireEvent.changeText(s.getByPlaceholderText('Search USA visits/migration journey…'), 'a plain query');
    await fireEvent.press(s.getByText('Search'));

    await s.findByText('H-1B RFE experience');
    expect(s.queryByText('Tags from your search')).toBeNull();
  });
});

// Regression: a facet's chip in "Refine by" comes from `suggested`, which
// is recomputed from the CURRENT (already-filtered) result set on every
// response. A facet that narrows results enough can legitimately stop
// being suggested for that narrower set — previously that silently
// removed the only way to undo the selection.
describe('SearchScreen — Active filters stay removable independent of suggested', () => {
  it('a selected facet remains removable even after the backend stops suggesting it', async () => {
    (searchPostings as jest.Mock)
      .mockResolvedValueOnce({
        results: [POSTING], next_page_token: '',
        suggested_filters: [{ key: 'tag', label: 'Topic', field: 'tags', values: [{ code: 'arrest', label: 'Arrest', count: 25 }] }],
      })
      .mockResolvedValueOnce({
        results: [{ ...POSTING, title: 'Arrest result' }], next_page_token: '',
        // No longer suggests "Arrest" for the narrowed set — only "Approved".
        suggested_filters: [{ key: 'tag', label: 'Topic', field: 'tags', values: [{ code: 'approved', label: 'Approved', count: 12 }] }],
      });

    const s = await renderSearch();
    await fireEvent.changeText(s.getByPlaceholderText('Search USA visits/migration journey…'), 'H1B RFE');
    await fireEvent.press(s.getByText('Search'));
    await fireEvent.press(await s.findByText('Arrest (25)'));
    await s.findByText('Arrest result');

    // "Arrest (25)" is gone from "Refine by" (only "Approved (12)" shows),
    // but "Arrest" must still appear, and be removable, as an active filter.
    expect(s.queryByText('Arrest (25)')).toBeNull();
    expect(await s.findByText('Approved (12)')).toBeOnTheScreen();
    const activeChip = await s.findByText('Arrest');

    await fireEvent.press(activeChip);

    await waitFor(() =>
      expect(searchPostings).toHaveBeenLastCalledWith('H1B RFE', expect.objectContaining({ facets: [] }))
    );
  });

  it('Clear all removes every active filter at once', async () => {
    (searchPostings as jest.Mock)
      .mockResolvedValueOnce({
        results: [POSTING], next_page_token: '',
        suggested_filters: [{
          key: 'tag', label: 'Topic', field: 'tags',
          values: [{ code: 'arrest', label: 'Arrest', count: 25 }, { code: 'approved', label: 'Approved', count: 65 }],
        }],
      })
      .mockResolvedValue({
        results: [{ ...POSTING, title: 'Filtered result' }], next_page_token: '',
        suggested_filters: [{ key: 'tag', label: 'Topic', field: 'tags', values: [{ code: 'approved', label: 'Approved', count: 12 }] }],
      });

    const s = await renderSearch();
    await fireEvent.changeText(s.getByPlaceholderText('Search USA visits/migration journey…'), 'H1B RFE');
    await fireEvent.press(s.getByText('Search'));
    await fireEvent.press(await s.findByText('Arrest (25)'));
    await fireEvent.press(await s.findByText('Approved (12)'));
    await s.findByText('Filtered result');
    expect(s.getByText('Active filters')).toBeOnTheScreen();

    await fireEvent.press(s.getByText('Clear all'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenLastCalledWith('H1B RFE', expect.objectContaining({ facets: [] }))
    );
    expect(s.queryByText('Active filters')).toBeNull();
  });
});

describe('SearchScreen — Advanced Search entry point', () => {
  it('navigates to AdvancedSearch when the button is pressed', async () => {
    const navigation = { navigate: jest.fn() };
    const s = await renderSearch(navigation);

    await fireEvent.press(s.getByLabelText('Advanced Search'));

    expect(navigation.navigate).toHaveBeenCalledWith('AdvancedSearch');
  });
});

// Precision (Broad/Balanced/Strict) moved to Advanced Search — main search
// always runs at "balanced" and has no picker of its own.
describe('SearchScreen — Match precision', () => {
  it('shows no Precision control', async () => {
    const s = await renderSearch();

    expect(s.queryByText('Precision')).toBeNull();
    expect(s.queryByText('Broad')).toBeNull();
    expect(s.queryByText('Strict')).toBeNull();
  });

  it('search calls searchPostings without a strictness override (backend default is balanced)', async () => {
    const s = await renderSearch();
    await fireEvent.changeText(s.getByPlaceholderText('Search USA visits/migration journey…'), 'H1B RFE');

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() => expect(searchPostings).toHaveBeenCalled());
    const [, opts] = (searchPostings as jest.Mock).mock.calls[0];
    expect(opts.strictness).toBeUndefined();
  });
});

// Advanced Search's News/Cutoff controls (includeNews, maxAgeDays) are
// explicit opt-ins — Home must never send them, on any code path, so the
// backend keeps applying each branch's own legacy default (see
// backend/api.py's _recency_news_clause). A regression here would silently
// change Home's search behavior the next time someone touches runSearch.
describe('SearchScreen — never sends Advanced Search\'s News/Cutoff params', () => {
  it('a typed-text search omits includeNews and maxAgeDays', async () => {
    const s = await renderSearch();
    await fireEvent.changeText(s.getByPlaceholderText('Search USA visits/migration journey…'), 'H1B RFE');

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() => expect(searchPostings).toHaveBeenCalled());
    const [, opts] = (searchPostings as jest.Mock).mock.calls[0];
    expect(opts.includeNews).toBeUndefined();
    expect(opts.maxAgeDays).toBeUndefined();
  });

  it('a facet-refine search omits includeNews and maxAgeDays', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValue([{ field: 'tags', code: 'RFE', label: 'RFE' }]);
    const s = await renderSearch();
    await fireEvent.changeText(s.getByPlaceholderText('Search USA visits/migration journey…'), 'H1B RFE');
    await fireEvent.press(s.getByText('Search'));
    const chip = await s.findByText('RFE');

    await fireEvent.press(chip);

    await waitFor(() => expect(searchPostings).toHaveBeenCalledTimes(2));
    const [, opts] = (searchPostings as jest.Mock).mock.calls[1];
    expect(opts.includeNews).toBeUndefined();
    expect(opts.maxAgeDays).toBeUndefined();
  });
});

describe('SearchScreen — Ask AI/Post launcher (AI_ASSIST_ENABLED)', () => {
  it('renders the launcher and opens the assist modal on press', async () => {
    const { openAssist } = require('../../utils/assistLauncher');
    const s = await renderSearch();
    await fireEvent.press(s.getByText('Ask AI / Post'));
    expect(openAssist).toHaveBeenCalled();
  });
});
