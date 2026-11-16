// Keeping the map for when there is no signal, without anything to manage: the map around where you are,
// and around any trail you open, save or start, is fetched quietly in the background.
import { effect } from '@preact/signals';
import { following, mapsOverCellular, online, savedTrails, selected, view } from './state';
import { myLocation } from './map/map';
import { countFor, hereParts, mayDownload, saveArea, trailParts, MAX_JOB_TILES, BYTES_PER_TILE } from './map/tilesource';
import { bboxOf, distance, type BBox } from './lib/geo';
import type { Coord } from './lib/polyline';
import { load, save } from './lib/storage';

/** A small job (a trail's own map) may use any connection; a big one waits for Wi-Fi unless allowed. */
async function allowed(parts: Parameters<typeof countFor>[0]): Promise<boolean> {
  return mayDownload(mapsOverCellular.peek() || countFor(parts) <= 300);
}

export async function saveTrailMap(key: string, box: BBox): Promise<void> {
  const parts = trailParts(box);
  if (await allowed(parts)) await saveArea(`trail:${key}`, parts);
}

/** "Save this area": what the map shows now, to zoom 14. Returns a sentence saying what happened. */
export async function saveView(): Promise<string> {
  const v = view.peek();
  if (!v) return 'The map is not ready yet.';
  const parts = [{ box: v.bounds, zooms: [Math.max(4, Math.floor(v.zoom) - 3), 14] as [number, number] }];
  const n = countFor(parts);
  if (n > MAX_JOB_TILES) return 'That is too much map to save at once. Zoom in and try again.';
  if (!(await mayDownload(true))) return 'There is no connection, so the map can\'t be saved now.';
  void saveArea('area', parts);
  return `Saving this part of the map (about ${Math.max(1, Math.round((n * BYTES_PER_TILE) / 1e6))} MB at most).`;
}

export function startOffline(): void {
  // around where you are: once, and again when you have moved a few kilometres
  let last: Coord | null = load<Coord | null>('maps-here', null);
  let busy = false;
  effect(() => {
    const me = myLocation.value;
    online.value; mapsOverCellular.value;
    if (!me || busy || (last && distance(last, me.at) < 5000)) return;
    busy = true;
    void (async () => {
      const parts = hereParts(me.at[0], me.at[1]);
      if (await mayDownload(mapsOverCellular.peek())) {
        const job = await saveArea('here', parts);
        if (job.state === 'ready') { last = me.at; save('maps-here', last); }
      }
    })().finally(() => { setTimeout(() => { busy = false; }, 60_000); });
  });

  // a trail that is opened, or followed
  effect(() => {
    const t = selected.value;
    if (t) void saveTrailMap(t.key, t.bbox);
  });
  effect(() => {
    const f = following.value;
    const box = f && bboxOf([f.path]);
    if (f && box) void saveTrailMap(f.id ? `${f.region}/${f.id}` : 'route', box);
  });
  // a trail that is saved (only its start is kept with it: the map a few kilometres around that)
  let known = new Set<string>();
  effect(() => {
    const list = savedTrails.value;
    for (const s of list) {
      const key = `${s.region}/${s.id}`;
      if (known.has(key)) continue;
      const reach = Math.min(8, Math.max(1, s.length / 2000));
      const d = reach / 111;
      void saveTrailMap(key, [s.start[0] - d, s.start[1] - d * 1.3, s.start[0] + d, s.start[1] + d * 1.3]);
    }
    known = new Set(list.map((s) => `${s.region}/${s.id}`));
  });
}
