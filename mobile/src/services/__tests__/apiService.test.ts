import { searchPostings, assistTurn, getAssistSessionId } from '../apiService';

// assistTurn gates on AI consent (like askQuestion/onboard) — no-op it here.
jest.mock('../aiConsent', () => ({
  assertAIConsent: jest.fn(),
  AIConsentError: class AIConsentError extends Error {},
}));

// Regression: searchPostings used to default an empty `q` to the literal
// filler string "immigration visa experience" before building the request
// URL. Discovery Engine relevance-ranks against `q` IN ADDITION TO applying
// any facet filter, so that filler string silently dropped facet-matching
// documents that didn't also relevance-match it — confirmed live: a
// `tags:asylum` filter alone returned the correct 24 postings, but with the
// filler `q` attached it dropped to 3. This is the actual apiService.ts
// implementation (not the mocked module other screen tests use), since the
// bug lived inside the URL-building logic itself.
describe('apiService.searchPostings — no filler q text', () => {
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ results: [], next_page_token: '', suggested_filters: [] }),
    })) as unknown as typeof fetch;
  });

  it('omits the q param entirely for a facet-only search (empty query)', async () => {
    await searchPostings('', { facets: ['tags:asylum'] });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('q=');
    expect(calledUrl).toContain(encodeURIComponent('tags:asylum'));
  });

  it('still sends q when the caller passes real typed text', async () => {
    await searchPostings('asylum', {});

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('q=asylum');
  });
});

// Advanced Search's News/Cutoff controls — the same URL-building layer this
// bug lived in, so it gets the same direct (non-mocked) unit coverage.
describe('apiService.searchPostings — includeNews / maxAgeDays', () => {
  beforeEach(() => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ results: [], next_page_token: '', suggested_filters: [] }),
    })) as unknown as typeof fetch;
  });

  it('sends include_news=true when includeNews: true is passed', async () => {
    await searchPostings('', { facets: ['tags:asylum'], includeNews: true });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('include_news=true');
  });

  it('sends include_news=false when includeNews: false is passed', async () => {
    await searchPostings('', { facets: ['tags:asylum'], includeNews: false });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('include_news=false');
  });

  it('omits include_news entirely when the caller never passes it (Home/News/Discussions)', async () => {
    await searchPostings('', { facets: ['tags:asylum'] });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('include_news');
  });

  it('sends max_age_days when a positive value is passed', async () => {
    await searchPostings('', { facets: ['tags:asylum'], maxAgeDays: 30 });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('max_age_days=30');
  });

  it('omits max_age_days when 0 ("All time") is passed — 0 is the no-restriction sentinel, not a real window', async () => {
    await searchPostings('', { facets: ['tags:asylum'], maxAgeDays: 0 });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('max_age_days');
  });

  it('omits max_age_days entirely when the caller never passes it', async () => {
    await searchPostings('', { facets: ['tags:asylum'] });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('max_age_days');
  });

  it('combines includeNews=false and maxAgeDays together in the same request', async () => {
    await searchPostings('', { facets: ['tags:asylum'], includeNews: false, maxAgeDays: 90 });

    const calledUrl = (global.fetch as jest.Mock).mock.calls[0][0] as string;
    expect(calledUrl).toContain('include_news=false');
    expect(calledUrl).toContain('max_age_days=90');
    expect(calledUrl).toContain(encodeURIComponent('tags:asylum'));
  });
});

// ---------------------------------------------------------------------------
// Group + invitation calls.
//
// This branch added ~14 of these and none had coverage — the file only tested
// search-param building. They are the whole client half of the groups feature,
// and each one hand-rolls the same four things: the URL (with the group id
// interpolated), the method, the identity headers, and the error message it
// raises when the backend says no. A dropped X-User-Id here is invisible until
// a live 400.
// ---------------------------------------------------------------------------
import {
  archiveGroup, searchGroups, addMembers, joinGroup, saveMemberAttributes,
  getMemberAttributes, inviteToGroup, getMyInvitations, getGroupInvitations,
  acceptInvitation, declineInvitation, findCandidates, saveKeyDates,
  previewGroup, requiredAttributeKeys, setActiveUserId, CHECKBOX_ON,
  type PostJoinAttributeRow,
} from '../apiService';

