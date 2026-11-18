// The open trail as chosen to walk: the whole trail or one of its short loops, on its own or in from a
// trailhead; and what the map draws for that choice. Plain functions (tested in test/choice.test.ts) over the
// website's trail rules (shortLoops, shortened, accessPoints, hikeFrom in web/src/lib/trail.ts).
import { heightAt, hikeFrom, shortened, type Access, type Profile, type ShortLoop, type Trail } from '@web/lib/trail';
import { distance, distanceToLine } from '@web/lib/geo';
import type { Coord } from '@web/lib/polyline';

type FC = GeoJSON.FeatureCollection;

/** A walk-in must meet the route within this many metres; nothing longer is ever drawn as a straight join. */
export const MEET_WITHIN = 60;

/** The route as chosen before any walk in: one of the short loops, or the whole trail. */
export function baseRoute(whole: Trail, shorts: ShortLoop[], short: number): Trail {
  const loop = shorts[short];
  return loop ? shortened(whole, loop) : whole;
}

/** The route with the walk in from a trailhead, or null when the two do not meet: the walk-in line must end on
 *  the route, and the join the trail rules make (web/src/lib/trail.ts hikeFrom) must not jump across the map. */
function withWalkIn(base: Trail, head: Access): Trail | null {
  if (head.line.length < 2 || base.path.length < 2) return null;
  const end = head.line[head.line.length - 1];
  if (distanceToLine(end, base.path) > MEET_WITHIN) return null;
  const out = hikeFrom(base, head);
  if (out === base) return null;
  const n = head.line.length, m = out.path.length;
  // the steps where the pieces were joined: in, and (for a loop) back out
  if (m <= n || distance(out.path[n - 1], out.path[n]) > MEET_WITHIN) return null;
  if (base.isLoop && (m < 2 * n || distance(out.path[m - n - 1], out.path[m - n]) > MEET_WITHIN)) return null;
  return out;
}

/** Which starts can be used for a route: one with a walk-in that meets it, or one that is on it. */
export function usableStarts(base: Trail, heads: Access[]): boolean[] {
  return heads.map((h) => (h.line.length > 1 && h.distance >= 15 ? withWalkIn(base, h) != null : distanceToLine(h.point, base.path) <= MEET_WITHIN));
}

/** You are at a trailhead when within this many metres of it. */
export const AT_START = 400;
/** A start whose walk in is this much longer than the shortest is never picked for you (it can still be chosen). */
export const MUCH_LONGER = 300;

/** Where to start by default, of the usable starts: the one you are standing at, if any; else, of those with
 *  about the shortest walk in, the one nearest you (the list comes shortest walk first). A trailhead a mile
 *  down another trail is never picked just because it is on your side of the park. -1 when there is none:
 *  the trail on its own. */
export function defaultStart(heads: Access[], me: Coord | null, usable?: boolean[]): number {
  const ok = heads.map((_, i) => i).filter((i) => !usable || usable[i]);
  if (!ok.length) return -1;
  if (!me) return ok[0];
  const nearest = (among: number[]): [number, number] => {
    let best = among[0], bestD = Infinity;
    for (const i of among) { const d = distance(me, heads[i].point); if (d < bestD) { bestD = d; best = i; } }
    return [best, bestD];
  };
  const [at, atD] = nearest(ok);
  if (atD <= AT_START) return at;
  const shortest = Math.min(...ok.map((i) => heads[i].distance));
  const [best, bestD] = nearest(ok.filter((i) => heads[i].distance <= shortest + MUCH_LONGER));
  // far from all of them (looking at a trail in another state): the one nearest the trail
  return bestD < 80_000 ? best : ok[0];
}

// ── The elevation of a walk in plus a route, with no steps where they join ────────────────────────────
type Pts = [number, number][];
const totalOf = (p: Profile) => p.distances[p.distances.length - 1] ?? 0;

function between(p: Profile, a: number, b: number): Pts {
  if (!(b > a)) return [];
  const out: Pts = [[0, heightAt(p, a)]];
  p.distances.forEach((d, i) => { if (d > a && d < b) out.push([d - a, p.elevations[i]]); });
  out.push([b - a, heightAt(p, b)]);
  return out;
}
const whole = (p: Profile) => between(p, 0, totalOf(p));
const reversed = (pts: Pts): Pts => { const t = pts.length ? pts[pts.length - 1][0] : 0; return pts.slice().reverse().map(([d, e]) => [t - d, e]); };
const lifted = (pts: Pts, by: number): Pts => pts.map(([d, e]) => [d, e + by]);
const flat = (length: number, height: number): Pts => (length > 0 ? [[0, height], [length, height]] : []);

function strung(parts: Pts[], gain: number, loss: number): Profile {
  const distances: number[] = [], elevations: number[] = [];
  let offset = 0;
  for (const part of parts) {
    if (!part.length) continue;
    // (the first point of a later part is the same place as the last point of the one before)
    part.forEach(([d, e], i) => { if (i > 0 || !distances.length) { distances.push(offset + d); elevations.push(e); } });
    offset += part[part.length - 1][0];
  }
  return { distances, elevations, gain, loss, min: Math.min(...elevations), max: Math.max(...elevations) };
}

/** The profile of walking in from a trailhead and around (or along) a route. The route's own profile is kept as
 *  it is; the walk in is set at the height the route has where they meet, so there is never a cliff at the join.
 *  When the walk in has no heights of its own it is drawn level (`level`: true), and its climb is not known. */
