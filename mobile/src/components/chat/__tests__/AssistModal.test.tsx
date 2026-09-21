import React from 'react';
import { Text, TouchableOpacity } from 'react-native';
import { renderScreen, fireEvent } from '../../../test/render';
import { AssistModal } from '../AssistModal';
import { assistTurn } from '../../../services/apiService';
import { navigateNested } from '../../../navigation/navigationRef';

// Stub the heavy leaf deps so the test exercises the AssistModal logic only.
jest.mock('../../../services/apiService', () => ({
  assistTurn: jest.fn(),
  getAssistSessionId: jest.fn(async () => 'sess-test'),
}));
jest.mock('../../../services/aiConsent', () => ({
  assertAIConsent: jest.fn(),
  AIConsentError: class AIConsentError extends Error {},
}));
jest.mock('../../../navigation/navigationRef', () => ({ navigateNested: jest.fn() }));
jest.mock('../../Markdown', () => ({
  __esModule: true,
  default: ({ children }: { children: string }) => {
    const { Text: T } = require('react-native');
    return <T>{children}</T>;
  },
}));
jest.mock('../../AnimatedPressable', () => ({
  AnimatedPressable: ({ children, onPress }: any) => {
    const { TouchableOpacity: TO } = require('react-native');
    return <TO onPress={onPress}>{children}</TO>;
  },
}));
// ChatInput pulls BlurView + the magic Orb (native) — replace with a bare
// "SEND" button that fires onSend, so tests can drive a turn deterministically.
jest.mock('../ChatInput', () => ({
  ChatInput: ({ onSend }: { onSend: (m: string) => void }) => {
    const { Text: T, TouchableOpacity: TO } = require('react-native');
    return (
      <TO onPress={() => onSend('a question')}>
        <T>SEND</T>
      </TO>
    );
  },
}));

function resp(over: Record<string, unknown> = {}) {
  return {
    intent: 'answer-gov', confidence: 0.9, answer: '', source_tier: '',
    citations: [], community_cards: [], clarify_questions: [],
    post_draft: null, timeline: null, find_url: '', search_suggestions_html: '', disclaimer: '',
    can_post: true, can_find_timeline: false, can_find_similar: false,
    rationale: '', id: 'x', turns_used: 1, ...over,
  };
}

describe('AssistModal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('renders a grounded answer with its source citation', async () => {
    (assistTurn as jest.Mock).mockResolvedValue(
      resp({
        answer: 'File Form AR-11.',
        source_tier: 'gov',
        citations: [{ source: 'https://uscis.gov/ar-11', title: 'USCIS AR-11', as_of: '2026-09-01' }],
      })
    );
    const screen = await renderScreen(<AssistModal visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByText('SEND'));
    expect(await screen.findByText('File Form AR-11.')).toBeOnTheScreen();
    expect(screen.getByText(/USCIS AR-11/)).toBeOnTheScreen();
  });

  it('renders community cards for the community tier', async () => {
    (assistTurn as jest.Mock).mockResolvedValue(
      resp({
        intent: 'answer-community',
        source_tier: 'community',
        community_cards: [
          { case_id: 'p1', title: 'Mumbai 221g', snippet: 'took 3 weeks', url: 'https://reddit.com/p1', channel: 'reddit' },
        ],
      })
    );
    const screen = await renderScreen(<AssistModal visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByText('SEND'));
    expect(await screen.findByText('Mumbai 221g')).toBeOnTheScreen();
  });

  it('find-similar button hands off to FindScreen with the parsed regular params', async () => {
    (assistTurn as jest.Mock).mockResolvedValue(
      resp({ intent: 'find-similar', can_find_similar: true, find_url: '/find?type=regular&q=H-1B+Mumbai&visa=H-1B' })
    );
    const screen = await renderScreen(<AssistModal visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByText('SEND'));
    fireEvent.press(await screen.findByText(/Find people in the same boat/));
    expect(navigateNested).toHaveBeenCalledWith('Find', 'FindMain', {
      type: 'regular', q: 'H-1B Mumbai', visa: 'H-1B',
    });
  });

  it('ungrounded answer offers the "search further" USCIS link', async () => {
    (assistTurn as jest.Mock).mockResolvedValue(resp({ answer: 'General guidance about AR-11.', source_tier: 'ungrounded' }));
    const screen = await renderScreen(<AssistModal visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByText('SEND'));
    expect(await screen.findByText('General guidance about AR-11.')).toBeOnTheScreen();
    expect(screen.getByText('Search on USCIS.gov')).toBeOnTheScreen();
  });

  it('shows a guest-limit nudge on the 429 cap', async () => {
    (assistTurn as jest.Mock).mockRejectedValue(Object.assign(new Error('guest'), { status: 429 }));
    const screen = await renderScreen(<AssistModal visible onClose={jest.fn()} />);
    fireEvent.press(screen.getByText('SEND'));
    expect(await screen.findByText(/guest limit/i)).toBeOnTheScreen();
  });
});