const API = process.env.EXPO_PUBLIC_API_URL
  || 'https://immiguide-api-971592620882.us-central1.run.app';

function mockOk(payload: unknown = { ok: true }) {
  global.fetch = jest.fn(async () => ({
    ok: true, status: 200, json: async () => payload,
  })) as unknown as typeof fetch;
}
function mockErr(status: number, payload: unknown) {
  global.fetch = jest.fn(async () => ({
    ok: false, status, json: async () => payload,
  })) as unknown as typeof fetch;
}
const call = (n = 0) => (global.fetch as jest.Mock).mock.calls[n];
const url = (n = 0) => String(call(n)[0]);
const init = (n = 0) => (call(n)[1] || {}) as RequestInit;
const headers = (n = 0) => (init(n).headers || {}) as Record<string, string>;
const body = (n = 0) => JSON.parse(String(init(n).body ?? '{}'));

describe('apiService — group calls carry the caller identity', () => {
  beforeEach(async () => {
    await setActiveUserId('demo-arjun');
    mockOk();
  });
  afterEach(async () => { await setActiveUserId(null); });

  it('attaches X-User-Id to an authed group call', async () => {
    await joinGroup('g1');
    expect(headers()['X-User-Id']).toBe('demo-arjun');
  });

  it('omits X-User-Id entirely when there is no active user', async () => {
    // An empty header value would read as a real (blank) identity upstream.
    await setActiveUserId(null);
    mockOk();
    await joinGroup('g1');
    expect(headers()).not.toHaveProperty('X-User-Id');
  });

  it('does NOT send identity on group SEARCH — that route is public', async () => {
    await searchGroups({} as never, 'timeline', 'balanced', 0);
    expect(headers()).not.toHaveProperty('X-User-Id');
  });
});

