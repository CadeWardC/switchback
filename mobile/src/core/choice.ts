// The open trail as chosen to walk: the whole trail or one of its short loops, on its own or in from a
// trailhead; and what the map draws for that choice. Plain functions (tested in test/choice.test.ts) over the
// website's trail rules (shortLoops, shortened, accessPoints, hikeFrom in web/src/lib/trail.ts).
import { hikeFrom, shortened, type Access, type ShortLoop, type Trail } from '@web/lib/trail';
import { distance } from '@web/lib/geo';
import type { Coord } from '@web/lib/polyline';

type FC = GeoJSON.FeatureCollection;

/** Where to start by default: the trailhead nearest you (when you are within reach of one), else the one
 *  nearest the trail (the list comes nearest first). -1 when the trail has none. */
export function defaultStart(heads: Access[], me: Coord | null): number {
  if (!heads.length) return -1;
  if (!me) return 0;
  let best = 0, bestD = Infinity;
  heads.forEach((h, i) => { const d = distance(me, h.point); if (d < bestD) { bestD = d; best = i; } });
  // far from all of them (looking at a trail in another state): the one nearest the trail
  return bestD < 80_000 ? best : 0;
}

/** The trail as chosen: a short loop of it (or the whole), then the walk in from a trailhead (or none). */
export function chosenTrail(whole: Trail, shorts: ShortLoop[], short: number, heads: Access[], start: number): Trail {
  const loop = shorts[short];
  const base = loop ? shortened(whole, loop) : whole;
  const head = heads[start];
  return head ? hikeFrom(base, head) : base;
}

/** The lines to highlight: the main line as chosen (it may run along other trails where pieces were joined,
 *  a loop was closed, or you walk in), plus the trail's own sections when the whole trail is chosen. */
export function highlightLines(whole: Trail, chosen: Trail, short: number): Coord[][] {
  const lines: Coord[][] = [chosen.path];
  if (short < 0) lines.push(...whole.segments);
  return lines.filter((l) => l.length > 1);
}

/** The starts as map points: `i` the index, `on` 1 for the chosen one, `name` for its label. */
export function startFeatures(heads: Access[], chosen: number): FC {
  return {
    type: 'FeatureCollection',
    features: heads.map((h, i) => ({
      type: 'Feature',
      properties: { start: i, on: i === chosen ? 1 : 0, name: shortName(h.name) },
      geometry: { type: 'Point', coordinates: [h.point[1], h.point[0]] },
    })),
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
