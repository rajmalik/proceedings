import React from 'react';
import { Alert, Share } from 'react-native';
import { renderScreen, fireEvent, waitFor } from '../../test/render';
import { GroupChatScreen } from '../GroupChatScreen';
import {
  getGroup,
  leaveGroup,
  inviteToGroup,
  renameGroup,
  deleteGroup,
  archiveGroup,
  joinGroup,
  saveMemberAttributes,
  getMemberAttributes,
  getGroupInvitations,
  findCandidates,
  addMembers,
  getTagVocab,
} from '../../services/apiService';

// Navigation hooks: fixed groupId param + spyable nav actions.
// (jest hoists jest.mock; only `mock`-prefixed vars may be referenced inside.)
const mockNavigate = jest.fn();
const mockGoBack = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack }),
  useRoute: () => ({ params: { groupId: 'g1', groupName: 'Group Chat' } }),
}));

jest.mock('../../services/apiService', () => ({
  getGroup: jest.fn(),
  leaveGroup: jest.fn(),
  inviteToGroup: jest.fn(),
  renameGroup: jest.fn(),
  deleteGroup: jest.fn(),
  archiveGroup: jest.fn(),
  joinGroup: jest.fn(),
  saveMemberAttributes: jest.fn(),
  getMemberAttributes: jest.fn(),
  getGroupInvitations: jest.fn(),
  findCandidates: jest.fn(),
  addMembers: jest.fn(),
  getTagVocab: jest.fn(),
  getActiveUserId: jest.fn(() => 'demo-arjun'),
  // Real (non-jest.fn) exports. The checkbox control writes this literal, so
  // omitting it from the factory would silently store `undefined`; the
  // resolver is called during render, so omitting it throws outright.
  CHECKBOX_ON: 'yes',
  requiredAttributeKeys: (rows: { key: string; required?: boolean }[]) => {
    if (rows.some((r) => r.required !== undefined)) return rows.filter((r) => r.required).map((r) => r.key);
    return rows.length ? [rows[0].key] : [];
  },
}));

// The message thread itself is covered by GroupChat's own tests — stub it
// here so this screen's tests focus on the header/members-modal chrome.
// MatchCard/AppText are real (lightweight, no native deps) so the new
// Find-candidates UI renders faithfully.
// AuthorCard does its own fetching and is covered by AuthorCard.test.tsx —
// the member sheet only needs to prove it mounts the right author.
jest.mock('../../components', () => {
  const actual = jest.requireActual('../../components');
  const { Text } = jest.requireActual('react-native');
  return {
    ...actual,
    GroupChat: () => null,
    AuthorCard: ({ authorId }: { authorId: string }) => <Text>author-card:{authorId}</Text>,
  };
});

const GROUP = {
  group_id: 'g1', name: 'Mumbai H-1B crew', description: 'H-1B folks near BOM',
  group_type: '', criteria_text: 'looking for H-1B folks at Mumbai',
  members: [
    { user_id: 'demo-arjun', username: 'arjun-h1b' },
    { user_id: 'demo-mei', username: 'mei-f1' },
  ],
  created_by: 'demo-arjun',
  is_admin: false,
  is_member: true,
  created_at: '2026-06-07T00:00:00.000Z',
  last_activity_at: '2026-06-07T00:05:00.000Z',
  score: 0, shared: [],
};

const VOCAB = {
  post_join_attribute_templates: {
    'stem-opt-extension': [
      { label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' },
      { label: 'Notice of Intent to Deny (NOID)', field: 'key_dates', key: 'noid_date' },
    ],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  (getGroup as jest.Mock).mockResolvedValue(GROUP);
  (getTagVocab as jest.Mock).mockResolvedValue(VOCAB);
  (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: [] });
  (getGroupInvitations as jest.Mock).mockResolvedValue({ invitations: [] });
});

async function openMembersModal(screen: Awaited<ReturnType<typeof renderScreen>>) {
  const header = await screen.findByText('Mumbai H-1B crew');
  await fireEvent.press(header);
  await waitFor(() => expect(screen.getByText('Members (2)')).toBeOnTheScreen());
}

