import React from 'react';
import { Alert } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { FindScreen } from '../FindScreen';
import {
  getTagVocab,
  getAllGroups,
  createGroup,
  previewGroup,
  searchGroups,
  joinGroup,
  getActiveUserId,
  loadActiveUser,
  getMyInvitations,
  acceptInvitation,
  declineInvitation,
} from '../../services/apiService';

// What the server generates for the criteria these tests pick.
const PREVIEW = { name: 'H-1B-change-of-status-COS-Mar-2026', description: 'Generated blurb.' };

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  // No deep-link params by default; the AI-Assist handoff prefill is inert here.
  useRoute: () => ({ params: {} }),
}));

jest.mock('../../services/apiService', () => {
  const actual = jest.requireActual('../../services/apiService');
  return {
    ...actual,
    getTagVocab: jest.fn(),
    getAllGroups: jest.fn(),
    createGroup: jest.fn(),
    previewGroup: jest.fn(),
    searchGroups: jest.fn(),
    joinGroup: jest.fn(),
    getActiveUserId: jest.fn(),
    setActiveUserId: jest.fn(),
    loadActiveUser: jest.fn(),
    getMyInvitations: jest.fn(),
    acceptInvitation: jest.fn(),
    declineInvitation: jest.fn(),
  };
});

const TEST_METRICS = { insets: { top: 0, right: 0, bottom: 0, left: 0 }, frame: { x: 0, y: 0, width: 390, height: 844 } };
/**
 * Opens the Find / Create tab and selects a group type.
 *
 * The tab now DEFAULTS to Timeline, so the many Regular-centric tests below
 * opt in to Regular explicitly. The default itself is asserted separately
 * (see "defaults to Timeline"), which is why that test doesn't use this.
 */
async function renderFind(groupType: 'regular' | 'timeline' = 'regular') {
  const s = await renderScreen(
    <SafeAreaProvider initialMetrics={TEST_METRICS}>
      <FindScreen />
    </SafeAreaProvider>
  );
  await fireEvent.press(s.getByText('Find / Create'));
  await waitFor(() => expect(getTagVocab).toHaveBeenCalled());
  await fireEvent.press(s.getByText(groupType === 'timeline' ? 'Timeline' : 'Regular'));
  return s;
}

