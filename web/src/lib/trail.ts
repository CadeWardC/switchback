// A trail as the packs store it, and the rules the apps share (mirrors Switchback/Model/Trail.swift).
import { decodeInts, decodePolyline, type Coord } from './polyline';
import { bboxOf, distance, type BBox } from './geo';

export type Difficulty = 'easy' | 'moderate' | 'hard' | 'veryHard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'moderate', 'hard', 'veryHard'];
export const DIFFICULTY_TITLE: Record<Difficulty, string> = {
  easy: 'Easy', moderate: 'Moderate', hard: 'Hard', veryHard: 'Very hard',
};
export const DIFFICULTY_COLOR: Record<Difficulty, string> = {
  easy: '#2E9E5B', moderate: '#2B7FD9', hard: '#D9482B', veryHard: '#7B4BC9',
};

export interface Profile {
  distances: number[];
  elevations: number[];
  gain: number;
  loss: number;
  min: number;
  max: number;
}

export interface PackedElevation { s: number; p: string; g?: number; l?: number; mn?: number; mx?: number }

export interface RawTrail {
  id: string;
  name: string;
  source: string;
  osmId?: number;
  segments: string[];
  pathIndex?: number;
  path?: string;
  length: number;
  tags?: Record<string, string>;
  elev?: PackedElevation;
}

export interface Access { name: string; distance: number; point: Coord; line: Coord[]; profile: Profile | null }

/** A shorter loop of a trail, by a cut-across that isn't a trail of its own. */
export interface ShortLoop { id: string; name: string; length: number; line: Coord[]; profile: Profile | null }

export interface Trail {
  /** "<region>/<id>": unique across regions. */
  key: string;
  region: string;
  id: string;
  name: string;
  source: string;
  osmId?: number;
  segments: Coord[][];
  path: Coord[];
  length: number;
  tags: Record<string, string>;
  profile: Profile | null;
  start: Coord;
  bbox: BBox;
  difficulty: Difficulty;
  isLoop: boolean;
  isHike: boolean;
  area: string | null;
}

/** Elevation as packs store it: {s: metres per step, p: (steps, metres) deltas, g, l, mn, mx}. */
export function unpackProfile(e: PackedElevation | undefined): Profile | null {
  if (!e || typeof e.s !== 'number' || typeof e.p !== 'string') return null;
  const ints = decodeInts(e.p);
  if (ints.length < 4) return null;
  const distances: number[] = [], elevations: number[] = [];
  let step = 0, height = 0;
  for (let i = 0; i + 1 < ints.length; i += 2) {
    step += ints[i];
    height += ints[i + 1];
    distances.push(step * e.s);
    elevations.push(height);
  }
  const p = profileOf(distances, elevations);
  if (typeof e.g === 'number') p.gain = e.g;
  if (typeof e.l === 'number') p.loss = e.l;
  if (typeof e.mn === 'number') p.min = e.mn;
  if (typeof e.mx === 'number') p.max = e.mx;
  return p;
}

/** Climb and descent ignore wiggles smaller than `threshold` metres. */
export function profileOf(distances: number[], elevations: number[], threshold = 2): Profile {
  let gain = 0, loss = 0;
  if (elevations.length) {
    let ref = elevations[0];
    for (const e of elevations) {
      if (e - ref >= threshold) { gain += e - ref; ref = e; }
      else if (ref - e >= threshold) { loss += ref - e; ref = e; }
    }
  }
  return {
    distances, elevations, gain, loss,
    min: elevations.length ? Math.min(...elevations) : 0,
    max: elevations.length ? Math.max(...elevations) : 0,
  };
}

/** The height at a distance along a profile. */
export function heightAt(p: Profile, d: number): number {
  const n = p.distances.length;
  if (!n) return 0;
  if (d <= p.distances[0]) return p.elevations[0];
  if (d >= p.distances[n - 1]) return p.elevations[n - 1];
  let i = 1;
  while (i < n - 1 && p.distances[i] < d) i++;
  const span = p.distances[i] - p.distances[i - 1];
  if (span <= 0) return p.elevations[i];
  const t = (d - p.distances[i - 1]) / span;
  return p.elevations[i - 1] + (p.elevations[i] - p.elevations[i - 1]) * t;
}