describe('GroupChatScreen — metadata + admin badge', () => {
  it('shows the group name/description/dates and an Admin badge on the creator', async () => {
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    expect(screen.getByText('H-1B folks near BOM')).toBeOnTheScreen();
    expect(screen.getByText(/Created/)).toBeOnTheScreen();
    expect(screen.getByText('Admin')).toBeOnTheScreen();
    expect(screen.getByText('arjun-h1b')).toBeOnTheScreen();
    expect(screen.getByText('mei-f1')).toBeOnTheScreen();
  });
});

describe('GroupChatScreen — rename (admin-only)', () => {
  it('does not show Rename for a non-admin viewer', async () => {
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);
    expect(screen.queryByText('Rename')).toBeNull();
  });

  it('lets the admin rename the group', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true });
    (renameGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true, name: 'BOM H-1B group' });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('Rename'));
    const nameInput = await screen.findByDisplayValue('Mumbai H-1B crew');
    await fireEvent.changeText(nameInput, 'BOM H-1B group');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(renameGroup).toHaveBeenCalledWith('g1', { name: 'BOM H-1B group', description: 'H-1B folks near BOM' }));
    // Both the header AND the modal's title now reflect the new name.
    await waitFor(() => expect(screen.getAllByText('BOM H-1B group').length).toBeGreaterThanOrEqual(1));
  });

  it('Cancel restores the original name/description without calling renameGroup', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('Rename'));
    const nameInput = await screen.findByDisplayValue('Mumbai H-1B crew');
    await fireEvent.changeText(nameInput, 'Something Else');
    await fireEvent.press(screen.getByText('Cancel'));

    await waitFor(() => expect(screen.getAllByText('Mumbai H-1B crew').length).toBeGreaterThanOrEqual(1));
    expect(screen.queryByText('Something Else')).toBeNull();
    expect(renameGroup).not.toHaveBeenCalled();
  });
});

describe('GroupChatScreen — invite by handle (any member)', () => {
  it('sends an invitation and shows the invitee as pending, NOT as a member', async () => {
    (inviteToGroup as jest.Mock).mockResolvedValue({
      invitation_id: 'g1__demo-omar', group_id: 'g1',
      user_id: 'demo-omar', username: 'omar-b1b2', status: 'pending',
    });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.changeText(screen.getByPlaceholderText('their handle…'), 'omar-b1b2');
    await fireEvent.press(screen.getByText('Invite'));

    await waitFor(() => expect(inviteToGroup).toHaveBeenCalledWith('g1', 'omar-b1b2'));
    expect(await screen.findByText('Invited (1)')).toBeOnTheScreen();
    expect(screen.getByText('omar-b1b2 · awaiting reply')).toBeOnTheScreen();
    // The group itself is untouched until they accept.
    expect(screen.getByText('Members (2)')).toBeOnTheScreen();
    expect(screen.getByText(/they’ll join once they accept/)).toBeOnTheScreen();
  });

  it('surfaces an error when the handle is not found', async () => {
    (inviteToGroup as jest.Mock).mockRejectedValue(new Error('No user with the handle "nope".'));
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.changeText(screen.getByPlaceholderText('their handle…'), 'nope');
    await fireEvent.press(screen.getByText('Invite'));

    expect(await screen.findByText(/No user with the handle/)).toBeOnTheScreen();
  });

  it('clears the invite input after a successful invite', async () => {
    (inviteToGroup as jest.Mock).mockResolvedValue({
      ...GROUP,
      members: [...GROUP.members, { user_id: 'demo-omar', username: 'omar-b1b2' }],
    });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.changeText(screen.getByPlaceholderText('their handle…'), 'omar-b1b2');
    await fireEvent.press(screen.getByText('Invite'));

    await waitFor(() => expect(inviteToGroup).toHaveBeenCalledWith('g1', 'omar-b1b2'));
    await waitFor(() => expect(screen.getByPlaceholderText('their handle…').props.value).toBe(''));
  });
});

describe('GroupChatScreen — empty description', () => {
  it('does not render a description when the group has none', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, description: '' });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);
    expect(screen.queryByText('H-1B folks near BOM')).toBeNull();
  });
});