// The base period pair every Timeline scope leads with. The server resolves
// it onto each option before sending, so fixtures carry it the same way.
const PERIOD_ROWS = [
  { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
    options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
  { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
];

const VOCAB = {
  visa: ['H-1B', 'F-1'],
  consulate: ['BOM'],
  consulate_options: [{ code: 'BOM', label: 'Mumbai, India (BOM)' }],
  consulate_tree: [],
  tag: ['rfe-experience', 'timeline', 'stem-opt', 'stem-opt-extension'],
  misc: [],
  misc_options: [],
  stage_key: [],
  date_key: ['ead_filed_date', 'noid_date'],
  profile_stage_key: ['citizen_of_country', 'filing_month', 'filing_year'],
  stage_value_domains: { citizen_of_country: 'country' },
  country: ['IN'],
  outcome: ['approved'],
  tag_attribute_templates: {
    'stem-opt-extension': [
      { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
        options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
      { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
    ],
    'H-1B': [
      { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
        options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
      { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
    ],
    'h4-ead': [
      { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
        options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
      { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
    ],
  },
  post_join_attribute_templates: {
    'stem-opt-extension': [{ label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' }],
  },
  processing_types: [
    {
      value: 'EAD', label: 'EAD',
      eligibility_categories: [
        // These two carry no scope_rows on purpose — they exercise the
        // fallback to tag_attribute_templates that keeps a vocab payload
        // cached before the framework landed working.
        { code: '(c)(3)(C)', label: 'F-1 STEM OPT extension (24-month)', tag: 'stem-opt-extension' },
        { code: '(c)(26)', label: 'H-4 spouse of H-1B', tag: 'h4-ead' },
        // AOS resolves its rows server-side. Its priority date is a
        // per-member fact collected on JOIN, so it is NOT a scope row here.
        {
          code: '(c)(9)', label: 'Pending adjustment of status (I-485)', tag: 'adjustment-of-status',
          scope_rows: [
            { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
              options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
            { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
          ],
          post_join_rows: [
            { kind: 'date', label: 'Priority Date', field: 'key_dates', key: 'priority_date', required: false },
          ],
        },
        // No category configures an extra SCOPE row today; this one carries a
        // synthetic date row so the panel's date control and its key_dates
        // routing stay covered (mirrors the backend's M45).
        {
          code: '(c)(x)', label: 'Synthetic scope-extra category', tag: 'synthetic-scope-extra',
          scope_rows: [
            { kind: 'select', label: 'Month', field: 'key_stages_or_info', key: 'filing_month',
              options: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] },
            { kind: 'year', label: 'Year', field: 'key_stages_or_info', key: 'filing_year' },
            { kind: 'date', label: 'Receipt Date', field: 'key_dates', key: 'receipt_date', name_prefix: 'RD' },
          ],
        },
      ],
    },
    // H-1B's second picker is application types, not 8 CFR eligibility
    // categories, so it names its own heading via category_label.
    {
      value: 'H-1B', label: 'H-1B', category_label: 'Application type',
      eligibility_categories: [
        { code: 'CoS', label: 'Change of Status (initial, in the U.S.)', tag: 'change-of-status-COS', scope_rows: PERIOD_ROWS },
        { code: 'Consular', label: 'Consular processing / stamping (initial)', tag: 'h1b-stamping', scope_rows: PERIOD_ROWS },
        { code: 'COE', label: 'Change of employer (H-1B transfer)', tag: 'change-of-employer-COE', scope_rows: PERIOD_ROWS },
      ],
    },
    // A type that configures no categories at all — the second picker is
    // hidden entirely rather than rendered empty.
    { value: 'O-1', label: 'O-1', eligibility_categories: [] },
  ],
};

/**
 * Picks a processing type; when given an eligibility TAG instead of a type,
 * presses EAD first and then that category. Month/Year hang off the
 * eligibility category now, not the type.
 */
/** Switches the find tab from SEARCH into CREATE mode. */
async function enterCreateMode(s: any, groupType: 'regular' | 'timeline' = 'timeline') {
  await fireEvent.press(s.getByText(`Create a ${groupType === 'timeline' ? 'Timeline' : 'Regular'} Group`));
}

// Pass a processing type to tap just the first chip row, or a category tag to
// tap its owning type and then the category.
async function pickProcessing(s: any, value: string) {
  const owner = VOCAB.processing_types.find(
    (t: any) => t.eligibility_categories?.some((c: any) => c.tag === value));
  await fireEvent.press(s.getByText(owner ? owner.value : value));
  if (owner) {
    await fireEvent.press(s.getByText(value));
  }
}

const GROUP = {
  group_id: 'g1', name: 'H-1B → H-1B', description: '', group_type: '',
  criteria_text: 'looking for H-1B folks', members: [{ user_id: 'u1', username: 'alpha' }],
  created_by: 'u1', is_admin: false, is_member: false,
  created_at: '2026-06-08T00:00:00.000Z', last_activity_at: '2026-06-08T00:00:00.000Z',
  score: 3, shared: ['H-1B'],
};

beforeEach(() => {
  jest.clearAllMocks();
  mockNavigate.mockClear();
  (loadActiveUser as jest.Mock).mockResolvedValue(undefined);
  (getActiveUserId as jest.Mock).mockReturnValue('demo-arjun');
  (getTagVocab as jest.Mock).mockResolvedValue(VOCAB);
  (getAllGroups as jest.Mock).mockResolvedValue({ groups: [] });
  (searchGroups as jest.Mock).mockResolvedValue({ groups: [GROUP] });
  (createGroup as jest.Mock).mockResolvedValue({ group_id: 'new-g', name: 'New Group', group_type: '', joined: false, members: [] });
  (previewGroup as jest.Mock).mockResolvedValue(PREVIEW);
  (joinGroup as jest.Mock).mockResolvedValue(undefined);
  (getMyInvitations as jest.Mock).mockResolvedValue({ invitations: [] });
  (acceptInvitation as jest.Mock).mockResolvedValue(undefined);
  (declineInvitation as jest.Mock).mockResolvedValue(undefined);
});

describe('FindScreen — tabs', () => {
  it('lands on the Groups (browse) tab by default', async () => {
    const s = await renderScreen(
      <SafeAreaProvider initialMetrics={TEST_METRICS}>
        <FindScreen />
      </SafeAreaProvider>
    );
    expect(await s.findByText('No groups yet')).toBeOnTheScreen();
  });
});

describe('FindScreen — header visibility', () => {
  it('shows no category sections initially, only "+ Add" chips', async () => {
    const s = await renderFind();
    expect(await s.findByText('+ Add Current status')).toBeOnTheScreen();
    expect(s.queryByText('CURRENT STATUS')).toBeNull();
  });

  it('"+ Add" reveals an empty section', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('+ Add Tags'));
    expect(await s.findByText('TAGS')).toBeOnTheScreen();
    expect(s.getByText('None.')).toBeOnTheScreen();
  });
});

describe('FindScreen — Regular vs Timeline group type', () => {
  it('defaults to Timeline — the group type this product is organised around', async () => {
    const s = await renderScreen(
      <SafeAreaProvider initialMetrics={TEST_METRICS}>
        <FindScreen />
      </SafeAreaProvider>
    );
    await fireEvent.press(s.getByText('Find / Create'));
    await waitFor(() => expect(getTagVocab).toHaveBeenCalled());
    // Timeline is exact-match, so it has no precision threshold to tune.
    expect(s.queryByText('Precision')).toBeNull();
    expect(await s.findByText('PROCESSING TYPE')).toBeOnTheScreen();
  });

  it('selecting Regular shows Precision', async () => {
    const s = await renderFind('regular');
    expect(await s.findByText('Precision')).toBeOnTheScreen();
  });

  it('switching to Timeline hides Precision', async () => {
    const s = await renderFind();
    await s.findByText('Precision');

    await fireEvent.press(s.getByText('Timeline'));

    expect(s.queryByText('Precision')).toBeNull();
  });
});

describe('FindScreen — manual tag add/remove', () => {
  it('picking a suggestion adds a chip', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('+ Add Tags'));
    const input = await s.findByPlaceholderText('Add tags…');

    await fireEvent.changeText(input, 'timeline');
    await fireEvent.press(await s.findByText('timeline'));

    expect(await s.findByText('TAGS')).toBeOnTheScreen();
  });

  it('picks a consulate by its label', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('+ Add Consulate(s)'));
    const input = await s.findByPlaceholderText('Add a consulate…');

    await fireEvent.changeText(input, 'Mumbai');
    await fireEvent.press(await s.findByText('Mumbai, India (BOM)'));

    expect(await s.findByText('Mumbai, India (BOM)')).toBeOnTheScreen();
  });
});

describe('FindScreen — Search (group search, not candidate matching)', () => {
  it('calls searchGroups with the panel criteria + group type + precision + cutoff', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('+ Add Tags'));
    const input = await s.findByPlaceholderText('Add tags…');
    await fireEvent.changeText(input, 'timeline');
    await fireEvent.press(await s.findByText('timeline'));

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() => expect(searchGroups).toHaveBeenCalled());
    const [criteria, groupType, precision, maxAgeDays] = (searchGroups as jest.Mock).mock.calls[0];
    expect(criteria.tags).toEqual(['timeline']);
    expect(groupType).toBe('');
    expect(precision).toBe('balanced');
    expect(maxAgeDays).toBe(0);
  });

  it('sends group_type="timeline" when Timeline is selected', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() => expect(searchGroups).toHaveBeenCalled());
    const [, groupType] = (searchGroups as jest.Mock).mock.calls[0];
    expect(groupType).toBe('timeline');
  });

  it('renders matched groups inline with a Join button', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Search'));

    expect(await s.findByText('H-1B → H-1B')).toBeOnTheScreen();
    expect(s.getByText('Join')).toBeOnTheScreen();
  });

  it('joining a result calls joinGroup and navigates to the group', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Search'));
    await s.findByText('H-1B → H-1B');

    await fireEvent.press(s.getByText('Join'));

    await waitFor(() => expect(joinGroup).toHaveBeenCalledWith('g1'));
    expect(mockNavigate).toHaveBeenCalledWith('GroupChat', { groupId: 'g1', groupName: 'H-1B → H-1B' });
  });

  it('shows View (not Join) for a Timeline result and navigates without calling joinGroup', async () => {
    (searchGroups as jest.Mock).mockResolvedValue({ groups: [{ ...GROUP, group_id: 'tl1', name: 'STEM-OPT Fall 2026', group_type: 'timeline' }] });
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    await fireEvent.press(s.getByText('Search'));
    await s.findByText('STEM-OPT Fall 2026');

    expect(s.queryByText('Join')).toBeNull();
    await fireEvent.press(s.getByText('View'));

    expect(mockNavigate).toHaveBeenCalledWith('GroupChat', { groupId: 'tl1', groupName: 'STEM-OPT Fall 2026' });
    expect(joinGroup).not.toHaveBeenCalled();
  });

  it('shows an empty-results message pointing at Create a group', async () => {
    (searchGroups as jest.Mock).mockResolvedValue({ groups: [] });
    const s = await renderFind();
    await fireEvent.press(s.getByText('Search'));

    expect(await s.findByText(/No groups found/)).toBeOnTheScreen();
  });

  it('surfaces an error when searchGroups fails', async () => {
    (searchGroups as jest.Mock).mockRejectedValue(new Error('Group search unavailable'));
    const s = await renderFind();
    await fireEvent.press(s.getByText('Search'));

    expect(await s.findByText('Group search unavailable')).toBeOnTheScreen();
  });
});

