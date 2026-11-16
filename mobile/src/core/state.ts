// What the whole app shares, as signals (@preact/signals-core, the same store the website uses, without
// Preact). Adapted from web/src/state.ts: no address bar (the app has tabs and a sheet instead), the system
// theme from React Native, the connection from expo-network. The filters are the website's own store
// (web/src/filters.ts), re-exported unchanged.
import { batch, computed, effect, signal } from '@preact/signals-core';
import { Appearance } from 'react-native';
import * as Network from 'expo-network';
import { defaultUnits, type Units } from '@web/lib/format';
import {
  load, loadDoc, save, saveDoc, summaryOf, walkDoc, type Marker, type SavedTrail, type Walk, type WalkPoint, type WalkSummary,
} from '@web/lib/storage';
import { filters, passes } from '@web/filters';
import type { Coord } from '@web/lib/polyline';
import { accessPoints, difficultyOf, isLoopLine, shortLoops, type Profile, type Trail } from '@web/lib/trail';
import { baseRoute, defaultStart, usableStarts } from './choice';
import { climbedSoFar } from './hikeMath';
import { newSaved, newWalks } from './backup';
import type { Stop } from '@web/lib/follow';
import type { Journey } from '@web/lib/journey';
import type { BBox } from '@web/lib/geo';
import type { Region } from '@web/lib/pack';
import { platform } from '../platform';

export * from '@web/filters';

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────────
export const units = signal<Units>(load<Units | null>('units', null) ?? defaultUnits());
export type ThemePref = 'auto' | 'light' | 'dark';
export const themePref = signal<ThemePref>(load<ThemePref>('theme', 'auto'));
const systemDark = signal(Appearance.getColorScheme() === 'dark');
Appearance.addChangeListener(({ colorScheme }) => { systemDark.value = colorScheme === 'dark'; });
export const dark = computed(() => (themePref.value === 'auto' ? systemDark.value : themePref.value === 'dark'));
/** Map downloads in the background may use mobile data (off: Wi-Fi only). */
export const mapsOverCellular = signal<boolean>(load<boolean>('maps-cellular', false));

effect(() => { save('units', units.value); });
effect(() => { save('theme', themePref.value); });
effect(() => { save('maps-cellular', mapsOverCellular.value); });

// ── Signal ────────────────────────────────────────────────────────────────────────────────────────────
/** False when the device says it has no connection at all. */
export const online = signal(true);
/** Wi-Fi, mobile data, or not known. */
export const connection = signal<'wifi' | 'cellular' | 'none' | 'unknown'>('unknown');
const onNetwork = (s: Network.NetworkState) => {
  online.value = s.isConnected !== false && s.isInternetReachable !== false;
  connection.value = s.isConnected === false ? 'none'
    : s.type === Network.NetworkStateType.WIFI ? 'wifi' : s.type === Network.NetworkStateType.CELLULAR ? 'cellular' : 'unknown';
};
Network.getNetworkStateAsync().then(onNetwork, () => {});
Network.addNetworkStateListener(onNetwork);

// ── Tabs and the sheet ────────────────────────────────────────────────────────────────────────────────
export type Tab = 'explore' | 'hike' | 'saved' | 'log';
export const tab = signal<Tab>('explore');
/** The sheet over the map: 0 peek, 1 half, 2 full. */
export const sheetIndex = signal(1);

// ── The map ───────────────────────────────────────────────────────────────────────────────────────────
export const MIN_TRAIL_ZOOM = 8;
export interface ViewState { center: Coord; zoom: number; bounds: BBox }
export interface MapView { lat: number; lon: number; zoom: number }
export const view = signal<ViewState | null>(null);
/** Where the map starts: where it was last time, else the whole of the US. */
export const initialView: MapView = load<MapView | null>('view', null) ?? { lat: 39.5, lon: -98.35, zoom: 3.4 };
export const hasSavedView = load<MapView | null>('view', null) != null;
/** Ask the map to move. A new object each time, so the same place twice still moves it. */
export const flyTo = signal<{ center?: Coord; zoom?: number; bounds?: BBox } | null>(null);
/** Where you are (the yellow dot). */
export interface Me { at: Coord; accuracy: number; ele: number | null; heading: number | null }
export const myLocation = signal<Me | null>(null);
/** The way the phone points (degrees from north), from its compass, while the app is on screen. */
export const compass = signal<number | null>(null);
/** While off the trail: the dotted line from you back to it. */
export const backLine = signal<[Coord, Coord] | null>(null);
/** The point being touched on the ridge, shown on the map. */
export const chartPoint = signal<Coord | null>(null);
/** A finger is on an elevation chart: the sheet neither moves nor scrolls until it lifts. */
export const scrubbing = signal(false);
/** A recorded hike being looked at in the Log (its line is drawn on the map). */
export const shownWalk = signal<Walk | null>(null);

