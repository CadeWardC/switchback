// Recording a hike. Adapted from web/src/recorder.ts (which depends on the browser's page visibility and the
// maplibre-gl map module); the rules are the website's own, imported from web/src/lib: addFix (track.ts),
// progressOn / watchEnd / whichWay (follow.ts), restoreLog. What is different here:
//   - fixes come from a background location task, which also runs when the app's screens are not alive
//     (Android may restart only the task after the app was swiped away): then the recording is rebuilt
//     from its log first, so no point is lost;
//   - each kept point is appended to the log the moment it arrives;
//   - the end-of-trail question goes out as a notification with Keep going / Finish buttons whenever the
//     app is not on screen.
import { batch } from '@preact/signals-core';
import { AppState } from 'react-native';
import { platform, type Fix, type LocationProblem } from '../platform';
import { attachRecording, recordingRunning, setHeadlessRecorder } from '../platform/location';
import {
  addWalk, backLine, endReached, following, myLocation, offTrail, offTrailInfo, recAccuracy, recError, recMarkers, recSeconds, recSegments,
  recLength, recStarted, recState, say, shownWalk, tab, type Following,
} from './state';
import { bearing, newEndWatch, progressOn, watchEnd, whichWay, type EndWatch } from '@web/lib/follow';
import { newId, type Marker, type Walk } from '@web/lib/storage';
import { addFix, emptyTrack, lastPoint, newStretch, restoreLog, type LogLine, type Track } from '@web/lib/track';
import { decodePolyline, encodePolyline, type Coord } from '@web/lib/polyline';
import { isLoopLine } from '@web/lib/trail';

const LOG = 'recording';
/** Further than this from the trail being followed counts as off it; back within the second, on it again. */
export const OFF_TRAIL = 60;
const BACK_ON_TRAIL = 40;
/** Set while the location service runs, so a restart knows the hike was not paused. */
const LIVE = 'rec-live';

let started = 0;
let banked = 0;
let since = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
let track: Track = emptyTrack();
let offCount = 0;
let endWatch: EndWatch = newEndWatch();
let followTotal = 0;
let lastAlong = -Infinity;
let restored = false;

const PROBLEMS: Record<LocationProblem, string> = {
  denied: 'Switchback is not allowed to use your location. Allow it in Settings, then start again.',
  unavailable: "Your position can't be found right now. Recording continues when it comes back.",
  unsupported: "This phone can't share its location.",
};

const write = (line: LogLine | { m: Marker }) => { void platform.documents.append(LOG, JSON.stringify(line)); };
const onScreen = () => AppState.currentState === 'active';
const secondsAt = (time: number) => banked + Math.max(0, (time - since) / 1000);

function headingNow(fix: Fix): number | null {
  if (fix.heading != null) return fix.heading;
  const pts = track.segments[track.segments.length - 1] ?? [];
  if (pts.length < 2) return null;
  const a = pts[pts.length - 2], b = pts[pts.length - 1];
  return bearing([a.lat, a.lon], [b.lat, b.lon]);
}

function checkOffTrail(fix: Fix): void {
  const f = following.peek();
  if (!f) return;
  const here: Coord = [fix.lat, fix.lon];
  const at = progressOn(f.path, here, lastAlong);
  const d = at.off;
  if (!offTrail.peek()) {
    // three fixes in a row, so one stray reading does not raise the alarm
    offCount = d > OFF_TRAIL ? offCount + 1 : 0;
    if (offCount >= 3) {
      offTrail.value = true;
      platform.haptics.success();
      if (!onScreen()) void platform.notifications.show('You have left the trail', `${f.name} is about ${Math.round(d)} m ${whichWay(here, at.point, headingNow(fix))}.`);
    }
  } else if (d < BACK_ON_TRAIL) {
    offTrail.value = false;
    offCount = 0;
  }
  if (offTrail.peek()) {
    offTrailInfo.value = { metres: d, way: whichWay(here, at.point, headingNow(fix)) };
    backLine.value = [here, at.point];
  } else {
    lastAlong = at.along;
    if (offTrailInfo.peek()) offTrailInfo.value = null;
    if (backLine.peek()) backLine.value = null;
  }
}

function checkEnd(fix: Fix): void {
  const f = following.peek();
  if (!f || !f.id || f.path.length < 2) return;
  const r = watchEnd(endWatch, [fix.lat, fix.lon], f.path, followTotal, !!f.loop);
  endWatch = r.watch;
  if (!r.ask || endReached.peek()) return;
  endReached.value = r.ask;
  platform.haptics.success();
  if (!onScreen()) {
    void platform.notifications.ask(
      r.ask === 'start' ? 'You are back at the trailhead' : 'You have reached the end of the trail', 'Finish this hike?',
      [{ id: 'keep', title: 'Keep going' }, { id: 'finish', title: 'Finish hike' }],
      (id) => {
        if (id === 'keep') keepGoing();
        else if (id === 'finish') void finish().then(showFinished);
        // a tap on the notification itself opens the app, where the same question is showing
      },
    );
  }
}

/** After finishing: the Log, with the hike open. */
export async function showFinished(w: Walk | null): Promise<void> {
  if (!w) {
    say('Nothing was recorded, so there is no hike to keep.');
    return;
  }
  batch(() => {
    tab.value = 'log';
    shownWalk.value = w;
  });
}

export function keepGoing(): void {
  endReached.value = null;
}

function startFollowing(f: Following | null): void {
  endWatch = newEndWatch();
  lastAlong = -Infinity;
  followTotal = f && f.path.length > 1 ? progressOn(f.path, f.path[0]).total : 0;
  offCount = 0;
  batch(() => {
    offTrail.value = false;
    offTrailInfo.value = null;
    backLine.value = null;
    endReached.value = null;
  });
}

