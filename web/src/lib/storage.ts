// Things kept on this device: settings, planned routes and recorded walks.
import type { Coord } from './polyline';
import { platform } from '../platform';
import type { Difficulty } from './trail';

export interface PlannedRoute { id: string; name: string; points: Coord[]; length: number; created: number }

export interface WalkPoint { lat: number; lon: number; ele: number | null; t: number; acc: number }

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

export interface Walk {
  id: string;
  name: string;
  started: number;
  ended: number;
  /** Seconds spent recording (pauses left out). */
  seconds: number;
  length: number;
  /** One list per stretch between pauses. */
  segments: WalkPoint[][];
}

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

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