describe('GroupChatScreen — leave group (previously 404\'d, backend route now exists)', () => {
  it('confirms via Alert, calls leaveGroup, and navigates back', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const leaveButton = buttons?.find((b) => b.text === 'Leave');
      leaveButton?.onPress?.();
    });
    (leaveGroup as jest.Mock).mockResolvedValue(undefined);
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Mumbai H-1B crew');

    await fireEvent.press(screen.getByLabelText('Leave Group'));
    await waitFor(() => expect(leaveGroup).toHaveBeenCalledWith('g1'));
    expect(mockGoBack).toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('does nothing when the Leave confirmation is dismissed/cancelled', async () => {
    // The real 'Cancel' button has no onPress at all — dismissing the alert
    // without invoking any button faithfully reproduces that path.
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Mumbai H-1B crew');

    await fireEvent.press(screen.getByLabelText('Leave Group'));
    expect(leaveGroup).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('shows an error Alert and does not navigate back when leaveGroup fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const leaveButton = buttons?.find((b) => b.text === 'Leave');
      leaveButton?.onPress?.();
    });
    (leaveGroup as jest.Mock).mockRejectedValue(new Error('network down'));
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Mumbai H-1B crew');

    await fireEvent.press(screen.getByLabelText('Leave Group'));
    await waitFor(() => expect(leaveGroup).toHaveBeenCalledWith('g1'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Error', 'network down'));
    expect(mockGoBack).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

describe('GroupChatScreen — delete group (admin-only)', () => {
  it('does not show Delete Group for a non-admin viewer', async () => {
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);
    expect(screen.queryByText('Delete Group')).toBeNull();
  });

  it('confirms via Alert, calls deleteGroup, and navigates back', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const deleteButton = buttons?.find((b) => b.text === 'Delete');
      deleteButton?.onPress?.();
    });
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true });
    (deleteGroup as jest.Mock).mockResolvedValue(undefined);
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('Delete Group'));
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith('g1'));
    expect(mockGoBack).toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('does nothing when the Delete confirmation is dismissed/cancelled', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('Delete Group'));
    expect(deleteGroup).not.toHaveBeenCalled();
    expect(mockGoBack).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it('shows an error Alert and does not navigate back when deleteGroup fails', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((_title, _msg, buttons) => {
      const deleteButton = buttons?.find((b) => b.text === 'Delete');
      deleteButton?.onPress?.();
    });
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true });
    (deleteGroup as jest.Mock).mockRejectedValue(new Error("Only the group's creator can delete it."));
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('Delete Group'));
    await waitFor(() => expect(deleteGroup).toHaveBeenCalledWith('g1'));
    await waitFor(() => expect(alertSpy).toHaveBeenCalledWith('Error', "Only the group's creator can delete it."));
    expect(mockGoBack).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });
});

describe('GroupChatScreen — Group details metadata panel', () => {
  it('shows created date, status/expiration and the criteria breakdown — but NOT the creator', async () => {
    (getGroup as jest.Mock).mockResolvedValue({
      ...GROUP, status: 'active', expiration_date: '2027-01-01T00:00:00.000Z', created_by_username: 'arjun-h1b',
      criteria_tags: {
        current_visa_or_greencard_category: ['H-1B'], visa_applying_for: ['EB-2'], consulates: ['BOM'],
        tags: ['rfe-experience'], key_stages_or_info: { stem_opt_cycle: 'Fall' },
      },
    });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    // The creator already carries the Admin badge in the Members list, so
    // naming them here said the same thing twice.
    expect(screen.queryByText(/Created by/)).toBeNull();
    expect(screen.getByText(/Expires/)).toBeOnTheScreen();
    expect(screen.getByText(/EB-2/)).toBeOnTheScreen();
    expect(screen.getByText(/rfe-experience/)).toBeOnTheScreen();
    expect(screen.getByText(/Fall/)).toBeOnTheScreen();
  });

  it('shows "Expired" instead of "Expires" once the group is archived', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, status: 'archived', expiration_date: '2020-01-01T00:00:00.000Z' });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    expect(screen.getByText(/Expired/)).toBeOnTheScreen();
    expect(screen.queryByText(/^Expires/)).toBeNull();
  });
});

describe('GroupChatScreen — Archive/Unarchive (admin-only)', () => {
  it('does not show an Archive control for a non-admin viewer', async () => {
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);
    expect(screen.queryByText('Archive Group')).toBeNull();
  });

  it('tapping Archive Group calls archiveGroup(true) and flips to Unarchive Group', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true, status: 'active' });
    (archiveGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true, status: 'archived' });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('Archive Group'));

    await waitFor(() => expect(archiveGroup).toHaveBeenCalledWith('g1', true));
    expect(await screen.findByText('Unarchive Group')).toBeOnTheScreen();
  });
});

