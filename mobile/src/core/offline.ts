// The base map with no signal, with nothing to manage (as web/src/offline.ts does in the browser, but with
// MapLibre Native's own storage): a generous ambient cache keeps everything already looked at, and offline
// packs are saved quietly for the area around you and around every trail you open, save or start.
// Trail files themselves are kept by web/src/data.ts (src/platform/files.ts stores them).
//
// ── PLACE FOR A BUNDLED OVERVIEW MAP ───────────────────────────────────────────────────────────────────
// A built-in overview base map (.pmtiles or .mbtiles shipped in the app) is a later job. It would be added
// here: copy the file from the bundle on first launch, then either OfflineManager.mergeOfflineRegions(path)
// for an .mbtiles-style offline database, or add it to the styles as a "pmtiles://file://…" source in
// src/map/style.ts (MapLibre Native reads PMTiles), drawn under the OpenFreeMap source.
// ───────────────────────────────────────────────────────────────────────────────────────────────────────
import { effect, signal } from '@preact/signals-core';
import { Directory, File, Paths } from 'expo-file-system';
import { OfflineManager, type OfflinePack } from '@maplibre/maplibre-react-native';
import { distance, type BBox } from '@web/lib/geo';
import { bboxOf } from '@web/lib/geo';
import { load, save } from '@web/lib/storage';
import type { Coord } from '@web/lib/polyline';
import { connection, following, mapsOverCellular, myLocation, savedTrails, selected } from './state';
import { styleFor } from '../map/style';

/** The ambient cache: what has been looked at stays, up to this many bytes. */
export const AMBIENT_CACHE_BYTES = 768 * 1024 * 1024;
/** Trail packs kept beyond this many are dropped, oldest first (they are small: a few MB each). */
const MAX_TRAIL_PACKS = 60;
const MAX_ZOOM = 14;
/** The places you have been: the last few are kept. */
const MAX_HERE_PACKS = 8;

/** Pack name → its state, for "Ready offline" and Settings. */
export const packStates = signal<Record<string, { state: 'saving' | 'ready' | 'failed'; percent: number; bytes: number }>>({});

const km = (lat: number, k: number) => ({ dLat: k / 111, dLon: k / (111 * Math.max(0.2, Math.cos((lat * Math.PI) / 180))) });
function around(b: BBox, k: number): BBox {
  const { dLat, dLon } = km((b[0] + b[2]) / 2, k);
  return [b[0] - dLat, b[1] - dLon, b[2] + dLat, b[3] + dLon];
}
const lngLatBounds = (b: BBox): [number, number, number, number] => [b[1], b[0], b[3], b[2]];

/** The style file offline packs are made from (packs take a style URL; tiles are shared with the map). */
function styleUrl(): string {
  const dir = new Directory(Paths.document, 'map');
  if (!dir.exists) dir.create({ intermediates: true });
  const f = new File(dir, 'style-light.json');
  const text = JSON.stringify(styleFor(false, 'imperial'));
  if (!f.exists || f.size !== text.length) {
    if (f.exists) f.delete();
    f.create();
    f.write(text);
  }
  return f.uri;
}

let packList: Promise<OfflinePack[]> | null = null;
const packs = () => (packList ??= OfflineManager.getPacks().catch(() => []));
const nameOf = (p: OfflinePack) => String(p.metadata?.name ?? '');

function note(name: string, s: { state: 'saving' | 'ready' | 'failed'; percent: number; bytes: number }): void {
  packStates.value = { ...packStates.peek(), [name]: s };
}

async function mayDownload(small: boolean): Promise<boolean> {
  const c = connection.peek();
  if (c === 'none') return false;
  return c !== 'cellular' || small || mapsOverCellular.peek();
}

/** Saves an area as an offline pack under a name (once; an existing pack of that name is kept). */
async function saveArea(name: string, parts: { box: BBox; zooms: [number, number] }[], small: boolean): Promise<void> {
  const have = (await packs()).filter((p) => nameOf(p).startsWith(name));
  if (have.length >= parts.length) return;
  if (!(await mayDownload(small))) return;
  const url = styleUrl();
  for (let i = 0; i < parts.length; i++) {
    const partName = parts.length > 1 ? `${name}#${i}` : name;
    if (have.some((p) => nameOf(p) === partName)) continue;
    const part = parts[i];
    try {
      note(name, { state: 'saving', percent: 0, bytes: 0 });
      const pack = await OfflineManager.createPack(
        { mapStyle: url, bounds: lngLatBounds(part.box), minZoom: part.zooms[0], maxZoom: part.zooms[1], metadata: { name: partName, saved: Date.now() } },
        (_p, s) => note(name, { state: s.state === 'complete' ? 'ready' : 'saving', percent: Math.round(s.percentage), bytes: s.completedResourceSize }),
        () => note(name, { state: 'failed', percent: 0, bytes: 0 }),
      );
      (await packs()).push(pack);
    } catch {
      note(name, { state: 'failed', percent: 0, bytes: 0 });
    }
  }
  void prune();
}

