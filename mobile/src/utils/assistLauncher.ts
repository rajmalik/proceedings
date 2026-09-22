import { DeviceEventEmitter } from 'react-native';

// The AI Assist chat modal is rendered once at the TabNavigator level. Any
// screen (e.g. the Home search row) opens it by emitting this event — the RN
// analog of the website's `aiassist:open` window event (assistLauncher.ts).
export const ASSIST_OPEN_EVENT = 'assist:open';

export function openAssist(): void {
  DeviceEventEmitter.emit(ASSIST_OPEN_EVENT);
}