describe('GroupChatScreen — non-member join preview', () => {
  it('shows a Join button instead of the chat/members UI for a non-member', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_member: false });
    const screen = await renderScreen(<GroupChatScreen />);

    expect(await screen.findByText('Join group')).toBeOnTheScreen();
    expect(screen.queryByText(/member/)).not.toBeNull(); // "N members" summary line still shows
    expect(screen.queryByPlaceholderText('their handle…')).toBeNull();
  });

  it('shows a Timeline badge for a Timeline group', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_member: false, group_type: 'timeline' });
    const screen = await renderScreen(<GroupChatScreen />);
    expect(await screen.findByText('Timeline')).toBeOnTheScreen();
  });

  it('hides the Join button and shows an archived note instead', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_member: false, status: 'archived' });
    const screen = await renderScreen(<GroupChatScreen />);

    await screen.findByText(/archived and no longer accepting new members/);
    expect(screen.queryByText('Join group')).toBeNull();
  });

  it('tapping Join calls joinGroup and shows the group as a member', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_member: false });
    (joinGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_member: true });
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Join group');

    await fireEvent.press(screen.getByText('Join group'));

    await waitFor(() => expect(joinGroup).toHaveBeenCalledWith('g1', {}, ''));
    expect(await screen.findByLabelText('Leave Group')).toBeOnTheScreen();
  });

  it('a member sees the full chat UI, not the join preview', async () => {
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Mumbai H-1B crew');
    expect(screen.queryByText('Join group')).toBeNull();
  });
});

describe('GroupChatScreen — share group link', () => {
  it('opens the native share sheet with a link to the group', async () => {
    const shareSpy = jest.spyOn(Share, 'share').mockResolvedValue({ action: Share.sharedAction });
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Mumbai H-1B crew');

    await fireEvent.press(screen.getByLabelText('Share group link'));

    await waitFor(() => expect(shareSpy).toHaveBeenCalled());
    const arg = shareSpy.mock.calls[0][0];
    expect(arg.url).toContain('/groups/g1');
    shareSpy.mockRestore();
  });
});

describe('GroupChatScreen — Find candidates (member-only)', () => {
  const CANDIDATE = { user_id: 'u9', username: 'nine', score: 4.5, shared: ['H-1B'], summary: 'H-1B', background: '' };

  it('finds candidates scoped to this group and renders them', async () => {
    (findCandidates as jest.Mock).mockResolvedValue({ matches: [CANDIDATE], total: 1 });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getAllByText('Find candidates')[1]);

    expect(await screen.findByText('nine')).toBeOnTheScreen();
    expect(findCandidates).toHaveBeenCalledWith('g1');
  });

  it('shows a no-candidates message when none are found', async () => {
    (findCandidates as jest.Mock).mockResolvedValue({ matches: [], total: 0 });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getAllByText('Find candidates')[1]);

    expect(await screen.findByText(/No candidates found/)).toBeOnTheScreen();
  });

  it('selecting a candidate and adding calls addMembers with the selected user_ids', async () => {
    (findCandidates as jest.Mock).mockResolvedValue({ matches: [CANDIDATE], total: 1 });
    (addMembers as jest.Mock).mockResolvedValue({
      ...GROUP,
      members: [...GROUP.members, { user_id: 'u9', username: 'nine' }],
    });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);
    await fireEvent.press(screen.getAllByText('Find candidates')[1]);
    await screen.findByText('nine');

    await fireEvent.press(screen.getByLabelText('Include nine'));
    await fireEvent.press(screen.getByText('Invite 1 selected'));

    await waitFor(() => expect(addMembers).toHaveBeenCalledWith('g1', ['u9']));
  });

  it('the Add button is disabled until a candidate is selected', async () => {
    (findCandidates as jest.Mock).mockResolvedValue({ matches: [CANDIDATE], total: 1 });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);
    await fireEvent.press(screen.getAllByText('Find candidates')[1]);
    await screen.findByText('nine');

    expect(screen.getByText('Invite selected')).toBeDisabled();
  });
});

