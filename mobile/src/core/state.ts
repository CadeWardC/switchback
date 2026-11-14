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
import { accessPoints, type Profile, type Trail } from '@web/lib/trail';
import { defaultStart } from './choice';
import type { Stop } from '@web/lib/follow';
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
/** While off the trail: the dotted line from you back to it. */
export const backLine = signal<[Coord, Coord] | null>(null);
/** The point being touched on the ridge, shown on the map. */
export const chartPoint = signal<Coord | null>(null);
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
    // the trailhead nearest you, else the one nearest the trail
    chosenStart.value = defaultStart(accessPoints(t), myLocation.peek()?.at ?? null);
    trailRest.value = null;
    selected.value = t;
    tab.value = 'explore';
    if (sheetIndex.peek() === 0) sheetIndex.value = 1;
    flyTo.value = { bounds: t.bbox };
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
/** Set when the end of the trail being followed is reached: the question "finish this hike?" is showing. */
export const endReached = signal<'start' | 'end' | null>(null);
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

export async function renameWalk(id: string, name: string): Promise<void> {
  walks.value = walks.peek().map((x) => (x.id === id ? { ...x, name } : x));
  const w = await loadWalk(id);
  if (w) await saveDoc(walkDoc(id), { ...w, name });
}

export async function deleteWalk(id: string): Promise<void> {
  walks.value = walks.peek().filter((x) => x.id !== id);
  await platform.documents.remove(walkDoc(id));
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
  for (const [doc, sig] of [['walks.json', walks], ['saved-trails.json', savedTrails]] as const) {
    let first = true;
    effect(() => {
      const value = sig.value;
      if (first) { first = false; return; }
      void saveDoc(doc, value).then((ok) => { if (!ok) storageFailed.value = true; });
    });
  }
}