export function joinedProfile(base: Trail, head: Access): { profile: Profile; level: boolean } | null {
  const p = base.profile;
  if (!p || p.distances.length < 2 || base.path.length < 2) return null;
  const join = head.line[head.line.length - 1];
  let i = 0, bd = Infinity, run = 0, at = 0;
  base.path.forEach((c, k) => {
    if (k > 0) run += distance(base.path[k - 1], c);
    const d = distance(c, join);
    if (d < bd) { bd = d; i = k; at = run; }
  });
  const total = totalOf(p);
  const along = run > 0 ? (at / run) * total : 0;
  const own = head.profile && head.profile.distances.length > 1 ? head.profile : null;
  const inPts = own ? whole(own) : flat(head.distance, 0);
  const inEnd = inPts.length ? inPts[inPts.length - 1][1] : 0;
  if (base.isLoop) {
    const route = i > 0 && along > 0 && along < total ? [...between(p, along, total), ...between(p, 0, along).slice(1).map(([d, e]) => [d + (total - along), e] as [number, number])] : whole(p);
    const meet = route[0][1];
    const walkIn = lifted(inPts, meet - inEnd);
    return { profile: strung([walkIn, route, reversed(walkIn)], p.gain + (own ? own.gain + own.loss : 0), p.loss + (own ? own.gain + own.loss : 0)), level: !own };
  }
  // one way: in to whichever end the walk in meets, then along the trail from there
  const flip = distance(base.path[base.path.length - 1], join) < distance(base.path[0], join);
  const route = flip ? reversed(whole(p)) : whole(p);
  const walkIn = lifted(inPts, route[0][1] - inEnd);
  return { profile: strung([walkIn, route], (flip ? p.loss : p.gain) + (own ? own.gain : 0), (flip ? p.gain : p.loss) + (own ? own.loss : 0)), level: !own };
}

export interface Chosen {
  /** The trail as it will be walked (its line, length and profile include a usable walk in). */
  trail: Trail;
  /** The route before the walk in. */
  base: Trail;
  /** True when the heights are the trail's own only (the walk in has none, or the trail has none to join to):
   *  the ridge then shows `base`, with a line saying so. */
  trailOnly: boolean;
}

/** The trail as chosen: a short loop of it (or the whole), then the walk in from a trailhead when the two
 *  truly meet. A start that does not meet the chosen route adds nothing (never a line across the map). */
export function choose(wholeTrail: Trail, shorts: ShortLoop[], short: number, heads: Access[], start: number): Chosen {
  const base = baseRoute(wholeTrail, shorts, short);
  const head = heads[start];
  const walked = head ? withWalkIn(base, head) : null;
  if (!head || !walked) return { trail: base, base, trailOnly: false };
  const joined = joinedProfile(base, head);
  if (!joined) return { trail: { ...walked, profile: null }, base, trailOnly: false };
  return { trail: { ...walked, profile: joined.profile }, base, trailOnly: joined.level };
}

/** As `choose`, for callers that only need the trail. */
export function chosenTrail(wholeTrail: Trail, shorts: ShortLoop[], short: number, heads: Access[], start: number): Trail {
  return choose(wholeTrail, shorts, short, heads, start).trail;
}

/** The lines to highlight: the main line as chosen (it may run along other trails where pieces were joined,
 *  a loop was closed, or you walk in), plus the trail's own sections when the whole trail is chosen. */
export function highlightLines(whole: Trail, chosen: Trail, short: number): Coord[][] {
  const lines: Coord[][] = [chosen.path];
  if (short < 0) lines.push(...whole.segments);
  return lines.filter((l) => l.length > 1);
}

/** The starts as map points: `start` the index, `on` 1 for the chosen one, `name` for its label. Starts that
 *  cannot be used for the chosen route (`usable[i]` false) are left out. */
export function startFeatures(heads: Access[], chosen: number, usable?: boolean[]): FC {
  return {
    type: 'FeatureCollection',
    features: heads.flatMap((h, i) => (usable && !usable[i] ? [] : [{
      type: 'Feature' as const,
      properties: { start: i, on: i === chosen ? 1 : 0, name: shortName(h.name) },
      geometry: { type: 'Point' as const, coordinates: [h.point[1], h.point[0]] },
    }])),
  };
}

/** A name short enough for a map label. */
export function shortName(name: string): string {
  const n = name.replace(/\s+(Trailhead|Trail Head)$/i, '').trim() || name;
  return n.length > 26 ? `${n.slice(0, 24).trimEnd()}…` : n;
}

/** The start under a tap, if any (a feature of the starts layer carries `start`). */
export function pickStart(features: { properties?: Record<string, unknown> | null }[]): number | null {
  const f = features.find((x) => x.properties && typeof x.properties.start === 'number');
  return f ? (f.properties!.start as number) : null;
}

export interface LoopChoice { index: number; name: string; length: number; gain: number | null }

/** The ways to walk a trail with short loops: the full loop first, then each short loop by its own name
 *  ("West loop", "East loop", "Short loop"). There may be none, one or several. */
export function loopChoices(whole: Trail, shorts: ShortLoop[]): LoopChoice[] {
  if (!shorts.length) return [];
  return [
    { index: -1, name: whole.isLoop ? 'Full loop' : 'Full trail', length: whole.length, gain: whole.profile ? whole.profile.gain : null },
    ...shorts.map((s, i) => ({ index: i, name: s.name.trim() || 'Short loop', length: s.length, gain: s.profile ? s.profile.gain : null })),
  ];
}
