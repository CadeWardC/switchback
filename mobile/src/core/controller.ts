// Keeps the trails in step with the map (adapted from web/src/controller.ts; the trail loading itself is the
// website's web/src/data.ts, unchanged).
import { effect } from '@preact/signals-core';
import { loadRegions, trailsIn } from '@web/data';
import { loading, loadNote, online, regions, regionsError, trailsInView, unverifiedInView, view, MIN_TRAIL_ZOOM } from './state';

export function startController(): void {
  const fetchRegions = () => loadRegions().then(
    (r) => { regions.value = r; regionsError.value = null; },
    () => { regionsError.value = "The trail files couldn't be loaded. Check your connection."; },
  );
  void fetchRegions();
  // no list yet and the connection came back: try again
  effect(() => { if (online.value && !regions.peek().length) void fetchRegions(); });

  let run = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    const v = view.value;
    if (!regions.value.length || !v) return;
    clearTimeout(timer);
    const id = ++run;
    if (v.zoom < MIN_TRAIL_ZOOM) {
      if (trailsInView.peek().length) trailsInView.value = [];
      if (unverifiedInView.peek().length) unverifiedInView.value = [];
      loading.value = false;
      loadNote.value = null;
      return;
    }
    loading.value = true;
    timer = setTimeout(async () => {
      try {
        const res = await trailsIn(v.bounds, () => id === run);
        if (!res || id !== run) return;
        trailsInView.value = res.trails;
        unverifiedInView.value = res.unverified;
        loadNote.value = res.failed.length
          ? online.peek()
            ? `Trails for ${res.failed.join(', ')} couldn't be loaded. Check your connection.`
            : `Trails for ${res.failed.join(', ')} are not on this phone yet. They download when there is a connection.`
          : res.uncovered ? 'No trail files cover this part of the map yet.' : null;
      } catch {
        if (id === run) loadNote.value = "Trails couldn't be loaded. Check your connection.";
      } finally {
        if (id === run) loading.value = false;
      }
    }, 120);
  });
}
