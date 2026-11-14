// GPX files for a trail and for a recorded hike (from web/src/ui/TrailPage.tsx and Activity.tsx, which are
// Preact files), written with the website's own buildGpx (web/src/lib/gpx.ts).
import { buildGpx, xml, type GpxPoint } from '@web/lib/gpx';
import { distance, lineLength } from '@web/lib/geo';
import { heightAt, type Trail } from '@web/lib/trail';
import type { Walk } from '@web/lib/storage';
import type { Coord } from '@web/lib/polyline';

export const CREATOR = 'Switchback React Native 1.0';

export function trailGpx(t: Trail, creator = CREATOR): string {
  const total = lineLength(t.path), profileTotal = t.profile?.distances[t.profile.distances.length - 1] ?? 0;
  let run = 0;
  const main: GpxPoint[] = t.path.map((c, i) => {
    if (i > 0) run += distance(t.path[i - 1], c);
    const ele = t.profile && total > 0 ? heightAt(t.profile, (run / total) * profileTotal) : null;
    return { lat: c[0], lon: c[1], ele };
  });
  const last = (a: Coord[]) => a[a.length - 1];
  const same = (a: Coord[], b: Coord[]) => a.length === b.length && a[0][0] === b[0][0] && a[0][1] === b[0][1] && last(a)[0] === last(b)[0];
  const others = t.segments.filter((s) => !same(s, t.path));
  const tracks = [{ name: t.name, segments: [main] }];
  if (others.length) tracks.push({ name: `${t.name} (other sections)`, segments: others.map((s) => s.map((c) => ({ lat: c[0], lon: c[1], ele: null }))) });
  return buildGpx({
    creator, name: t.name,
    desc: [t.area, 'Trail data © OpenStreetMap contributors, ODbL. From Switchback.'].filter(Boolean).join('. '),
    tracks,
  });
}

export function walkGpx(w: Walk, creator = CREATOR): string {
  const waypoints = (w.markers ?? []).map((m) =>
    `  <wpt lat="${m.lat.toFixed(7)}" lon="${m.lon.toFixed(7)}">${m.ele != null ? `<ele>${m.ele.toFixed(1)}</ele>` : ''}<time>${new Date(m.t).toISOString().replace(/\.\d{3}Z$/, 'Z')}</time><name>${xml(m.name)}</name></wpt>`);
  return buildGpx({
    creator, name: w.name, time: w.started, waypoints,
    tracks: [{ name: w.name, segments: w.segments.map((s) => s.map((p): GpxPoint => ({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.t }))) }],
  });
}
