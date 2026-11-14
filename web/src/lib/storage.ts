// What is kept on this device, and how.
//   Settings (small values): platform.keyValue.
//   The person's own things (recorded hikes, planned routes, saved trails): platform.documents, as JSON
//   text. A hike is a document of its own ("walk-<id>.json"), so the list stays small however long the
//   hikes are, and nothing depends on localStorage's few megabytes.
import type { Coord } from './polyline';
import { platform } from '../platform';
import type { Difficulty } from './trail';

export interface PlannedRoute { id: string; name: string; points: Coord[]; length: number; created: number }

export interface WalkPoint { lat: number; lon: number; ele: number | null; t: number; acc: number }

/** A place marked during a hike. */
export interface Marker { lat: number; lon: number; ele: number | null; t: number; name: string }

/** A recorded hike as the list shows it. */
export interface WalkSummary {
  id: string;
  name: string;
  started: number;
  ended: number;
  /** Seconds spent recording (pauses left out). */
  seconds: number;
  length: number;
  /** The trail that was being followed, if any. */
  trail?: { region: string; id: string; name: string };
}

export interface Walk extends WalkSummary {
  /** One list per stretch between pauses. */
  segments: WalkPoint[][];
  markers?: Marker[];
}

/** A bookmarked trail: enough to list it without its region's file. */
export interface SavedTrail {
  region: string;
  id: string;
  name: string;
  area: string | null;
  length: number;
  gain: number;
  difficulty: Difficulty;
  loop: boolean;
  start: Coord;
  saved: number;
}

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────────
export function load<T>(key: string, fallback: T): T {
  try {
    const text = platform.keyValue.get(key);
    return text == null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

/** Returns false when the device would not keep it (private mode, storage full). */
export function save(key: string, value: unknown): boolean {
  return platform.keyValue.set(key, JSON.stringify(value));
}

// ── Documents ─────────────────────────────────────────────────────────────────────────────────────────
export async function loadDoc<T>(name: string, fallback: T): Promise<T> {
  try {
    const text = await platform.documents.read(name);
    return text == null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

export function saveDoc(name: string, value: unknown): Promise<boolean> {
  return platform.documents.write(name, JSON.stringify(value));
}

export const walkDoc = (id: string) => `walk-${id}.json`;

export function summaryOf(w: Walk): WalkSummary {
  const { segments: _s, markers: _m, ...rest } = w;
  return rest;
}

/** Moves what the first version of the website kept in localStorage into documents. Runs once. */
export async function migrateFromKeyValue(): Promise<void> {
  const old = load<Walk[] | null>('walks', null);
  if (Array.isArray(old)) {
    const have = await loadDoc<WalkSummary[]>('walks.json', []);
    const fresh = old.filter((w) => w && w.id && Array.isArray(w.segments) && !have.some((h) => h.id === w.id));
    for (const w of fresh) await saveDoc(walkDoc(w.id), w);
    if (await saveDoc('walks.json', [...fresh.map(summaryOf), ...have])) platform.keyValue.remove('walks');
  }
  for (const [key, doc] of [['routes', 'routes.json'], ['saved-trails', 'saved-trails.json']] as const) {
    const rows = load<unknown[] | null>(key, null);
    if (Array.isArray(rows)) {
      const have = await loadDoc<unknown[]>(doc, []);
      if (await saveDoc(doc, [...rows, ...have])) platform.keyValue.remove(key);
    }
  }
  platform.keyValue.remove('recording');
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
