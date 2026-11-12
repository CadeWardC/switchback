// The trails as GeoJSON for the map's line layers (the same properties as web/src/map/map.ts):
//   k: the trail's key, c: its colour (the park's blaze colour where known, green otherwise),
//   h: 1 for a hike (0 for a side path), u: 1 for an unnamed path, name: for the label along the line.
import { trailColor, light, dark } from '@web/tokens';
import type { Trail } from '@web/lib/trail';
import type { Coord } from '@web/lib/polyline';

type FC = GeoJSON.FeatureCollection;
export const EMPTY: FC = { type: 'FeatureCollection', features: [] };

const lngLat = (c: Coord): [number, number] => [c[1], c[0]];

/** White blazes would not show on the map: green then. */
export function lineColor(t: Pick<Trail, 'tags' | 'difficulty'>, isDark: boolean): string {
  const c = trailColor(t.tags, t.difficulty, isDark);
  return c.toLowerCase() === '#ffffff' ? (isDark ? dark : light).green : c;
}

/** Drops points closer than `min` degrees to the last kept one (far out, lines need far fewer points). */
export function thin(line: Coord[], min: number): [number, number][] {
  if (min <= 0 || line.length < 3) return line.map(lngLat);
  const out: [number, number][] = [lngLat(line[0])];
  let last = line[0];
  for (let i = 1; i < line.length - 1; i++) {
    const c = line[i];
    if (Math.abs(c[0] - last[0]) + Math.abs(c[1] - last[1]) >= min) { out.push(lngLat(c)); last = c; }
  }
  out.push(lngLat(line[line.length - 1]));
  return out;
}

export function trailFeatures(trails: Trail[], zoom: number, isDark: boolean): FC {
  // far out, only the hikes, with coarser lines: a whole state stays quick
  const hikesOnly = zoom < 10.5;
  const min = zoom < 9 ? 0.0012 : zoom < 10.5 ? 0.0005 : zoom < 12 ? 0.00015 : 0;
  const features: GeoJSON.Feature[] = [];
  for (const t of trails) {
    if (hikesOnly && !t.isHike) continue;
    const unnamed = t.tags['switchback:unnamed'] === 'yes';
    features.push({
      type: 'Feature',
      properties: { k: t.key, c: lineColor(t, isDark), h: t.isHike ? 1 : 0, u: unnamed ? 1 : 0, ...(unnamed ? {} : { name: t.name }) },
      geometry: { type: 'MultiLineString', coordinates: (hikesOnly ? [t.path] : t.segments).map((s) => thin(s, min)) },
    });
  }
  return { type: 'FeatureCollection', features };
}

/** A circle at each hike's start (the trailhead), but not the open trail's. */
export function headFeatures(trails: Trail[], openKey: string | null, isDark: boolean): FC {
  return {
    type: 'FeatureCollection',
    features: trails.filter((t) => t.key !== openKey).map((t) => ({
      type: 'Feature', properties: { k: t.key, c: lineColor(t, isDark) }, geometry: { type: 'Point', coordinates: lngLat(t.start) },
    })),
  };
}

export function lineFeature(path: Coord[], props: Record<string, unknown> = {}): FC {
  return path.length > 1
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: path.map(lngLat) } }] }
    : EMPTY;
}

export function linesFeature(lines: Coord[][], props: Record<string, unknown> = {}): FC {
  const ls = lines.filter((l) => l.length > 1);
  return ls.length
    ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: props, geometry: { type: 'MultiLineString', coordinates: ls.map((l) => l.map(lngLat)) } }] }
    : EMPTY;
}

export function pointFeatures(points: { at: Coord; props?: Record<string, unknown> }[]): FC {
  return { type: 'FeatureCollection', features: points.map((p) => ({ type: 'Feature', properties: p.props ?? {}, geometry: { type: 'Point', coordinates: lngLat(p.at) } })) };
}

/** The key under a tap: a trailhead first, then a hike before a side path. */
export function pickKey(features: { properties?: Record<string, unknown> | null; layerId?: string }[]): string | null {
  const keyed = features.filter((f) => f.properties && typeof f.properties.k === 'string');
  const hike = keyed.find((f) => f.properties!.h === 1) ?? keyed[0];
  return hike ? String(hike.properties!.k) : null;
}