export function difficultyOf(length: number, gain: number, tags: Record<string, string>): Difficulty {
  // the trail files say, when they have worked it out; otherwise the rule below
  const said = tags['switchback:difficulty'] as Difficulty | undefined;
  if (said && DIFFICULTIES.includes(said)) return said;
  const effort = length / 1000 + gain / 100;
  let level = effort < 8 ? 0 : effort < 16 ? 1 : effort < 26 ? 2 : 3;
  // Forest Service class 1 (minimally developed) trails are rough going
  if ((tags['usfs:trail_class'] ?? '').replace(/\D/g, '') === '1') level = Math.max(level, 1);
  switch (tags['sac_scale']) {
    case 'mountain_hiking': level = Math.max(level, 1); break;
    case 'demanding_mountain_hiking': level = Math.max(level, 2); break;
    case 'alpine_hiking':
    case 'demanding_alpine_hiking':
    case 'difficult_alpine_hiking': level = 3; break;
  }
  return DIFFICULTIES[level];
}

export function isLoopLine(path: Coord[], length: number): boolean {
  if (path.length < 2 || length <= 500) return false;
  return distance(path[0], path[path.length - 1]) < Math.max(150, length * 0.03);
}

/** A hike to list: not a side trail, informal path, unnamed line, or one the trail files mark as not a hike. */
export function isHikeTags(tags: Record<string, string>): boolean {
  return tags['switchback:hike'] !== 'no' && tags['switchback:side'] !== 'yes'
    && tags['switchback:informal'] !== 'yes' && tags['switchback:unnamed'] !== 'yes';
}

export function makeTrail(region: string, raw: RawTrail): Trail | null {
  if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.segments)) return null;
  const segments = raw.segments.map(decodePolyline).filter((s) => s.length > 1);
  let path: Coord[] | undefined;
  if (typeof raw.pathIndex === 'number') path = decodePolyline(raw.segments[raw.pathIndex] ?? '');
  if ((!path || path.length < 2) && typeof raw.path === 'string') path = decodePolyline(raw.path);
  if (!path || path.length < 2) path = segments[0];
  if (!path || path.length < 2) return null;
  const tags = raw.tags ?? {};
  const profile = unpackProfile(raw.elev);
  const length = Number(raw.length) || 0;
  return {
    key: `${region}/${raw.id}`, region, id: raw.id, name: raw.name || 'Trail', source: raw.source, osmId: raw.osmId,
    segments: segments.length ? segments : [path], path, length, tags, profile,
    start: path[0],
    bbox: bboxOf(segments.length ? segments : [path])!,
    difficulty: difficultyOf(length, profile?.gain ?? 0, tags),
    isLoop: isLoopLine(path, length),
    isHike: isHikeTags(tags),
    area: tags['switchback:area'] ?? null,
  };
}

/** Naismith's rule at an easy pace: 4.5 km/h plus an hour for every 600 m of climb. Seconds. */
export function estimatedSeconds(t: Pick<Trail, 'length' | 'profile'> & { tags?: Record<string, string> }): number {
  const minutes = Number(t.tags?.['switchback:minutes']);
  if (minutes > 0) return minutes * 60;
  return (t.length / 1000 / 4.5 + (t.profile?.gain ?? 0) / 600) * 3600;
}

export function routeType(t: Trail): string {
  return t.tags['switchback:network'] === 'yes' ? 'Trail network' : t.isLoop ? 'Loop' : 'One way';
}

/** Trailheads and car parks this trail can be started from, nearest first. */
export function accessPoints(t: Trail): Access[] {
  try {
    const rows = JSON.parse(t.tags['switchback:access'] ?? '[]');
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r: any) =>
      typeof r?.n === 'string' && Array.isArray(r.p) && r.p.length === 2
        ? [{
          name: r.n, distance: Number(r.d) || 0, point: [Number(r.p[0]), Number(r.p[1])] as Coord,
          line: typeof r.l === 'string' ? decodePolyline(r.l) : [], profile: unpackProfile(r.e),
        }] : []);
  } catch {
    return [];
  }
}

export function shortLoops(t: Trail): ShortLoop[] {
  try {
    const rows = JSON.parse(t.tags['switchback:short'] ?? '[]');
    if (!Array.isArray(rows)) return [];
    return rows.flatMap((r: any) =>
      typeof r?.n === 'string' && Number(r.m) > 0 && typeof r.l === 'string'
        ? [{ id: `short-${Math.trunc(Number(r.m))}`, name: r.n, length: Number(r.m), line: decodePolyline(r.l), profile: unpackProfile(r.e) }] : []);
  } catch {
    return [];
  }
}

/** A trail with another line as the one to walk (a short loop, or in from a trailhead): everything that
 *  follows from the line (difficulty, loop or not, bounds) is worked out again. */
