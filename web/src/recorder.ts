// Recording a walk. Fixes come from the device (platform.location): in a browser only while the page is
// open; in the phone apps from a background location service that keeps going with the screen off. Each
// kept point is written to the device as it arrives (a growing log), so a closed app or a reload loses
// nothing, and fixes are placed by their own time, so a batch that arrives late is handled like any other.
import { batch } from '@preact/signals';
import { platform, type Fix, type LocationProblem } from './platform';
import {
  addWalk, following, offTrail, recAccuracy, recError, recLength, recMarkers, recSeconds, recSegments, recState, recWakeLock, say,
  type Following,
} from './state';
import { newId, type Marker, type Walk } from './lib/storage';
import { addFix, emptyTrack, lastPoint, newStretch, restoreLog, MAX_ACCURACY, type LogLine, type Track } from './lib/track';
import { distanceToLine } from './lib/geo';
import { decodePolyline, encodePolyline } from './lib/polyline';
import { myLocation } from './map/map';

export { MAX_ACCURACY };
const LOG = 'recording';
/** Further than this from the trail being followed counts as off it; back within the second, on it again. */
export const OFF_TRAIL = 60;
const BACK_ON_TRAIL = 40;

let started = 0;
/** Seconds recorded before the current stretch, and when the current stretch began. */
let banked = 0;
let since = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
let track: Track = emptyTrack();
let offCount = 0;

const PROBLEMS: Record<LocationProblem, string> = {
  denied: platform.name === 'web'
    ? 'Location is turned off for this site. Allow it in your browser or phone settings, then try again.'
    : 'Switchback is not allowed to use your location. Allow it in Settings, then start again.',
  unavailable: "Your position can't be found right now. Recording continues when it comes back.",
  unsupported: "This browser can't share your location, so walks can't be recorded here.",
};

const write = (line: LogLine) => { void platform.documents.append(LOG, JSON.stringify(line)); };

/** Seconds on the clock for a moment in time (the clock runs on real time, not on timers that may sleep). */
const secondsAt = (time: number) => banked + Math.max(0, (time - since) / 1000);

function checkOffTrail(fix: Fix): void {
  const f = following.peek();
  if (!f) return;
  const d = distanceToLine([fix.lat, fix.lon], f.path);
  if (!offTrail.peek()) {
    // three fixes in a row, so one stray reading does not raise the alarm
    offCount = d > OFF_TRAIL ? offCount + 1 : 0;
    if (offCount >= 3) {
      offTrail.value = true;
      platform.haptics.success();
      void platform.notifications.show('You have left the trail', `${f.name} is about ${Math.round(d)} m away.`);
    }
  } else if (d < BACK_ON_TRAIL) {
    offTrail.value = false;
    offCount = 0;
  }
}

function onFix(fix: Fix): void {
  recAccuracy.value = fix.accuracy;
  recError.value = null;
  myLocation.value = { at: [fix.lat, fix.lon], accuracy: fix.accuracy };
  if (recState.peek() !== 'recording') return;
  // (a fix a little older than "since" is fine: the service may have had it ready)
  const r = addFix(track, fix, since - 5000);
  if (!r.kept) return;
  track = r.track;
  if (r.newStretch) write({ gap: true });
  write({ p: r.point, s: Math.round(secondsAt(fix.time)) });
  batch(() => {
    recSegments.value = track.segments;
    recLength.value = track.length;
  });
  checkOffTrail(fix);
}

function onProblem(p: LocationProblem): void {
  recError.value = PROBLEMS[p];
  if (p !== 'unavailable') void pause();
}

function tick(): void {
  if (recState.peek() === 'recording') recSeconds.value = secondsAt(Date.now());
}
// back from the background: the clock catches up at once
platform.app.onResume(tick);

async function run(): Promise<void> {
  since = Date.now();
  clearInterval(ticker);
  ticker = setInterval(tick, 1000);
  recState.value = 'recording';
  // Android 13+ only shows the recording notice (and "you have left the trail") when notifications are allowed
  if (platform.location.recordsInBackground) await platform.notifications.request();
  recWakeLock.value = platform.location.recordsInBackground ? 'off' : (await platform.keepAwake.on()) ? 'on' : 'unsupported';
  const f = following.peek();
  await platform.location.startRecording(onFix, onProblem, {
    title: f ? `Following ${f.name}` : 'Recording your hike',
    text: 'Switchback is using your location to record. Open the app to pause or finish.',
  });
}

