// Keeps the trails in step with the map and the address bar.
import { effect } from '@preact/signals';
import {
  loading, loadNote, online, unverifiedInView, MIN_TRAIL_ZOOM, regions, regionsError, route, selected, selectedState, sheet, trailsInView, view, flyTo,
} from './state';
import { findTrail, loadRegions, trailsIn } from './data';
import { isPhone } from './layout';

export function startController(): void {
  void loadRegions().then(
    (r) => { regions.value = r; },
    () => { regionsError.value = "The trail files couldn't be loaded. Check your connection and reload the page."; },
  );

  // the map moved: load the trails for what it shows
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
            : `Trails for ${res.failed.join(', ')} are not on this device yet. They download when there is a connection.`
          : res.uncovered ? 'No trail files cover this part of the map yet.' : null;
      } catch {
        if (id === run) loadNote.value = "Trails couldn't be loaded. Check your connection.";
      } finally {
        if (id === run) loading.value = false;
      }
    }, 80);
  });

  // a trail page opened (a tap, or a shared link): find the trail and show it on the map
  let finding = 0;
  effect(() => {
    const r = route.value;
    if (r.page !== 'trail') {
      selectedState.value = 'idle';
      // closing a trail (back, Escape, or a tap on the map away from it) lets go of it: the whole map and list again
      if (selected.peek()) selected.value = null;
      return;
    }
    const key = `${r.region}/${r.id}`;
    const have = selected.peek();
    if (have?.key === key) {
      selectedState.value = 'idle';
      return;
    }
    const near = trailsInView.peek().find((t) => t.key === key) ?? unverifiedInView.peek().find((t) => t.key === key);
    const id = ++finding;
    const show = (t: NonNullable<typeof near>) => {
      selected.value = t;
      selectedState.value = 'idle';
      if (isPhone() && sheet.peek() !== 'half') sheet.value = 'half';
      flyTo.value = { bounds: t.bbox, zoom: 15.5 };
    };
    if (near) {
      show(near);
      return;
    }
    selectedState.value = 'loading';
    findTrail(r.region, r.id).then(
      (t) => {
        if (id !== finding) return;
        if (t) show(t);
        else selectedState.value = 'missing';
      },
      () => { if (id === finding) selectedState.value = 'missing'; },
    );
  });
}
