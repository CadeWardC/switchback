// Reading a GPX file someone picked: its first track (or route) as a line.
import type { Coord } from './polyline';
import { distance } from './geo';

export interface ImportedGpx { name: string; points: Coord[]; length: number }

export function readGpx(text: string, fallbackName: string): ImportedGpx | null {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const pick = (name: string) => Array.from(doc.getElementsByTagNameNS('*', name));
  let nodes = pick('trkpt');
  if (nodes.length < 2) nodes = pick('rtept');
  const all: Coord[] = [];
  for (const n of nodes) {
    const lat = Number(n.getAttribute('lat')), lon = Number(n.getAttribute('lon'));
    if (Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) all.push([lat, lon]);
  }
  if (all.length < 2) return null;
  // a recorded track has a point every second or so: keep one every few metres, at most a few thousand
  let min = 4, points = all;
  do {
    points = [all[0]];
    for (let i = 1; i < all.length - 1; i++) if (distance(points[points.length - 1], all[i]) >= min) points.push(all[i]);
    points.push(all[all.length - 1]);
    min *= 2;
  } while (points.length > 3000);
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  const named = (pick('trk')[0] ?? pick('rte')[0] ?? pick('metadata')[0])?.getElementsByTagNameNS('*', 'name')[0]?.textContent?.trim();
  return { name: named || fallbackName.replace(/\.gpx(\.txt)?$/i, '') || 'Imported route', points, length };
}