describe('FindScreen — the generated name and description', () => {
  it('shows the server-generated name at the top of the create view', async () => {
    const s = await renderFind('timeline');
    await enterCreateMode(s, 'timeline');

    // Server-generated on purpose: Timeline dedup keys on the name, so a
    // local guess that drifted would promise a new cohort and deliver a join.
    await waitFor(() => expect(s.getByText(PREVIEW.name)).toBeTruthy());
    expect(s.getByText('GROUP NAME')).toBeTruthy();
  });

  it('does not show it while searching, only while creating', async () => {
    const s = await renderFind('timeline');
    expect(s.queryByText('GROUP NAME')).toBeNull();
  });

  it('asks for a preview with the criteria currently in the panel', async () => {
    const s = await renderFind('timeline');
    await pickProcessing(s, 'stem-opt-extension');

    await waitFor(() => {
      const calls = (previewGroup as jest.Mock).mock.calls;
      const [criteria, groupType] = calls[calls.length - 1];
      expect(groupType).toBe('timeline');
      expect(criteria.tags).toEqual(['EAD', 'stem-opt-extension']);
    });
  });

  it('prefills the description, and stops once the creator edits it', async () => {
    const s = await renderFind('timeline');
    await enterCreateMode(s, 'timeline');
    const box = () => s.getByPlaceholderText("What's this group for? Shown to anyone browsing before they join.");

    await waitFor(() => expect(box().props.value).toBe(PREVIEW.description));
    expect(s.queryByText('Reset to generated')).toBeNull();

    await fireEvent.changeText(box(), 'my own words');
    expect(box().props.value).toBe('my own words');

    // Changing a criterion must not silently discard what they wrote.
    await pickProcessing(s, 'stem-opt-extension');
    expect(box().props.value).toBe('my own words');

    await fireEvent.press(s.getByText('Reset to generated'));
    expect(box().props.value).toBe(PREVIEW.description);
  });

  it('sends the generated description when the creator leaves it alone', async () => {
    const s = await renderFind('timeline');
    await enterCreateMode(s, 'timeline');
    await waitFor(() => expect(
      s.getByPlaceholderText("What's this group for? Shown to anyone browsing before they join.").props.value
    ).toBe(PREVIEW.description));

    await fireEvent.press(s.getByText('Create a Timeline group'));
    await waitFor(() => expect(createGroup).toHaveBeenCalled());
    expect((createGroup as jest.Mock).mock.calls[0][4]).toBe(PREVIEW.description);
  });

  it('a failed preview leaves the create view usable rather than erroring', async () => {
    (previewGroup as jest.Mock).mockResolvedValue({ name: '', description: '' });
    const s = await renderFind('timeline');
    await enterCreateMode(s, 'timeline');

    expect(s.queryByText('GROUP NAME')).toBeNull();
    expect(s.getByText('Create a Timeline group')).toBeTruthy();
  });
});