describe('apiService — URL, method and body per call', () => {
  beforeEach(async () => { await setActiveUserId('demo-arjun'); mockOk(); });
  afterEach(async () => { await setActiveUserId(null); });

  it('joinGroup posts values + notes to the join route', async () => {
    await joinGroup('g1', { ead_filed_date: '2026-03-01' }, 'hello');
    expect(url()).toBe(`${API}/api/groups/g1/join`);
    expect(init().method).toBe('POST');
    expect(body()).toEqual({ values: { ead_filed_date: '2026-03-01' }, notes: 'hello' });
  });

  it('saveMemberAttributes posts to the attributes route', async () => {
    await saveMemberAttributes('g1', { priority_date: '2021-03-15' }, '');
    expect(url()).toBe(`${API}/api/groups/g1/attributes`);
    expect(init().method).toBe('POST');
    expect(body()).toEqual({ values: { priority_date: '2021-03-15' }, notes: '' });
  });

  it('getMemberAttributes GETs the attributes route', async () => {
    mockOk({ attributes: [] });
    await getMemberAttributes('g1');
    expect(url()).toBe(`${API}/api/groups/g1/attributes`);
    expect(init().method ?? 'GET').toBe('GET');
  });

  it('archiveGroup posts the archived flag', async () => {
    await archiveGroup('g1', true);
    expect(url()).toBe(`${API}/api/groups/g1/archive`);
    expect(body()).toEqual({ archived: true });
  });

  it('archiveGroup sends false when un-archiving rather than dropping the key', async () => {
    await archiveGroup('g1', false);
    expect(body()).toEqual({ archived: false });
  });

  it('inviteToGroup posts the handle', async () => {
    await inviteToGroup('g1', 'omar-b1b2');
    expect(url()).toBe(`${API}/api/groups/g1/invite`);
    expect(body()).toEqual({ handle: 'omar-b1b2' });
  });

  it('addMembers posts the selected user ids', async () => {
    await addMembers('g1', ['u2', 'u3']);
    expect(url()).toBe(`${API}/api/groups/g1/add-members`);
    expect(body()).toEqual({ user_ids: ['u2', 'u3'] });
  });

  it('findCandidates posts to the per-group candidates route', async () => {
    mockOk({ matches: [] });
    await findCandidates('g1');
    expect(url()).toBe(`${API}/api/groups/g1/find-candidates`);
    expect(init().method).toBe('POST');
  });

  it('getMyInvitations GETs the cross-group feed, not a per-group path', async () => {
    mockOk({ invitations: [] });
    await getMyInvitations();
    expect(url()).toBe(`${API}/api/groups/invitations`);
  });

  it('getGroupInvitations GETs the per-group list', async () => {
    mockOk({ invitations: [] });
    await getGroupInvitations('g1');
    expect(url()).toBe(`${API}/api/groups/g1/invitations`);
  });

  it('acceptInvitation posts values + notes — accepting runs the same gate as joining', async () => {
    await acceptInvitation('g1', { ead_filed_date: '2026-03-01' }, 'note');
    expect(url()).toBe(`${API}/api/groups/g1/invitations/accept`);
    expect(body()).toEqual({ values: { ead_filed_date: '2026-03-01' }, notes: 'note' });
  });

  it('acceptInvitation works with no attributes at all', async () => {
    await acceptInvitation('g1');
    expect(body()).toEqual({ values: {}, notes: '' });
  });

  it('declineInvitation posts to the decline route', async () => {
    await declineInvitation('g1');
    expect(url()).toBe(`${API}/api/groups/g1/invitations/decline`);
    expect(init().method).toBe('POST');
  });

  it('saveKeyDates posts the map to the profile route', async () => {
    await saveKeyDates({ ead_filed_date: '2026-03-01' });
    expect(url()).toBe(`${API}/api/profile/key-dates`);
    expect(body()).toEqual({ key_dates: { ead_filed_date: '2026-03-01' } });
  });

  it('searchGroups forwards every search knob', async () => {
    mockOk({ groups: [] });
    await searchGroups({ tags: ['EAD'] } as never, 'timeline', 'strict', 30);
    expect(url()).toBe(`${API}/api/groups/search`);
    expect(body()).toEqual({
      criteria: { tags: ['EAD'] }, group_type: 'timeline',
      precision: 'strict', max_age_days: 30,
    });
  });

  it('previewGroup posts the criteria and returns the generated pair', async () => {
    mockOk({ name: 'H-1B-change-of-status-COS-Mar-2026', description: 'Blurb.' });
    const out = await previewGroup({ tags: ['EAD'] } as never, 'timeline');
    expect(url()).toBe(`${API}/api/groups/preview`);
    expect(body()).toEqual({ criteria: { tags: ['EAD'] }, group_type: 'timeline' });
    expect(out).toEqual({ name: 'H-1B-change-of-status-COS-Mar-2026', description: 'Blurb.' });
  });
});

// previewGroup is the one group call that must NEVER throw: its result is
// cosmetic (the name shown above the create form), and a create screen you
// can't use because the preview died is a worse bug than a missing name.
describe('apiService.previewGroup — failure is cosmetic, never fatal', () => {
  afterEach(async () => { await setActiveUserId(null); });

  it('resolves to empty strings on a backend refusal instead of throwing', async () => {
    mockErr(500, { detail: 'boom' });
    await expect(previewGroup({} as never, 'timeline'))
      .resolves.toEqual({ name: '', description: '' });
  });

  it('resolves to empty strings when the backend is unreachable', async () => {
    global.fetch = jest.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(previewGroup({} as never, 'timeline'))
      .resolves.toEqual({ name: '', description: '' });
  });

  it('fills in missing fields rather than handing back undefined', async () => {
    mockOk({});
    await expect(previewGroup({} as never, 'timeline'))
      .resolves.toEqual({ name: '', description: '' });
  });
});

