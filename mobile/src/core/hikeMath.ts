// Small sums for the hike and trail screens (from web/src/ui/Record.tsx and TrailPage.tsx, which are Preact
// files). Plain functions, tested in test/hikeMath.test.ts.
import { profileOf, type Profile, type Trail } from '@web/lib/trail';
import type { WalkPoint } from '@web/lib/storage';
import type { Coord } from '@web/lib/polyline';
import { distance } from '@web/lib/geo';
import { progressOn, secondsLeft } from '@web/lib/follow';
import { climbOver, planOf, type Journey, type Plan } from '@web/lib/journey';

const lengths = new WeakMap<Coord[], number>();
/** The length of a line, in metres (worked out once for each line). */
export function lineLength(path: Coord[]): number {
  let n = lengths.get(path);
  if (n == null) {
    n = path.length > 1 ? progressOn(path, path[0]).total : 0;
    lengths.set(path, n);
  }
  return n;
}

export interface HikeNumbers {
  /** Metres still to walk. */
  left: number;
  /** What `left` is: on to the end, to the end and back to where you joined, or back to where you joined. */
  kind: Plan['kind'];
  /** Metres still to climb on the way. */
  climbAhead: number;
  /** When you would be done, at your own pace. */
  back: Date;
}

/** What is left of a hike that follows a trail, for the hike screen and the lock screen. `j`: null until
 *  you are on the trail (then it is the whole trail). */
export function hikeNumbers(
  f: { path: Coord[]; profile: Profile | null; loop?: boolean }, j: Journey | null, walked: number, seconds: number, now: Date,
): HikeNumbers {
  const total = lineLength(f.path);
  const plan: Plan = j ? planOf(j, total, !!f.loop) : { left: total, legs: [[0, total]], kind: 'onward' };
  const climbAhead = f.profile ? climbOver(f.profile, plan, total) : 0;
  return { left: plan.left, kind: plan.kind, climbAhead, back: new Date(now.getTime() + secondsLeft(plan.left, climbAhead, walked, seconds) * 1000) };
}

/** The words under the distance left. */
export const leftLabel = (kind: Plan['kind']) => (kind === 'out-back' ? 'Left, out and back' : kind === 'home' ? 'Back to your start' : 'Left');

/** A clock time without AM/PM ("2:48"). */
export const clock = (d: Date) => {
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** Minutes as "2 h 05" or "40 min". */
export const hm = (minutes: number) => {
  const m = Math.max(0, Math.round(minutes));
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}` : `${m} min`;
};

/** Minutes, short: "2 h 10", "45 min". */
export const dur = (min: number) => {
  const m = Math.round(Math.abs(min));
  return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}` : `${m} min`;
};

/** Pace as minutes per mile or kilometre ("28:30"), or a dash before there is enough to say. */
export function pace(seconds: number, metres: number, imperial: boolean): string {
  if (metres < 50 || seconds < 10) return '–';
  const per = seconds / (metres / (imperial ? 1609.344 : 1000));
  if (per > 5999) return '–';
  const m = Math.floor(per / 60), s = Math.round(per % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

/** How fast you are going right now, in metres a second, from the newest recorded points (about the last
 *  20 seconds of walking). Standing still adds no points, so nothing new for a while is 0. null before
 *  there is anything to go by. */
export function speedNow(segments: WalkPoint[][], now: number, span = 20_000, still = 12_000): number | null {
  const s = segments[segments.length - 1];
  if (!s || s.length < 2) return null;
  const newest = s[s.length - 1];
  if (now - newest.t > still) return 0;
  let metres = 0, i = s.length - 1;
  while (i > 0 && (i === s.length - 1 || newest.t - s[i - 1].t <= span)) {
    metres += distance([s[i - 1].lat, s[i - 1].lon], [s[i].lat, s[i].lon]);
    i--;
  }
  const seconds = (newest.t - s[i].t) / 1000;
  return seconds > 0 ? metres / seconds : null;
}

/** A speed as miles or kilometres an hour ("2.8"), or a dash when there is none to give. */
export function speed(metresPerSecond: number | null, imperial: boolean): string {
  if (metresPerSecond == null || !Number.isFinite(metresPerSecond) || metresPerSecond < 0) return '–';
  return (metresPerSecond * 3600 / (imperial ? 1609.344 : 1000)).toFixed(1);
}

/** The average speed over a distance, as miles or kilometres an hour, or a dash before there is enough to say. */
export const averageSpeed = (seconds: number, metres: number, imperial: boolean) =>
  (metres < 50 || seconds < 10 ? '–' : speed(metres / seconds, imperial));

/** What has been climbed so far, from the heights the phone gave (smoothed: phone heights jump about). */
export function climbedSoFar(segments: WalkPoint[][]): number | null {
  const es = segments.flat().map((p) => p.ele).filter((e): e is number => e != null);
  if (es.length < 10) return null;
  const smooth = es.map((_, i) => { const a = es.slice(Math.max(0, i - 2), i + 3); return a.reduce((x, y) => x + y, 0) / a.length; });
  return profileOf(smooth.map((_, i) => i), smooth, 5).gain;
}

/** The time at an easy pace for the big number: "1:45" h, or "40" min. */
export function bigTime(seconds: number): { value: string; unit: string } {
  return seconds >= 3600
    ? { value: `${Math.floor(seconds / 3600)}:${String(Math.round((seconds % 3600) / 60)).padStart(2, '0')}`.replace(/:60$/, ':59'), unit: 'h' }
    : { value: String(Math.max(1, Math.round(seconds / 60))), unit: 'min' };
}

/** The daylight line: how much of the bar the hike takes, how much light is left, and whether it ends late. */
export function daylight(now: Date, back: Date, sunset: Date | null): { share: number; spareMin: number; late: boolean; dark: boolean } | null {
  if (!sunset) return null;
  const spareMin = (sunset.getTime() - back.getTime()) / 60000;
  const span = Math.max(sunset.getTime() + 20 * 60000, back.getTime()) - now.getTime();
  const share = Math.max(0.04, Math.min(1, (back.getTime() - now.getTime()) / Math.max(1, span)));
  return { share, spareMin, late: spareMin < 0, dark: now.getTime() >= sunset.getTime() };
}

/** Groups keep the order their first trail has in the sorted list (web/src/ui/Explore.tsx). */
export function grouped(trails: Trail[]): { area: string; trails: Trail[] }[] {
  const groups = new Map<string, Trail[]>();
  for (const t of trails) {
    const system = t.tags['switchback:system'];
    const area = system ? `${system} (trail system)` : t.area ?? 'Other trails';
    const g = groups.get(area);
    if (g) g.push(t);
    else groups.set(area, [t]);
  }
  return [...groups].map(([area, ts]) => ({ area, trails: ts }));
}
