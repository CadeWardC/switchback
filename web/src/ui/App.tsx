// The frame: the map behind, a panel beside it (wide screens) or a sheet over it with a tab bar (phones).
import { useEffect, useRef } from 'preact/hooks';
import {
  baseMap, dark, flyTo, go, loading, online, MIN_TRAIL_ZOOM, recState, route, say, sheet, tabOf, toast, view, type Sheet, type Tab,
} from '../state';
import { createMap, myLocation, resizeMap, zoomBy } from '../map/map';
import { mapJobs, mapOffline } from '../map/tilesource';
import { saveView } from '../offline';
import { isPhone, sheetVisible } from '../layout';
import { isNativeApp, platform } from '../platform';
import { Icon } from './Icon';
import { Explore } from './Explore';
import { TrailPage } from './TrailPage';
import { Saved } from './Saved';
import { Plan } from './Plan';
import { Record } from './Record';
import { Activity, WalkPage } from './Activity';
import { Settings } from './Settings';
import { Help } from './Help';

const TABS: { tab: Tab; label: string; icon: string }[] = [
  { tab: 'explore', label: 'Explore', icon: 'map' },
  { tab: 'record', label: 'Record', icon: 'record' },
  { tab: 'saved', label: 'Saved', icon: 'bookmark' },
  { tab: 'activity', label: 'Activity', icon: 'activity' },
];

function Tabs() {
  const current = tabOf(route.value);
  return (
    <nav class="tabs" aria-label="Sections">
      <a class="brand" href="#/" aria-label="Switchback, home">
        <img src="./icons/favicon.png" width="28" height="28" alt="" />
        <span>Switchback</span>
      </a>
      <div class="tab-list">
        {TABS.map((t) => (
          <a href={`#/${t.tab === 'explore' ? '' : t.tab}`} class={`tab${current === t.tab ? ' on' : ''}`} aria-current={current === t.tab ? 'page' : undefined}
            onClick={() => platform.haptics.tap()}>
            <span class="tab-icon">
              <Icon name={t.icon} size={22} />
              {t.tab === 'record' && recState.value !== 'idle' && <span class={`rec-dot ${recState.value}`} />}
            </span>
            <span class="tab-label">{t.label}</span>
          </a>
        ))}
        <a href="#/settings" class={`tab tab-gear${current === 'settings' ? ' on' : ''}`} aria-current={current === 'settings' ? 'page' : undefined} aria-label="Settings" title="Settings">
          <span class="tab-icon"><Icon name="gear" size={22} /></span>
          <span class="tab-label">Settings</span>
        </a>
      </div>
    </nav>
  );
}

let stopWatching: (() => void) | null = null;

function locate(): void {
  platform.haptics.tap();
  const first = !myLocation.peek();
  if (!stopWatching) {
    let moved = false;
    stopWatching = platform.location.watch(
      (fix) => {
        myLocation.value = { at: [fix.lat, fix.lon], accuracy: fix.accuracy, ele: fix.ele, heading: fix.heading };
        if (!moved) { moved = true; flyTo.value = { center: [fix.lat, fix.lon], zoom: Math.max(13, view.peek()?.zoom ?? 0) }; }
      },
      (problem) => {
        stopWatching?.();
        stopWatching = null;
        say(problem === 'denied' ? 'Location is turned off for this site. Allow it in your settings to see where you are.'
          : problem === 'unsupported' ? "This browser can't share your location." : "Your position can't be found right now.");
      },
    );
  } else if (!first) {
    const me = myLocation.peek()!;
    flyTo.value = { center: me.at, zoom: Math.max(13, view.peek()?.zoom ?? 0) };
  }
}

