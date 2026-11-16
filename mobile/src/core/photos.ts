// Photos of a trail, so people can recognise it by its picture.
//
// One small interface: photosFor(trail). Behind it is a list of sources; today there is one, Wikimedia
// Commons, found the way the Swift app does (Switchback/Services/Photos.swift): photos the map data links to
// first (the trail's `wikimedia_commons`, `image` and `wikidata` tags), then photos taken at the sights along
// the trail and along its line. Author and licence come with every photo and are always shown.
// ── TO ADD HIKERS' OWN PHOTOS LATER: write another PhotoSource and put it first in SOURCES. ──
// What is found is kept on the phone (docs/photos.json), so a trail is looked up once. Nothing here blocks
// the screen: with no connection, or no photos, the answer is an empty list.
import { pointAlong, lineLength } from '@web/lib/geo';
import { loadDoc, saveDoc } from '@web/lib/storage';
import type { Trail } from '@web/lib/trail';
import type { Coord } from '@web/lib/polyline';
import { highlightsIn } from '@web/data';

export interface TrailPhoto {
  /** Unique within its source ("File:…" on Commons). */
  id: string;
  /** A picture about 960 px wide, and a small one for lists. */
  url: string;
  small: string;
  /** The page about it (where the licence is spelled out). */
  page?: string;
  author?: string;
  license?: string;
  source: string;
}

export interface PhotoSource {
  name: string;
  /** `first`: stop at the first photo found (a list card needs one). */
  find(trail: Trail, first: boolean): Promise<TrailPhoto[]>;
}

/** "Jane Doe · CC BY-SA 4.0 · Wikimedia Commons" */
export function credit(p: TrailPhoto): string {
  return [p.author, p.license, p.source].filter(Boolean).join(' · ');
}

// ── Wikimedia Commons ─────────────────────────────────────────────────────────────────────────────────
const API = 'https://commons.wikimedia.org/w/api.php';
const HEADERS = { 'Api-User-Agent': 'Switchback/1.0 (hiking app; https://github.com/cadewardc/switchback)', Accept: 'application/json' };
const MAX_PHOTOS = 14;
const NOT_PHOTOS = ['map', 'karte', 'carte', 'diagram', 'logo', 'sign', 'plan', 'profile', 'locator'];

/** A Commons thumbnail address at another width (Commons serves a fixed set of widths: 250 and 960 are two). */
export const sized = (url: string, px: number) => url.replace(/\/\d+px-([^/]+)$/, `/${px}px-$1`);

const stripHtml = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();

/** One page of a Commons answer as a photo, or null when it is not a real photo (a map, a logo, too small). */
export function photoFromPage(page: any): TrailPhoto | null {
  const info = page?.imageinfo?.[0];
  if (!info || typeof info.thumburl !== 'string' || typeof page.title !== 'string') return null;
  if (info.mime !== 'image/jpeg' || !(info.width >= 640) || !(info.height >= 400)) return null;
  const lower = page.title.toLowerCase();
  if (NOT_PHOTOS.some((w) => lower.includes(w))) return null;
  const artist = typeof info.extmetadata?.Artist?.value === 'string' ? stripHtml(info.extmetadata.Artist.value).slice(0, 60) : '';
  const license = typeof info.extmetadata?.LicenseShortName?.value === 'string' ? stripHtml(info.extmetadata.LicenseShortName.value) : '';
  return {
    id: page.title, url: info.thumburl, small: sized(info.thumburl, 250), source: 'Wikimedia Commons',
    ...(typeof info.descriptionurl === 'string' ? { page: info.descriptionurl } : {}),
    ...(artist ? { author: artist } : {}), ...(license ? { license } : {}),
  };
}

/** "https://commons.wikimedia.org/wiki/File:X.jpg" or "File:X.jpg" → "File:X.jpg". */
export function commonsTitle(s: string | undefined): string | null {
  if (!s) return null;
  const at = s.indexOf('File:');
  if (at < 0) return null;
  try { return decodeURIComponent(s.slice(at)).replace(/_/g, ' '); } catch { return s.slice(at); }
}

/** The files a trail's tags point to. */
export function linkedTitles(tags: Record<string, string>): string[] {
  const out: string[] = [];
  for (const t of [commonsTitle(tags.wikimedia_commons), commonsTitle(tags.image)]) if (t && !out.includes(t)) out.push(t);
  return out;
}

/** `count` places spread evenly along a line. */
export function sampleSpots(path: Coord[], count: number): Coord[] {
  const total = lineLength(path);
  if (path.length < 2 || !(total > 0)) return path.slice(0, 1);
  return Array.from({ length: count }, (_, i) => pointAlong(path, (total * (i + 0.5)) / count));
}

const query = (params: Record<string, string>) => Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

