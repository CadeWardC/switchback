// Keeping your hikes through a reinstall. Everything the Log and Saved hold lives in the app's own files,
// which the phone erases with the app, so Settings can write it all to one backup file (handed to the share
// sheet: Files, iCloud Drive, AirDrop, mail) and read it back. A GPX file shared from a hike's page can be
// read back as a hike too. Reading only ever adds: nothing already on the phone is replaced.
// Plain functions, tested in test/core.test.ts.
import { distance } from '@web/lib/geo';
import type { Marker, SavedTrail, Walk, WalkPoint, WalkSummary } from '@web/lib/storage';
import { climbedSoFar } from './hikeMath';

export interface Backup { walks: Walk[]; saved: SavedTrail[] }

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const place = (lat: unknown, lon: unknown) => num(lat) && num(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

/** The backup file: every hike in full and every saved trail. */
export function backupText(walks: Walk[], saved: SavedTrail[], now: number): string {
  return JSON.stringify({ app: 'switchback', kind: 'backup', version: 1, exported: new Date(now).toISOString(), walks, saved });
}

export const backupName = (now: Date) =>
  `Switchback-backup-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.json`;

function walkOf(x: unknown): Walk | null {
  const w = x as Partial<Walk> | null;
  if (!w || typeof w !== 'object' || typeof w.id !== 'string' || !w.id || !num(w.started) || !Array.isArray(w.segments)) return null;
  const segments = w.segments
    .filter(Array.isArray)
    .map((s) => s.filter((p: Partial<WalkPoint> | null) => p && place(p.lat, p.lon) && num(p.t))
      .map((p: WalkPoint): WalkPoint => ({ lat: p.lat, lon: p.lon, ele: num(p.ele) ? p.ele : null, t: p.t, acc: num(p.acc) ? p.acc : 0 })))
    .filter((s) => s.length > 0);
  if (segments.reduce((n, s) => n + s.length, 0) < 2) return null;
  const last = segments[segments.length - 1];
  const markers = Array.isArray(w.markers)
    ? w.markers.filter((m: Partial<Marker> | null) => m && place(m.lat, m.lon) && num(m.t))
      .map((m: Marker): Marker => ({ lat: m.lat, lon: m.lon, ele: num(m.ele) ? m.ele : null, t: m.t, name: String(m.name ?? '') }))
    : [];
  const tr = w.trail;
  return {
    id: w.id, name: typeof w.name === 'string' && w.name.trim() ? w.name : 'Hike', started: w.started,
    ended: num(w.ended) ? w.ended : last[last.length - 1].t,
    seconds: num(w.seconds) ? w.seconds : movingSeconds(segments),
    length: num(w.length) ? w.length : lengthOf(segments),
    segments,
    gain: num(w.gain) ? w.gain : Math.round(climbedSoFar(segments) ?? 0),
    ...(markers.length ? { markers } : {}),
    ...(tr && typeof tr.region === 'string' && typeof tr.id === 'string' && typeof tr.name === 'string' ? { trail: { region: tr.region, id: tr.id, name: tr.name } } : {}),
  };
}

function savedOf(x: unknown): SavedTrail | null {
  const s = x as Partial<SavedTrail> | null;
  if (!s || typeof s !== 'object' || typeof s.region !== 'string' || typeof s.id !== 'string' || typeof s.name !== 'string') return null;
  if (!Array.isArray(s.start) || !place(s.start[0], s.start[1]) || !num(s.length)) return null;
  return {
    region: s.region, id: s.id, name: s.name, area: typeof s.area === 'string' ? s.area : null, length: s.length,
    gain: num(s.gain) ? s.gain : 0, difficulty: (s.difficulty ?? 'easy') as SavedTrail['difficulty'], loop: !!s.loop,
    start: [s.start[0], s.start[1]], saved: num(s.saved) ? s.saved : Date.now(),
  };
}

/** Reads a backup file. null when the text is not one. */
export function readBackup(text: string): Backup | null {
  let data: { app?: unknown; walks?: unknown; saved?: unknown };
  try { data = JSON.parse(text); } catch { return null; }
  if (!data || typeof data !== 'object' || data.app !== 'switchback' || !Array.isArray(data.walks)) return null;
  return {
    walks: data.walks.map(walkOf).filter((w): w is Walk => !!w),
    saved: (Array.isArray(data.saved) ? data.saved : []).map(savedOf).filter((s): s is SavedTrail => !!s),
  };
}

const lengthOf = (segments: WalkPoint[][]) =>
  segments.reduce((n, s) => n + s.reduce((m, p, i) => (i ? m + distance([s[i - 1].lat, s[i - 1].lon], [p.lat, p.lon]) : m), 0), 0);
/** Time spent on each stretch (a pause starts a new stretch, so pauses are left out). */
const movingSeconds = (segments: WalkPoint[][]) =>
  Math.round(segments.reduce((n, s) => n + (s[s.length - 1].t - s[0].t) / 1000, 0));

const unxml = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(lt|gt|quot|apos|amp);/g, (_, e: string) => ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' })[e]!).trim();
const inner = (block: string, tag: string) => new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`, 'i').exec(block)?.[1] ?? null;
const attr = (tagText: string, name: string) => Number(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(tagText)?.[1] ?? NaN);

/** Every <tag …/> or <tag …>…</tag> in the text: its opening tag and what is inside it. */
function elements(text: string, tag: string): { open: string; body: string }[] {
  const out: { open: string; body: string }[] = [];
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*?)(/>|>([\\s\\S]*?)</(?:\\w+:)?${tag}>)`, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ open: m[1], body: m[3] ?? '' });
  return out;
}

