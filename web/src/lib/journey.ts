// The hike as it is actually walked, which is not always the trail from its first point to its last: you may
// join a trail in the middle, walk to an end and come back; turn round early; or walk on past where you began.
// This keeps track of where you joined the line and which way you are going, and says what is still to walk.
// No network, no browser. Fed one position along the line at a time (see progressOn in follow.ts).
import { ARRIVE_WITHIN } from './follow';
import { heightAt, type Profile } from './trail';

/** Joining a line further than this (metres) from both its ends counts as joining it in the middle. */
export const MID_START = 150;
/** This far (metres) along the line from where you joined, the way you are walking is known. */
const DIRECTION_AFTER = 25;
/** Coming back this far (metres) from the furthest point reached counts as turning round. */
const TURNED_AFTER = 30;
/** Further than this (metres) from where you joined counts as having been away from it. */
const AWAY = 120;

export interface Journey {
  /** Metres along the line where the hike joined it. */
  origin: number;
  /** Joined well away from both ends: the hike is out to an end and back to here. */
  mid: boolean;
  /** Where you are now, metres along the line. */
  along: number;
  /** Metres gone from where you joined, along the line: positive towards its end, negative towards its
   *  start. On a loop it keeps counting round. */
  gone: number;
  /** The way you are walking: 1 towards the end of the line, -1 towards its start. */
  dir: 1 | -1;
  /** The direction has been seen from your own movement (before that it is a guess). */
  sure: boolean;
  /** The furthest `gone` in the direction being walked. */
  far: number;
  /** Has been well away from where you joined, since joining or since the question was last asked. */
  away: boolean;
}

/** What is still to walk. */
export interface Plan {
  /** Metres. */
  left: number;
  /** Stretches of the line still to walk, in order, as [from, to] in metres along it (to < from: walked
   *  against the line). */
  legs: [number, number][];
  /** 'onward': on to the end of the line (or round the loop). 'out-back': to the end ahead and back to
   *  where you joined. 'home': back to where you joined. */
  kind: 'onward' | 'out-back' | 'home';
}

/**
 * Feed it your position along the line each time you are on it. `ask` is true when you have come back to
 * where you joined the line in the middle, after being away: the moment to ask "finish this hike?".
 * (A hike begun at an end of the line is asked about by watchEnd in follow.ts instead.)
 */
export function stepJourney(j: Journey | null, along: number, total: number, loop: boolean): { journey: Journey; ask: boolean } {
  if (!j) {
    const mid = Math.min(along, total - along) > MID_START;
    // not seen yet: towards the end of the line, or away from the end you began at
    const dir = loop || mid || along < total / 2 ? 1 : -1;
    return { journey: { origin: along, mid, along, gone: 0, dir, sure: false, far: 0, away: false }, ask: false };
  }
  let step = along - j.along;
  // across the join of a loop, the short way
  if (loop && total > 0) step -= Math.round(step / total) * total;
  const next: Journey = { ...j, along, gone: j.gone + step };
  if (!next.sure) {
    if (Math.abs(next.gone) >= DIRECTION_AFTER) {
      next.dir = next.gone > 0 ? 1 : -1;
      next.sure = true;
      next.far = next.gone;
    }
  } else if ((next.gone - next.far) * next.dir > 0) next.far = next.gone;
  else if ((next.far - next.gone) * next.dir >= TURNED_AFTER) {
    next.dir = next.dir > 0 ? -1 : 1;
    next.far = next.gone;
  }
  const home = fromHome(next, total, loop);
  if (home > AWAY) next.away = true;
  if (!next.mid || !next.away || home > ARRIVE_WITHIN) return { journey: next, ask: false };
  // back where you joined: a lap of a loop starts again from nothing
  if (loop && total > 0) next.gone -= Math.round(next.gone / total) * total;
  next.far = next.gone;
  next.away = false;
  return { journey: next, ask: true };
}

/** Metres along the line between you and where you joined it (the short way round a loop). */
function fromHome(j: Journey, total: number, loop: boolean): number {
  const g = Math.abs(j.gone);
  if (!loop || total <= 0) return g;
  const r = g % total;
  return Math.min(r, total - r);
}

/** What is still to walk, from where you are and the way you are going. */
export function planOf(j: Journey, total: number, loop: boolean): Plan {
  const headingHome = j.sure && j.gone !== 0 && (j.gone > 0 ? 1 : -1) !== j.dir;
  let legs: [number, number][];
  let kind: Plan['kind'];
  if (loop) {
    const g = total > 0 ? Math.abs(j.gone) % total : 0;
    // on round the loop to where you joined, or back the way you came
    legs = round(j.along, j.dir, headingHome ? g : total - g, total);
    kind = headingHome ? 'home' : 'onward';
  } else if (headingHome) {
    legs = [[j.along, j.origin]];
    kind = 'home';
  } else {
    const end = j.dir > 0 ? total : 0;
    legs = [[j.along, end]];
    if (j.mid) legs.push([end, j.origin]);
    kind = j.mid ? 'out-back' : 'onward';
  }
  legs = legs.filter(([a, b]) => a !== b);
  return { left: legs.reduce((n, [a, b]) => n + Math.abs(b - a), 0), legs, kind };
}

/** `metres` of a loop from `from`, the way `dir` goes, as stretches that do not cross its join. */
function round(from: number, dir: 1 | -1, metres: number, total: number): [number, number][] {
  const legs: [number, number][] = [];
  let at = from, left = Math.max(0, Math.min(metres, total));
  while (left > 0.01) {
    if (dir > 0 && at >= total) at = 0;
    if (dir < 0 && at <= 0) at = total;
    const to = dir > 0 ? Math.min(total, at + left) : Math.max(0, at - left);
    legs.push([at, to]);
    left -= Math.abs(to - at);
    at = to;
  }
  return legs;
}

/** The climbing walking a profile from one distance to another (wiggles under 2 m ignored); `to` before
 *  `from` is the profile walked backwards, where its descents are the climbs. */
export function climbBetween(p: Profile, from: number, to: number): number {
  if (p.distances.length < 2 || from === to) return 0;
  const lo = Math.min(from, to), hi = Math.max(from, to);
  const heights = [heightAt(p, lo)];
  p.distances.forEach((d, i) => { if (d > lo && d < hi) heights.push(p.elevations[i]); });
  heights.push(heightAt(p, hi));
  const forward = to > from;
  if (!forward) heights.reverse();
  // the stored totals come from finer samples than the chart points: keep the two in step
  const whole = forward ? p.elevations : p.elevations.slice().reverse();
  const all = ups(whole), stored = forward ? p.gain : p.loss;
  const gain = ups(heights);
  return all > 0 && stored > 0 ? Math.min(stored, gain * (stored / all)) : gain;
}

function ups(heights: number[]): number {
  let ref = heights[0] ?? 0, gain = 0;
  for (const e of heights) { if (e - ref >= 2) { gain += e - ref; ref = e; } else if (ref - e >= 2) ref = e; }
  return gain;
}

/** The climbing over what is still to walk. `total`: the length of the line the plan is measured on (the
 *  profile may be measured a little differently). */
export function climbOver(p: Profile, plan: Plan, total: number): number {
  const chart = p.distances[p.distances.length - 1] ?? 0;
  if (total <= 0 || chart <= 0) return 0;
  const k = chart / total;
  return plan.legs.reduce((n, [a, b]) => n + climbBetween(p, a * k, b * k), 0);
}