function rerouted(t: Trail, path: Coord[], length: number, profile: Profile | null, extra: Coord[][], drop: string[]): Trail {
  const tags = { ...t.tags };
  for (const tag of drop) delete tags[tag];
  const segments = [...t.segments, ...extra.filter((s) => s.length > 1)];
  return {
    ...t, path, length, profile, segments, tags, start: path[0], bbox: bboxOf(segments) ?? t.bbox,
    difficulty: difficultyOf(length, profile?.gain ?? 0, tags), isLoop: isLoopLine(path, length),
  };
}

/** This trail walked as one of its short loops: the same trail and trailheads, a shorter line. */
export function shortened(t: Trail, short: ShortLoop): Trail {
  if (short.line.length < 2) return t;
  // (the cut-across is added to the lines so it is drawn; these tags were worked out for the whole loop)
  return rerouted(t, short.line, short.length, short.profile, [short.line],
    ['switchback:short', 'switchback:ext', 'switchback:difficulty', 'switchback:minutes']);
}

// ── Profiles walked one after another (mirrors ElevationProfile in Trail.swift) ──────────────────────
type Pts = [number, number][];
const profileTotal = (p: Profile) => p.distances[p.distances.length - 1] ?? 0;

function pointsBetween(p: Profile, a: number, b: number): Pts {
  if (!(b > a)) return [];
  const out: Pts = [[0, heightAt(p, a)]];
  p.distances.forEach((d, i) => { if (d > a && d < b) out.push([d - a, p.elevations[i]]); });
  out.push([b - a, heightAt(p, b)]);
  return out;
}

function joined(parts: Pts[], gain: number, loss: number, min: number, max: number): Profile {
  const distances: number[] = [], elevations: number[] = [];
  let offset = 0;
  for (const part of parts) {
    if (!part.length) continue;
    for (const [d, e] of part) { distances.push(offset + d); elevations.push(e); }
    offset += part[part.length - 1][0];
  }
  return { distances, elevations, gain, loss, min, max };
}

const allPoints = (p: Profile) => pointsBetween(p, 0, profileTotal(p));
const backwards = (p: Profile): Profile =>
  joined([allPoints(p).reverse().map(([d, e]) => [profileTotal(p) - d, e] as [number, number])], p.loss, p.gain, p.min, p.max);
const rotated = (p: Profile, d: number): Profile =>
  d > 0 && d < profileTotal(p) ? joined([pointsBetween(p, d, profileTotal(p)), pointsBetween(p, 0, d)], p.gain, p.loss, p.min, p.max) : p;
const then = (a: Profile, b: Profile): Profile =>
  joined([allPoints(a), allPoints(b)], a.gain + b.gain, a.loss + b.loss, Math.min(a.min, b.min), Math.max(a.max, b.max));

/** This trail as the hike you'd walk from a trailhead: in along the way from it (and back out, for a loop). */
export function hikeFrom(t: Trail, a: Access): Trail {
  if (a.line.length < 2 || t.path.length < 2) return t;
  const join = a.line[a.line.length - 1];
  let route = t.path;
  let chart: Profile | null = t.profile;
  const nearest = (c: Coord) => { let best = 0, bd = Infinity; route.forEach((p, i) => { const d = distance(p, c); if (d < bd) { bd = d; best = i; } }); return best; };
  const along = (i: number) => {
    let d = 0, whole = 0;
    for (let k = 1; k < route.length; k++) { const step = distance(route[k - 1], route[k]); whole += step; if (k <= i) d += step; }
    return whole > 0 && chart ? (d / whole) * profileTotal(chart) : 0;
  };
  let length = t.length;
  if (t.isLoop) {
    const i = nearest(join);
    chart = chart && a.profile ? then(then(a.profile, rotated(chart, along(i))), backwards(a.profile)) : null;
    if (i > 0) route = [...route.slice(i), ...route.slice(1, i + 1)];
    route = [...a.line, ...route, ...a.line.slice().reverse()];
    length += 2 * a.distance;
  } else {
    const flip = distance(route[route.length - 1], join) < distance(route[0], join);
    chart = chart && a.profile ? then(a.profile, flip ? backwards(chart) : chart) : null;
    if (flip) route = route.slice().reverse();
    route = [...a.line, ...route];
    length += a.distance;
  }
  // (when a part has no elevation of its own, the chart stays the trail's)
  const out = rerouted(t, route, length, chart ?? t.profile, [a.line], ['switchback:difficulty', 'switchback:minutes']);
  // a walk in does not turn a one-way trail into a loop, or a loop into a one-way
  out.isLoop = t.isLoop;
  return out;
}

export const isUnwalked = (t: Trail) => t.tags['switchback:unwalked'] === 'yes';
export const needsVerification = (t: Trail) => t.tags['switchback:needs_verification'] === 'yes';

