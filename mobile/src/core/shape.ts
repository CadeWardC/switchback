// A trail's own shape, small, from its real line (copied from web/src/ui/common.tsx, which is a Preact file).
import type { Coord } from '@web/lib/polyline';

/** A line fitted into a square box as an SVG path (north up, true proportions). */
export function shapePath(path: Coord[], box: number, pad: number): string {
  if (path.length < 2) return '';
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lon] of path) { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon; }
  const k = Math.cos(((s + n) / 2) * Math.PI / 180);
  const width = Math.max(1e-9, (e - w) * k), height = Math.max(1e-9, n - s);
  const scale = (box - 2 * pad) / Math.max(width, height);
  const ox = (box - width * scale) / 2, oy = (box - height * scale) / 2;
  // about forty points are plenty at this size
  const step = Math.max(1, Math.floor(path.length / 40));
  const at = (c: Coord) => `${(ox + (c[1] - w) * k * scale).toFixed(1)} ${(oy + (n - c[0]) * scale).toFixed(1)}`;
  const pts: string[] = [];
  for (let i = 0; i < path.length; i += step) pts.push(at(path[i]));
  pts.push(at(path[path.length - 1]));
  return `M${pts.join('L')}`;
}

/** A number and its unit apart ("3.7", "mi"), for the big numbers. */
export function split(text: string): { value: string; unit: string } {
  const m = /^([\d.,:–-]+)\s*(.*)$/.exec(text);
  return m ? { value: m[1], unit: m[2] } : { value: text, unit: '' };
}