describe('FindScreen — Create a group', () => {
  it('calls createGroup with the panel criteria + group_type + description, then navigates', async () => {
    const s = await renderFind('timeline');
    await enterCreateMode(s, 'timeline');

    await fireEvent.changeText(s.getByPlaceholderText("What's this group for? Shown to anyone browsing before they join."), 'Fall cohort');
    await fireEvent.press(s.getByText('Create a Timeline group'));

    await waitFor(() => expect(createGroup).toHaveBeenCalled());
    const args = (createGroup as jest.Mock).mock.calls[0];
    expect(args[3]).toBe('timeline');
    expect(args[4]).toBe('Fall cohort');
  });

  it('does not send a group description for Regular groups', async () => {
    const s = await renderFind('regular');
    await enterCreateMode(s, 'regular');

    await fireEvent.press(s.getByText('Create a group'));
    await waitFor(() => expect(createGroup).toHaveBeenCalled());
    expect((createGroup as jest.Mock).mock.calls[0][4]).toBe('');
  });

  it('shows an error Alert when createGroup fails', async () => {
    const spy = jest.spyOn(Alert, 'alert');
    (createGroup as jest.Mock).mockRejectedValue(new Error('nope'));
    const s = await renderFind('timeline');
    await enterCreateMode(s, 'timeline');

    await fireEvent.press(s.getByText('Create a Timeline group'));
    await waitFor(() => expect(spy).toHaveBeenCalled());
  });

  it('never asks for the post-join attributes — those belong to joining', async () => {
    const s = await renderFind('timeline');
    await pickProcessing(s, 'stem-opt-extension');
    // The heading over Month/Year reads "Date Applied" too, so this asserts
    // the absence of the post-join CONTROL, not of the text.
    expect(s.queryByLabelText('Date Applied')).toBeNull();

    await enterCreateMode(s, 'timeline');
    expect(s.queryByLabelText('Date Applied')).toBeNull();

    // Create is therefore never gated on them.
    await fireEvent.press(s.getByText('Create a Timeline group'));
    await waitFor(() => expect(createGroup).toHaveBeenCalled());
  });
});