/** Buttons and notes that sit on the map. */
function MapChrome() {
  const zoomedOut = (view.value?.zoom ?? 99) < MIN_TRAIL_ZOOM;
  const page = route.value.page;
  const exploring = page === 'explore' || page === 'trail';
  const area = mapJobs.value.area;
  return (
    <>
      <div class="map-buttons">
        <a class="map-btn only-phone" href="#/settings" aria-label="Settings"><Icon name="gear" size={20} /></a>
        <button type="button" class="map-btn" aria-label="Show where I am" title="Show where I am" onClick={locate}>
          <Icon name="locate" size={20} />
        </button>
        <button type="button" class="map-btn" aria-label="Save this part of the map for offline use" title="Save this area for offline"
          onClick={() => { void saveView().then(say); }}>
          <Icon name="download" size={20} />
        </button>
        <div class="zoom only-wide">
          <button type="button" class="map-btn" aria-label="Zoom in" onClick={() => zoomBy(1)}><Icon name="plus" size={20} /></button>
          <button type="button" class="map-btn" aria-label="Zoom out" onClick={() => zoomBy(-1)}><Icon name="minus" size={20} /></button>
        </div>
      </div>
      <div class="map-notes" aria-live="polite">
        {exploring && zoomedOut && <span class="pill">Zoom in to see trails</span>}
        {exploring && !zoomedOut && loading.value && <span class="pill"><span class="spinner" />Loading trails</span>}
        {page === 'plan' && <span class="pill">Tap the map to add points</span>}
        {(mapOffline.value || !online.value) && <span class="pill pill-quiet">Offline: showing saved maps</span>}
        {area?.state === 'saving' && <span class="pill pill-quiet">Saving map… {Math.round((area.done / Math.max(1, area.total)) * 100)}%</span>}
        {baseMap.value === 'plain' && <span class="pill pill-quiet">The map style couldn't be loaded. Trails still work.</span>}
      </div>
    </>
  );
}

function Attribution() {
  return (
    <p class="attribution">
      © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors
      {' · '}<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a>
      {' · '}© <a href="https://openmaptiles.org" target="_blank" rel="noopener">OpenMapTiles</a>
    </p>
  );
}

const ORDER: Sheet[] = ['peek', 'half', 'full'];

/** The panel. On phones it is a sheet: drag the handle, or tap it, to move it between three heights. */
function Panel({ children }: { children: any }) {
  const el = useRef<HTMLElement>(null);
  const drag = useRef<{ startY: number; startOffset: number; moved: boolean } | null>(null);

  const offsetFor = (s: Sheet) => Math.max(0, (el.current?.offsetHeight ?? 0) - sheetVisible(s));
  const place = (offset: number, animate: boolean) => {
    const node = el.current;
    if (!node) return;
    node.style.transition = animate ? '' : 'none';
    node.style.setProperty('--sheet-y', `${offset}px`);
  };
  // The scrolling part is only as tall as what shows, so everything in it can be scrolled (and focused) into
  // view. It changes when the sheet comes to rest, never while it moves (the move itself is a transform).
  const restTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rest = (offset: number) => {
    const node = el.current;
    if (!node) return;
    clearTimeout(restTimer.current);
    const now = parseFloat(node.style.getPropertyValue('--sheet-rest')) || 0;
    const set = () => node.style.setProperty('--sheet-rest', `${offset}px`);
    // moving down: shrink once it has arrived, so the part sliding away is not blank on the way
    if (offset > now && !matchMedia('(prefers-reduced-motion: reduce)').matches) restTimer.current = setTimeout(set, 270);
    else set();
  };

  useEffect(() => {
    const sync = () => {
      if (isPhone()) { place(offsetFor(sheet.value), true); rest(offsetFor(sheet.value)); }
      else { place(0, false); rest(0); }
      resizeMap();
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, [sheet.value]);

  const down = (e: PointerEvent) => {
    if (!isPhone()) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startOffset: offsetFor(sheet.peek()), moved: false };
    rest(0);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > 4) d.moved = true;
    place(Math.max(0, Math.min(offsetFor('peek'), d.startOffset + dy)), false);
  };
  const up = (e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    let next: Sheet;
    if (!d.moved) {
      // a tap: step up, and from the top back down to the middle
      next = sheet.peek() === 'peek' ? 'half' : sheet.peek() === 'half' ? 'full' : 'half';
    } else {
      const at = d.startOffset + (e.clientY - d.startY);
      next = ORDER.reduce((best, s) => (Math.abs(offsetFor(s) - at) < Math.abs(offsetFor(best) - at) ? s : best), 'half' as Sheet);
    }
    platform.haptics.tap();
    if (next === sheet.peek()) { place(offsetFor(next), true); rest(offsetFor(next)); }
    else sheet.value = next;
  };
  const key = (e: KeyboardEvent) => {
    const i = ORDER.indexOf(sheet.peek());
    if (e.key === 'ArrowUp' && i < 2) sheet.value = ORDER[i + 1];
    else if (e.key === 'ArrowDown' && i > 0) sheet.value = ORDER[i - 1];
    else if (e.key === 'Enter' || e.key === ' ') sheet.value = ORDER[(i + 1) % 3];
    else return;
    e.preventDefault();
  };

  return (
    <section class="panel" ref={el} data-sheet={sheet.value} aria-label="Trails and tools">
      <Attribution />
      <button type="button" class="grabber" aria-label={`Resize the panel. It is ${sheet.value === 'peek' ? 'small' : sheet.value === 'half' ? 'half open' : 'fully open'}.`}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}>
        <span />
      </button>
      <div class="panel-body">{children}</div>
    </section>
  );
}