function onFix(fix: Fix): void {
  recAccuracy.value = fix.accuracy;
  if (recError.peek()) recError.value = null;
  myLocation.value = { at: [fix.lat, fix.lon], accuracy: fix.accuracy, ele: fix.ele, heading: fix.heading };
  if (recState.peek() !== 'recording') return;
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
  checkEnd(fix);
}

function onProblem(p: LocationProblem): void {
  recError.value = PROBLEMS[p];
  if (p !== 'unavailable') void pause();
}

function tick(): void {
  if (recState.peek() === 'recording') recSeconds.value = secondsAt(Date.now());
}
platform.app.onResume(tick);

function startTicker(): void {
  clearInterval(ticker);
  ticker = setInterval(tick, 1000);
}

async function run(): Promise<void> {
  since = Date.now();
  startTicker();
  recState.value = 'recording';
  platform.keyValue.set(LIVE, '1');
  // Android 13+ only shows the recording notice (and "you have left the trail") when notifications are allowed
  await platform.notifications.request();
  const f = following.peek();
  await platform.location.startRecording(onFix, onProblem, {
    title: f && f.id ? `Following ${f.name}` : 'Recording your hike',
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
  });
  startFollowing(follow);
  started = Date.now();
  recStarted.value = started;
  banked = 0;
  restored = true;
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
  platform.keyValue.remove(LIVE);
  write({ s: Math.round(banked) });
  await platform.location.stopRecording();
}

export async function resume(): Promise<void> {
  if (recState.peek() !== 'paused') return;
  const next = newStretch(track);
  if (next !== track) write({ gap: true });
  track = next;
  recError.value = null;
  platform.haptics.tap();
  await run();
}

/** Stops following the trail and follows your own recorded track back to where you started. */
export function headBack(): boolean {
  const points = track.segments.flat();
  if (points.length < 2) return false;
  following.value = { region: '', id: '', name: 'Back to the start', path: points.map((p) => [p.lat, p.lon] as Coord).reverse(), profile: null };
  startFollowing(following.peek());
  return true;
}

export function stopFollowing(): void {
  following.value = null;
  startFollowing(null);
}

/** Marks where you are now, with a name (a spring, a junction, a view). */
export function dropMarker(name: string): boolean {
  const at = lastPoint(track);
  if (!at) return false;
  const marker: Marker = { lat: at.lat, lon: at.lon, ele: at.ele, t: Date.now(), name: name.trim() || 'Marked spot' };
  recMarkers.value = [...recMarkers.peek(), marker];
  write({ m: marker });
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
  });
  startFollowing(null);
  platform.keyValue.remove(LIVE);
  await platform.documents.removeLog(LOG);
}

/** Stops and keeps the hike. Returns it, or null when there was nothing to keep. */
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
    id: newId(), name: f && f.id ? f.name : `${part} hike`, started, ended: points[points.length - 1].t,
    seconds: Math.round(recSeconds.peek()), length: track.length, segments,
    ...(recMarkers.peek().length ? { markers: recMarkers.peek() } : {}),
    ...(f && f.id ? { trail: { region: f.region, id: f.id, name: f.name } } : {}),
  };
  await addWalk(walk);
  platform.haptics.success();
  if (!onScreen()) void platform.notifications.show('Hike saved', walk.name);
  await reset();
  return walk;
}

export async function discard(): Promise<void> {
  await pause();
  await reset();
}

/** Rebuilds the recording from its log. `live`: the location service is still running, so it carries on. */
async function restoreFrom(lines: string[], live: boolean): Promise<boolean> {
  const d = restoreLog(lines);
  if (!d) return false;
  started = d.started;
  banked = d.seconds;
  track = d.track;
  const markers: Marker[] = [];
  for (const text of lines) {
    try { const row = JSON.parse(text); if (row?.m && typeof row.m.lat === 'number') markers.push(row.m); } catch { /* a line cut short */ }
  }
  const line = d.follow ? decodePolyline(d.follow.line) : null;
  batch(() => {
    recStarted.value = started;
    recSegments.value = track.segments;
    recLength.value = track.length;
    recSeconds.value = d.seconds;
    recMarkers.value = markers;
    recState.value = live ? 'recording' : 'paused';
    following.value = d.follow && line
      ? { region: d.follow.region, id: d.follow.id, name: d.follow.name, path: line, profile: null, loop: isLoopLine(line, progressOn(line, line[0]).total) }
      : null;
  });
  startFollowing(following.peek());
  if (live) {
    // the clock carries on from the last point written: the time in between was spent walking
    const last = lastPoint(track);
    since = last ? last.t : Date.now();
    startTicker();
    tick();
  }
  return true;
}

/** At launch: a recording that was running comes back running (the service never stopped), or paused. */
export async function restoreDraft(): Promise<void> {
  if (restored) return;
  restored = true;
  const lines = await platform.documents.readLog(LOG);
  const live = !!platform.keyValue.get(LIVE) && (await recordingRunning());
  if (!(await restoreFrom(lines, live))) return;
  if (live) attachRecording(onFix, onProblem);
  else {
    platform.keyValue.remove(LIVE);
    say('Your recording was kept. It is paused.');
  }
}

// Fixes delivered while the screens were not running: rebuild from the log first, then carry on.
let headlessQueue: Promise<void> = Promise.resolve();
setHeadlessRecorder((fixes) => {
  headlessQueue = headlessQueue.then(async () => {
    if (!restored) {
      restored = true;
      const lines = await platform.documents.readLog(LOG);
      if (!(await restoreFrom(lines, true))) return;
    }
    attachRecording(onFix, onProblem);
    for (const f of fixes) onFix(f);
  }).catch(() => {});
});