describe('FindScreen — Timeline-only panel shape', () => {
  it('Regular shows Cutoff period and Consulate(s); Timeline shows neither', async () => {
    const s = await renderFind();
    await waitFor(() => expect(s.getByText('Cutoff period')).toBeOnTheScreen());
    expect(s.getByText('+ Add Consulate(s)')).toBeOnTheScreen();

    await fireEvent.press(s.getByText('Timeline'));

    expect(s.queryByText('Cutoff period')).toBeNull();
    expect(s.queryByText('+ Add Consulate(s)')).toBeNull();
  });

  it('a Timeline search never sends consulates, even if one was picked while on Regular', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('+ Add Consulate(s)'));
    const input = await s.findByPlaceholderText('Add a consulate…');
    await fireEvent.changeText(input, 'Mumbai');
    await fireEvent.press(await s.findByText('Mumbai, India (BOM)'));

    await fireEvent.press(s.getByText('Timeline'));
    await fireEvent.press(s.getByText('Search'));

    await waitFor(() => expect(searchGroups).toHaveBeenCalled());
    const [criteria] = (searchGroups as jest.Mock).mock.calls[0];
    expect(criteria.consulates).toEqual([]);
  });
});

describe('FindScreen — Status facts / Key dates / Tags entry removed from the Timeline panel', () => {
  it('no manual stage-key / date-key inputs render for Timeline', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));

    expect(s.queryByPlaceholderText('stage key')).toBeNull();
    expect(s.queryByPlaceholderText('date key')).toBeNull();
    expect(s.queryByText('STATUS FACTS')).toBeNull();
    expect(s.queryByText('KEY DATES')).toBeNull();
  });

  it('Tags category is hidden for Timeline (Processing type is the only tag entry point)', async () => {
    const s = await renderFind();
    expect(await s.findByText('+ Add Tags')).toBeOnTheScreen();

    await fireEvent.press(s.getByText('Timeline'));

    expect(s.queryByText('+ Add Tags')).toBeNull();
  });

  it('switching back to Regular restores the Tags category', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    expect(s.queryByText('+ Add Tags')).toBeNull();

    await fireEvent.press(s.getByText('Regular'));

    expect(s.getByText('+ Add Tags')).toBeOnTheScreen();
  });
});

