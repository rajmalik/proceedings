import { DeviceEventEmitter } from 'react-native';
import { ASSIST_OPEN_EVENT, openAssist } from '../assistLauncher';

// The global AI Assist modal (rendered in TabNavigator) opens when any screen —
// e.g. the Home search-row "Ask AI/Post" — fires this event.
describe('assistLauncher', () => {
  it('has a stable event name', () => {
    expect(ASSIST_OPEN_EVENT).toBe('assist:open');
  });

  it('openAssist() emits the ASSIST_OPEN_EVENT', () => {
    const listener = jest.fn();
    const sub = DeviceEventEmitter.addListener(ASSIST_OPEN_EVENT, listener);
    openAssist();
    expect(listener).toHaveBeenCalledTimes(1);
    sub.remove();
  });
});