// ── Trails ────────────────────────────────────────────────────────────────────────────────────────────
export const regions = signal<Region[]>([]);
export const regionsError = signal<string | null>(null);
export const trailsInView = signal<Trail[]>([]);
export const unverifiedInView = signal<Trail[]>([]);
export const loading = signal(false);
export const loadNote = signal<string | null>(null);
/** The trail whose page is open. */
export const selected = signal<Trail | null>(null);
/** The open trail as it is being looked at: a short loop of it, or with the walk in from a trailhead. */
export const shownTrail = signal<Trail | null>(null);
/** Which of the open trail's short loops is chosen (an index into shortLoops(trail)), or -1 for the full trail. */
export const chosenShort = signal(-1);
/** Where the hike starts: an index into accessPoints(trail), or -1 for the trail on its own. */
export const chosenStart = signal(-1);
/** How tall the sheet should rest so the open trail's ridge card shows whole (set by the trail page). */
export const trailRest = signal<number | null>(null);
export const query = signal('');

/** The hikes to list and to pin on the map: in view, and passing the filters. */
export const hikesInView = computed(() => {
  const v = view.value;
  if (!v) return [];
  const f = filters.value, u = units.value;
  const [s, w, n, e] = v.bounds;
  return trailsInView.value.filter(
    (t) => t.isHike && t.bbox[0] <= n && t.bbox[2] >= s && t.bbox[1] <= e && t.bbox[3] >= w && passes(t, f, u));
});

/** Opens a trail's page: the sheet shows it and the map fits it. */
export function openTrail(t: Trail, short = -1): void {
  batch(() => {
    chosenShort.value = short;
    chosenStart.value = startFor(t, short);
    trailRest.value = null;
    selected.value = t;
    tab.value = 'explore';
    if (sheetIndex.peek() === 0) sheetIndex.value = 1;
    flyTo.value = { bounds: t.bbox };
  });
}

/** The start to begin with for a trail walked as one of its short loops (or whole): of the starts that meet
 *  that route, the one nearest you, else the one nearest the trail; -1 (the trail on its own) when none does. */
export function startFor(t: Trail, short: number): number {
  const heads = accessPoints(t);
  return defaultStart(heads, myLocation.peek()?.at ?? null, usableStarts(baseRoute(t, shortLoops(t), short), heads));
}

/** Chooses a short loop of the open trail (-1: the whole). A start that does not meet it is let go of. */
export function chooseShort(short: number): void {
  const t = selected.peek();
  if (!t || short === chosenShort.peek()) return;
  batch(() => {
    chosenShort.value = short;
    const heads = accessPoints(t), from = chosenStart.peek();
    if (from >= 0 && !usableStarts(baseRoute(t, shortLoops(t), short), heads)[from]) chosenStart.value = startFor(t, short);
  });
}

export function closeTrail(): void {
  if (!selected.peek()) return;
  batch(() => {
    selected.value = null;
    shownTrail.value = null;
    chosenShort.value = -1;
    chosenStart.value = -1;
    trailRest.value = null;
    chartPoint.value = null;
  });
}

// ── Location ──────────────────────────────────────────────────────────────────────────────────────────
/** off: not asked yet. on: located (or locating). denied: said no (a quiet "Turn on location" chip shows). */
export const locationState = signal<'off' | 'on' | 'denied'>('off');

// ── Recording a hike ──────────────────────────────────────────────────────────────────────────────────
export type RecState = 'idle' | 'recording' | 'paused';
export const recState = signal<RecState>('idle');
export const recSegments = signal<WalkPoint[][]>([]);
export const recLength = signal(0);
export const recSeconds = signal(0);
/** When the hike began (ms), for "time on the trail" (pauses included). */
export const recStarted = signal(0);
/** Set when the end of the trail being followed is reached, or you are back where you joined it ('origin'):
 *  the question "finish this hike?" is showing. */
export const endReached = signal<'start' | 'end' | 'origin' | null>(null);
export const recAccuracy = signal<number | null>(null);
export const recError = signal<string | null>(null);
export const recMarkers = signal<Marker[]>([]);
export interface Following {
  region: string; id: string; name: string; path: Coord[]; profile: Profile | null;
  /** The things on the way, for the ridge. */
  stops?: Stop[];
  loop?: boolean;
}
export const following = signal<Following | null>(null);
/** Where you joined the trail being followed and which way you are walking it (null until you are on it). */
export const journey = signal<Journey | null>(null);
export const offTrail = signal(false);
export const offTrailInfo = signal<{ metres: number; way: string } | null>(null);

// ── Recorded hikes and saved trails ───────────────────────────────────────────────────────────────────
export const walks = signal<WalkSummary[]>([]);
export const savedTrails = signal<SavedTrail[]>([]);
export const storageFailed = signal(false);