describe('FindScreen — Processing type chip row + Month/Year', () => {
  it('shows PROCESSING TYPE listing registered TYPES (EAD, not the raw tag) for Timeline only', async () => {
    const s = await renderFind();
    expect(s.queryByText('PROCESSING TYPE')).toBeNull();

    await fireEvent.press(s.getByText('Timeline'));

    expect(await s.findByText('PROCESSING TYPE')).toBeOnTheScreen();
    expect(s.getByText('EAD')).toBeOnTheScreen();
    // The old chip row showed the raw action tag; "EAD" is the filing.
    expect(s.queryByText('stem-opt-extension')).toBeNull();
    expect(s.getByText('H-1B')).toBeOnTheScreen();
  });

  it('picking stem-opt-extension reveals Month/Year (Tags category itself is hidden for Timeline)', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    await s.findByText('PROCESSING TYPE');

    await pickProcessing(s, 'stem-opt-extension');

    expect(await s.findByText('Month')).toBeOnTheScreen();
    expect(s.getByText('Year')).toBeOnTheScreen();
    // The required post-join attribute (Date Applied) IS shown here — the
    // creator of a brand-new matched group is gated the same as a joiner.
    // This fixture's post_join_attribute_templates has only one row, so a
    // field like NOID (never registered in this test's vocab) stays absent.
    // The post-join attributes moved to the group page's join gate —
    // searching for a cohort never asks about your own case.
    expect(s.queryByText('Date Applied *')).toBeNull();
    expect(s.queryByText('Notice of Intent to Deny (NOID)')).toBeNull();

    // The pick still lands in criteria.tags even though no chip is rendered.
    await fireEvent.press(s.getByText('Search'));
    await waitFor(() => expect(searchGroups).toHaveBeenCalled());
    const [criteria] = (searchGroups as jest.Mock).mock.calls[0];
    // BOTH picks land in criteria.tags — the processing type and the
    // eligibility category under it. The pair names the group.
    expect(criteria.tags).toEqual(['EAD', 'stem-opt-extension']);
  });

  it('picking H-1B lands it in current_visa_or_greencard_category (visa branch) — no Current status category renders (hidden for Timeline)', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    await s.findByText('PROCESSING TYPE');

    await fireEvent.press(s.getByText('H-1B'));

    expect(s.queryByText('CURRENT STATUS')).toBeNull();
    // H-1B now has application types, so — exactly like EAD — the period
    // fields wait for the second picker rather than appearing at once. The
    // heading is the type's own, not EAD's "eligibility category" framing.
    expect(s.queryByText('Month')).toBeNull();
    expect(s.getByText('APPLICATION TYPE')).toBeOnTheScreen();
    expect(s.queryByText('ELIGIBILITY CATEGORY')).toBeNull();

    await fireEvent.press(s.getByText('change-of-status-COS'));
    expect(await s.findByText('Month')).toBeOnTheScreen();
    expect(s.getByText('Year')).toBeOnTheScreen();

    await fireEvent.press(s.getByText('Search'));
    await waitFor(() => expect(searchGroups).toHaveBeenCalled());
    const [criteria] = (searchGroups as jest.Mock).mock.calls[0];
    // The type is visa vocabulary so it lands in the visa field; the
    // application type is a plain tag, so it lands in tags.
    expect(criteria.current_visa_or_greencard_category).toEqual(['H-1B']);
    expect(criteria.tags).toEqual(['change-of-status-COS']);
  });

  it('a type that configures no categories gets no second picker at all', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    await s.findByText('PROCESSING TYPE');

    await fireEvent.press(s.getByText('O-1'));

    expect(s.queryByText('ELIGIBILITY CATEGORY')).toBeNull();
    expect(s.queryByText('APPLICATION TYPE')).toBeNull();
  });

  it('switching processing type removes the old selection and adds the new one', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    await s.findByText('PROCESSING TYPE');
    await pickProcessing(s, 'stem-opt-extension');
    await s.findByText('Month');

    await fireEvent.press(s.getByText('H-1B'));

    await fireEvent.press(s.getByText('Search'));
    await waitFor(() => expect(searchGroups).toHaveBeenCalled());
    const [criteria] = (searchGroups as jest.Mock).mock.calls[0];
    // EAD *and* its category are both gone — switching the first picker must
    // not leave the old pair's second half behind.
    expect(criteria.tags).toEqual([]);
    expect(criteria.current_visa_or_greencard_category).toEqual(['H-1B']);
  });

  it('picking a Month option sticks (writes into key_stages_or_info) and is sent on Search', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    await s.findByText('PROCESSING TYPE');
    await pickProcessing(s, 'stem-opt-extension');
    await s.findByText('Month');

    await fireEvent.press(s.getByText('Sep'));

    await fireEvent.press(s.getByText('Search'));
    await waitFor(() => expect(searchGroups).toHaveBeenCalled());
    const [criteria] = (searchGroups as jest.Mock).mock.calls[0];
    expect(criteria.key_stages_or_info.filing_month).toBe('Sep');
  });

  it('the Year picker offers the previous, current, and next year', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    await s.findByText('PROCESSING TYPE');
    await pickProcessing(s, 'stem-opt-extension');
    await s.findByText('Year');

    const thisYear = new Date().getFullYear();
    expect(s.getByText(String(thisYear - 1))).toBeOnTheScreen();
    expect(s.getByText(String(thisYear))).toBeOnTheScreen();
    expect(s.getByText(String(thisYear + 1))).toBeOnTheScreen();
  });

  it('re-pressing the selected eligibility chip clears it and hides Month/Year', async () => {
    const s = await renderFind();
    await fireEvent.press(s.getByText('Timeline'));
    await s.findByText('PROCESSING TYPE');
    await pickProcessing(s, 'stem-opt-extension');
    await s.findByText('Month');

    // Press the CATEGORY chip again — pressing EAD would clear the type too.
    await fireEvent.press(s.getByText('stem-opt-extension'));

    expect(s.queryByText('Month')).toBeNull();
    expect(s.queryByText('Year')).toBeNull();
  });
});

