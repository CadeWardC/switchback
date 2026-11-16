// The hiking totals of the Log kept on this phone (its owner's): for a year or for all time. Plain functions, tested in
// test/core.test.ts.
import type { WalkSummary } from '@web/lib/storage';

export interface Totals {
  hikes: number;
  /** Metres walked. */
  length: number;
  /** Metres climbed. */
  gain: number;
  /** Seconds spent hiking (pauses left out). */
  seconds: number;
  /** Days with at least one hike. */
  days: number;
  longest: WalkSummary | null;
  /** The hike with the most climbing (null when none climbed anything). */
  steepest: WalkSummary | null;
  /** How many different trails were followed. */
  trails: number;
  /** The trail followed most often, when one was followed more than once. */
  favourite: { name: string; times: number } | null;
}

/** The hikes of a year; `year` null is all time. */
export function hikesOf(walks: WalkSummary[], year: number | null): WalkSummary[] {
  return walks.filter((w) => year == null || new Date(w.started).getFullYear() === year);
}

export function totals(walks: WalkSummary[]): Totals {
  const byTrail = new Map<string, { name: string; times: number }>();
  const days = new Set<string>();
  let longest: WalkSummary | null = null, steepest: WalkSummary | null = null;
  let length = 0, gain = 0, seconds = 0;
  for (const w of walks) {
    length += w.length;
    gain += w.gain ?? 0;
    seconds += w.seconds;
    const d = new Date(w.started);
    days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
    if (!longest || w.length > longest.length) longest = w;
    if ((w.gain ?? 0) > (steepest?.gain ?? 0)) steepest = w;
    if (w.trail) {
      const key = `${w.trail.region}/${w.trail.id}`;
      const t = byTrail.get(key) ?? { name: w.trail.name, times: 0 };
      t.times++;
      byTrail.set(key, t);
    }
  }
  const top = [...byTrail.values()].sort((a, b) => b.times - a.times)[0];
  return { hikes: walks.length, length, gain, seconds, days: days.size, longest, steepest, trails: byTrail.size, favourite: top && top.times > 1 ? top : null };
}

/** The years that have hikes, newest first, always with this year. */
export function yearsOf(walks: WalkSummary[], now: Date): number[] {
  const ys = new Set<number>([now.getFullYear()]);
  for (const w of walks) ys.add(new Date(w.started).getFullYear());
  return [...ys].sort((a, b) => b - a);
}

const TALL: [string, number][] = [
  ['Mount Everest', 8849], ['the Grand Canyon', 1800], ['El Capitan', 900], ['the Empire State Building', 443],
  ['the Eiffel Tower', 330], ['the Gateway Arch', 192], ['the Statue of Liberty', 93],
];

/** The climbing as something tall: "2.3 times up the Eiffel Tower". Null when there is too little to say. */
export function climbAs(gain: number): string | null {
  const hit = TALL.find(([, h]) => gain >= h);
  if (!hit) return null;
  const times = gain / hit[1];
  return times < 1.15 ? `once up ${hit[0]}` : `${times >= 10 ? Math.round(times) : times.toFixed(1).replace(/\.0$/, '')} times up ${hit[0]}`;
}