export async function start(follow: Following | null = null): Promise<void> {
  track = emptyTrack();
  offCount = 0;
  batch(() => {
    recSegments.value = track.segments;
    recLength.value = 0;
    recSeconds.value = 0;
    recError.value = null;
    recMarkers.value = [];
    following.value = follow;
    offTrail.value = false;
  });
  started = Date.now();
  banked = 0;
  await platform.documents.removeLog(LOG);
  write({ start: started, ...(follow ? { follow: { region: follow.region, id: follow.id, name: follow.name, line: encodePolyline(follow.path) } } : {}) });
  platform.haptics.tap();
  await run();
}

export async function pause(): Promise<void> {
  if (recState.peek() !== 'recording') return;
  banked = secondsAt(Date.now());
  recSeconds.value = banked;
  clearInterval(ticker);
  recState.value = 'paused';
  write({ s: Math.round(banked) });
  await platform.location.stopRecording();
  await platform.keepAwake.off();
  recWakeLock.value = 'off';
}

export async function resume(): Promise<void> {
  if (recState.peek() !== 'paused') return;
  // a new stretch, so the pause is not drawn as a straight line
  const next = newStretch(track);
  if (next !== track) write({ gap: true });
  track = next;
  recError.value = null;
  platform.haptics.tap();
  await run();
}

/** Marks where you are now, with a name (a spring, a junction, a view). */
export function dropMarker(name: string): boolean {
  const at = lastPoint(track);
  if (!at) return false;
  const marker: Marker = { lat: at.lat, lon: at.lon, ele: at.ele, t: Date.now(), name: name.trim() || 'Marker' };
  recMarkers.value = [...recMarkers.peek(), marker];
  void platform.documents.append(LOG, JSON.stringify({ m: marker }));
  platform.haptics.tap();
  return true;
}

async function reset(): Promise<void> {
  clearInterval(ticker);
  track = emptyTrack();
  batch(() => {
    recState.value = 'idle';
    recSegments.value = [];
    recLength.value = 0;
    recSeconds.value = 0;
    recAccuracy.value = null;
    recMarkers.value = [];
    following.value = null;
    offTrail.value = false;
  });
  await platform.documents.removeLog(LOG);
}

/** Stops and keeps the walk. Returns it, or null when there was nothing to keep. */
export async function finish(): Promise<Walk | null> {
  await pause();
  const segments = track.segments.filter((s) => s.length > 0);
  const points = segments.flat();
  if (points.length < 2) {
    await reset();
    return null;
  }
  const when = new Date(started);
  const part = when.getHours() < 12 ? 'Morning' : when.getHours() < 17 ? 'Afternoon' : 'Evening';
  const f = following.peek();
  const walk: Walk = {
    id: newId(), name: f ? f.name : `${part} walk`, started, ended: points[points.length - 1].t,
    seconds: Math.round(recSeconds.peek()), length: track.length, segments,
    ...(recMarkers.peek().length ? { markers: recMarkers.peek() } : {}),
    ...(f ? { trail: { region: f.region, id: f.id, name: f.name } } : {}),
  };
  await addWalk(walk);
  platform.haptics.success();
  // (only seen when the app is not in front: finishing from the notification, later)
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') void platform.notifications.show('Hike saved', walk.name);
  await reset();
  return walk;
}

export async function discard(): Promise<void> {
  await pause();
  await reset();
}

/** A recording that was running when the app or page closed comes back paused. */
export async function restoreDraft(): Promise<void> {
  const lines = await platform.documents.readLog(LOG);
  const d = restoreLog(lines);
  if (!d) return;
  started = d.started;
  banked = d.seconds;
  track = d.track;
  const markers: Marker[] = [];
  for (const text of lines) {
    try { const row = JSON.parse(text); if (row?.m && typeof row.m.lat === 'number') markers.push(row.m); } catch { /* a line cut short */ }
  }
  batch(() => {
    recSegments.value = track.segments;
    recLength.value = track.length;
    recSeconds.value = d.seconds;
    recMarkers.value = markers;
    recState.value = 'paused';
    following.value = d.follow ? { region: d.follow.region, id: d.follow.id, name: d.follow.name, path: decodePolyline(d.follow.line) } : null;
  });
  say('Your recording was kept. It is paused.');
}
