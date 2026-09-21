import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { AdvancedSearchScreen } from '../AdvancedSearchScreen';
import { fetchQueryTags, searchPostings, getTagVocab } from '../../services/apiService';

const TEST_METRICS = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } };
async function renderAdvancedSearch(navigation: { navigate: jest.Mock; goBack: jest.Mock } = { navigate: jest.fn(), goBack: jest.fn() }) {
  const s = await renderScreen(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <AdvancedSearchScreen navigation={navigation} />
    </SafeAreaProvider>
  );
  await waitFor(() => expect(getTagVocab).toHaveBeenCalled());
  return s;
}

jest.mock('../../services/apiService', () => {
  const actual = jest.requireActual('../../services/apiService');
  return {
    ...actual,
    fetchQueryTags: jest.fn(),
    searchPostings: jest.fn(),
    getTagVocab: jest.fn(),
  };
});

const VOCAB = {
  visa: ['H-1B', 'F-1'],
  consulate: ['BOM'],
  consulate_options: [{ code: 'BOM', label: 'Mumbai, India (BOM)' }],
  consulate_tree: [],
  tag: ['rfe-experience', 'timeline'],
  misc: [],
  misc_options: [],
  stage_key: [],
  date_key: [],
  profile_stage_key: [],
  stage_value_domains: {},
  country: [],
  outcome: [],
};

const POSTING = {
  case_id: 'app-1', title: 'H-1B RFE experience', description: '', visa: ['H-1B'],
  consulates: [], outcome: '', subreddit: '', channel: 'app', tags: [], url: '',
  date: '2026-07-28',
};

beforeEach(() => {
  jest.clearAllMocks();
  (getTagVocab as jest.Mock).mockResolvedValue(VOCAB);
  (fetchQueryTags as jest.Mock).mockResolvedValue([]);
  (searchPostings as jest.Mock).mockResolvedValue({ results: [POSTING], next_page_token: '', suggested_filters: [] });
});

describe('AdvancedSearchScreen — header visibility', () => {
  it('shows no category sections initially, only "+ Add" chips', async () => {
    const s = await renderAdvancedSearch();
    expect(await s.findByText('+ Add Current status')).toBeOnTheScreen();
    expect(s.queryByText('CURRENT STATUS')).toBeNull();
  });

  it('reveals only the category with a generated tag after Send', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValue([{ field: 'visa_applying_for', code: 'H-1B', label: 'H-1B' }]);
    const s = await renderAdvancedSearch();
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'H-1B story');
    await fireEvent.press(s.getByText('Send'));

    expect(await s.findByText('APPLYING FOR')).toBeOnTheScreen();
    expect(s.queryByText('CURRENT STATUS')).toBeNull();
  });
});

describe('AdvancedSearchScreen — Send', () => {
  it('calls fetchQueryTags with the typed text and renders the returned tag', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValue([{ field: 'tags', code: 'rfe-experience', label: 'rfe-experience' }]);
    const s = await renderAdvancedSearch();
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'my rfe story');
    await fireEvent.press(s.getByText('Send'));

    await waitFor(() => expect(fetchQueryTags).toHaveBeenCalledWith('my rfe story'));
    expect(await s.findByText('rfe-experience')).toBeOnTheScreen();
  });

  it('a second Send resets the panel — replaces the previous tags/headers rather than merging', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValueOnce([
      { field: 'tags', code: 'rfe-experience', label: 'rfe-experience' },
    ]);
    const s = await renderAdvancedSearch();
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'first text');
    await fireEvent.press(s.getByText('Send'));
    expect(await s.findByText('rfe-experience')).toBeOnTheScreen();

    (fetchQueryTags as jest.Mock).mockResolvedValueOnce([{ field: 'consulates', code: 'BOM', label: 'BOM' }]);
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'second text');
    await fireEvent.press(s.getByText('Send'));

    expect(await s.findByText('Mumbai, India (BOM)')).toBeOnTheScreen();
    expect(s.queryByText('rfe-experience')).toBeNull();
    expect(s.queryByText('TAGS')).toBeNull();
  });

  it('Send resets manually-added tags too, not just AI-generated ones (full reset)', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('+ Add Current status'));
    const statusInput = await s.findByPlaceholderText('Add current status…');
    await fireEvent.changeText(statusInput, 'H-1B');
    await fireEvent.press(await s.findByText('H-1B'));
    expect(s.getByText('H-1B')).toBeOnTheScreen();

    (fetchQueryTags as jest.Mock).mockResolvedValueOnce([{ field: 'consulates', code: 'BOM', label: 'BOM' }]);
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'some text');
    await fireEvent.press(s.getByText('Send'));

    expect(await s.findByText('Mumbai, India (BOM)')).toBeOnTheScreen();
    expect(s.queryByText('H-1B')).toBeNull();
    expect(s.queryByText('CURRENT STATUS')).toBeNull();
  });
});

