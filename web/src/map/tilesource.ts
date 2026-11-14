// Where the base map's tiles, fonts and terrain come from, and keeping them for when there is no signal.
//
// Every map request goes through one handler ("sb://…", registered with MapLibre's addProtocol), which
// looks in this order:
//   1. a base-map file for the whole state on the device (PMTiles) — NOT BUILT YET, see statePack below;
//   2. the tile store on the device (platform.tiles): everything ever loaded is kept there;
//   3. the network (and what comes back is kept).
// So anywhere you have looked works offline, with nothing to manage. On top of that, areas are saved ahead
// quietly: around where you are, and around a trail you open, save or start. Those jobs are polite to the
// free tile server: three connections at a time, at most 12,000 tiles a job, and they back off on errors.
import { signal } from '@preact/signals';
import { platform } from '../platform';
import { load, save } from '../lib/storage';
import type { BBox } from '../lib/geo';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const TERRAIN = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
export const MAX_TILE_ZOOM = 14;
const MAX_TERRAIN_ZOOM = 11; // saved ahead to this zoom; the hill shading needs no more
export const MAX_JOB_TILES = 12_000;
const CONNECTIONS = 3;
const FONTS = ['Noto Sans Regular', 'Noto Sans Bold', 'Noto Sans Italic'];

/** True after a map request failed for want of a connection, until one succeeds. */
export const mapOffline = signal(false);

// ── The tile address (OpenFreeMap puts the data's date in it; it changes every week or so) ────────────
let template: string | null = load<string | null>('tile-template', null);
let templateAsked = 0;

async function tileTemplate(): Promise<string | null> {
  // ask again at most every six hours while it works, every minute while it does not
  const age = Date.now() - templateAsked;
  if (template && age < 6 * 3_600_000) return template;
  if (!template && age < 60_000) return null;
  templateAsked = Date.now();
  try {
    const res = await fetch(TILEJSON, { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    if (typeof json?.tiles?.[0] === 'string') {
      template = json.tiles[0];
      save('tile-template', template);
    }
  } catch { /* offline: the last one known, if any */ }
  return template;
}

// ── 1. A state's base map as one file (PMTiles) ───────────────────────────────────────────────────────
// STUB. The plan: one base-map file per state, built in CI and published beside the trail files, that
// the app downloads with a state's trails. When that exists: add the "pmtiles" package, open the files
// kept by platform.fileStore, and return the tile's bytes here (null when no file covers it). Until then
// this always answers null and the handler goes on to the tile store and the network.
async function statePack(_key: string): Promise<ArrayBuffer | null> {
  return null;
}

// ── The handler ───────────────────────────────────────────────────────────────────────────────────────
const EMPTY = new ArrayBuffer(0);

function addressOf(key: string, tiles: string | null): string | null {
  const [kind, ...rest] = key.split('/');
  if (kind === 'g') return GLYPHS.replace('{fontstack}', encodeURIComponent(rest[0])).replace('{range}', rest[1]);
  const [z, x, y] = rest;
  const fill = (t: string) => t.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  if (kind === 'd') return fill(TERRAIN);
  return tiles ? fill(tiles) : null;
}

/** One tile, font range or terrain tile: from the device if it is there, else from the network (and kept). */
export async function fetchMapData(key: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const packed = await statePack(key);
  if (packed) return packed;
  const kept = await platform.tiles.get(key);
  if (kept) return kept;
  const url = addressOf(key, key.startsWith('v/') ? await tileTemplate() : null);
  if (!url) throw new Error('offline');
  let res: Response;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error)?.name !== 'AbortError') mapOffline.value = true;
    throw e;
  }
  mapOffline.value = false;
  // no tile there (open sea, beyond the data): remember that, so it is not asked for again
  if (res.status === 404 || res.status === 204) {
    void platform.tiles.put(key, EMPTY);
    return EMPTY;
  }
  if (!res.ok) throw new Error(`map ${res.status}`);
  const data = await res.arrayBuffer();
  void platform.tiles.put(key, data);
  return data;
}

/** The function MapLibre calls for every "sb://" address. */
export async function mapProtocol(params: { url: string }, abort: AbortController): Promise<{ data: ArrayBuffer }> {
  const key = decodeURIComponent(params.url.slice('sb://'.length));
  try {
    return { data: await fetchMapData(key, abort.signal) };
  } catch (e) {
    // a missing font must not take the trail lines down with it: an empty answer draws no names
    if (key.startsWith('g/')) return { data: EMPTY };
    throw e;
  }
}

/** The base style with its sources pointed at the handler. */
export function throughStore<T extends { glyphs?: string; sources: Record<string, any> }>(style: T): T {
  const sources: Record<string, any> = { ...style.sources };
  for (const [id, src] of Object.entries(sources)) {
    if (src.type === 'vector') {
      const { url: _url, ...rest } = src;
      sources[id] = { ...rest, tiles: ['sb://v/{z}/{x}/{y}'], minzoom: 0, maxzoom: MAX_TILE_ZOOM };
    } else if (src.type === 'raster-dem') {
      sources[id] = { ...src, tiles: ['sb://d/{z}/{x}/{y}'] };
    }
  }
  return { ...style, glyphs: 'sb://g/{fontstack}/{range}', sources };
}

// ── Saving areas ahead ────────────────────────────────────────────────────────────────────────────────
const tileX = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
const tileY = (lat: number, z: number) => {
  const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

/** The keys of everything needed to draw a box from `minZoom` to `maxZoom`. */
export function keysFor(box: BBox, minZoom: number, maxZoom: number): string[] {
  const out: string[] = [];
  for (let z = minZoom; z <= Math.min(maxZoom, MAX_TILE_ZOOM); z++) {
    const n = 2 ** z - 1;
    const x0 = Math.max(0, tileX(box[1], z)), x1 = Math.min(n, tileX(box[3], z));
    const y0 = Math.max(0, tileY(box[2], z)), y1 = Math.min(n, tileY(box[0], z));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        out.push(`v/${z}/${x}/${y}`);
        if (z <= MAX_TERRAIN_ZOOM) out.push(`d/${z}/${x}/${y}`);
      }
    }
  }
  return out;
}

