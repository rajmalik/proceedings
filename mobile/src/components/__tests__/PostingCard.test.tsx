import React from 'react';
import { renderScreen } from '../../test/render';
import { PostingCard, type PostingCardData } from '../PostingCard';

function posting(over: Partial<PostingCardData> = {}): PostingCardData {
  return {
    case_id: 'app-1', title: 'H-1B RFE experience', description: 'desc',
    visa: ['H-1B'], consulates: [], outcome: '', subreddit: '', channel: 'app',
    tags: [], url: '', date: '2026-07-28',
    ...over,
  };
}

// features/ui-changes-1/changes-2-.md item 2: "at least one relevant/main
// tag" must always render — visa first, falling back to a general tag when
// there's no visa/status. Item 1: a distinct "News" pill for news-update.
describe('PostingCard tag/news badges', () => {
  it('renders the visa badge when present (no fallback needed)', async () => {
    const s = await renderScreen(<PostingCard posting={posting({ visa: ['H-1B'], tags: ['timeline'] })} />);
    expect(s.getByText('H-1B')).toBeOnTheScreen();
    expect(s.queryByText('timeline')).toBeNull();
  });

  it('falls back to the first general tag when there is no visa/status', async () => {
    const s = await renderScreen(<PostingCard posting={posting({ visa: [], tags: ['timeline', 'other'] })} />);
    expect(s.getByText('timeline')).toBeOnTheScreen();
  });

  it('shows a distinct "News" pill when tags include news-update', async () => {
    const s = await renderScreen(
      <PostingCard posting={posting({ visa: [], channel: 'gov_news', tags: ['news-update', 'USCIS'] })} />
    );
    expect(s.getByText('News')).toBeOnTheScreen();
    expect(s.getByText('USCIS')).toBeOnTheScreen();
  });

  it('does not show the News pill for a regular posting', async () => {
    const s = await renderScreen(<PostingCard posting={posting({ tags: ['timeline'] })} />);
    expect(s.queryByText('News')).toBeNull();
  });

  // Phase D: Discussions tab — same badge pattern as News, for the two tags
  // (discussion/blog) that scope the new tab's content.
  it('shows a distinct "Discussion" pill when tags include discussion', async () => {
    const s = await renderScreen(
      <PostingCard posting={posting({ visa: [], tags: ['discussion', 'family-based-immigration'] })} />
    );
    expect(s.getByText('Discussion')).toBeOnTheScreen();
    expect(s.getByText('family-based-immigration')).toBeOnTheScreen();
  });

  it('shows a distinct "Blog" pill when tags include blog', async () => {
    const s = await renderScreen(<PostingCard posting={posting({ visa: [], tags: ['blog', 'h1b-lottery'] })} />);
    expect(s.getByText('Blog')).toBeOnTheScreen();
    expect(s.getByText('h1b-lottery')).toBeOnTheScreen();
  });

  // discussion/blog/news-update aren't mutually exclusive (Phase B: a
  // link-share reacting to news gets both news-update and discussion) — all
  // applicable pills must render together, and the fallback tag badge must
  // skip all three, not just whichever one happens to be present.
  it('shows News, Discussion, and Blog pills together when a card carries all three tags', async () => {
    const s = await renderScreen(
      <PostingCard posting={posting({ visa: [], tags: ['news-update', 'discussion', 'blog', 'OPT'] })} />
    );
    expect(s.getByText('News')).toBeOnTheScreen();
    expect(s.getByText('Discussion')).toBeOnTheScreen();
    expect(s.getByText('Blog')).toBeOnTheScreen();
    expect(s.getByText('OPT')).toBeOnTheScreen();
  });

  it('the fallback tag badge skips news-update, discussion, AND blog, not just one of them', async () => {
    const s = await renderScreen(
      <PostingCard posting={posting({ visa: [], tags: ['news-update', 'discussion', 'blog'] })} />
    );
    expect(s.getAllByText('News')).toHaveLength(1);
    expect(s.getAllByText('Discussion')).toHaveLength(1);
    expect(s.getAllByText('Blog')).toHaveLength(1);
  });
});
