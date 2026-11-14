// Following a trail: where you are along it, what is left, and when the sun sets. No network, no browser.
import type { Coord } from './polyline';
import { heightAt, type Profile } from './trail';

const rad = Math.PI / 180;

export interface Progress {
  /** Metres from the start of the line to the nearest point on it. */
  along: number;
  /** Metres from you to that point. */
  off: number;
  total: number;
  /** That point. */
  point: Coord;
}

/** The nearest point on a line to a place. `after` (metres): on a loop or an out-and-back, prefer a point
 *  not far behind where you were last, so the start and the end of a loop are not confused. */
export function progressOn(path: Coord[], c: Coord, after = -Infinity): Progress {
  const k = Math.cos(c[0] * rad), mLat = 111_320, mLon = 111_320 * k;
  let best = { along: 0, off: Infinity, point: path[0] }, bestScore = Infinity;
  let run = 0;
  let ax = (path[0][1] - c[1]) * mLon, ay = (path[0][0] - c[0]) * mLat;
  for (let i = 1; i < path.length; i++) {
    const bx = (path[i][1] - c[1]) * mLon, by = (path[i][0] - c[0]) * mLat;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, len = Math.sqrt(len2);
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + t * dx, ay + t * dy), along = run + t * len;
    // going back along the line costs a little, so of two places equally near, the one ahead wins
    const score = off + (along < after - 30 ? 25 + (after - along) * 0.02 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = { along, off, point: [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * t, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * t] };
    }
    run += len;
    ax = bx;
    ay = by;
  }
  if (path.length === 1) best = { along: 0, off: Math.hypot(ax, ay), point: path[0] };
  return { ...best, total: run };
}

/** The climbing still to do from a distance along a profile (wiggles under 2 m ignored). */
export function climbLeft(p: Profile, from: number): number {
  const total = p.distances[p.distances.length - 1] ?? 0;
  if (from >= total) return 0;
  let ref = heightAt(p, from), gain = 0;
  p.distances.forEach((d, i) => {
    if (d <= from) return;
    const e = p.elevations[i];
    if (e - ref >= 2) { gain += e - ref; ref = e; } else if (ref - e >= 2) ref = e;
  });
  // the stored total comes from finer samples than the chart points: keep the two in step
  const whole = climbLeftRaw(p);
  return whole > 0 ? Math.min(p.gain, gain * (p.gain / whole)) : gain;
}

function climbLeftRaw(p: Profile): number {
  let ref = p.elevations[0] ?? 0, gain = 0;
  for (const e of p.elevations) { if (e - ref >= 2) { gain += e - ref; ref = e; } else if (ref - e >= 2) ref = e; }
  return gain;
}

/** Seconds to cover what is left: at your own pace once you have walked a little, else an easy 4.5 km/h;
 *  plus an hour for every 600 m still to climb. */
export function secondsLeft(metresLeft: number, climb: number, walked: number, seconds: number): number {
  const own = walked > 300 && seconds > 120 ? walked / seconds : 0;
  const speed = own > 0.3 && own < 3 ? own : 4500 / 3600;
  return metresLeft / speed + (climb / 600) * 3600;
}

/** Today's sunrise and sunset at a place (the standard almanac formula), or null in polar day or night. */
export function sunTimes(date: Date, at: Coord): { sunrise: Date; sunset: Date } | null {
  const event = (rising: boolean): Date | null => {
    const startOfYear = new Date(date.getFullYear(), 0, 0);
    const n = Math.floor((new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() - startOfYear.getTime()) / 86_400_000 + 0.5);
    const lngHour = at[1] / 15;
    const t = n + ((rising ? 6 : 18) - lngHour) / 24;
    const m = 0.9856 * t - 3.289;
    let l = (m + 1.916 * Math.sin(m * rad) + 0.02 * Math.sin(2 * m * rad) + 282.634) % 360;
    if (l < 0) l += 360;
    let ra = (Math.atan(0.91764 * Math.tan(l * rad)) / rad) % 360;
    if (ra < 0) ra += 360;
    ra += Math.floor(l / 90) * 90 - Math.floor(ra / 90) * 90;
    ra /= 15;
    const sinDec = 0.39782 * Math.sin(l * rad), cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(at[0] * rad)) / (cosDec * Math.cos(at[0] * rad));
    if (cosH < -1 || cosH > 1) return null;
    const h = (rising ? 360 - Math.acos(cosH) / rad : Math.acos(cosH) / rad) / 15;
    let ut = (h + ra - 0.06571 * t - 6.622 - lngHour) % 24;
    if (ut < 0) ut += 24;
    let result = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) + ut * 3_600_000;
    // keep it within the local day asked for (west of Greenwich, evening UTC times fall on the next day)
    const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
    while (result - noon > 12 * 3_600_000) result -= 86_400_000;
    while (noon - result > 12 * 3_600_000) result += 86_400_000;
    return new Date(result);
  };
  const sunrise = event(true), sunset = event(false);
  return sunrise && sunset ? { sunrise, sunset } : null;
}