describe('AdvancedSearchScreen — Send error handling / disabled state', () => {
  it('shows an ErrorState when fetchQueryTags fails', async () => {
    (fetchQueryTags as jest.Mock).mockRejectedValue(new Error('The assistant is temporarily unavailable.'));
    const s = await renderAdvancedSearch();
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'x');
    await fireEvent.press(s.getByText('Send'));

    expect(await s.findByText('The assistant is temporarily unavailable.')).toBeOnTheScreen();
  });

  it('a failed second Send preserves the tags from the previous successful Send', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValueOnce([
      { field: 'tags', code: 'rfe-experience', label: 'rfe-experience' },
    ]);
    const s = await renderAdvancedSearch();
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'first text');
    await fireEvent.press(s.getByText('Send'));
    expect(await s.findByText('rfe-experience')).toBeOnTheScreen();

    (fetchQueryTags as jest.Mock).mockRejectedValueOnce(new Error('The assistant is temporarily unavailable.'));
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'second text');
    await fireEvent.press(s.getByText('Send'));

    expect(await s.findByText('The assistant is temporarily unavailable.')).toBeOnTheScreen();
    expect(s.getByText('rfe-experience')).toBeOnTheScreen();
  });

  it('pressing Send with empty/whitespace-only text does not call fetchQueryTags', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('Send'));
    expect(fetchQueryTags).not.toHaveBeenCalled();

    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), '   ');
    await fireEvent.press(s.getByText('Send'));
    expect(fetchQueryTags).not.toHaveBeenCalled();
  });
});

describe('AdvancedSearchScreen — manual add via TagPicker', () => {
  it('typing a substring and tapping a suggestion adds the tag to the right category', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('+ Add Tags'));

    const input = await s.findByPlaceholderText('Add tags…');
    await fireEvent.changeText(input, 'timeline');
    await fireEvent.press(await s.findByText('timeline'));

    expect(await s.findByText('TAGS')).toBeOnTheScreen();
  });

  it('removing a tag chip removes it', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValue([{ field: 'tags', code: 'timeline', label: 'timeline' }]);
    const s = await renderAdvancedSearch();
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'x');
    await fireEvent.press(s.getByText('Send'));
    const chip = await s.findByText('timeline');

    await fireEvent.press(chip);

    await waitFor(() => expect(s.getByText('None.')).toBeOnTheScreen());
  });

  it('adding the same value twice does not create a duplicate chip', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('+ Add Tags'));
    const input = await s.findByPlaceholderText('Add tags…');

    await fireEvent.changeText(input, 'timeline');
    await fireEvent.press(await s.findByText('timeline'));
    await fireEvent.changeText(input, 'timeline');
    // Two "timeline" texts now exist (the chip already added + the TagPicker
    // suggestion, which doesn't filter out already-selected values) — the
    // suggestion is the last one in document order.
    const matches = await s.findAllByText('timeline');
    await fireEvent.press(matches[matches.length - 1]);

    expect(s.getAllByText('timeline')).toHaveLength(1);
  });

  it('adds a consulate by its label, displaying the resolved label on the chip', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('+ Add Consulate(s)'));

    const input = await s.findByPlaceholderText('Add a consulate…');
    await fireEvent.changeText(input, 'Mumbai');
    await fireEvent.press(await s.findByText('Mumbai, India (BOM)'));

    expect(await s.findByText('Mumbai, India (BOM)')).toBeOnTheScreen();
  });

  it('all four categories revealed leaves no "+ Add" chips', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('+ Add Current status'));
    await fireEvent.press(s.getByText('+ Add Applying for'));
    await fireEvent.press(s.getByText('+ Add Consulate(s)'));
    await fireEvent.press(s.getByText('+ Add Tags'));

    await waitFor(() => expect(s.queryByText(/^\+ Add/)).toBeNull());
  });
});

