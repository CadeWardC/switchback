// Loading trails from the packs published next to the site (./data/regions.json and ./data/<region>.trails).
// A region's file is fetched once, kept in memory and in the browser's Cache Storage (so the next visit needs
// no download), and only the cells the map shows are unpacked.
import { cellKeyOf, cellKeys, openPack, readBlock, regionCovers, type Pack, type Region } from './lib/pack';
import { makeTrail, type RawTrail, type Trail } from './lib/trail';
import { expand, intersects, type BBox } from './lib/geo';
import type { Coord } from './lib/polyline';

import { platform } from './platform';

let regionList: Promise<Region[]> | null = null;

async function fetchRegions(): Promise<Region[]> {
  const res = await fetch(platform.trailFiles.url('regions.json'), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`The list of regions could not be loaded (${res.status})`);
  const json = (await res.json()) as { regions: Record<string, Region> };
  return Object.values(json.regions).filter((r) => Array.isArray(r.bbox) && r.bbox.length === 4);
}

export function loadRegions(): Promise<Region[]> {
  if (!regionList) {
    const p = fetchRegions();
    regionList = p;
    p.catch(() => { if (regionList === p) regionList = null; });
  }
  return regionList;
}

export const regionName = (r: Region) =>
  r.name ?? r.region.replace(/^ca-/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ── Region files ──────────────────────────────────────────────────────────────────────────────────────
// Kept on the device as "<region>@<version>.trails".
const packs = new Map<string, Promise<Pack | null>>();
const openedPacks = new Map<string, Pack>();
const stored = (r: Region) => `${r.region}@${r.version}.trails`;
const regionOfStored = (name: string) => name.slice(0, name.lastIndexOf('@'));

async function fetchPack(r: Region): Promise<Pack | null> {
  const name = stored(r);
  const kept = await platform.fileStore.read(name);
  if (kept) {
    try {
      const pack = openPack(kept);
      openedPacks.set(r.region, pack);
      return pack;
    } catch { /* a broken copy: download it again */ }
  }
  const res = await fetch(`${platform.trailFiles.url(`${r.region}.trails`)}?v=${encodeURIComponent(r.version)}`);
  if (!res.ok) throw new Error(`${regionName(r)} trails could not be loaded (${res.status})`);
  const data = await res.arrayBuffer();
  const pack = openPack(data);
  openedPacks.set(r.region, pack);
  // older versions of this region's file are not needed any more
  for (const old of await platform.fileStore.list()) {
    if (old !== name && regionOfStored(old) === r.region) await platform.fileStore.remove(old);
  }
  await platform.fileStore.write(name, data); // if it can't be kept, the file still works from memory
  return pack;
}

export function loadPack(r: Region): Promise<Pack | null> {
  let p = packs.get(r.region);
  if (!p) {
    p = fetchPack(r);
    packs.set(r.region, p);
    p.catch(() => packs.delete(r.region)); // try again next time the map shows it
  }
  return p;
}

export interface TrailFilesInfo { regions: string[]; bytes: number }

/** The trail files kept on this device. */
export async function trailFilesOnDevice(): Promise<TrailFilesInfo> {
  const names = await platform.fileStore.list();
  let all: Region[] = [];
  try { all = await loadRegions(); } catch { /* names only */ }
  const ids = [...new Set(names.map(regionOfStored))];
  return {
    regions: ids.map((id) => { const r = all.find((x) => x.region === id); return r ? regionName(r) : id; }).sort(),
    bytes: ids.reduce((n, id) => n + (all.find((x) => x.region === id)?.bytes ?? 0), 0),
  };
}

/** Throws away every trail file on the device and downloads the current ones again. Nothing is removed
 *  unless the list of files can be reached. Returns a sentence saying what happened. */
export async function resetTrailFiles(): Promise<string> {
  let fresh: Region[];
  try {
    fresh = await fetchRegions();
  } catch {
    return "Couldn't reach the trail files, so nothing was removed. Check your connection and try again.";
  }
  // let downloads already under way finish first, so they don't write a file after the reset
  await Promise.allSettled([...packs.values()]);
  const names = await platform.fileStore.list();
  const had = new Set([...names.map(regionOfStored), ...openedPacks.keys()]);
  regionList = Promise.resolve(fresh);
  packs.clear();
  openedPacks.clear();
  cells.clear();
  highlightCells.clear();
  indexed.clear();
  for (const n of names) await platform.fileStore.remove(n);
  // smallest first, so the most regions are back soonest
  const todo = fresh.filter((r) => had.has(r.region)).sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0));
  if (!todo.length) return 'Trail files were reset. They download again when the map shows a region.';
  let done = 0;
  for (const r of todo) {
    try { if (await loadPack(r)) done++; } catch { /* counted below */ }
  }
  if (done < todo.length) {
    return `Downloaded ${done} of ${todo.length} regions again. The rest download when the map shows them.`;
  }
  return `Downloaded ${done} ${done === 1 ? 'region' : 'regions'} again (${todo.map(regionName).slice(0, 3).join(', ')}${todo.length > 3 ? '…' : ''}).`;
}

