// Things kept in this browser: settings, planned routes and recorded walks.
import type { Coord } from './polyline';

export interface PlannedRoute { id: string; name: string; points: Coord[]; length: number; created: number }

export interface WalkPoint { lat: number; lon: number; ele: number | null; t: number; acc: number }

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
    const text = localStorage.getItem(`switchback:${key}`);
    return text == null ? fallback : (JSON.parse(text) as T);
  } catch {
    return fallback;
  }
}

/** Returns false when the browser would not keep it (private mode, storage full). */
export function save(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(`switchback:${key}`, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