async function getJson(url: string, ms = 15_000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers: HEADERS, signal: ctl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function commonsQuery(extra: Record<string, string>): Promise<TrailPhoto[]> {
  const json = await getJson(`${API}?${query({
    action: 'query', format: 'json', prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: '960',
    iiextmetadatafilter: 'Artist|LicenseShortName', ...extra,
  })}`);
  const pages = json?.query?.pages;
  if (!pages || typeof pages !== 'object') return [];
  return Object.values(pages).map(photoFromPage).filter((p): p is TrailPhoto => !!p);
}

async function byTitles(titles: string[]): Promise<TrailPhoto[]> {
  if (!titles.length) return [];
  const found = await commonsQuery({ titles: titles.slice(0, 20).join('|') });
  // in the order asked for
  return titles.flatMap((t) => found.filter((p) => p.id === t));
}

const near = (c: Coord, radius: number) => commonsQuery({
  generator: 'geosearch', ggsnamespace: '6', ggscoord: `${c[0].toFixed(5)}|${c[1].toFixed(5)}`, ggsradius: String(Math.min(10_000, radius)), ggslimit: '8',
});

/** The main image (P18) of a Wikidata item, as a Commons file name. */
async function wikidataImage(id: string): Promise<string | null> {
  if (!/^Q\d+$/.test(id)) return null;
  try {
    const json = await getJson(`https://www.wikidata.org/w/api.php?${query({ action: 'wbgetclaims', format: 'json', property: 'P18', entity: id })}`);
    const value = json?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    return typeof value === 'string' ? `File:${value}` : null;
  } catch {
    return null;
  }
}

const SIGHTS = new Set(['viewpoint', 'waterfall', 'peak', 'cave']);

export const commons: PhotoSource = {
  name: 'Wikimedia Commons',
  async find(trail, first) {
    // 1. photos the map data points to (a failure here means no connection: give up, and try another day)
    const titles = linkedTitles(trail.tags);
    const q = trail.tags.wikidata ? await wikidataImage(trail.tags.wikidata) : null;
    if (q && !titles.includes(q)) titles.push(q);
    const photos = await byTitles(titles);
    if (first && photos.length) return photos;
    // 2. photos taken at the sights along the trail, then along its line
    const spots: { at: Coord; radius: number }[] = [];
    try {
      const s = Math.min(...trail.path.map((c) => c[0])), n = Math.max(...trail.path.map((c) => c[0]));
      const w = Math.min(...trail.path.map((c) => c[1])), e = Math.max(...trail.path.map((c) => c[1]));
      for (const h of await highlightsIn([s - 0.001, w - 0.001, n + 0.001, e + 0.001])) {
        if (SIGHTS.has(h.kind) && spots.length < 4) spots.push({ at: [h.lat, h.lon], radius: 150 });
      }
    } catch { /* no sights known */ }
    for (const at of sampleSpots(trail.path, trail.isLoop ? 3 : 4)) spots.push({ at, radius: 300 });
    for (const spot of spots) {
      if (photos.length >= MAX_PHOTOS || (first && photos.length)) break;
      for (const p of await near(spot.at, spot.radius)) if (!photos.some((x) => x.id === p.id)) photos.push(p);
    }
    return photos.slice(0, MAX_PHOTOS);
  },
};

// ── The one interface ─────────────────────────────────────────────────────────────────────────────────
const SOURCES: PhotoSource[] = [commons];

interface Kept { t: number; all: boolean; photos: TrailPhoto[] }
const DOC = 'photos.json';
const MAX_KEPT = 1500;
/** "None found" is believed for this long, then looked up again. */
const EMPTY_FOR = 21 * 86_400_000;

let kept: Record<string, Kept> | null = null;
let loading: Promise<Record<string, Kept>> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
const running = new Map<string, Promise<TrailPhoto[]>>();

function store(): Promise<Record<string, Kept>> {
  return (loading ??= loadDoc<Record<string, Kept>>(DOC, {}).then((d) => (kept = d && typeof d === 'object' ? d : {})));
}

function remember(key: string, value: Kept): void {
  if (!kept) return;
  kept[key] = value;
  const keys = Object.keys(kept);
  if (keys.length > MAX_KEPT) for (const k of keys.slice(0, keys.length - 1000)) delete kept[k];
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { void saveDoc(DOC, kept); }, 1500);
}

/** Whether what is kept answers the question (all of them, or just one), and is not a stale "none". */
function usable(k: Kept | undefined, needAll: boolean): boolean {
  if (!k || (needAll && !k.all)) return false;
  return k.photos.length > 0 || Date.now() - k.t < EMPTY_FOR;
}

/** What is already known about a trail's photos, at once (undefined: not looked up yet). */
export function knownPhotos(key: string): TrailPhoto[] | undefined {
  return kept?.[key]?.photos;
}

/** A trail's photos. `first`: one is enough (list cards). Never throws; an empty list when there are none or
 *  there is no connection (a failed lookup is not kept, so it is tried again later). */
export async function photosFor(trail: Trail, first = false): Promise<TrailPhoto[]> {
  if (trail.id.startsWith('nv:')) return [];
  const all = await store();
  const have = all[trail.key];
  if (have && usable(have, !first)) return have.photos;
  const job = `${trail.key}|${first ? 1 : 0}`;
  let run = running.get(job);
  if (!run) {
    run = (async () => {
      const photos: TrailPhoto[] = [];
      for (const source of SOURCES) {
        if (first && photos.length) break;
        for (const p of await source.find(trail, first)) if (!photos.some((x) => x.id === p.id && x.source === p.source)) photos.push(p);
      }
      // a search that found nothing while looking for one photo is a full answer too
      remember(trail.key, { t: Date.now(), all: !first || !photos.length, photos });
      return photos;
    })().catch(() => have?.photos ?? []).finally(() => running.delete(job));
    running.set(job, run);
  }
  return run;
}