describe('apiService — backend refusals surface as real errors', () => {
  beforeEach(async () => { await setActiveUserId('demo-arjun'); });
  afterEach(async () => { await setActiveUserId(null); });

  it('raises the backend detail rather than a generic message', async () => {
    mockErr(422, { detail: '"Date Applied" is required to join this group.' });
    await expect(joinGroup('g1')).rejects.toThrow('"Date Applied" is required to join this group.');
  });

  it('falls back to its own message when the backend gives no detail', async () => {
    mockErr(500, {});
    await expect(joinGroup('g1')).rejects.toThrow('Could not join group');
  });

  it('surfaces a 403 on invite', async () => {
    mockErr(403, { detail: 'Only members can invite.' });
    await expect(inviteToGroup('g1', 'omar')).rejects.toThrow('Only members can invite.');
  });

  it('surfaces an unknown-handle 422 on invite', async () => {
    mockErr(422, { detail: 'No user with the handle "nope".' });
    await expect(inviteToGroup('g1', 'nope')).rejects.toThrow('No user with the handle "nope".');
  });

  it('surfaces a dead-group refusal on accept', async () => {
    mockErr(422, { detail: 'That group is no longer active.' });
    await expect(acceptInvitation('g1')).rejects.toThrow('That group is no longer active.');
  });

  it('surfaces a rejected select value on saveMemberAttributes', async () => {
    mockErr(422, { detail: '"maybe" is not a valid Status.' });
    await expect(saveMemberAttributes('g1', { application_status: 'maybe' }, ''))
      .rejects.toThrow('"maybe" is not a valid Status.');
  });
});

describe('apiService — requiredAttributeKeys mirrors posting.required_keys()', () => {
  const row = (key: string, required?: boolean): PostJoinAttributeRow =>
    ({ label: key, field: 'key_dates', key, ...(required === undefined ? {} : { required }) });

  it('falls back to row 0 when nothing is declared', () => {
    expect(requiredAttributeKeys([row('a'), row('b')])).toEqual(['a']);
  });

  it('honours an explicit required:true', () => {
    expect(requiredAttributeKeys([row('a'), row('b', true)])).toEqual(['b']);
  });

  it('treats a declared required:false as nothing mandatory — the I-485 case', () => {
    expect(requiredAttributeKeys([row('priority_date', false)])).toEqual([]);
  });

  it('does not fall back to row 0 once any row declares', () => {
    expect(requiredAttributeKeys([row('a'), row('b', false), row('c', true)])).toEqual(['c']);
  });

  it('requires nothing for an empty template', () => {
    expect(requiredAttributeKeys([])).toEqual([]);
  });

  it('agrees with the backend on the checkbox literal', () => {
    expect(CHECKBOX_ON).toBe('yes');
  });
});

// AI Assist client (POST /api/assist). Same direct (non-mocked apiService) unit
// coverage as searchPostings — mocks fetch, exercises the real request builder.
describe('apiService.assistTurn', () => {
  it('POSTs message/history/session_id/force_intent to /api/assist', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ intent: 'answer-gov', answer: 'hi', source_tier: 'gov' }),
    })) as unknown as typeof fetch;

    await assistTurn('how long is EAD?', [{ role: 'user', content: 'hi', intent: '' }], 'sess-1', 'post');

    const [url, opts] = (global.fetch as jest.Mock).mock.calls[0];
    expect(String(url)).toContain('/api/assist');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.message).toBe('how long is EAD?');
    expect(body.session_id).toBe('sess-1');
    expect(body.force_intent).toBe('post');
    expect(body.history).toHaveLength(1);
  });

  it('throws an Error carrying .status on the 429 guest cap', async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ detail: 'guest limit' }),
    })) as unknown as typeof fetch;

    await expect(assistTurn('x', [], 'sess-1')).rejects.toMatchObject({ status: 429 });
  });
});

describe('apiService.getAssistSessionId', () => {
  it('returns a stable sess- id across calls', async () => {
    const a = await getAssistSessionId();
    const b = await getAssistSessionId();
    expect(a).toBe(b);
    expect(a).toMatch(/^sess-/);
  });
});

import { createPosting } from '../apiService';

// Regression: createPosting used to omit the identity headers, so every mobile
// post 401'd against the hardened backend (which now requires a signed-in
// author). It must carry the caller identity like the other authed calls.
describe('apiService.createPosting — sends the caller identity (auth fix)', () => {
  beforeEach(async () => { await setActiveUserId('demo-arjun'); mockOk({ case_id: 'c1', author_handle: 'anon' }); });
  afterEach(async () => { await setActiveUserId(null); });

  it('attaches X-User-Id to the POST /api/postings call', async () => {
    await createPosting('a title', 'a description', {} as never, {}, {}, 'ios');
    expect(url()).toContain('/api/postings');
    expect(init().method).toBe('POST');
    expect(headers()['X-User-Id']).toBe('demo-arjun');
  });
});
