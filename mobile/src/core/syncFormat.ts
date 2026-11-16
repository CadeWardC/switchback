// How saved trails and hikes look on the server: document ids and compact hikes. No React Native in here, so
// tests (and anything else) can use it as is.
import type { SavedTrail, Walk, WalkPoint } from '@web/lib/storage';
import { submissionGpx } from '@web/lib/submit';

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


/** A hike sent in for review, in the shape web/review.html reads; with the submission file
 * (docs/SUBMISSIONS.md) the existing checks take. */
export function submissionDoc(w: Walk, name: string, review: { rating: number | null; text: string } | null, appVersion: string, now = Date.now()) {
  const markers = w.markers ?? [];
  return {
    v: 2,
    status: 'pending' as const,
    submitted_at: now,
    name,
    review,
    public_use_consent: true,
    app_version: appVersion,
    hike: {
      id: w.id, name, start: w.started, end: w.ended, distance: Math.round(w.length * 10) / 10,
      moving_time: w.seconds, elapsed_time: Math.round((w.ended - w.started) / 1000), gain: w.gain ?? null,
      trail_id: w.trail?.id ?? null, trail_name: w.trail?.name ?? null,
      segments: w.segments.filter((s) => s.length).map((s) => ({
        line: encodeTrack(s),
        alt: s.map((p) => (p.ele == null ? null : Math.round(p.ele * 10) / 10)),
        t: s.map((p) => Math.round((p.t - w.started) / 100) / 10),
      })),
      points: markers.map((m, i) => ({ id: `${w.id}-${i}`, kind: 'spot', note: m.name, lat: m.lat, lon: m.lon, time: m.t })),
    },
    gpx: submissionGpx({
      name, notes: review?.text ?? '', kind: 'walked', publicAccess: true, lengthMetres: w.length,
      points: w.segments.flat().map((p) => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.t })),
    }, now),
  };
}