describe('FindScreen — Open groups browse section', () => {
  const OPEN_TIMELINE = {
    group_id: 'open-tl', name: 'Immigration', description: 'Fall 2026 cohort', group_type: 'timeline',
    criteria_text: '', criteria_tags: { tags: ['stem-opt-extension'], current_visa_or_greencard_category: [] },
    members: [{ user_id: 'u9', username: 'zeta' }], created_by: 'u9', is_admin: false, is_member: false,
    created_at: '', last_activity_at: '', score: 0, shared: [],
  };
  const OPEN_REGULAR = {
    group_id: 'open-reg', name: 'H-1B → EB-2', description: '', group_type: '',
    criteria_text: '', criteria_tags: { current_visa_or_greencard_category: ['H-1B'], visa_applying_for: ['EB-2'], consulates: ['BOM'] },
    members: [{ user_id: 'u8', username: 'eta' }], created_by: 'u8', is_admin: false, is_member: false,
    created_at: '', last_activity_at: '', score: 0, shared: [],
  };
  const JOINED = {
    group_id: 'mine', name: 'My group', description: '', group_type: '', criteria_text: '', criteria_tags: {},
    members: [{ user_id: 'demo-arjun', username: 'arjun' }], created_by: 'demo-arjun', is_admin: true, is_member: true,
    created_at: '', last_activity_at: '', score: 0, shared: [],
  };

  async function renderBrowse() {
    return renderScreen(
      <SafeAreaProvider initialMetrics={TEST_METRICS}>
        <FindScreen />
      </SafeAreaProvider>
    );
  }

  it('the two sections partition the groups — a joined group is never listed twice', async () => {
    (getAllGroups as jest.Mock).mockResolvedValue({ groups: [OPEN_REGULAR, JOINED] });
    const s = await renderBrowse();

    await s.findByText('All groups');
    expect(s.getByText('H-1B → EB-2')).toBeOnTheScreen();
    expect(s.getByText('H-1B · EB-2 · BOM')).toBeOnTheScreen();
    // Joined => "Your groups" only. Listing it under "All groups" too reads
    // as two different groups.
    expect(s.getAllByText('My group').length).toBe(1);
  });

  it('"All groups" says so when the only groups that exist are ones you have joined', async () => {
    (getAllGroups as jest.Mock).mockResolvedValue({ groups: [JOINED] });
    const s = await renderBrowse();

    await s.findByText('All groups');
    expect(s.getByText(/joined every group there is/)).toBeOnTheScreen();
    expect(s.queryByText(/be the first to create one/)).toBeNull();
  });

  it('shows a Timeline badge and description for a Timeline group', async () => {
    (getAllGroups as jest.Mock).mockResolvedValue({ groups: [OPEN_TIMELINE] });
    const s = await renderBrowse();

    await s.findByText('Immigration');
    expect(s.getByText('Timeline')).toBeOnTheScreen();
    expect(s.getByText('Fall 2026 cohort')).toBeOnTheScreen();
    expect(s.getByText('stem-opt-extension')).toBeOnTheScreen();
  });

  it('shows a Regular badge for a non-Timeline group', async () => {
    (getAllGroups as jest.Mock).mockResolvedValue({ groups: [OPEN_REGULAR] });
    const s = await renderBrowse();

    await s.findByText('H-1B → EB-2');
    expect(s.getAllByText('Regular').length).toBeGreaterThan(0);
  });

  it('tapping a group navigates to GroupChat (no Join button on the card)', async () => {
    (getAllGroups as jest.Mock).mockResolvedValue({ groups: [OPEN_TIMELINE] });
    const s = await renderBrowse();
    await s.findByText('Immigration');

    await fireEvent.press(s.getByText('Immigration'));

    expect(mockNavigate).toHaveBeenCalledWith('GroupChat', { groupId: 'open-tl', groupName: 'Immigration' });
  });

  it('shows an empty-state message in "Your groups" when the user has not joined anything', async () => {
    (getAllGroups as jest.Mock).mockResolvedValue({ groups: [OPEN_REGULAR] });
    const s = await renderBrowse();

    expect(await s.findByText('No groups yet')).toBeOnTheScreen();
  });

  it('the "Create Group" button (above the panels) switches to the Find / Create tab', async () => {
    (getAllGroups as jest.Mock).mockResolvedValue({ groups: [] });
    const s = await renderBrowse();
    await s.findByText('All groups');

    await fireEvent.press(s.getByText('Create Group'));

    expect(await s.findByText('Search criteria')).toBeOnTheScreen();
  });
});