// ── Which way back to the trail ───────────────────────────────────────────────────────────────────────
/** The compass bearing from one place to another, degrees from north. */
export function bearing(from: Coord, to: Coord): number {
  const y = Math.sin((to[1] - from[1]) * rad) * Math.cos(to[0] * rad);
  const x = Math.cos(from[0] * rad) * Math.sin(to[0] * rad) - Math.sin(from[0] * rad) * Math.cos(to[0] * rad) * Math.cos((to[1] - from[1]) * rad);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/** "to your right", "ahead of you"… relative to the way you are going; a compass word when that is not known. */
export function whichWay(from: Coord, to: Coord, heading: number | null): string {
  const b = bearing(from, to);
  if (heading == null || !Number.isFinite(heading)) return `to the ${COMPASS[Math.round(b / 45) % 8]}`;
  const turn = ((b - heading + 540) % 360) - 180; // -180..180, positive to the right
  if (Math.abs(turn) <= 35) return 'ahead of you';
  if (Math.abs(turn) >= 145) return 'behind you';
  return turn > 0 ? 'to your right' : 'to your left';
}

// ── Reaching the end ──────────────────────────────────────────────────────────────────────────────────
/** Near enough (metres) to the start or the end to count as there. */
export const ARRIVE_WITHIN = 35;

export interface EndWatch {
  /** Metres walked since the hike began, or since the last time the question was asked. */
  walked: number;
  last: Coord | null;
  /** How many times the question has been asked. */
  asked: number;
  /** Has been well away from the trail's ends since the hike began or the question was last asked. */
  away: boolean;
}

export const newEndWatch = (): EndWatch => ({ walked: 0, last: null, asked: 0, away: false });

/**
 * Feed it each recorded point while a trail is followed. It says when to ask "finish this hike?":
 *   - a loop: back at its start after most of it has been walked (passing near the start early on,
 *     as loops often do in their first stretch, does not count);
 *   - a one-way trail: at its far end; or back at its start after walking out and back.
 * After it has asked, it stays quiet until another long stretch has been walked away from the ends.
 */
export function watchEnd(w: EndWatch, at: Coord, path: Coord[], total: number, isLoop: boolean): { watch: EndWatch; ask: 'start' | 'end' | null } {
  const step = w.last ? distanceFlat(w.last, at) : 0;
  const watch: EndWatch = { ...w, walked: w.walked + step, last: at };
  const start = path[0], end = path[path.length - 1];
  const toStart = distanceFlat(at, start), toEnd = distanceFlat(at, end);
  if (Math.min(toStart, toEnd) > Math.max(120, ARRIVE_WITHIN * 3)) watch.away = true;
  // how much must be walked before arriving means anything
  const enough = watch.asked === 0 ? total * (isLoop ? 0.7 : 0.6) : Math.max(300, total * 0.5);
  if (!watch.away || watch.walked < enough) return { watch, ask: null };
  let ask: 'start' | 'end' | null = null;
  if (isLoop) {
    if (toStart <= ARRIVE_WITHIN) ask = 'start';
  } else if (toEnd <= ARRIVE_WITHIN) ask = 'end';
  else if (toStart <= ARRIVE_WITHIN && (watch.asked > 0 || watch.walked >= total * 1.5)) ask = 'start';
  if (!ask) return { watch, ask: null };
  return { watch: { walked: 0, last: at, asked: watch.asked + 1, away: false }, ask };
}

function distanceFlat(a: Coord, b: Coord): number {
  const k = Math.cos(a[0] * rad);
  return Math.hypot((b[0] - a[0]) * 111_320, (b[1] - a[1]) * 111_320 * k);
}

// ── The things on the way, for the ridge ──────────────────────────────────────────────────────────────
export interface Stop {
  /** A short name: "Creek", "High point", "Overlook", "Short loop". */
  name: string;
  /** Metres from the start. */
  along: number;
  /** Lower comes first when there is not room for all. */
  rank: number;
}

/** At most `max` stops, none closer together than `gap` (a share of the whole length), in order along the trail. */
export function pickStops(stops: Stop[], total: number, max = 5, gap = 0.13): Stop[] {
  const out: Stop[] = [];
  for (const s of stops.slice().sort((a, b) => a.rank - b.rank || a.along - b.along)) {
    if (out.length >= max) break;
    if (s.along < total * 0.04 || s.along > total * 0.97) continue; // on top of the start or the end
    if (out.some((o) => Math.abs(o.along - s.along) < total * gap)) continue;
    out.push(s);
  }
  return out.sort((a, b) => a.along - b.along);
}

/** The next stop ahead of a distance along the trail. */
export function nextStop(stops: Stop[], along: number): Stop | null {
  return stops.find((s) => s.along > along + 15) ?? null;
}
