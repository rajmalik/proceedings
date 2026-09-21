import React from 'react';
import { Linking } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { renderScreen, fireEvent } from '../../test/render';
import { CaseDetailsScreen } from '../CaseDetailsScreen';
import { getPosting } from '../../services/apiService';

// CaseDetailsScreen renders the shared <Header>, which reads useSafeAreaInsets() —
// needs a real provider ancestor in the test tree (see PostScreen.test.tsx for the
// same pattern).
const TEST_METRICS = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } };
function renderCaseDetails(navigation: ReturnType<typeof makeNav>) {
  return renderScreen(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <CaseDetailsScreen navigation={navigation} route={route} />
    </SafeAreaProvider>
  );
}

jest.mock('../../services/apiService', () => ({ getPosting: jest.fn() }));
// Stub the heavy children that fetch on their own - isolate the screen's own UI.
jest.mock('../../components/VoteControl', () => ({ VoteControl: () => null }));
jest.mock('../../components/Replies', () => ({ Replies: () => null }));
// The report/block overflow pulls the auth context; stub it out for this screen test.
jest.mock('../../components/ContentActionsMenu', () => ({ ContentActionsMenu: () => null }));
jest.mock('../../components/AuthorCard', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return { AuthorCard: ({ authorId }: any) => React.createElement(Text, null, 'AUTHORCARD:' + authorId) };
});

const BASE = {
  case_id: 'app-1', title: 'My H-1B experience', description: '', visa: ['H-1B'],
  consulates: [], outcome: '', subreddit: '', channel: 'app', tags: [], url: '',
  date: '2026-06-13', body: '', author_id: '', author_handle: '', tag_sections: [],
};

function mockPosting(over: Record<string, unknown>) {
  (getPosting as jest.Mock).mockResolvedValue({ ...BASE, ...over });
}

const makeNav = () => ({ navigate: jest.fn(), push: jest.fn(), goBack: jest.fn() });
const route = { params: { caseId: 'app-1' } };

describe('CaseDetailsScreen', () => {
  it('renders every tag category as its own labeled section', async () => {
    mockPosting({
      tag_sections: [
        { label: 'Applying for', tags: ['EB-2'] },
        { label: 'Concerns & questions', tags: ['rfe', 'wage-compliance'] },
      ],
    });
    const screen = await renderCaseDetails(makeNav());

    expect(await screen.findByText('Applying for')).toBeOnTheScreen();
    expect(screen.getByText('Concerns & questions')).toBeOnTheScreen();
    expect(screen.getByText('EB-2')).toBeOnTheScreen();
    expect(screen.getByText('rfe')).toBeOnTheScreen();
  });

  // Website parity: reported live that a redundant "Original Content"/"Full
  // Experience" section heading above the posting body read as clutter — the
  // posting's own title already introduces it, and the AI summary (website)
  // has its own distinct label, so there's no ambiguity to disambiguate.
  it('renders the posting body without a "Full Experience" section heading', async () => {
    mockPosting({ body: 'The full text of the posting.' });
    const screen = await renderCaseDetails(makeNav());

    expect(await screen.findByText('The full text of the posting.')).toBeOnTheScreen();
    expect(screen.queryByText('Full Experience')).toBeNull();
  });

  it('first-party posting (handle, no uid): shows a tappable author → AuthorByHandle', async () => {
    mockPosting({ author_id: '', author_handle: 'brave-maple-3272' });
    const navigation = makeNav();
    const screen = await renderCaseDetails(navigation);

    const handle = await screen.findByText('brave-maple-3272');
    await fireEvent.press(handle);
    expect(navigation.navigate).toHaveBeenCalledWith('AuthorByHandle', { handle: 'brave-maple-3272' });
    // the rich uid-based card must NOT render here
    expect(screen.queryByText(/AUTHORCARD:/)).toBeNull();
  });

  it('in-app author (real uid): renders the rich AuthorCard, not the handle card', async () => {
    mockPosting({ author_id: 'user-9', author_handle: 'brave-maple-3272' });
    const screen = await renderCaseDetails(makeNav());

    expect(await screen.findByText('AUTHORCARD:user-9')).toBeOnTheScreen();
    expect(screen.queryByText('brave-maple-3272')).toBeNull();
  });

  // Phase 2.9 fix (features/ui-changes-1): gov-news content has a fixed
  // per-source handle (e.g. "USCIS") with no in-app profile behind it, so it
  // must link OUT to the source URL — not into AuthorByHandle like a real
  // app-channel handle would. Mirrors the website's case/[id]/page.tsx
  // 3-way branch (AuthorCard / Source-link / AuthorByHandle).
  it('gov-news posting (fixed source handle): shows "Source" heading, opens the external URL, never navigates in-app', async () => {
    const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    mockPosting({
      channel: 'gov_news', author_id: '', author_handle: 'USCIS',
      url: 'https://www.uscis.gov/newsroom/some-update',
    });
    const navigation = makeNav();
    const screen = await renderCaseDetails(navigation);

    // "Source" also appears as a plain label in the top Details card
    // (independent of channel) — the author-block heading is the SECOND
    // occurrence, so assert both are present rather than a single match.
    await screen.findByText('View the original announcement');
    expect(screen.getAllByText('Source')).toHaveLength(2);
    expect(screen.queryByText('Author')).toBeNull();

    const handle = screen.getByText('USCIS');
    await fireEvent.press(handle);
    expect(openURL).toHaveBeenCalledWith('https://www.uscis.gov/newsroom/some-update');
    expect(navigation.navigate).not.toHaveBeenCalledWith('AuthorByHandle', expect.anything());
    expect(screen.queryByText(/AUTHORCARD:/)).toBeNull();

    openURL.mockRestore();
  });

  it('app-channel posting (not gov-news): shows "Author" heading, not "Source"', async () => {
    mockPosting({ channel: 'app', author_id: '', author_handle: 'brave-maple-3272' });
    const screen = await renderCaseDetails(makeNav());

    expect(await screen.findByText('Author')).toBeOnTheScreen();
    // The Details card's plain "Source" label still renders (unrelated to
    // channel), but the author-block heading must not be a second "Source".
    expect(screen.getAllByText('Source')).toHaveLength(1);
    expect(screen.getByText('See all postings by this author')).toBeOnTheScreen();
  });
});