export function osmUrl(t: Trail): string | null {
  if (!t.osmId) return null;
  if (t.source === 'osmRelation') return `https://www.openstreetmap.org/relation/${t.osmId}`;
  if (t.source === 'osmWay') return `https://www.openstreetmap.org/way/${t.osmId}`;
  return null;
}

const cap = (s: string) => s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export interface Fact { title: string; value: string; href?: string }

/** Facts from the tags worth showing, in plain words. `fmtDistance` formats metres in the reader's units. */
export function facts(t: Trail, fmtDistance: (m: number) => string): Fact[] {
  const g = t.tags, out: Fact[] = [];
  if (g.from && g.to) out.push({ title: 'Route', value: `${g.from} → ${g.to}` });
  if (g['switchback:system']) out.push({ title: 'Part of', value: g['switchback:system'] });
  if (g.operator) out.push({ title: 'Managed by', value: g.operator });
  if (g.network) {
    const names: Record<string, string> = { lwn: 'Local', rwn: 'Regional', nwn: 'National', iwn: 'International' };
    out.push({ title: 'Route network', value: names[g.network] ?? g.network });
  }
  if (g.sac_scale) {
    const names: Record<string, string> = {
      hiking: 'Hiking (T1)', mountain_hiking: 'Mountain hiking (T2)',
      demanding_mountain_hiking: 'Demanding mountain hiking (T3)', alpine_hiking: 'Alpine hiking (T4)',
      demanding_alpine_hiking: 'Demanding alpine hiking (T5)', difficult_alpine_hiking: 'Difficult alpine hiking (T6)',
    };
    out.push({ title: 'Terrain', value: names[g.sac_scale] ?? cap(g.sac_scale) });
  }
  if (g['switchback:multiuse'] === 'yes') out.push({ title: 'Shared with', value: 'Bikes (a walking and cycling path)' });
  const surface = g.surface ?? g['usfs:surface'];
  if (surface) out.push({ title: 'Surface', value: cap(surface) });
  if (g.trail_visibility) out.push({ title: 'How clear the path is', value: cap(g.trail_visibility) });
  if (g.ref) out.push({ title: 'Trail number', value: g.ref });
  if (g.symbol) out.push({ title: 'Waymarks', value: g.symbol });
  if (g['usfs:trail_class']) {
    const names: Record<string, string> = {
      '1': 'Minimally developed', '2': 'Moderately developed', '3': 'Developed', '4': 'Highly developed', '5': 'Fully developed',
    };
    out.push({ title: 'Forest Service class', value: names[g['usfs:trail_class'].replace(/\D/g, '')] ?? g['usfs:trail_class'] });
  }
  if (g['usfs:grade']) out.push({ title: 'Typical grade', value: g['usfs:grade'] });
  if (g.dog) out.push({ title: 'Dogs', value: cap(g.dog) });
  const bridged = Number(g['switchback:bridged']);
  if (bridged > 0) {
    out.push({ title: 'Joined sections', value: `${fmtDistance(bridged)} follows roads or unnamed stretches between the mapped sections` });
  }
  return out;
}

/** What an official list or park map says about the trail, when one confirms it. */
export function officialFacts(t: Trail, fmtDistance: (m: number) => string): Fact[] {
  const g = t.tags, out: Fact[] = [];
  if (!g['official:source']) return out;
  out.push({ title: 'Confirmed by', value: g['official:source'] });
  if (g['official:name']) out.push({ title: 'Official name', value: g['official:name'] });
  if (g['official:ref']) out.push({ title: 'Official number', value: g['official:ref'] });
  const miles = Number(g['official:miles']);
  if (miles > 0) out.push({ title: 'Official length', value: fmtDistance(miles * 1609.344) });
  if (g['official:url'] && /^https?:\/\//.test(g['official:url'])) {
    out.push({ title: 'Official page', value: hostOf(g['official:url']), href: g['official:url'] });
  }
  return out;
}

export function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

export function website(t: Trail): string | null {
  const u = t.tags.website ?? t.tags.url;
  return u && /^https?:\/\//.test(u) ? u : null;
}

export function summary(t: Trail): string | null {
  return t.tags.description ?? t.tags['description:en'] ?? t.tags.note ?? null;
}

/** Where the line came from, for the credit under a trail. */
export function lineCredit(t: Trail): string {
  const origin = t.tags['switchback:origin'];
  if (origin) return `Trail line from ${origin}.`;
  return 'Trail line © OpenStreetMap contributors, Open Database License (ODbL).';
}
