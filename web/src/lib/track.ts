// The rules for turning location fixes into a recorded line. No browser needed, so they can be tested.
// Fixes carry their own time: they may arrive late and several at once (the page was asleep while the
// phone's location service kept going), so nothing here looks at the clock.
import { distance } from './geo';
import type { WalkPoint } from './storage';

/** Fixes that may be further off than this (metres) are left out. */
export const MAX_ACCURACY = 50;
/** Smaller moves than this are GPS wobble while standing still. */
export const MIN_STEP = 3;
/** A gap this long between two fixes is not drawn as a straight line: a new stretch starts instead. */
export const MAX_JUMP = 150;

export interface TrackFix { lat: number; lon: number; ele: number | null; accuracy: number; time: number }

export interface Track {
  /** One list per stretch (a pause, or a gap in the fixes, starts a new one). */
  segments: WalkPoint[][];
  length: number;
}

export type FixResult =
  | { kept: false; why: 'rough' | 'old' | 'still' }
  | { kept: true; point: WalkPoint; newStretch: boolean; track: Track };

export const emptyTrack = (): Track => ({ segments: [[]], length: 0 });

export function lastPoint(track: Track): WalkPoint | null {
  for (let i = track.segments.length - 1; i >= 0; i--) {
    const s = track.segments[i];
    if (s.length) return s[s.length - 1];
  }
  return null;
}

/**
 * Adds a fix to a track, or says why it was left out.
 * `notBefore`: fixes older than this (ms) belong to before the recording started or resumed.
 */
export function addFix(track: Track, fix: TrackFix, notBefore = 0): FixResult {
  if (!(fix.accuracy <= MAX_ACCURACY)) return { kept: false, why: 'rough' };
  const last = lastPoint(track);
  // late or repeated fixes: a batch can overlap what already arrived
  if (fix.time < notBefore || (last && fix.time <= last.t)) return { kept: false, why: 'old' };
  const point: WalkPoint = { lat: fix.lat, lon: fix.lon, ele: fix.ele, t: fix.time, acc: Math.round(fix.accuracy) };
  const segments = track.segments.length ? track.segments.slice() : [[]];
  const current = segments[segments.length - 1];
  const prev = current[current.length - 1];
  if (!prev) {
    segments[segments.length - 1] = [point];
    return { kept: true, point, newStretch: false, track: { segments, length: track.length } };
  }
  const step = distance([prev.lat, prev.lon], [point.lat, point.lon]);
  if (step < MIN_STEP) return { kept: false, why: 'still' };
  if (step > MAX_JUMP) {
    segments.push([point]);
    return { kept: true, point, newStretch: true, track: { segments, length: track.length } };
  }
  segments[segments.length - 1] = [...current, point];
  return { kept: true, point, newStretch: false, track: { segments, length: track.length + step } };
}

/** Starts a new stretch (after a pause), unless the current one is still empty. */
export function newStretch(track: Track): Track {
  const last = track.segments[track.segments.length - 1];
  return last && last.length ? { segments: [...track.segments, []], length: track.length } : track;
}

export function trackLength(segments: WalkPoint[][]): number {
  let d = 0;
  for (const s of segments) for (let i = 1; i < s.length; i++) d += distance([s[i - 1].lat, s[i - 1].lon], [s[i].lat, s[i].lon]);
  return d;
}

// ── A recording as it is kept on the device while it runs: one line of JSON per event ────────────────
export type LogLine =
  | { start: number; follow?: { region: string; id: string; name: string; line: string } }
  | { p: WalkPoint; s: number }
  | { gap: true }
  | { s: number };

export interface Restored {
  started: number;
  seconds: number;
  track: Track;
  follow?: { region: string; id: string; name: string; line: string };
}

/** Rebuilds a recording from its log. Broken lines (a write cut short) are skipped. */
export function restoreLog(lines: string[]): Restored | null {
  let started = 0, seconds = 0, follow: Restored['follow'];
  const segments: WalkPoint[][] = [[]];
  for (const text of lines) {
    let row: any;
    try { row = JSON.parse(text); } catch { continue; }
    if (!row || typeof row !== 'object') continue;
    if (typeof row.start === 'number') { started = row.start; follow = row.follow; }
    if (row.gap && segments[segments.length - 1].length) segments.push([]);
    if (row.p && typeof row.p.lat === 'number' && typeof row.p.lon === 'number' && typeof row.p.t === 'number') segments[segments.length - 1].push(row.p);
    if (typeof row.s === 'number' && row.s > seconds) seconds = row.s;
  }
  if (!started || !segments.some((s) => s.length)) return null;
  return { started, seconds, track: { segments, length: trackLength(segments) }, follow };
}