// ── Cells ─────────────────────────────────────────────────────────────────────────────────────────────
const cells = new Map<string, Trail[]>();
const MAX_CELLS = 900;

async function cellTrails(region: string, pack: Pack, key: string): Promise<Trail[]> {
  const memKey = `${region}/${key}`;
  const have = cells.get(memKey);
  if (have) return have;
  let trails: Trail[] = [];
  try {
    const rows = await readBlock<RawTrail[]>(pack, key);
    if (Array.isArray(rows)) {
      for (const raw of rows) {
        try {
          const t = makeTrail(region, raw);
          // informal paths (not for hikers, or on no official list) are left out, as the apps do by default
          if (t && t.tags['switchback:informal'] !== 'yes') trails.push(t);
        } catch { /* one bad trail does not take its neighbours with it */ }
      }
    }
  } catch (e) {
    console.warn(`trail cell ${memKey} could not be read`, e);
  }
  if (cells.size >= MAX_CELLS) {
    // forget the oldest half
    let n = 0;
    for (const k of cells.keys()) { if (n++ > MAX_CELLS / 2) break; cells.delete(k); }
  }
  cells.set(memKey, trails);
  return trails;
}

const pause = () => new Promise<void>((r) => setTimeout(r, 0));

export interface ViewTrails {
  trails: Trail[];
  /** Regions that should have had trails here but could not be loaded. */
  failed: string[];
  /** No region covers this part of the map. */
  uncovered: boolean;
}

/** Every trail that starts in (or just outside) a box. `alive` lets a newer request cancel this one. */
export async function trailsIn(box: BBox, alive: () => boolean = () => true): Promise<ViewTrails | null> {
  const all = await loadRegions();
  const wide = expand(box, 0.12); // a trail is stored where it starts, which may be just off screen
  const covering = all.filter((r) => regionCovers(r, wide));
  const out: Trail[] = [], failed: string[] = [];
  let tick = performance.now();
  await Promise.all(covering.map(async (r) => {
    let pack: Pack | null = null;
    try { pack = await loadPack(r); } catch { /* reported below */ }
    if (!pack) { failed.push(regionName(r)); return; }
    for (const key of cellKeys(wide, pack.header.cell)) {
      if (!pack.header.cells[key]) continue;
      if (!alive()) return;
      for (const t of await cellTrails(r.region, pack, key)) if (intersects(t.bbox, wide)) out.push(t);
      // let the page breathe while a whole state unpacks
      if (performance.now() - tick > 12) { await pause(); tick = performance.now(); }
    }
  }));
  if (!alive()) return null;
  return { trails: out, failed, uncovered: covering.length === 0 };
}

/** One trail by region and id (a shared link). Looks where its id says it starts first, then everywhere. */
export async function findTrail(region: string, id: string): Promise<Trail | null> {
  const r = (await loadRegions()).find((x) => x.region === region);
  if (!r) return null;
  const pack = await loadPack(r);
  if (!pack) return null;
  const tried = new Set<string>();
  const look = async (key: string) => {
    if (tried.has(key) || !pack.header.cells[key]) return null;
    tried.add(key);
    return (await cellTrails(region, pack, key)).find((t) => t.id === id) ?? null;
  };
  // ids of named paths end in the start, rounded: "wBluff Trail-38.942,-92.310"
  const at = /(-?\d+\.\d+),(-?\d+\.\d+)(?:\||$)/.exec(id);
  if (at) {
    const size = pack.header.cell, lat = +at[1], lon = +at[2];
    for (const dLat of [0, -size, size]) {
      for (const dLon of [0, -size, size]) {
        const hit = await look(cellKeyOf(lat + dLat, lon + dLon, size));
        if (hit) return hit;
      }
    }
  }
  for (const key of Object.keys(pack.header.cells)) {
    if (key.startsWith('p:')) continue;
    const hit = await look(key);
    if (hit) return hit;
  }
  return null;
}

// ── Highlights (viewpoints, water, parking… near trails) ──────────────────────────────────────────────
export interface Highlight { lat: number; lon: number; kind: string; name: string | null; elevation: number | null; id: string }

const highlightCells = new Map<string, Highlight[]>();

