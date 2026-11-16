// Location: the dot on the map while the app is open (watch), and a recording that keeps going with the
// screen off (startRecording): a background location task, an Android foreground service with its own
// notification, and the iOS "location" background mode. "When in use" is asked on launch; "always" only
// when the first hike starts (iOS shows the upgrade prompt then; Android may send the person to Settings).
// A recording works with "when in use" alone too: it is started from the screen, so the foreground service
// (Android) and the background indicator (iOS) keep it alive.
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import type { Fix, FixHandler, PlatformLocation, ProblemHandler } from '@web/platform/types';
import { keyValue } from './files';

export const RECORD_TASK = 'switchback-record';

export const toFix = (l: Location.LocationObject): Fix => ({
  lat: l.coords.latitude,
  lon: l.coords.longitude,
  ele: l.coords.altitude ?? null,
  accuracy: l.coords.accuracy ?? 999,
  time: l.timestamp,
  heading: l.coords.heading != null && l.coords.heading >= 0 && (l.coords.speed ?? 0) > 0.3 ? l.coords.heading : null,
});

let sink: { onFix: FixHandler; onProblem: ProblemHandler } | null = null;
/** Takes fixes when the task wakes an app whose screens never started (Android, after the app was swiped
 *  away while the service kept running). Set by the recorder. */
let headless: ((fixes: Fix[]) => void) | null = null;
export function setHeadlessRecorder(fn: (fixes: Fix[]) => void): void { headless = fn; }

// Must run when the bundle loads (index.ts imports this module first).
TaskManager.defineTask<{ locations?: Location.LocationObject[] }>(RECORD_TASK, async ({ data, error }) => {
  if (error) {
    sink?.onProblem('unavailable');
    return;
  }
  const fixes = (data?.locations ?? []).map(toFix).sort((a, b) => a.time - b.time);
  if (!fixes.length) return;
  if (sink) for (const f of fixes) sink.onFix(f);
  else headless?.(fixes);
});

async function foreground(): Promise<boolean> {
  const have = await Location.getForegroundPermissionsAsync();
  if (have.granted) return true;
  if (!have.canAskAgain) return false;
  return (await Location.requestForegroundPermissionsAsync()).granted;
}

/** Asks for "always" once, the first time a hike starts. The answer does not stop the hike. */
async function askAlwaysOnce(): Promise<void> {
  if (keyValue.get('asked-always')) return;
  keyValue.set('asked-always', '1');
  try {
    const bg = await Location.getBackgroundPermissionsAsync();
    if (!bg.granted && bg.canAskAgain) await Location.requestBackgroundPermissionsAsync();
  } catch { /* not available: recording still works while started from the screen */ }
}

export async function locationAllowed(): Promise<'granted' | 'denied' | 'undetermined'> {
  try {
    const p = await Location.getForegroundPermissionsAsync();
    return p.granted ? 'granted' : p.canAskAgain ? 'undetermined' : 'denied';
  } catch {
    return 'undetermined';
  }
}

export const location: PlatformLocation = {
  recordsInBackground: true,

  async current() {
    if (!(await foreground())) throw new Error('denied');
    return toFix(await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }));
  },

  watch(onFix, onProblem) {
    let stopped = false;
    let sub: Location.LocationSubscription | null = null;
    void (async () => {
      try {
        if (!(await foreground())) { onProblem('denied'); return; }
        if (stopped) return;
        // the last known place first: the map can move at once
        const last = await Location.getLastKnownPositionAsync({ maxAge: 10 * 60_000 }).catch(() => null);
        if (last && !stopped) onFix(toFix(last));
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, distanceInterval: 4, timeInterval: 2000 },
          (l) => { if (!stopped) onFix(toFix(l)); },
          () => onProblem('unavailable'),
        );
        if (stopped) sub.remove();
      } catch {
        onProblem('unavailable');
      }
    })();
    return () => {
      stopped = true;
      sub?.remove();
    };
  },

  async startRecording(onFix, onProblem, notice) {
    sink = { onFix, onProblem };
    if (!(await foreground())) { onProblem('denied'); return; }
    await askAlwaysOnce();
    try {
      if (await Location.hasStartedLocationUpdatesAsync(RECORD_TASK)) await Location.stopLocationUpdatesAsync(RECORD_TASK);
      await Location.startLocationUpdatesAsync(RECORD_TASK, {
        accuracy: Location.Accuracy.BestForNavigation,
        distanceInterval: 3,
        timeInterval: 2000,
        activityType: Location.ActivityType.Fitness,
        pausesUpdatesAutomatically: false,
        showsBackgroundLocationIndicator: true,
        foregroundService: {
          notificationTitle: notice.title,
          notificationBody: notice.text,
          notificationColor: '#12543f',
          killServiceOnDestroy: false,
        },
      });
    } catch {
      onProblem('unavailable');
    }
  },

  async stopRecording() {
    sink = null;
    try {
      if (await Location.hasStartedLocationUpdatesAsync(RECORD_TASK)) await Location.stopLocationUpdatesAsync(RECORD_TASK);
    } catch { /* already stopped */ }
  },
};

/** The recorder (re)attaches itself after a restart, so fixes go to it rather than the headless path. */
export function attachRecording(onFix: FixHandler, onProblem: ProblemHandler): void {
  sink = { onFix, onProblem };
}

export async function recordingRunning(): Promise<boolean> {
  try { return await Location.hasStartedLocationUpdatesAsync(RECORD_TASK); } catch { return false; }
}