const fontKeys = () => FONTS.flatMap((f) => [`g/${f}/0-255`, `g/${f}/256-511`]);

/** A box with a margin in kilometres. */
export function around(box: BBox, km: number): BBox {
  const dLat = km / 111.32, dLon = km / (111.32 * Math.max(0.2, Math.cos(((box[0] + box[2]) / 2) * Math.PI / 180)));
  return [box[0] - dLat, box[1] - dLon, box[2] + dLat, box[3] + dLon];
}

export interface MapJob { done: number; total: number; state: 'saving' | 'ready' | 'failed' | 'waiting' }
/** Jobs by name ("trail:<key>", "here", "area"), for the small status lines. */
export const mapJobs = signal<Record<string, MapJob>>({});
const setJob = (name: string, job: MapJob) => { mapJobs.value = { ...mapJobs.value, [name]: job }; };

/** Whether background downloads may run now: never without a connection; on mobile data only if allowed. */
export async function mayDownload(overCellular: boolean): Promise<boolean> {
  const kind = await platform.network.kind();
  if (kind === 'none') return false;
  return kind !== 'cellular' || overCellular;
}

const queue: { key: string; done: (ok: boolean) => void }[] = [];
let running = 0;
let failures = 0;
let pausedUntil = 0;

function pump(): void {
  while (running < CONNECTIONS && queue.length) {
    const wait = pausedUntil - Date.now();
    if (wait > 0) { setTimeout(pump, wait + 50); return; }
    const item = queue.shift()!;
    running++;
    fetchMapData(item.key, AbortSignal.timeout(20_000)).then(
      () => { failures = 0; item.done(true); },
      () => {
        // back off: 5 s, 10 s, 20 s… up to two minutes between tries while the server or the signal is unhappy
        failures++;
        pausedUntil = Date.now() + Math.min(120_000, 5000 * 2 ** Math.min(failures - 1, 5));
        item.done(false);
      },
    ).finally(() => { running--; pump(); });
  }
}

const running_jobs = new Map<string, Promise<MapJob>>();

/** What is still missing of a list of keys. */
async function missing(keys: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const k of keys) if (!(await platform.tiles.has(k))) out.push(k);
  return out;
}

/**
 * Saves an area for offline use, in the background. Resolves when it is done (or has given up).
 * `zooms`: [from, to]. A job is cut down to MAX_JOB_TILES by dropping its closest zoom levels.
 */
export function saveArea(name: string, parts: { box: BBox; zooms: [number, number] }[]): Promise<MapJob> {
  const already = running_jobs.get(name);
  if (already) return already;
  const job = (async (): Promise<MapJob> => {
    let keys: string[] = [];
    let trim = 0;
    do {
      keys = [...new Set([...fontKeys(), ...parts.flatMap((p) => keysFor(p.box, p.zooms[0], p.zooms[1] - trim))])];
      trim++;
    } while (keys.length > MAX_JOB_TILES && trim < 8);
    const todo = await missing(keys);
    const total = keys.length;
    let done = total - todo.length, failed = 0;
    if (!todo.length) { const j: MapJob = { done, total, state: 'ready' }; setJob(name, j); return j; }
    setJob(name, { done, total, state: 'saving' });
    await new Promise<void>((resolve) => {
      let left = todo.length;
      for (const key of todo) {
        queue.push({
          key,
          done: (ok) => {
            if (ok) done++; else failed++;
            if (--left === 0) resolve();
            else if ((done + failed) % 8 === 0) setJob(name, { done, total, state: 'saving' });
          },
        });
      }
      pump();
    });
    const j: MapJob = { done, total, state: failed === 0 ? 'ready' : 'failed' };
    setJob(name, j);
    return j;
  })().finally(() => running_jobs.delete(name));
  running_jobs.set(name, job);
  return job;
}

/** Whether an area is already on the device (nothing is fetched). */
export async function areaReady(parts: { box: BBox; zooms: [number, number] }[]): Promise<boolean> {
  const keys = parts.flatMap((p) => keysFor(p.box, p.zooms[0], p.zooms[1])).filter((k) => k.startsWith('v/'));
  if (keys.length > MAX_JOB_TILES) return false;
  return (await missing(keys)).length === 0;
}

/** The map around a trail: to zoom 14 with about a kilometre of margin, and a wider view above it. */
export const trailParts = (box: BBox): { box: BBox; zooms: [number, number] }[] => [
  { box: around(box, 1), zooms: [10, MAX_TILE_ZOOM] },
  { box: around(box, 12), zooms: [5, 9] },
];

/** The map around a place: about 25 km at overview zooms, and to zoom 14 within a few kilometres. */
export const hereParts = (lat: number, lon: number): { box: BBox; zooms: [number, number] }[] => [
  { box: around([lat, lon, lat, lon], 25), zooms: [4, 10] },
  { box: around([lat, lon, lat, lon], 4), zooms: [11, MAX_TILE_ZOOM] },
];

/** How many tiles a job would need, for saying its size before it starts. About 18 KB a tile on average. */
export function countFor(parts: { box: BBox; zooms: [number, number] }[]): number {
  return parts.reduce((n, p) => n + keysFor(p.box, p.zooms[0], p.zooms[1]).length, 0);
}
export const BYTES_PER_TILE = 18_000;