describe('AdvancedSearchScreen — Precision', () => {
  it('defaults to Balanced and calls searchPostings with the selected level', async () => {
    const s = await renderAdvancedSearch();

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({ strictness: 'balanced' }))
    );
  });

  it('tapping Strict switches the level used on the next search', async () => {
    const s = await renderAdvancedSearch();

    await fireEvent.press(s.getByText('Strict'));
    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({ strictness: 'strict' }))
    );
  });
});

describe('AdvancedSearchScreen — News/Cutoff controls', () => {
  it('defaults to news included and all-time, sent explicitly on every search', async () => {
    const s = await renderAdvancedSearch();

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith(
        '', expect.objectContaining({ includeNews: true, maxAgeDays: 0 })
      )
    );
  });

  it('toggling the news switch off sends includeNews=false on the next search', async () => {
    const s = await renderAdvancedSearch();

    await fireEvent(s.getByTestId('include-news-switch'), 'valueChange', false);
    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({ includeNews: false }))
    );
  });

  it('tapping a cutoff step sends the matching maxAgeDays on the next search', async () => {
    const s = await renderAdvancedSearch();

    await fireEvent.press(s.getByText('30d'));
    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({ maxAgeDays: 30 }))
    );
  });

  it.each([
    ['7d', 7],
    ['90d', 90],
    ['6mo', 182],
    ['1yr', 365],
  ])('cutoff step %s sends maxAgeDays=%s', async (label, days) => {
    const s = await renderAdvancedSearch();

    await fireEvent.press(s.getByText(label));
    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({ maxAgeDays: days }))
    );
  });

  it('leaving the cutoff at "All" sends maxAgeDays=0, even combined with a tag filter', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('+ Add Tags'));
    const input = await s.findByPlaceholderText('Add tags…');
    await fireEvent.changeText(input, 'timeline');
    await fireEvent.press(await s.findByText('timeline'));

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith(
        '', expect.objectContaining({ facets: ['tags:timeline'], maxAgeDays: 0 })
      )
    );
  });

  it('toggling the news switch back on after switching it off reverts to includeNews=true', async () => {
    const s = await renderAdvancedSearch();

    await fireEvent(s.getByTestId('include-news-switch'), 'valueChange', false);
    await fireEvent(s.getByTestId('include-news-switch'), 'valueChange', true);
    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({ includeNews: true }))
    );
  });

  it('combines a tag filter, excluded news, and a cutoff window in the same search call', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('+ Add Tags'));
    const input = await s.findByPlaceholderText('Add tags…');
    await fireEvent.changeText(input, 'timeline');
    await fireEvent.press(await s.findByText('timeline'));
    await fireEvent(s.getByTestId('include-news-switch'), 'valueChange', false);
    await fireEvent.press(s.getByText('30d'));

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({
        facets: ['tags:timeline'], includeNews: false, maxAgeDays: 30,
      }))
    );
  });

  it('Load more carries forward the same includeNews/maxAgeDays as the initial search', async () => {
    (searchPostings as jest.Mock)
      .mockResolvedValueOnce({ results: [POSTING], next_page_token: 'p2', suggested_filters: [] })
      .mockResolvedValueOnce({ results: [{ ...POSTING, case_id: 'app-2' }], next_page_token: '', suggested_filters: [] });
    const s = await renderAdvancedSearch();
    await fireEvent(s.getByTestId('include-news-switch'), 'valueChange', false);
    await fireEvent.press(s.getByText('30d'));
    await fireEvent.press(s.getByText('Search'));
    await s.findByText('Load more');

    await fireEvent.press(s.getByText('Load more'));

    await waitFor(() => expect(searchPostings).toHaveBeenCalledTimes(2));
    expect(searchPostings).toHaveBeenLastCalledWith('', expect.objectContaining({
      pageToken: 'p2', includeNews: false, maxAgeDays: 30,
    }));
  });
});

