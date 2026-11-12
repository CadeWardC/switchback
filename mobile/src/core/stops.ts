// The main things on the way, pinned to the ridge (from web/src/ui/TrailPage.tsx, a Preact file): where the
// short loop turns off, the high point, and the sights and water the trail files know of along the line.
// Distances are metres along the trail's line.
import { pickStops, progressOn, type Stop } from '@web/lib/follow';
import { shortLoops, type Trail } from '@web/lib/trail';
import { bboxOf, expand } from '@web/lib/geo';
import { highlightsIn } from '@web/data';

const KINDS: Record<string, [string, number]> = {
  viewpoint: ['Overlook', 2], waterfall: ['Waterfall', 2], peak: ['Summit', 2], cave: ['Cave', 3], water: ['Water', 3], shelter: ['Shelter', 5],
  campsite: ['Campsite', 6], picnic: ['Picnic', 7],
};

export async function stopsFor(t: Trail, whole: Trail, showShort: boolean): Promise<Stop[]> {
  const total = progressOn(t.path, t.path[0]).total;
  const stops: Stop[] = [];
  if (showShort) {
    for (const short of shortLoops(whole)) {
      const off = short.line.map((c) => progressOn(t.path, c));
      const first = off.findIndex((o) => o.off > 30), last = off.length - 1 - off.slice().reverse().findIndex((o) => o.off > 30);
      if (first > 0) stops.push({ name: 'Short loop', along: off[first - 1].along, rank: 0 });
      if (first > 0 && last < off.length - 1 && off[last + 1].along - off[first - 1].along > total * 0.15) stops.push({ name: 'Rejoins', along: off[last + 1].along, rank: 4 });
    }
  }
  const p = t.profile;
  if (p && p.max - p.min >= 15) {
    const i = p.elevations.indexOf(Math.max(...p.elevations));
    const profileTotal = p.distances[p.distances.length - 1] || 1;
    stops.push({ name: 'High point', along: (p.distances[i] / profileTotal) * total, rank: 1 });
  }
  try {
    const box = bboxOf([t.path]);
    for (const h of box ? await highlightsIn(expand(box, 0.001)) : []) {
      const kind = KINDS[h.kind];
      if (!kind) continue;
      const at = progressOn(t.path, [h.lat, h.lon]);
      if (at.off > 45) continue;
      const name = h.name && h.name.length <= 16 ? h.name : kind[0];
      stops.push({ name, along: at.along, rank: kind[1] });
    }
  } catch { /* no highlights: the ridge is drawn without them */ }
  return pickStops(stops, total);
}