describe('GroupChatScreen — join preview attribute form (non-member)', () => {
  const TIMELINE_GROUP = {
    ...GROUP, group_type: 'timeline', criteria_tags: { tags: ['stem-opt-extension'] }, is_member: false,
  };

  it('shows the attribute form inline on the join preview for a matching Timeline group', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE_GROUP);
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Join group');

    expect(screen.getByText('Your stem-opt-extension attributes')).toBeOnTheScreen();
    expect(screen.getByText('Date Applied *')).toBeOnTheScreen();
    expect(screen.getByText('Notice of Intent to Deny (NOID)')).toBeOnTheScreen();
  });

  it('disables Join until the required field (row 0 — Date Applied) is filled', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE_GROUP);
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Join group');

    expect(screen.getByText('Join group')).toBeDisabled();

    await fireEvent.changeText(screen.getAllByPlaceholderText('YYYY-MM-DD')[0], '2026-03-01');

    expect(screen.getByText('Join group')).not.toBeDisabled();
  });

  it('Join sends the filled values + notes to joinGroup()', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE_GROUP);
    (joinGroup as jest.Mock).mockResolvedValue({ ...TIMELINE_GROUP, is_member: true, needs_attributes: false });
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Join group');

    await fireEvent.changeText(screen.getAllByPlaceholderText('YYYY-MM-DD')[0], '2026-03-01');
    await fireEvent.changeText(screen.getByPlaceholderText('Anything else worth sharing with the cohort?'), 'filed early');
    await fireEvent.press(screen.getByText('Join group'));

    await waitFor(() => expect(joinGroup).toHaveBeenCalledWith('g1', { ead_filed_date: '2026-03-01' }, 'filed early'));
  });

  it('does not show the form for a Regular group, even with a matching tag, and Join has no required-field gate', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...TIMELINE_GROUP, group_type: '' });
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Join group');

    expect(screen.queryByText(/Your .* attributes/)).toBeNull();
    expect(screen.getByText('Join group')).not.toBeDisabled();
  });

  it('does not show the form when the Timeline group has no registered post-join template (e.g. H-1B)', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...TIMELINE_GROUP, criteria_tags: { current_visa_or_greencard_category: ['H-1B'] } });
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Join group');

    expect(screen.queryByText(/Your .* attributes/)).toBeNull();
    expect(screen.getByText('Join group')).not.toBeDisabled();
  });
});

describe('GroupChatScreen — mandatory attribute gate (member view, e.g. added via invite)', () => {
  const GATED_GROUP = {
    ...GROUP, group_type: 'timeline', criteria_tags: { tags: ['stem-opt-extension'] },
    is_member: true, needs_attributes: true,
  };

  it('blocks chat behind the mandatory gate when needs_attributes is true — the invite-bypass bug fix', async () => {
    (getGroup as jest.Mock).mockResolvedValue(GATED_GROUP);
    const screen = await renderScreen(<GroupChatScreen />);

    expect(await screen.findByText('Add your stem-opt-extension attributes')).toBeOnTheScreen();
    expect(screen.getByText(/Required to access this group/)).toBeOnTheScreen();
  });

  it('has no Skip button — the gate cannot be dismissed', async () => {
    (getGroup as jest.Mock).mockResolvedValue(GATED_GROUP);
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Add your stem-opt-extension attributes');

    expect(screen.queryByText('Skip')).toBeNull();
  });

  it('hides Members, Invite someone, and Find candidates in the Group Info modal while gated — not just chat', async () => {
    (getGroup as jest.Mock).mockResolvedValue(GATED_GROUP);
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Add your stem-opt-extension attributes');

    await fireEvent.press(screen.getByText('Mumbai H-1B crew'));

    expect(screen.queryByText(/^Members \(/)).toBeNull();
    expect(screen.queryByText('Invite someone')).toBeNull();
    expect(screen.queryByText('Find candidates')).toBeNull();
  });

  it('submitting the gate calls saveMemberAttributes and reveals chat once needs_attributes is false', async () => {
    (getGroup as jest.Mock).mockResolvedValue(GATED_GROUP);
    (saveMemberAttributes as jest.Mock).mockResolvedValue({ ...GATED_GROUP, needs_attributes: false });
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Add your stem-opt-extension attributes');

    await fireEvent.changeText(screen.getAllByPlaceholderText('YYYY-MM-DD')[0], '2026-03-01');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(saveMemberAttributes).toHaveBeenCalledWith('g1', { ead_filed_date: '2026-03-01' }, ''));
    await waitFor(() => expect(screen.queryByText('Add your stem-opt-extension attributes')).toBeNull());
  });

  it('a member with needs_attributes false sees chat directly — no gate', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GATED_GROUP, needs_attributes: false });
    const screen = await renderScreen(<GroupChatScreen />);
    await screen.findByText('Mumbai H-1B crew');
    expect(screen.queryByText(/Add your .* attributes/)).toBeNull();
  });
});