describe('AdvancedSearchScreen — Search', () => {
  it('calls searchPostings with the text and the selected facets, renders inline', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValue([{ field: 'visa_applying_for', code: 'H-1B', label: 'H-1B' }]);
    const s = await renderAdvancedSearch();
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'H-1B story');
    await fireEvent.press(s.getByText('Send'));
    await s.findByText('H-1B');

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('H-1B story', expect.objectContaining({ facets: ['visa_applying_for:H-1B'] }))
    );
    expect(await s.findByText('H-1B RFE experience')).toBeOnTheScreen();
  });

  it('paginates via Load more, accumulating results', async () => {
    (searchPostings as jest.Mock)
      .mockResolvedValueOnce({ results: [POSTING], next_page_token: 'p2', suggested_filters: [] })
      .mockResolvedValueOnce({ results: [{ ...POSTING, case_id: 'app-2' }], next_page_token: '', suggested_filters: [] });
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('Search'));
    await s.findByText('Load more');

    await fireEvent.press(s.getByText('Load more'));

    await waitFor(() => expect(searchPostings).toHaveBeenCalledTimes(2));
    expect(searchPostings).toHaveBeenLastCalledWith('', expect.objectContaining({ pageToken: 'p2' }));
    await waitFor(() => expect(s.queryByText('Load more')).toBeNull());
  });

  it('shows an ErrorState when searchPostings fails', async () => {
    (searchPostings as jest.Mock).mockRejectedValue(new Error('Search backend unavailable'));
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('Search'));

    expect(await s.findByText('Search backend unavailable')).toBeOnTheScreen();
  });

  it('searching with tags only (no free text) still calls searchPostings with an empty query', async () => {
    const s = await renderAdvancedSearch();
    await fireEvent.press(s.getByText('+ Add Tags'));
    const input = await s.findByPlaceholderText('Add tags…');
    await fireEvent.changeText(input, 'timeline');
    await fireEvent.press(await s.findByText('timeline'));

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith('', expect.objectContaining({ facets: ['tags:timeline'] }))
    );
  });

  it('includes every selected tag across multiple categories in the facets array', async () => {
    (fetchQueryTags as jest.Mock).mockResolvedValue([
      { field: 'visa_applying_for', code: 'H-1B', label: 'H-1B' },
      { field: 'consulates', code: 'BOM', label: 'BOM' },
      { field: 'tags', code: 'timeline', label: 'timeline' },
    ]);
    const s = await renderAdvancedSearch();
    await fireEvent.changeText(s.getByPlaceholderText(/H-1B RFE experiences/), 'x');
    await fireEvent.press(s.getByText('Send'));
    await s.findByText('timeline');

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() =>
      expect(searchPostings).toHaveBeenCalledWith(
        'x',
        expect.objectContaining({ facets: expect.arrayContaining(['visa_applying_for:H-1B', 'consulates:BOM', 'tags:timeline']) })
      )
    );
  });
});
