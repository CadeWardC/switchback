import type { Coord } from './polyline';

/** [south, west, north, east] */
export type BBox = [number, number, number, number];

const R = 6371008.8;
const rad = Math.PI / 180;

/** Metres between two points (haversine). */
export function distance(a: Coord, b: Coord): number {
  const dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLength(line: Coord[]): number {
  let d = 0;
  for (let i = 1; i < line.length; i++) d += distance(line[i - 1], line[i]);
  return d;
}

export function bboxOf(lines: Coord[][]): BBox | null {
  let s = 90, w = 180, n = -90, e = -180, any = false;
  for (const line of lines) {
    for (const [lat, lon] of line) {
      any = true;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
      if (lon < w) w = lon;
      if (lon > e) e = lon;
    }
  }
  return any ? [s, w, n, e] : null;
}

export function intersects(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function expand(b: BBox, deg: number): BBox {
  return [b[0] - deg, b[1] - deg, b[2] + deg, b[3] + deg];
}

/** The point a distance (m) along a line, and the index of the segment it is on. */
export function pointAlong(line: Coord[], d: number): Coord {
  if (line.length === 0) return [0, 0];
  if (d <= 0) return line[0];
  let run = 0;
  for (let i = 1; i < line.length; i++) {
    const step = distance(line[i - 1], line[i]);
    if (run + step >= d && step > 0) {
      const t = (d - run) / step;
      return [line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t];
    }
    run += step;
  }
  return line[line.length - 1];
}

/** Metres from a point to the nearest part of a line (flat-earth maths: fine over trail distances). */
export function distanceToLine(c: Coord, line: Coord[]): number {
  if (!line.length) return Infinity;
  const k = Math.cos(c[0] * rad), mLat = 111_320, mLon = 111_320 * k;
  const px = 0, py = 0;
  let best = Infinity;
  let ax = (line[0][1] - c[1]) * mLon, ay = (line[0][0] - c[0]) * mLat;
  if (line.length === 1) return Math.hypot(ax, ay);
  for (let i = 1; i < line.length; i++) {
    const bx = (line[i][1] - c[1]) * mLon, by = (line[i][0] - c[0]) * mLat;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
    if (d < best) best = d;
    ax = bx;
    ay = by;
  }
  return best;
}
