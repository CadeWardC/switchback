// Small sums for the hike and trail screens (from web/src/ui/Record.tsx and TrailPage.tsx, which are Preact
// files). Plain functions, tested in test/hikeMath.test.ts.
import { profileOf, type Trail } from '@web/lib/trail';
import type { WalkPoint } from '@web/lib/storage';

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
