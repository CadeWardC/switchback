// Recording a walk. Fixes come from the device (platform.location); points worse than 50 m are dropped.
// A recording in progress is kept on the device as it goes, so a reload or a closed tab does not lose it.
import { batch } from '@preact/signals';
import { platform, type Fix, type LocationProblem } from './platform';
import { recAccuracy, recError, recLength, recSeconds, recSegments, recState, recWakeLock, walks } from './state';
import { load, newId, save, type Walk, type WalkPoint } from './lib/storage';
import { distance } from './lib/geo';
import { myLocation } from './map/map';

export const MAX_ACCURACY = 50;
/** Smaller moves than this are GPS wobble while standing still. */
const MIN_STEP = 3;

interface Draft { started: number; seconds: number; segments: WalkPoint[][] }

let started = 0;
/** Seconds recorded before the current stretch, and when the current stretch began. */
let banked = 0;
let since = 0;
let ticker: ReturnType<typeof setInterval> | undefined;
let unsaved = 0;

const PROBLEMS: Record<LocationProblem, string> = {
  denied: 'Location is turned off for this site. Allow it in your browser or phone settings, then try again.',
  unavailable: "Your position can't be found right now. Recording continues when it comes back.",
  unsupported: "This browser can't share your location, so walks can't be recorded here.",
};

function lengthOf(segments: WalkPoint[][]): number {
  let d = 0;
  for (const s of segments) for (let i = 1; i < s.length; i++) d += distance([s[i - 1].lat, s[i - 1].lon], [s[i].lat, s[i].lon]);
  return d;
}

function keepDraft(): void {
  unsaved = 0;
  save('recording', { started, seconds: recSeconds.peek(), segments: recSegments.peek() } satisfies Draft);
}

function onFix(fix: Fix): void {
  recAccuracy.value = fix.accuracy;
  recError.value = null;
  myLocation.value = { at: [fix.lat, fix.lon], accuracy: fix.accuracy };
  if (recState.peek() !== 'recording' || !(fix.accuracy <= MAX_ACCURACY)) return;
  const segments = recSegments.peek();
  const current = segments[segments.length - 1] ?? [];
  const last = current[current.length - 1];
  const p: WalkPoint = { lat: fix.lat, lon: fix.lon, ele: fix.ele, t: fix.time, acc: Math.round(fix.accuracy) };
  if (last) {
    const step = distance([last.lat, last.lon], [p.lat, p.lon]);
    if (step < MIN_STEP) return;
    recLength.value = recLength.peek() + step;
  }
  recSegments.value = [...segments.slice(0, -1), [...current, p]];
  if (++unsaved >= 5) keepDraft();
}

function onProblem(p: LocationProblem): void {
  recError.value = PROBLEMS[p];
  if (p !== 'unavailable') void pause();
}

function tick(): void {
  recSeconds.value = banked + (Date.now() - since) / 1000;
}

async function run(): Promise<void> {
  since = Date.now();
  clearInterval(ticker);
  ticker = setInterval(tick, 1000);
  recState.value = 'recording';
  recWakeLock.value = (await platform.keepAwake.on()) ? 'on' : platform.location.recordsInBackground ? 'off' : 'unsupported';
  await platform.location.startRecording(onFix, onProblem);
}

export async function start(): Promise<void> {
  batch(() => {
    recSegments.value = [[]];
    recLength.value = 0;
    recSeconds.value = 0;
    recError.value = null;
  });
  started = Date.now();
  banked = 0;
  platform.haptics.tap();
  await run();
}

export async function pause(): Promise<void> {
  if (recState.peek() !== 'recording') return;
  tick();
  banked = recSeconds.peek();
  clearInterval(ticker);
  recState.value = 'paused';
  keepDraft();
  await platform.location.stopRecording();
  await platform.keepAwake.off();
  recWakeLock.value = 'off';
}

export async function resume(): Promise<void> {
  if (recState.peek() !== 'paused') return;
  // a new stretch, so the pause is not drawn as a straight line
  const segments = recSegments.peek();
  if (segments[segments.length - 1]?.length) recSegments.value = [...segments, []];
  recError.value = null;
  platform.haptics.tap();
  await run();
}

function reset(): void {
  clearInterval(ticker);
  platform.keyValue.remove('recording');
  batch(() => {
    recState.value = 'idle';
    recSegments.value = [];
    recLength.value = 0;
    recSeconds.value = 0;
    recAccuracy.value = null;
  });
}

/** Stops and keeps the walk. Returns it, or null when there was nothing to keep. */
export async function finish(): Promise<Walk | null> {
  await pause();
  const segments = recSegments.peek().filter((s) => s.length > 0);
  const points = segments.flat();
  if (points.length < 2) {
    reset();
    return null;
  }
  const when = new Date(started);
  const part = when.getHours() < 12 ? 'Morning' : when.getHours() < 17 ? 'Afternoon' : 'Evening';
  const walk: Walk = {
    id: newId(), name: `${part} walk`, started, ended: points[points.length - 1].t,
    seconds: Math.round(recSeconds.peek()), length: lengthOf(segments), segments,
  };
  walks.value = [walk, ...walks.peek()];
  platform.haptics.success();
  reset();
  return walk;
}

export async function discard(): Promise<void> {
  await pause();
  reset();
}

/** A recording that was running when the page closed comes back paused. */
export function restoreDraft(): void {
  const d = load<Draft | null>('recording', null);
  if (!d || !Array.isArray(d.segments) || !d.segments.some((s) => s.length)) return;
  started = d.started;
  banked = d.seconds;
  batch(() => {
    recSegments.value = d.segments;
    recLength.value = lengthOf(d.segments);
    recSeconds.value = d.seconds;
    recState.value = 'paused';
  });
}