describe('FindScreen — pending invitations', () => {
  const INVITED_GROUP = {
    ...GROUP, group_id: 'inv-g', name: 'EAD filers 2026',
    members: [{ user_id: 'u7', username: 'theta' }],
  };
  const INVITATION = {
    invitation_id: 'inv-g__demo-arjun', group_id: 'inv-g', group_name: 'EAD filers 2026',
    user_id: 'demo-arjun', username: 'arjun-h1b',
    invited_by: 'u7', invited_by_username: 'theta',
    status: 'pending', requires_attributes: false, created_at: '', responded_at: '',
  };

  // Stateful: once answered the backend stops returning it, so the
  // post-accept refetch doesn't resurrect the row a fixed fixture would.
  async function renderBrowse(invitation = INVITATION) {
    let answered = false;
    (acceptInvitation as jest.Mock).mockImplementation(async () => { answered = true; });
    (declineInvitation as jest.Mock).mockImplementation(async () => { answered = true; });
    (getMyInvitations as jest.Mock).mockImplementation(async () => ({
      invitations: answered ? [] : [{ invitation, group: INVITED_GROUP }],
    }));
    const s = await renderScreen(
      <SafeAreaProvider initialMetrics={TEST_METRICS}>
        <FindScreen />
      </SafeAreaProvider>
    );
    await waitFor(() => expect(getMyInvitations).toHaveBeenCalled());
    return s;
  }

  it('lists the invitation with who sent it', async () => {
    const s = await renderBrowse();
    expect(await s.findByText('Pending invitations (1)')).toBeOnTheScreen();
    expect(s.getByText('EAD filers 2026')).toBeOnTheScreen();
    expect(s.getByText('Invited by theta')).toBeOnTheScreen();
  });

  it('shows no section when there are no invitations', async () => {
    const s = await renderScreen(
      <SafeAreaProvider initialMetrics={TEST_METRICS}>
        <FindScreen />
      </SafeAreaProvider>
    );
    await waitFor(() => expect(getAllGroups).toHaveBeenCalled());
    expect(s.queryByTestId('pending-invitations')).toBeNull();
  });

  it('Accept joins the group and drops the row', async () => {
    const s = await renderBrowse();
    await fireEvent.press(await s.findByText('Accept'));

    await waitFor(() => expect(acceptInvitation).toHaveBeenCalledWith('inv-g'));
    await waitFor(() => expect(s.queryByText('Pending invitations (1)')).toBeNull());
  });

  it('Decline drops the row without joining', async () => {
    const s = await renderBrowse();
    await fireEvent.press(await s.findByText('Decline'));

    await waitFor(() => expect(declineInvitation).toHaveBeenCalledWith('inv-g'));
    expect(acceptInvitation).not.toHaveBeenCalled();
    await waitFor(() => expect(s.queryByText('Pending invitations (1)')).toBeNull());
  });

  it('routes to the group screen instead of accepting blind when attributes are required', async () => {
    const s = await renderBrowse({ ...INVITATION, requires_attributes: true });

    expect(await s.findByText('Joining asks for a few dates first.')).toBeOnTheScreen();
    await fireEvent.press(s.getByText('Accept'));

    expect(mockNavigate).toHaveBeenCalledWith('GroupChat', {
      groupId: 'inv-g', groupName: 'EAD filers 2026',
    });
    // The form lives on the group screen — accepting here would just 422.
    expect(acceptInvitation).not.toHaveBeenCalled();
  });
});

describe('FindScreen — scope rows are configuration, not code', () => {
  async function pickCategory(tag: string) {
    const s = await renderFind('timeline');
    await pickProcessing(s, tag);
    return s;
  }

  it('renders the extra row its category configures, on top of the period pair', async () => {
    const s = await pickCategory('synthetic-scope-extra');

    expect(await s.findByLabelText('Receipt Date')).toBeOnTheScreen();
    expect(s.getByText('Month')).toBeOnTheScreen();
    expect(s.getByText('Year')).toBeOnTheScreen();
  });

  it('sends a date row in key_dates and a period row in key_stages_or_info', async () => {
    const s = await pickCategory('synthetic-scope-extra');
    await fireEvent.changeText(await s.findByLabelText('Receipt Date'), '2026-08-20');
    await fireEvent.press(s.getByText('Aug'));

    await fireEvent.press(s.getByText('Search'));

    await waitFor(() => expect(searchGroups).toHaveBeenCalled());
    const [criteria] = (searchGroups as jest.Mock).mock.calls[0];
    expect(criteria.key_dates).toEqual({ receipt_date: '2026-08-20' });
    expect(criteria.key_stages_or_info).toEqual({ filing_month: 'Aug' });
  });

  it('a category without its own rows shows only the period pair', async () => {
    const s = await pickCategory('h4-ead');

    expect(await s.findByText('Month')).toBeOnTheScreen();
    expect(s.queryByLabelText('Receipt Date')).toBeNull();
  });

  it('I-485 asks for the priority date on JOIN, not on the find/create panel', async () => {
    const s = await pickCategory('adjustment-of-status');

    expect(await s.findByText('Month')).toBeOnTheScreen();
    expect(s.queryByLabelText('Priority Date')).toBeNull();
  });
});

describe('FindScreen — the period pair is labelled, and spans real filing years', () => {
  it('labels Month/Year as the Date Applied', async () => {
    const s = await renderFind('timeline');
    await pickProcessing(s, 'h4-ead');

    expect(await s.findByText('Date Applied')).toBeOnTheScreen();
  });

  it('offers the last 5 years through next year', async () => {
    const s = await renderFind('timeline');
    await pickProcessing(s, 'h4-ead');
    await s.findByText('Year');

    const y = new Date().getFullYear();
    expect(s.getByText(String(y - 5))).toBeOnTheScreen();
    expect(s.getByText(String(y + 1))).toBeOnTheScreen();
    expect(s.queryByText(String(y - 6))).toBeNull();
  });
});
