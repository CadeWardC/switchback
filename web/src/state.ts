// What the whole site shares: settings, where the map is, the trails in view, and which page is open.
import { computed, effect, signal } from '@preact/signals';
import { defaultUnits, type Units } from './lib/format';
import {
  load, loadDoc, migrateFromKeyValue, save, saveDoc, summaryOf, walkDoc, type Marker, type PlannedRoute, type SavedTrail, type Walk,
  type WalkPoint, type WalkSummary,
} from './lib/storage';
import { platform } from './platform';
import { filters, passes } from './filters';
import type { Coord } from './lib/polyline';
import type { Profile, Trail } from './lib/trail';
import type { Stop } from './lib/follow';
import type { BBox } from './lib/geo';
import type { Region } from './lib/pack';

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────────
export const units = signal<Units>(load<Units | null>('units', null) ?? defaultUnits());
export type ThemePref = 'auto' | 'light' | 'dark';
export const themePref = signal<ThemePref>(load<ThemePref>('theme', 'auto'));
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
const systemDark = signal(!!media?.matches);
media?.addEventListener('change', (e) => (systemDark.value = e.matches));
export const dark = computed(() => (themePref.value === 'auto' ? systemDark.value : themePref.value === 'dark'));

effect(() => { save('units', units.value); });
effect(() => { save('theme', themePref.value); });
effect(() => {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark.value ? '#0d1512' : '#edf0ec');
});

// ── Signal ──
/** False when the device says it has no connection at all. (True does not promise the internet works.) */
export const online = signal(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => (online.value = true));
  window.addEventListener('offline', () => (online.value = false));
}
/** Map downloads in the background may use mobile data (off: Wi-Fi only). */
export const mapsOverCellular = signal<boolean>(load<boolean>('maps-cellular', false));
effect(() => { save('maps-cellular', mapsOverCellular.value); });

// ── Pages ─────────────────────────────────────────────────────────────────────────────────────────────
export type Route =
  | { page: 'explore' }
  | { page: 'trail'; region: string; id: string }
  | { page: 'record' }
  | { page: 'saved' }
  | { page: 'plan' }
  | { page: 'activity' }
  | { page: 'walk'; id: string }
  | { page: 'settings' }
  | { page: 'help' };

export interface MapView { lat: number; lon: number; zoom: number }

/** Reads "#/trail/<region>/<id>", "#/record", "#/saved", "#/plan", "#/activity", "#/activity/<id>",
 *  "#/settings", or "#/@lat,lon,zoom" (a place on the map). */
export function parseHash(hash: string): { route: Route; view?: MapView } {
  const h = hash.replace(/^#\/?/, '');
  const at = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z?$/.exec(h);
  if (at) return { route: { page: 'explore' }, view: { lat: +at[1], lon: +at[2], zoom: +at[3] } };
  const parts = h.split('/');
  try {
    if (parts[0] === 'trail' && parts.length >= 3) {
      return { route: { page: 'trail', region: decodeURIComponent(parts[1]), id: decodeURIComponent(parts.slice(2).join('/')) } };
    }
    if ((parts[0] === 'activity' || parts[0] === 'log') && parts[1]) return { route: { page: 'walk', id: decodeURIComponent(parts[1]) } };
  } catch { /* a broken link: fall through to the map */ }
  if (parts[0] === 'record' || parts[0] === 'saved' || parts[0] === 'plan' || parts[0] === 'activity' || parts[0] === 'settings' || parts[0] === 'help') {
    return { route: { page: parts[0] } };
  }
  if (parts[0] === 'about') return { route: { page: 'settings' } };
  // the words on the row: Hike is where a hike is recorded, Log is the hikes you have recorded
  if (parts[0] === 'hike') return { route: { page: 'record' } };
  if (parts[0] === 'log') return { route: { page: 'activity' } };
  return { route: { page: 'explore' } };
}

export function hashFor(r: Route): string {
  switch (r.page) {
    case 'trail': return `#/trail/${encodeURIComponent(r.region)}/${encodeURIComponent(r.id)}`;
    case 'walk': return `#/log/${encodeURIComponent(r.id)}`;
    case 'record': return '#/hike';
    case 'activity': return '#/log';
    case 'explore': return '#/';
    default: return `#/${r.page}`;
  }
}

/** Which tab a page belongs to. */
export type Tab = 'explore' | 'record' | 'saved' | 'activity' | 'settings';
export function tabOf(r: Route): Tab {
  switch (r.page) {
    case 'trail': return 'explore';
    case 'plan': return 'saved';
    case 'help': return 'saved';
    case 'walk': return 'activity';
    default: return r.page;
  }
}

const first = parseHash(typeof location === 'undefined' ? '' : location.hash);
export const route = signal<Route>(first.route);
/** Where the map starts: from the link, else where it was last time, else the whole of the US. */
export const initialView: MapView = first.view ?? load<MapView | null>('view', null) ?? { lat: 39.5, lon: -98.35, zoom: 3.4 };
export const hasSavedView = !!first.view || load<MapView | null>('view', null) != null;
/** The app was opened on a link to a place or a trail (so it should not jump to where you are). */
export const openedAt = !!first.view || first.route.page === 'trail';

export function go(r: Route): void {
  const h = hashFor(r);
  if (location.hash !== h) location.hash = h; // the hashchange listener sets `route`
  else route.value = r;
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => {
    const p = parseHash(location.hash);
    route.value = p.route;
    if (p.view) flyTo.value = { center: [p.view.lat, p.view.lon], zoom: p.view.zoom };
  });
}

