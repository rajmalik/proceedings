import React from 'react';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { GroupAttributesScreen } from '../GroupAttributesScreen';
import { getGroup, getMemberAttributes, getTagVocab } from '../../services/apiService';

const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: mockGoBack }),
  useRoute: () => ({ params: { groupId: 'g1', groupName: 'Fall 2026 STEM OPT' } }),
}));

jest.mock('../../services/apiService', () => ({
  getGroup: jest.fn(),
  getMemberAttributes: jest.fn(),
  getTagVocab: jest.fn(),
}));

const VOCAB = {
  post_join_attribute_templates: {
    'stem-opt-extension': [
      { label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' },
      { label: 'EAD Received', field: 'key_dates', key: 'ead_approved_date' },
      // A select column, so the filter row's cycle-through-options branch is
      // exercised rather than only the substring one.
      { kind: 'select', label: 'Service Center', field: 'key_stages_or_info',
        key: 'service_center', options: ['PSC', 'VSC'] },
    ],
  },
};

const GROUP = {
  group_id: 'g1', name: 'Fall 2026 STEM OPT', description: '', group_type: 'timeline',
  criteria_text: '', criteria_tags: { tags: ['stem-opt-extension'] },
  members: [
    { user_id: 'demo-arjun', username: 'arjun-h1b' },
    { user_id: 'demo-mei', username: 'mei-f1' },
  ],
  created_by: 'demo-arjun', is_admin: false, is_member: true,
  created_at: '', last_activity_at: '', score: 0, shared: [],
};

const ATTRS = [
  {
    user_id: 'demo-arjun', username: 'arjun-h1b', processing_type: 'stem-opt-extension',
    values: { ead_filed_date: '2026-03-01', ead_approved_date: '2026-05-20', service_center: 'PSC' },
    notes: 'filed early', submitted_at: '', updated_at: '',
  },
];

// A second submitter, so filtering has something to actually exclude.
const ATTRS_TWO = [
  ...ATTRS,
  {
    user_id: 'demo-mei', username: 'mei-f1', processing_type: 'stem-opt-extension',
    values: { ead_filed_date: '2025-11-02', service_center: 'VSC' },
    notes: 'still waiting', submitted_at: '', updated_at: '',
  },
];

beforeEach(() => {
  jest.clearAllMocks();
  (getGroup as jest.Mock).mockResolvedValue(GROUP);
  (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: ATTRS });
  (getTagVocab as jest.Mock).mockResolvedValue(VOCAB);
});

describe('GroupAttributesScreen', () => {
  it('renders a column per template row and a value per member', async () => {
    const s = await renderScreen(<GroupAttributesScreen />);

    expect(await s.findByText('DATE APPLIED')).toBeOnTheScreen();
    expect(s.getByText('EAD RECEIVED')).toBeOnTheScreen();
    expect(s.getByText('2026-03-01')).toBeOnTheScreen();
    expect(s.getByText('2026-05-20')).toBeOnTheScreen();
    expect(s.getByText('filed early')).toBeOnTheScreen();
  });

  it('lists every member, not just the ones who submitted', async () => {
    const s = await renderScreen(<GroupAttributesScreen />);

    expect(await s.findByText('arjun-h1b')).toBeOnTheScreen();
    expect(s.getByText('mei-f1')).toBeOnTheScreen();
    // mei submitted nothing — her three value cells plus notes are all dashes.
    expect(s.getAllByText('—')).toHaveLength(4);
  });

  it('shows nothing to a non-member', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_member: false });
    const s = await renderScreen(<GroupAttributesScreen />);

    expect(await s.findByText('Only members can see this.')).toBeOnTheScreen();
    expect(s.queryByText('DATE APPLIED')).toBeNull();
  });

  it('explains itself when the group collects no attributes at all', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, group_type: '', criteria_tags: {} });
    const s = await renderScreen(<GroupAttributesScreen />);

    expect(await s.findByText(/doesn't collect timeline attributes/)).toBeOnTheScreen();
  });

  it('surfaces a load failure instead of an empty table', async () => {
    (getGroup as jest.Mock).mockRejectedValue(new Error('No such group.'));
    const s = await renderScreen(<GroupAttributesScreen />);

    expect(await s.findByText('No such group.')).toBeOnTheScreen();
  });

  it('goes back to the group', async () => {
    const s = await renderScreen(<GroupAttributesScreen />);

    await waitFor(() => expect(getGroup).toHaveBeenCalled());
    await fireEvent.press(s.getByLabelText('Back'));
    expect(mockGoBack).toHaveBeenCalled();
  });

  it('gives every column a filter', async () => {
    const s = await renderScreen(<GroupAttributesScreen />);
    await s.findByText('DATE APPLIED');

    // Every column, not just the ones the brief named — the columns are
    // configuration, so a hardcoded subset would stop covering a column added
    // from Firestore tomorrow.
    expect(s.getByLabelText('Filter Member')).toBeOnTheScreen();
    expect(s.getByLabelText('Filter Date Applied')).toBeOnTheScreen();
    expect(s.getByLabelText('Filter Service Center')).toBeOnTheScreen();
    expect(s.getByLabelText('Filter Notes')).toBeOnTheScreen();
  });

  it('filters rows down and clears them again', async () => {
    (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: ATTRS_TWO });
    const s = await renderScreen(<GroupAttributesScreen />);
    await s.findByText('DATE APPLIED');
    expect(s.getByText('mei-f1')).toBeOnTheScreen();

    // A date column matches on substring, so a bare year answers "who filed
    // in 2026" without a range picker.
    await fireEvent.changeText(s.getByLabelText('Filter Date Applied'), '2026');
    expect(s.getByText('arjun-h1b')).toBeOnTheScreen();
    expect(s.queryByText('mei-f1')).toBeNull();

    await fireEvent.press(s.getByLabelText('Clear filters'));
    expect(s.getByText('mei-f1')).toBeOnTheScreen();
  });

  it('cycles a select column through its configured options on tap', async () => {
    (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: ATTRS_TWO });
    const s = await renderScreen(<GroupAttributesScreen />);
    await s.findByText('DATE APPLIED');

    // RN has no <select>; a two-to-four-item domain cycles rather than
    // opening a picker. All → PSC → VSC → All.
    const cell = s.getByLabelText('Filter Service Center');
    await fireEvent.press(cell);
    // Two now read "PSC" — the filter cell and arjun's own value.
    expect(s.getAllByText('PSC')).toHaveLength(2);
    expect(s.queryByText('mei-f1')).toBeNull();

    await fireEvent.press(cell);
    expect(s.getByText('mei-f1')).toBeOnTheScreen();
    expect(s.queryByText('arjun-h1b')).toBeNull();

    await fireEvent.press(cell);
    expect(s.getByText('arjun-h1b')).toBeOnTheScreen();
    expect(s.getByText('mei-f1')).toBeOnTheScreen();
  });

  it('says so when nothing matches', async () => {
    const s = await renderScreen(<GroupAttributesScreen />);
    await s.findByText('DATE APPLIED');

    await fireEvent.changeText(s.getByLabelText('Filter Member'), 'nobody');
    expect(s.getByText('No members match these filters.')).toBeOnTheScreen();
  });
});