export async function highlightsIn(box: BBox): Promise<Highlight[]> {
  const out: Highlight[] = [];
  for (const r of (await loadRegions()).filter((x) => regionCovers(x, box))) {
    const pack = openedPacks.get(r.region);
    if (!pack) continue;
    for (const key of cellKeys(box, pack.header.cell)) {
      const memKey = `${r.region}/${key}`;
      let rows = highlightCells.get(memKey);
      if (!rows) {
        rows = [];
        try {
          const raw = await readBlock<unknown[][]>(pack, `p:${key}`);
          for (const row of raw ?? []) {
            if (!Array.isArray(row) || row.length < 6 || typeof row[0] !== 'number' || typeof row[1] !== 'number') continue;
            rows.push({
              lat: row[0] / 1e5, lon: (row[1] as number) / 1e5, kind: String(row[2]),
              name: typeof row[3] === 'string' && row[3] ? row[3] : null,
              elevation: typeof row[4] === 'number' ? row[4] : null, id: `node${row[5]}`,
            });
          }
        } catch { /* no highlights for this cell */ }
        if (highlightCells.size > 400) highlightCells.clear();
        highlightCells.set(memKey, rows);
      }
      for (const h of rows) if (h.lat >= box[0] && h.lat <= box[2] && h.lon >= box[1] && h.lon <= box[3]) out.push(h);
    }
  }
  return out;
}

// ── Search ────────────────────────────────────────────────────────────────────────────────────────────
export interface SearchHit {
  kind: 'trail' | 'area' | 'region';
  title: string;
  subtitle: string;
  trail?: Trail;
  center?: Coord;
  bounds?: BBox;
}

const indexed = new Map<string, Promise<Trail[]>>();

/** Every trail of a region whose file is already here (unpacks the whole file once, a little at a time). */
function regionTrails(region: string, pack: Pack): Promise<Trail[]> {
  let p = indexed.get(region);
  if (!p) {
    p = (async () => {
      const out: Trail[] = [];
      let tick = performance.now();
      for (const key of Object.keys(pack.header.cells)) {
        if (key.startsWith('p:')) continue;
        const start = pack.bodyStart + pack.header.cells[key][0];
        // straight from the file, without filling the cell cache with a whole state
        const have = cells.get(`${region}/${key}`);
        if (have) { out.push(...have); continue; }
        try {
          const rows = await readBlock<RawTrail[]>(pack, key);
          for (const raw of rows ?? []) {
            const t = makeTrail(region, raw);
            if (t && t.tags['switchback:informal'] !== 'yes') out.push(t);
          }
        } catch { void start; }
        if (performance.now() - tick > 12) { await pause(); tick = performance.now(); }
      }
      return out;
    })();
    indexed.set(region, p);
  }
  return p;
}

const fold = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Trails, areas and regions matching some words. Trails and areas come from the regions loaded so far. */
export async function search(text: string, near: Coord | null): Promise<SearchHit[]> {
  const words = fold(text).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const match = (s: string) => { const f = fold(s); return words.every((w) => f.includes(w)); };
  const all = await loadRegions();
  const hits: SearchHit[] = [];
  for (const r of all) {
    if (match(regionName(r))) {
      hits.push({
        kind: 'region', title: regionName(r),
        subtitle: r.trails ? `${r.trails.toLocaleString()} trails` : 'Region', bounds: r.bbox,
      });
    }
  }
  const trails: Trail[] = [], areas = new Map<string, { n: number; box: BBox; region: string }>();
  for (const [region, pack] of openedPacks) {
    const r = all.find((x) => x.region === region);
    for (const t of await regionTrails(region, pack)) {
      if (t.area && match(t.area)) {
        const key = `${region}/${t.area}`, a = areas.get(key);
        if (a) {
          a.n++;
          a.box = [Math.min(a.box[0], t.bbox[0]), Math.min(a.box[1], t.bbox[1]), Math.max(a.box[2], t.bbox[2]), Math.max(a.box[3], t.bbox[3])];
        } else areas.set(key, { n: 1, box: [...t.bbox] as BBox, region: r ? regionName(r) : region });
      }
      if (t.tags['switchback:unnamed'] !== 'yes' && match(t.name)) trails.push(t);
    }
  }
  for (const [key, a] of areas) {
    hits.push({
      kind: 'area', title: key.slice(key.indexOf('/') + 1),
      subtitle: `${a.n} ${a.n === 1 ? 'trail' : 'trails'} · ${a.region}`, bounds: a.box,
    });
  }
  const d2 = (t: Trail) => (near ? (t.start[0] - near[0]) ** 2 + ((t.start[1] - near[1]) * Math.cos(near[0] * Math.PI / 180)) ** 2 : 0);
  trails.sort((a, b) => Number(b.isHike) - Number(a.isHike) || d2(a) - d2(b));
  const regionOf = (t: Trail) => { const r = all.find((x) => x.region === t.region); return r ? regionName(r) : t.region; };
  for (const t of trails.slice(0, 40)) {
    hits.push({ kind: 'trail', title: t.name, subtitle: [t.area, regionOf(t)].filter(Boolean).join(' · '), trail: t });
  }
  return hits.slice(0, 60);
}

export const loadedRegionCount = () => openedPacks.size;
