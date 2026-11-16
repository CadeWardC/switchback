// Where you are, from the moment the app opens (as web/src/locate.ts does in the phone apps): "when in use"
// is asked at once and the map moves to you on the first fix. "Always" is asked only when the first hike starts (src/platform/location.ts).
import { platform } from '../platform';
import { save } from '@web/lib/storage';
import { flyTo, locationState, myLocation, say, view } from './state';

let stop: (() => void) | null = null;
const ZOOM = 12;

export function startLocating(center: boolean, fromButton = false): void {
  if (stop) {
    const me = myLocation.peek();
    if (center && me) flyTo.value = { center: me.at, zoom: Math.max(ZOOM + 2, view.peek()?.zoom ?? 0) };
    return;
  }
  locationState.value = 'on';
  let first = true;
  stop = platform.location.watch(
    (fix) => {
      myLocation.value = { at: [fix.lat, fix.lon], accuracy: fix.accuracy, ele: fix.ele, heading: fix.heading };
      if (first) {
        first = false;
        save('location-asked', true);
        if (center) flyTo.value = { center: [fix.lat, fix.lon], zoom: Math.max(ZOOM, view.peek()?.zoom ?? 0) };
      }
    },
    (problem) => {
      stop?.();
      stop = null;
      save('location-asked', true);
      locationState.value = problem === 'denied' ? 'denied' : 'off';
      if (fromButton) {
        say(problem === 'denied' ? 'Switchback is not allowed to use your location. Allow it in Settings.' : "Your position can't be found right now.");
      }
    },
  );
}

/** The locate button. */
export function locateMe(): void {
  platform.haptics.tap();
  startLocating(true, true);
}

/** "Turn on location" (after a no): the phone's settings for this app. */
export function turnOnLocation(): void {
  platform.links.openSettings();
}

/** At launch: ask, follow, and centre the map on you. */
export function locationAtLaunch(): void {
  startLocating(true);
}

/** Back from Settings with location now allowed: start again. */
export function retryLocation(): void {
  if (locationState.peek() === 'denied') startLocating(true);
}