/** Reads a recorded hike from a GPX file (one this app shared, or any track whose points carry times).
 *  null when it has no such track: a trail's line has no times, so it is not a hike. */
export function readGpxHike(text: string, fallbackName: string): Walk | null {
  if (!/<gpx[\s>]/i.test(text)) return null;
  const segments: WalkPoint[][] = [];
  for (const seg of elements(text, 'trkseg')) {
    const points: WalkPoint[] = [];
    for (const p of elements(seg.body, 'trkpt')) {
      const lat = attr(p.open, 'lat'), lon = attr(p.open, 'lon');
      const t = Date.parse(inner(p.body, 'time') ?? '');
      const ele = Number(inner(p.body, 'ele') ?? NaN);
      if (!place(lat, lon) || !Number.isFinite(t)) continue;
      if (points.length && t <= points[points.length - 1].t) continue;
      points.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, t, acc: 0 });
    }
    if (points.length) segments.push(points);
  }
  const all = segments.flat();
  if (all.length < 2) return null;
  const markers: Marker[] = [];
  for (const w of elements(text, 'wpt')) {
    const lat = attr(w.open, 'lat'), lon = attr(w.open, 'lon');
    if (!place(lat, lon)) continue;
    const t = Date.parse(inner(w.body, 'time') ?? ''), ele = Number(inner(w.body, 'ele') ?? NaN);
    markers.push({ lat, lon, ele: Number.isFinite(ele) ? ele : null, t: Number.isFinite(t) ? t : all[0].t, name: unxml(inner(w.body, 'name') ?? '') });
  }
  const meta = inner(text, 'metadata') ?? '';
  const began = Date.parse(inner(meta, 'time') ?? '');
  // this app writes when the hike began into the file; other files only have their points
  const started = Number.isFinite(began) && began <= all[0].t && all[0].t - began < 6 * 3600_000 ? began : all[0].t;
  const name = unxml(inner(inner(text, 'trk') ?? '', 'name') ?? inner(meta, 'name') ?? '') || fallbackName.replace(/\.gpx(\.txt)?$/i, '') || 'Imported hike';
  return {
    id: `gpx-${Math.floor(started / 1000).toString(36)}-${all.length.toString(36)}`, name: name.slice(0, 80), started, ended: all[all.length - 1].t,
    seconds: movingSeconds(segments), length: lengthOf(segments), segments, gain: Math.round(climbedSoFar(segments) ?? 0),
    ...(markers.length ? { markers } : {}),
  };
}

/** The hikes of `incoming` that are not on the phone yet: not the same hike by id, nor one that began the
 *  same second (the same hike, once from a backup and once from its GPX file). */
export function newWalks(have: WalkSummary[], incoming: Walk[]): Walk[] {
  const ids = new Set(have.map((w) => w.id)), starts = new Set(have.map((w) => Math.floor(w.started / 1000)));
  const out: Walk[] = [];
  for (const w of incoming) {
    const second = Math.floor(w.started / 1000);
    if (ids.has(w.id) || starts.has(second)) continue;
    ids.add(w.id);
    starts.add(second);
    out.push(w);
  }
  return out;
}

export function newSaved(have: SavedTrail[], incoming: SavedTrail[]): SavedTrail[] {
  const keys = new Set(have.map((s) => `${s.region}/${s.id}`));
  return incoming.filter((s) => !keys.has(`${s.region}/${s.id}`) && !!keys.add(`${s.region}/${s.id}`));
}

/** What an import did, in words. */
export function importSummary(hikes: number, saved: number, unread: number): string {
  const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;
  const added = [hikes ? many(hikes, 'hike', 'hikes') : '', saved ? many(saved, 'saved trail', 'saved trails') : ''].filter(Boolean).join(' and ');
  const bad = unread ? ` ${many(unread, 'file was', 'files were')} not a Switchback backup or a recorded GPX track.` : '';
  if (added) return `Added ${added}.${bad}`;
  return unread ? bad.trim() : 'Nothing new: everything in there is already on this phone.';
}