// ── The map ───────────────────────────────────────────────────────────────────────────────────────────
export const MIN_TRAIL_ZOOM = 8;
export interface ViewState { center: Coord; zoom: number; bounds: BBox }
export const view = signal<ViewState | null>(null);
/** Ask the map to move. */
export const flyTo = signal<{ center?: Coord; zoom?: number; bounds?: BBox } | null>(null);
/** full: the outdoor base map is drawing. plain: it could not be reached, so trails draw on a plain background. */
export const baseMap = signal<'checking' | 'full' | 'plain'>('checking');
/** The point being hovered on the elevation chart, shown on the map. */
export const chartPoint = signal<Coord | null>(null);
/** A trail being pointed at in the list or on the map. */
export const hoverKey = signal<string | null>(null);
/** Phones: how far up the sheet is. */
export type Sheet = 'peek' | 'half' | 'full';
export const sheet = signal<Sheet>('half');

// ── Trails ────────────────────────────────────────────────────────────────────────────────────────────
export const regions = signal<Region[]>([]);
export const regionsError = signal<string | null>(null);
/** Every trail loaded for the part of the map on screen. */
export const trailsInView = signal<Trail[]>([]);
/** Trails on the "needs verification" list for the part of the map on screen. */
export const unverifiedInView = signal<Trail[]>([]);
/** The open trail as it is being looked at: the whole trail, a short loop of it, or with the walk in from a trailhead. */
export const shownTrail = signal<Trail | null>(null);
export const loading = signal(false);
export const loadNote = signal<string | null>(null);
/** The short loop to show when a trail page opens (set by tapping that line in the list). */
export const openShort = signal<string | null>(null);
/** The trail whose page is open. */
export const selected = signal<Trail | null>(null);
export const selectedState = signal<'idle' | 'loading' | 'missing'>('idle');

export const query = signal('');

// The filters and the sort order are a store of their own (src/filters.ts), re-exported here.
export * from './filters';

/** The hikes to list and to pin on the map: in view, and passing the filters. */
export const hikesInView = computed(() => {
  const v = view.value;
  if (!v) return [];
  const f = filters.value, u = units.value;
  const [s, w, n, e] = v.bounds;
  return trailsInView.value.filter(
    (t) => t.isHike && t.bbox[0] <= n && t.bbox[2] >= s && t.bbox[1] <= e && t.bbox[3] >= w && passes(t, f, u));
});

// ── Planning a route ──────────────────────────────────────────────────────────────────────────────────
export const planPoints = signal<Coord[]>(load<Coord[]>('plan-draft', []));
export const planName = signal<string>(load<string>('plan-draft-name', ''));
/** The saved route being edited, if any. */
export const planEditing = signal<string | null>(null);
export const plannedRoutes = signal<PlannedRoute[]>([]);
export const storageFailed = signal(false);
effect(() => { save('plan-draft', planPoints.value); });
effect(() => { save('plan-draft-name', planName.value); });