export async function addWalk(w: Walk): Promise<void> {
  if (!(await saveDoc(walkDoc(w.id), w))) storageFailed.value = true;
  walks.value = [summaryOf(w), ...walks.peek().filter((x) => x.id !== w.id)];
}

export function loadWalk(id: string): Promise<Walk | null> {
  return loadDoc<Walk | null>(walkDoc(id), null);
}

/** Changes a kept hike: in the list, and in its own file. */
export async function updateWalk(id: string, patch: Partial<WalkSummary>): Promise<void> {
  walks.value = walks.peek().map((x) => (x.id === id ? { ...x, ...patch } : x));
  const w = await loadWalk(id);
  if (w) await saveDoc(walkDoc(id), { ...w, ...patch });
}

export const renameWalk = (id: string, name: string) => updateWalk(id, { name });

export async function deleteWalk(id: string): Promise<void> {
  walks.value = walks.peek().filter((x) => x.id !== id);
  await platform.documents.remove(walkDoc(id));
}

/** Every kept hike in full (its points too), for a backup file. */
export async function allWalks(): Promise<Walk[]> {
  const out: Walk[] = [];
  for (const s of walks.peek()) {
    const w = await loadWalk(s.id);
    if (w) out.push(w);
  }
  return out;
}

/** Adds hikes and saved trails read from a file: only the ones not here already. Resolves to how many were added. */
export async function importKept(hikes: Walk[], saved: SavedTrail[]): Promise<{ hikes: number; saved: number }> {
  const kept: Walk[] = [];
  for (const w of newWalks(walks.peek(), hikes)) {
    if (await saveDoc(walkDoc(w.id), w)) kept.push(w);
    else storageFailed.value = true;
  }
  if (kept.length) walks.value = [...walks.peek(), ...kept.map(summaryOf)].sort((a, b) => b.started - a.started);
  const trails = newSaved(savedTrails.peek(), saved);
  if (trails.length) savedTrails.value = [...savedTrails.peek(), ...trails].sort((a, b) => b.saved - a.saved);
  return { hikes: kept.length, saved: trails.length };
}

export function isSaved(t: { region: string; id: string }, list = savedTrails.value): boolean {
  return list.some((s) => s.region === t.region && s.id === t.id);
}

export function toggleSaved(t: Trail): boolean {
  if (isSaved(t, savedTrails.peek())) {
    savedTrails.value = savedTrails.peek().filter((s) => !(s.region === t.region && s.id === t.id));
    return false;
  }
  savedTrails.value = [{
    region: t.region, id: t.id, name: t.name, area: t.area, length: t.length, gain: t.profile?.gain ?? 0,
    difficulty: t.difficulty, loop: t.isLoop, start: t.start, saved: Date.now(),
  }, ...savedTrails.peek()];
  return true;
}

/** A hike you recorded, kept in Saved as your own trail (opening it shows the hike). */
export function saveOwnTrail(w: Walk): void {
  const path = w.segments.flat().map((p) => [p.lat, p.lon] as Coord);
  if (path.length < 2) return;
  const gain = w.gain ?? Math.round(climbedSoFar(w.segments) ?? 0);
  const own: SavedTrail = {
    region: 'own', id: w.id, walk: w.id, name: w.name, area: null, length: w.length, gain,
    difficulty: difficultyOf(w.length, gain, {}), loop: isLoopLine(path, w.length), start: path[0], saved: Date.now(),
  };
  savedTrails.value = [own, ...savedTrails.peek().filter((s) => !(s.region === 'own' && s.id === w.id))];
}

export function removeSaved(region: string, id: string): void {
  savedTrails.value = savedTrails.peek().filter((s) => !(s.region === region && s.id === id));
}

/** A short message that shows for a few seconds. */
export const toast = signal<string | null>(null);
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function say(message: string): void {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), 3500);
}

/** Loads saved trails and the list of hikes from the device, then keeps them written as they change. */
export async function hydrate(): Promise<void> {
  const [w, t] = await Promise.all([loadDoc<WalkSummary[]>('walks.json', []), loadDoc<SavedTrail[]>('saved-trails.json', [])]);
  walks.value = Array.isArray(w) ? w : [];
  savedTrails.value = Array.isArray(t) ? t : [];
  void fillInClimbs();
  for (const [doc, sig] of [['walks.json', walks], ['saved-trails.json', savedTrails]] as const) {
    let first = true;
    effect(() => {
      const value = sig.value;
      if (first) { first = false; return; }
      void saveDoc(doc, value).then((ok) => { if (!ok) storageFailed.value = true; });
    });
  }
}

/** Hikes kept before their climb was written down: work it out from each one's own points, once. */
async function fillInClimbs(): Promise<void> {
  for (const s of walks.peek()) {
    if (s.gain != null) continue;
    const w = await loadWalk(s.id);
    if (w) await updateWalk(s.id, { gain: Math.round(climbedSoFar(w.segments) ?? 0) });
  }
}
