// What the whole site shares: settings, where the map is, the trails in view, and which page is open.
import { computed, effect, signal } from '@preact/signals';
import { defaultUnits, type Units } from './lib/format';
import { load, save, type PlannedRoute, type Walk, type WalkPoint } from './lib/storage';
import type { Coord } from './lib/polyline';
import type { Difficulty, Trail } from './lib/trail';
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark.value ? '#111A15' : '#1F6B45');
});

// ── Pages ─────────────────────────────────────────────────────────────────────────────────────────────
export type Route =
  | { page: 'explore' }
  | { page: 'trail'; region: string; id: string }
  | { page: 'plan' }
  | { page: 'record' }
  | { page: 'about' };

export interface MapView { lat: number; lon: number; zoom: number }

/** Reads "#/trail/<region>/<id>", "#/plan", "#/record", "#/about", or "#/@lat,lon,zoom" (a place on the map). */
export function parseHash(hash: string): { route: Route; view?: MapView } {
  const h = hash.replace(/^#\/?/, '');
  const at = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)z?$/.exec(h);
  if (at) return { route: { page: 'explore' }, view: { lat: +at[1], lon: +at[2], zoom: +at[3] } };
  const parts = h.split('/');
  if (parts[0] === 'trail' && parts.length >= 3) {
    try {
      return { route: { page: 'trail', region: decodeURIComponent(parts[1]), id: decodeURIComponent(parts.slice(2).join('/')) } };
    } catch { /* a broken link: fall through to the map */ }
  }
  if (parts[0] === 'plan' || parts[0] === 'record' || parts[0] === 'about') return { route: { page: parts[0] } };
  return { route: { page: 'explore' } };
}

export function hashFor(r: Route): string {
  switch (r.page) {
    case 'trail': return `#/trail/${encodeURIComponent(r.region)}/${encodeURIComponent(r.id)}`;
    case 'explore': return '#/';
    default: return `#/${r.page}`;
  }
}

const first = parseHash(typeof location === 'undefined' ? '' : location.hash);
export const route = signal<Route>(first.route);
/** Where the map starts: from the link, else where it was last time, else the whole of the US. */
export const initialView: MapView = first.view ?? load<MapView | null>('view', null) ?? { lat: 39.5, lon: -98.35, zoom: 3.4 };
export const hasSavedView = !!first.view || load<MapView | null>('view', null) != null;

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
export const loading = signal(false);
export const loadNote = signal<string | null>(null);
/** The trail whose page is open. */
export const selected = signal<Trail | null>(null);
export const selectedState = signal<'idle' | 'loading' | 'missing'>('idle');

export type Sort = 'closest' | 'shortest' | 'longest' | 'leastClimb' | 'mostClimb';
export type LengthBand = 'any' | 'short' | 'medium' | 'long';
export const sort = signal<Sort>('closest');
export const difficultyFilter = signal<Difficulty[]>([]);
export const lengthFilter = signal<LengthBand>('any');
export const loopsOnly = signal(false);
export const query = signal('');

/** Length bands in the reader's units: under 3 mi / 5 km, up to 8 mi / 13 km, longer. */
export function lengthBands(u: Units): { short: number; long: number; labels: Record<LengthBand, string> } {
  return u === 'imperial'
    ? { short: 3 * 1609.344, long: 8 * 1609.344, labels: { any: 'Any length', short: 'Under 3 mi', medium: '3 to 8 mi', long: 'Over 8 mi' } }
    : { short: 5000, long: 13000, labels: { any: 'Any length', short: 'Under 5 km', medium: '5 to 13 km', long: 'Over 13 km' } };
}

export function passesFilters(t: Trail): boolean {
  const d = difficultyFilter.value;
  if (d.length && !d.includes(t.difficulty)) return false;
  if (loopsOnly.value && !t.isLoop) return false;
  const band = lengthFilter.value;
  if (band !== 'any') {
    const b = lengthBands(units.value);
    if (band === 'short' && t.length >= b.short) return false;
    if (band === 'medium' && (t.length < b.short || t.length > b.long)) return false;
    if (band === 'long' && t.length <= b.long) return false;
  }
  return true;
}

export const filtersOn = computed(() => difficultyFilter.value.length > 0 || lengthFilter.value !== 'any' || loopsOnly.value);

/** The hikes to list and to pin on the map: in view, and passing the filters. */
export const hikesInView = computed(() => {
  const v = view.value;
  if (!v) return [];
  const [s, w, n, e] = v.bounds;
  return trailsInView.value.filter(
    (t) => t.isHike && t.bbox[0] <= n && t.bbox[2] >= s && t.bbox[1] <= e && t.bbox[3] >= w && passesFilters(t));
});

// ── Planning a route ──────────────────────────────────────────────────────────────────────────────────
export const planPoints = signal<Coord[]>(load<Coord[]>('plan-draft', []));
export const planName = signal<string>(load<string>('plan-draft-name', ''));
/** The saved route being edited, if any. */
export const planEditing = signal<string | null>(null);
export const plannedRoutes = signal<PlannedRoute[]>(load<PlannedRoute[]>('routes', []));
export const storageFailed = signal(false);
effect(() => { save('plan-draft', planPoints.value); });
effect(() => { save('plan-draft-name', planName.value); });
effect(() => { if (!save('routes', plannedRoutes.value)) storageFailed.value = true; });

// ── Recording a walk ──────────────────────────────────────────────────────────────────────────────────
export type RecState = 'idle' | 'recording' | 'paused';
export const recState = signal<RecState>('idle');
export const recSegments = signal<WalkPoint[][]>([]);
export const recLength = signal(0);
export const recSeconds = signal(0);
export const recAccuracy = signal<number | null>(null);
export const recError = signal<string | null>(null);
export const recWakeLock = signal<'on' | 'off' | 'unsupported'>('off');
export const walks = signal<Walk[]>(load<Walk[]>('walks', []));
/** A saved walk or route being looked at (drawn on the map). */
export const shownWalk = signal<Walk | null>(null);
effect(() => { if (!save('walks', walks.value)) storageFailed.value = true; });
