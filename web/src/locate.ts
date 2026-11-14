// Where you are, from the moment the app opens.
//   Phone apps: location is asked for at once, when the app starts ("while using the app" on iPhone; the
//   "always" question comes only when the first hike is started, because only recording needs it).
//   Website: a browser should not be asked on load, so the first visit shows a one-line card instead; once
//   allowed, later visits use location without asking.
// Once there is a fix the map moves to you (unless the app was opened on a link to somewhere), and the trail
// files and map for your area start downloading by themselves (src/offline.ts follows myLocation).
import { signal } from '@preact/signals';
import { platform } from './platform';
import { flyTo, openedAt, route, say, view } from './state';
import { myLocation } from './map/map';
import { load, save } from './lib/storage';

/** off: not asked yet. ask: the website's first-visit card is showing. on: located (or locating).
 *  denied: the person said no, or turned it off (a quiet "Turn on location" chip shows). */
export const locationState = signal<'off' | 'ask' | 'on' | 'denied'>('off');

let stop: (() => void) | null = null;
const ZOOM = 12;

/** Starts following where you are. `center`: move the map to you on the first fix. */
export function startLocating(center: boolean, fromButton = false): void {
  if (stop) {
    const me = myLocation.peek();
    if (center && me) flyTo.value = { center: me.at, zoom: Math.max(ZOOM, view.peek()?.zoom ?? 0) };
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
      if (problem === 'denied') locationState.value = 'denied';
      else locationState.value = 'off';
      if (fromButton) {
        say(problem === 'denied'
          ? platform.name === 'web' ? 'Location is turned off for this site. Allow it in your browser settings to see where you are.'
            : 'Switchback is not allowed to use your location. Allow it in Settings.'
          : problem === 'unsupported' ? "This browser can't share your location." : "Your position can't be found right now.");
      }
    },
  );
}

/** The locate button. */
export function locateMe(): void {
  platform.haptics.tap();
  startLocating(true, true);
}

/** "Turn on location" (after a no): the phone's settings in the apps; one more try on the website. */
export function turnOnLocation(): void {
  if (platform.name !== 'web') platform.links.openSettings();
  else startLocating(true, true);
}

/** The website's first-visit card: "Not now". */
export function dismissLocationCard(): void {
  save('location-asked', true);
  locationState.value = 'off';
}

/** At launch. The map moves to you only when the app was not opened on a link to a place or a trail. */
export async function locationAtLaunch(): Promise<void> {
  const center = !openedAt && route.peek().page === 'explore';
  if (platform.name !== 'web') {
    startLocating(center);
    return;
  }
  let state: PermissionState | 'unknown' = 'unknown';
  try {
    state = (await navigator.permissions?.query({ name: 'geolocation' }))?.state ?? 'unknown';
  } catch { /* an older browser: treated as not asked */ }
  if (state === 'granted') startLocating(center);
  else if (state === 'denied') locationState.value = 'denied';
  else if (!load<boolean>('location-asked', false) && 'geolocation' in navigator) locationState.value = 'ask';
}