async function prune(): Promise<void> {
  const trail = (await packs()).filter((p) => nameOf(p).startsWith('trail:'))
    .sort((a, b) => Number(b.metadata?.saved ?? 0) - Number(a.metadata?.saved ?? 0));
  const here = (await packs()).filter((p) => nameOf(p).startsWith('here:'))
    .sort((a, b) => Number(b.metadata?.saved ?? 0) - Number(a.metadata?.saved ?? 0));
  // (each place is two packs, each trail two)
  const drop = [...trail.slice(MAX_TRAIL_PACKS * 2), ...here.slice(MAX_HERE_PACKS * 2)];
  for (const p of drop) {
    try { await OfflineManager.deletePack(p.id); } catch { /* gone */ }
  }
  if (drop.length) packList = null;
}

/** The map around a trail: to zoom 14 with about a kilometre of margin, and a wider view above it. */
export function saveTrailMap(key: string, box: BBox): Promise<void> {
  return saveArea(`trail:${key}`, [{ box: around(box, 1), zooms: [10, MAX_ZOOM] }, { box: around(box, 12), zooms: [5, 9] }], true);
}

/** Whether a trail's map is on the phone: 'ready', 'saving' (with a percentage), or null (not saved). */
export async function trailMapState(key: string): Promise<{ state: 'ready' | 'saving' | 'failed'; percent: number } | null> {
  const name = `trail:${key}`;
  const live = packStates.peek()[name];
  if (live) return live;
  const mine = (await packs()).filter((p) => nameOf(p).startsWith(name));
  if (!mine.length) return null;
  try {
    const all = await Promise.all(mine.map((p) => p.status()));
    const done = all.every((s) => s.state === 'complete' || s.percentage >= 100);
    return done ? { state: 'ready', percent: 100 } : { state: 'saving', percent: Math.round(all.reduce((n, s) => n + s.percentage, 0) / all.length) };
  } catch {
    return null;
  }
}

/** What the maps on this phone take, for Settings. */
export async function offlineSummary(): Promise<{ packs: number; bytes: number }> {
  const list = await packs();
  let bytes = 0;
  for (const p of list) {
    try { bytes += (await p.status()).completedResourceSize; } catch { /* skip */ }
  }
  return { packs: list.length, bytes };
}

/** Clears every saved map and the ambient cache (Settings: "Clear"). */
export async function clearMaps(): Promise<void> {
  for (const p of await packs()) {
    try { await OfflineManager.deletePack(p.id); } catch { /* gone */ }
  }
  packList = null;
  packStates.value = {};
  save('maps-here', null);
  try { await OfflineManager.clearAmbientCache(); } catch { /* nothing kept */ }
}

export function startOffline(): void {
  void OfflineManager.setMaximumAmbientCacheSize(AMBIENT_CACHE_BYTES).catch(() => {});
  OfflineManager.setProgressEventThrottle(1000);

  // around where you are: once, and again when you have moved a few kilometres
  let last: Coord | null = load<Coord | null>('maps-here', null);
  let busy = false;
  effect(() => {
    const me = myLocation.value;
    connection.value; mapsOverCellular.value;
    if (!me || busy || (last && distance(last, me.at) < 5000)) return;
    busy = true;
    const at = me.at;
    const name = `here:${at[0].toFixed(2)},${at[1].toFixed(2)}`;
    void saveArea(name, [
      { box: around([at[0], at[1], at[0], at[1]], 25), zooms: [4, 10] },
      { box: around([at[0], at[1], at[0], at[1]], 4), zooms: [11, MAX_ZOOM] },
    ], false).then(() => { last = at; save('maps-here', at); }).finally(() => { setTimeout(() => { busy = false; }, 60_000); });
  });

  // a trail that is opened, or followed
  effect(() => {
    const t = selected.value;
    if (t) void saveTrailMap(t.key, t.bbox);
  });
  effect(() => {
    const f = following.value;
    const box = f && bboxOf([f.path]);
    if (f && f.id && box) void saveTrailMap(`${f.region}/${f.id}`, box);
  });
  // a trail that is saved: the map a few kilometres around its start
  let known = new Set<string>();
  effect(() => {
    const list = savedTrails.value;
    for (const s of list) {
      const key = `${s.region}/${s.id}`;
      if (known.has(key)) continue;
      const reach = Math.min(8, Math.max(1, s.length / 2000)) / 111;
      void saveTrailMap(key, [s.start[0] - reach, s.start[1] - reach * 1.3, s.start[0] + reach, s.start[1] + reach * 1.3]);
    }
    known = new Set(list.map((s) => `${s.region}/${s.id}`));
  });
}
