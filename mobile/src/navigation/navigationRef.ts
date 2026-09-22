import { createNavigationContainerRef } from '@react-navigation/native';

// A container-level nav ref so components rendered OUTSIDE a screen (the global
// AI Assist modal) can navigate — e.g. its post/timeline/find-similar handoffs.
export const navigationRef = createNavigationContainerRef();

/** Navigate to a screen nested in a tab, e.g. go('Home', 'Post', {...}). No-op
 *  until the container is ready. */
export function navigateNested(tab: string, screen: string, params?: object): void {
  if (navigationRef.isReady()) {
    // @ts-expect-error — dynamic nested navigation target
    navigationRef.navigate(tab, { screen, params });
  }
}