describe('GroupChatScreen — member attributes moved out of the sidebar', () => {
  const TIMELINE = {
    ...GROUP, group_type: 'timeline',
    criteria_tags: { tags: ['stem-opt-extension'] }, needs_attributes: false,
  };
  const ARJUN_ATTRS = {
    user_id: 'demo-arjun', username: 'arjun-h1b', processing_type: 'stem-opt-extension',
    values: { ead_filed_date: '2026-03-01' }, notes: 'filed early',
  };

  it('no longer renders a Cohort attributes block', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE);
    (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: [ARJUN_ATTRS] });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);
    expect(screen.queryByText('Cohort attributes')).toBeNull();
  });

  it('offers a route to the full attributes screen, labelled "View All Data"', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE);
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(await screen.findByText('View All Data'));
    expect(mockNavigate).toHaveBeenCalledWith('GroupAttributes', {
      groupId: 'g1', groupName: 'Mumbai H-1B crew',
    });
  });

  it('tapping a member opens a sheet with their attributes for this group', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE);
    (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: [ARJUN_ATTRS] });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('arjun-h1b'));
    expect(await screen.findByText('Date Applied: 2026-03-01')).toBeOnTheScreen();
    expect(screen.getByText('“filed early”')).toBeOnTheScreen();
    // The same sheet carries their profile — mobile has no hover to split them.
    expect(screen.getByText('author-card:demo-arjun')).toBeOnTheScreen();
  });

  it('says so plainly when the tapped member has shared nothing', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE);
    (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: [ARJUN_ATTRS] });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('mei-f1'));
    expect(await screen.findByText(/Hasn't shared attributes with this group yet/)).toBeOnTheScreen();
  });

  it('lets you edit your own attributes, prefilled from what you submitted', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE);
    (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: [ARJUN_ATTRS] });
    (saveMemberAttributes as jest.Mock).mockResolvedValue(TIMELINE);
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(await screen.findByText('Edit your attributes'));
    expect(await screen.findByText('Edit your stem-opt-extension attributes')).toBeOnTheScreen();
    expect(screen.getByDisplayValue('2026-03-01')).toBeOnTheScreen();

    await fireEvent.changeText(screen.getByDisplayValue('2026-03-01'), '2026-04-02');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() =>
      expect(saveMemberAttributes).toHaveBeenCalledWith(
        'g1', expect.objectContaining({ ead_filed_date: '2026-04-02' }), 'filed early'
      )
    );
  });

  it('offers no Edit affordance to a member who has submitted nothing', async () => {
    (getGroup as jest.Mock).mockResolvedValue(TIMELINE);
    (getMemberAttributes as jest.Mock).mockResolvedValue({ attributes: [] });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);
    expect(screen.queryByText('Edit your attributes')).toBeNull();
  });
});

describe('GroupChatScreen — Timeline rename lock', () => {
  it('shows "Edit description" instead of "Rename" for a Timeline group admin, and no name input', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true, group_type: 'timeline' });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    expect(screen.queryByText('Rename')).toBeNull();
    const editTrigger = screen.getByText('Edit description');
    expect(editTrigger).toBeOnTheScreen();

    await fireEvent.press(editTrigger);
    expect(screen.getByText('Mumbai H-1B crew')).toBeOnTheScreen();
  });

  it('saving only sends {description} to renameGroup for a Timeline group — no name key', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true, group_type: 'timeline' });
    (renameGroup as jest.Mock).mockResolvedValue({ ...GROUP, is_admin: true, group_type: 'timeline', description: 'updated cohort description' });
    const screen = await renderScreen(<GroupChatScreen />);
    await openMembersModal(screen);

    await fireEvent.press(screen.getByText('Edit description'));
    const descInput = screen.getByPlaceholderText("What's this group for?");
    await fireEvent.changeText(descInput, 'updated cohort description');
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() => expect(renameGroup).toHaveBeenCalledWith('g1', { description: 'updated cohort description' }));
  });
});