function Page() {
  switch (route.value.page) {
    case 'trail': return <TrailPage />;
    case 'record': return <Record />;
    case 'saved': return <Saved />;
    case 'plan': return <Plan />;
    case 'activity': return <Activity />;
    case 'walk': return <WalkPage />;
    case 'settings': return <Settings />;
    case 'help': return <Help />;
    default: return <Explore />;
  }
}

export function App() {
  const mapEl = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mapEl.current) createMap(mapEl.current);
  }, []);
  // Escape goes back from a trail to the list
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && route.peek().page === 'trail' && !document.querySelector('dialog[open]')) go({ page: 'explore' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Android's back: close a dialog, lower the sheet, go back a page; only then leave the app
  useEffect(() => {
    platform.app.onBack(() => {
      const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
      if (dialog) { dialog.close(); return true; }
      if (isPhone() && sheet.peek() === 'full') { sheet.value = 'half'; return true; }
      const r = route.peek();
      if (r.page === 'explore') return false;
      go(r.page === 'trail' ? { page: 'explore' } : r.page === 'plan' || r.page === 'help' ? { page: 'saved' } : r.page === 'walk' ? { page: 'activity' } : { page: 'explore' });
      return true;
    });
  }, []);
  // system bars follow the theme
  useEffect(() => { platform.app.setTheme(dark.value); }, [dark.value]);
  // in the phone apps, links to other sites open outside the app (directions in the maps app)
  useEffect(() => {
    if (!isNativeApp) return;
    const onClick = (e: MouseEvent) => {
      const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || !/^https?:/.test(a.getAttribute('href') ?? '') || a.origin === location.origin) return;
      e.preventDefault();
      const d = a.dataset.directions?.split(',').map(Number);
      if (d && d.length === 2) platform.links.directions(d[0], d[1]);
      else platform.links.open(a.href);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  const page = route.value.page;
  return (
    <div class="app" data-page={page}>
      <a class="skip" href="#panel-main">Skip to the trail list</a>
      <div class="map" ref={mapEl} role="application" aria-label="Map of trails. Use the arrow keys to move and plus or minus to zoom." />
      <MapChrome />
      <Tabs />
      <Panel><div id="panel-main" class="panel-main" key={page === 'trail' ? 'trail' : page} tabIndex={-1}><Page /></div></Panel>
      {toast.value && <div class="toast" role="status">{toast.value}</div>}
    </div>
  );
}
