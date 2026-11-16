// How saved trails and hikes look on the server: document ids and compact hikes. No React Native in here, so
// tests (and anything else) can use it as is.
import type { SavedTrail, Walk, WalkPoint } from '@web/lib/storage';
import { bboxOf } from '@web/lib/geo';
import type { Coord } from '@web/lib/polyline';

/** Names and ids the server takes: 1-128 of A-Z a-z 0-9 _ - . */
export const validName = (s: string) => /^[A-Za-z0-9_.-]{1,128}$/.test(s);

// ── Document ids ──────────────────────────────────────────────────────────────────────────────────────
/** A 106-bit string hash (cyrb53, twice), as hex: for ids with characters the server doesn't allow. */
function hash(s: string): string {
  const one = (seed: number) => {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  };
  return one(1) + one(2);
}
export const trailKey = (t: Pick<SavedTrail, 'region' | 'id'>) => `${t.region}/${t.id}`;
export function trailDocId(key: string): string {
  const [region, ...rest] = key.split('/');
  const id = rest.join('/');
  // region and id are plain slugs almost always; anything else (dots, bars, slashes) is hashed
  const simple = /^[A-Za-z0-9_-]+$/;
  return simple.test(region) && simple.test(id) && validName(`t.${region}.${id}`) ? `t.${region}.${id}` : `h.${hash(key)}`;
}
export const walkDocId = (id: string) => (validName(`w.${id}`) ? `w.${id}` : `h.${hash(id)}`);

// ── Compact hikes ─────────────────────────────────────────────────────────────────────────────────────
/** Encoded polyline at 1e-6° (about 0.1 m). */
export function encodeTrack(pts: { lat: number; lon: number }[], scale = 1e6): string {
  let out = '', pLat = 0, pLon = 0;
  const put = (v: number) => {
    let x = v < 0 ? ~(v << 1) : v << 1;
    while (x >= 0x20) { out += String.fromCharCode((0x20 | (x & 0x1f)) + 63); x >>= 5; }
    out += String.fromCharCode(x + 63);
  };
  for (const p of pts) {
    const a = Math.round(p.lat * scale), b = Math.round(p.lon * scale);
    put(a - pLat); put(b - pLon);
    pLat = a; pLon = b;
  }
  return out;
}
export function decodeTrack(s: string, scale = 1e6): [number, number][] {
  const out: [number, number][] = [];
  let i = 0, lat = 0, lon = 0;
  const next = () => {
    let result = 0, shift = 0, b: number;
    do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20 && i < s.length + 1);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < s.length) { lat += next(); lon += next(); out.push([lat / scale, lon / scale]); }
  return out;
}

export interface CompactSegment { line: string; ele: (number | null)[]; t: number[]; acc: number[] }
export type CompactWalk = Omit<Walk, 'segments'> & { segments: CompactSegment[] };

export function compactWalk(w: Walk): CompactWalk {
  return {
    ...w,
    segments: w.segments.map((seg) => ({
      line: encodeTrack(seg),
      ele: seg.map((p) => (p.ele == null ? null : Math.round(p.ele * 10) / 10)),
      t: seg.map((p) => Math.round((p.t - w.started) / 100) / 10),
      acc: seg.map((p) => Math.round(p.acc)),
    })),
  };
}

export function expandWalk(c: CompactWalk): Walk {
  return {
    ...c,
    segments: c.segments.map((s) => decodeTrack(s.line).map(([lat, lon], i): WalkPoint => ({
      lat, lon, ele: s.ele[i] ?? null, t: c.started + Math.round((s.t[i] ?? 0) * 1000), acc: s.acc[i] ?? 0,
    }))),
  };
}


/** A random id in the form the server wants for new records (a version 4 UUID). */
export function uuid(): string {
  const h = Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16));
  h[12] = '4';
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16);
  const s = h.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

const MAX_LINE = 200_000;
const MAX_NOTE = 2000;
const DIFFICULTY: Record<string, string> = { easy: 'easy', moderate: 'moderate', hard: 'hard', veryHard: 'very_hard' };

/**
 * A recorded hike sent in as a new trail (PUT /v1/submissions/{uuid} on the server): the walked line (Google's
 * 1e-5° polyline, thinned if it would be longer than the server takes), the name, and a note with the review, the
 * spots marked on the way and the hiker's agreement to public use.
 */
export function trailSubmission(w: Walk, name: string, review: { rating: number | null; text: string } | null, difficulty?: string) {
  let pts = w.segments.flat();
  let line = encodeTrack(pts, 1e5);
  for (let step = 2; line.length > MAX_LINE && pts.length > 2; step++) {
    const all = w.segments.flat();
    pts = all.filter((_, i) => i % step === 0 || i === all.length - 1);
    line = encodeTrack(pts, 1e5);
  }
  const parts: string[] = [];
  if (review?.rating) parts.push(`Rating: ${'★'.repeat(review.rating)}${'☆'.repeat(5 - review.rating)}`);
  if (review?.text.trim()) parts.push(review.text.trim());
  const spots = w.markers ?? [];
  if (spots.length) parts.push(`Spots marked: ${spots.map((m) => `${m.name || 'spot'} (${m.lat.toFixed(5)}, ${m.lon.toFixed(5)})`).join('; ')}`);
  const km = (w.length / 1000).toFixed(2);
  parts.push(`Recorded on ${new Date(w.started).toISOString().slice(0, 10)}: ${km} km${w.gain != null ? `, ${Math.round(w.gain)} m climbed` : ''}, ${pts.length} points${w.trail ? `, following ${w.trail.name}` : ''}.`);
  parts.push('The hiker agreed that this may be shown publicly and that photos they submit are for public use.');
  let note = parts.join('\n\n');
  if (note.length > MAX_NOTE) note = `${note.slice(0, MAX_NOTE - 1)}…`;
  return {
    kind: 'new_trail' as const,
    name: name.slice(0, 120),
    line,
    note,
    ...(difficulty && DIFFICULTY[difficulty] ? { difficulty: DIFFICULTY[difficulty] } : {}),
  };
}

/** How the server is told which trail a review or photo is about (the same key as Saved: region/id). */
export interface TrailRef { id: string; name: string; start: [number, number]; bbox: [number, number, number, number] }

/** The trail a recorded hike followed, placed by the hike's own line; null for a hike not on a known trail. */
export function trailRefOfWalk(w: Pick<Walk, 'trail' | 'segments'>): TrailRef | null {
  if (!w.trail) return null;
  const lines = w.segments.map((s) => s.map((p) => [p.lat, p.lon] as Coord)).filter((l) => l.length);
  const box = bboxOf(lines);
  if (!box) return null;
  return { id: `${w.trail.region}/${w.trail.id}`, name: w.trail.name, start: lines[0][0], bbox: box };
}