describe('GroupChatScreen — attribute controls follow the template kind', () => {
  const KIND_VOCAB = {
    post_join_attribute_templates: {
      'stem-opt-extension': [
        { kind: 'date', label: 'Date Applied', field: 'key_dates', key: 'ead_filed_date' },
        { kind: 'select', label: 'Status', field: 'key_stages_or_info', key: 'application_status',
          options: ['approved', 'pending', 'denied', 'RFE', 'NOID'] },
        { kind: 'checkbox', label: 'Premium Processing', field: 'key_stages_or_info', key: 'premium_processing' },
      ],
    },
  };
  const GATED = {
    ...GROUP, group_type: 'timeline',
    criteria_tags: { tags: ['stem-opt-extension'] }, needs_attributes: true,
  };

  beforeEach(() => {
    (getTagVocab as jest.Mock).mockResolvedValue(KIND_VOCAB);
    (getGroup as jest.Mock).mockResolvedValue(GATED);
  });

  it('renders a date field, a chip row for a select, and a switch for a checkbox', async () => {
    const screen = await renderScreen(<GroupChatScreen />);

    expect(await screen.findByLabelText('Date Applied')).toBeOnTheScreen();
    // RN has no <select> — the chip row is this app's picker idiom.
    for (const o of ['approved', 'pending', 'denied', 'RFE', 'NOID']) {
      expect(screen.getByText(o)).toBeOnTheScreen();
    }
    expect(screen.getByLabelText('Premium Processing')).toBeOnTheScreen();
  });

  it('submits a ticked checkbox as "yes" and leaves an untouched one out', async () => {
    (saveMemberAttributes as jest.Mock).mockResolvedValue(GATED);
    const screen = await renderScreen(<GroupChatScreen />);

    await fireEvent.changeText(await screen.findByLabelText('Date Applied'), '2027-02-01');
    await fireEvent.press(screen.getByText('RFE'));
    await fireEvent(screen.getByLabelText('Premium Processing'), 'valueChange', true);
    await fireEvent.press(screen.getByText('Save'));

    await waitFor(() =>
      expect(saveMemberAttributes).toHaveBeenCalledWith(
        'g1',
        { ead_filed_date: '2027-02-01', application_status: 'RFE', premium_processing: 'yes' },
        ''
      )
    );
  });

  it('tapping the selected chip again clears it', async () => {
    const screen = await renderScreen(<GroupChatScreen />);

    await screen.findByLabelText('Date Applied');
    await fireEvent.press(screen.getByText('RFE'));
    await fireEvent.press(screen.getByText('RFE'));
    (saveMemberAttributes as jest.Mock).mockResolvedValue(GATED);
    await fireEvent.changeText(screen.getByLabelText('Date Applied'), '2027-02-01');
    await fireEvent.press(screen.getByText('Save'));

    // Cleared sends an empty string, exactly like an unticked checkbox —
    // _validate_attribute_values() drops both server-side.
    await waitFor(() =>
      expect(saveMemberAttributes).toHaveBeenCalledWith(
        'g1', { ead_filed_date: '2027-02-01', application_status: '' }, ''
      )
    );
  });
});

describe('GroupChatScreen — long member lists collapse', () => {
  const MANY = Array.from({ length: 8 }, (_, i) => ({ user_id: `u${i}`, username: `member-${i}` }));

  it('shows only the first 5, then reveals the rest on demand', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, members: MANY, created_by: 'u0' });
    const screen = await renderScreen(<GroupChatScreen />);
    await fireEvent.press(await screen.findByText('Mumbai H-1B crew'));
    await waitFor(() => expect(screen.getByText('Members (8)')).toBeOnTheScreen());

    expect(screen.getByText('member-4')).toBeOnTheScreen();
    expect(screen.queryByText('member-5')).toBeNull();

    await fireEvent.press(screen.getByText('Show all members…'));

    expect(await screen.findByText('member-7')).toBeOnTheScreen();
    expect(screen.queryByText('Show all members…')).toBeNull();
  });

  it('shows no link when the group fits', async () => {
    (getGroup as jest.Mock).mockResolvedValue({ ...GROUP, members: MANY.slice(0, 5), created_by: 'u0' });
    const screen = await renderScreen(<GroupChatScreen />);
    await fireEvent.press(await screen.findByText('Mumbai H-1B crew'));
    await waitFor(() => expect(screen.getByText('Members (5)')).toBeOnTheScreen());

    expect(screen.getByText('member-4')).toBeOnTheScreen();
    expect(screen.queryByText('Show all members…')).toBeNull();
  });
});