// ── Recording a walk ──────────────────────────────────────────────────────────────────────────────────
export type RecState = 'idle' | 'recording' | 'paused';
export const recState = signal<RecState>('idle');
export const recSegments = signal<WalkPoint[][]>([]);
export const recLength = signal(0);
export const recSeconds = signal(0);
/** When the hike began (ms), for "time on the trail" (pauses included). */
export const recStarted = signal(0);
/** Set when the end of the trail being followed is reached: the question "finish this hike?" is showing. */
export const endReached = signal<'start' | 'end' | null>(null);
export const recAccuracy = signal<number | null>(null);
export const recError = signal<string | null>(null);
export const recWakeLock = signal<'on' | 'off' | 'unsupported'>('off');
/** Places marked during the recording. */
export const recMarkers = signal<Marker[]>([]);
/** The trail being followed while recording. */
export interface Following {
  region: string; id: string; name: string; path: Coord[]; profile: Profile | null;
  /** The things on the way, for the ridge. */
  stops?: Stop[];
  loop?: boolean;
}
export const following = signal<Following | null>(null);
/** True while the walker is more than 60 m from the trail being followed. */
export const offTrail = signal(false);
/** While off the trail: how far it is, and which way ("to your right", "to the north-east"). */
export const offTrailInfo = signal<{ metres: number; way: string } | null>(null);

// ── Recorded hikes ────────────────────────────────────────────────────────────────────────────────────
export const walks = signal<WalkSummary[]>([]);

export async function addWalk(w: Walk): Promise<void> {
  if (!(await saveDoc(walkDoc(w.id), w))) storageFailed.value = true;
  walks.value = [summaryOf(w), ...walks.peek().filter((x) => x.id !== w.id)];
}

export function loadWalk(id: string): Promise<Walk | null> {
  return loadDoc<Walk | null>(walkDoc(id), null);
}

export async function renameWalk(id: string, name: string): Promise<void> {
  walks.value = walks.peek().map((x) => (x.id === id ? { ...x, name } : x));
  const w = await loadWalk(id);
  if (w) await saveDoc(walkDoc(id), { ...w, name });
}

export async function deleteWalk(id: string): Promise<void> {
  walks.value = walks.peek().filter((x) => x.id !== id);
  await platform.documents.remove(walkDoc(id));
}

// ── Saved trails ──────────────────────────────────────────────────────────────────────────────────────
export const savedTrails = signal<SavedTrail[]>([]);

export function isSaved(t: Trail): boolean {
  return savedTrails.value.some((s) => s.region === t.region && s.id === t.id);
}

export function toggleSaved(t: Trail): void {
  if (isSaved(t)) {
    savedTrails.value = savedTrails.value.filter((s) => !(s.region === t.region && s.id === t.id));
  } else {
    savedTrails.value = [{
      region: t.region, id: t.id, name: t.name, area: t.area, length: t.length, gain: t.profile?.gain ?? 0,
      difficulty: t.difficulty, loop: t.isLoop, start: t.start, saved: Date.now(),
    }, ...savedTrails.value];
  }
}

/** A short message that shows for a few seconds. */
export const toast = signal<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function say(message: string): void {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 4000);
}

// ── Reading the person's things at startup, and keeping them as they change ──────────────────────────
/** Loads saved trails, routes and the list of hikes from the device. Call once, before the first screen. */
export async function hydrate(): Promise<void> {
  await migrateFromKeyValue().catch(() => {});
  const [w, r, t] = await Promise.all([
    loadDoc<WalkSummary[]>('walks.json', []), loadDoc<PlannedRoute[]>('routes.json', []), loadDoc<SavedTrail[]>('saved-trails.json', []),
  ]);
  walks.value = Array.isArray(w) ? w : [];
  plannedRoutes.value = Array.isArray(r) ? r : [];
  savedTrails.value = Array.isArray(t) ? t : [];
  // from here on, every change is written (the first run of each effect only notes what is there)
  for (const [doc, sig] of [['walks.json', walks], ['routes.json', plannedRoutes], ['saved-trails.json', savedTrails]] as const) {
    let first = true;
    effect(() => {
      const value = sig.value;
      if (first) { first = false; return; }
      void saveDoc(doc, value).then((ok) => { if (!ok) storageFailed.value = true; });
    });
  }
}
