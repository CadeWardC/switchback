// The map: the base map (our outdoor style from OpenFreeMap, or a plain background when that can't be
// reached), with the trails, trailheads, the open trail, a planned route and a recording drawn on top.
import * as maplibregl from 'maplibre-gl';
import { type GeoJSONSource, type LayerSpecification, type Map as MlMap, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// the map's background worker is a file of its own: have the bundler copy it and tell the map where it is
import workerUrl from '../generated/maplibre-worker.js?url';
import { effect, signal, untracked } from '@preact/signals';
import {
  baseMap, chartPoint, dark, flyTo, hikesInView, hoverKey, initialView, MIN_TRAIL_ZOOM, planPoints, recSegments,
  regions, route, selected, sheet, shownTrail, trailsInView, unverifiedInView, following, recMarkers, units, view, go, type Route,
} from '../state';
import { dark as darkTokens, light as lightTokens, mapColors, trailColor } from '../tokens';
import { makeImage } from './images';
import { mapProtocol, throughStore } from './tilesource';
import { save } from '../lib/storage';
import type { Coord } from '../lib/polyline';
import type { BBox } from '../lib/geo';
import type { Trail } from '../lib/trail';
import { highlightsIn, regionName, type Highlight } from '../data';
import { platform } from '../platform';
import { coveredBottom, isPhone, panelWidth } from '../layout';

const EMPTY: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };

/** Where the device is, once the locate button has been used (or a recording is running). */
export const myLocation = signal<{ at: Coord; accuracy: number; ele?: number | null; heading?: number | null } | null>(null);
/** The walk being looked at on the Activity page, as lines to draw. */
export const shownLines = signal<Coord[][]>([]);
/** The places marked on that walk. */
export const shownMarkers = signal<Coord[]>([]);
/** Called when the map is tapped while planning a route. */
/** While off the trail being followed: from where you are to the nearest point on it. */
export const backLine = signal<[Coord, Coord] | null>(null);
export const planTap = signal<((c: Coord) => void) | null>(null);

let map: MlMap | null = null;
let ready = false;
let styleToken = 0;

const lngLat = (c: Coord): [number, number] => [c[1], c[0]];
const phone = isPhone;

/** The part of the map not covered by the panel (desktop) or the sheet and tab bar (phones), in pixels. */
function padding(): { top: number; bottom: number; left: number; right: number } {
  if (!phone()) return { top: 0, bottom: 0, left: panelWidth() + 24, right: 0 };
  return { top: 0, bottom: coveredBottom(sheet.peek()), left: 0, right: 0 };
}

function visibleView(m: MlMap) {
  const el = m.getContainer(), p = padding();
  const w = el.clientWidth, h = el.clientHeight;
  const sw = m.unproject([p.left, h - p.bottom]), ne = m.unproject([w - p.right, p.top]);
  const c = m.unproject([(p.left + w - p.right) / 2, (p.top + h - p.bottom) / 2]);
  return {
    center: [c.lat, c.lng] as Coord, zoom: m.getZoom(),
    bounds: [Math.min(sw.lat, ne.lat), Math.min(sw.lng, ne.lng), Math.max(sw.lat, ne.lat), Math.max(sw.lng, ne.lng)] as BBox,
  };
}

// ── Style ─────────────────────────────────────────────────────────────────────────────────────────────

function plainStyle(isDark: boolean): StyleSpecification {
  return {
    version: 8, name: 'Plain',
    sources: {},
    layers: [{ id: 'background', type: 'background', paint: { 'background-color': (isDark ? darkTokens : lightTokens).mapLand } }],
  };
}

/** Every trail feature carries its own colour (`c`): the park's blaze colour where known, green otherwise. */
const diffColor: any = ['coalesce', ['get', 'c'], lightTokens.green];
/** Dots for the things near trails: water in blue, everything else quiet (yellow is kept for you). */
const HIGHLIGHT_COLORS: Record<string, string> = {
  water: '#2f6fc0', waterfall: '#2f6fc0', viewpoint: '#5b6861', peak: '#5b6861', parking: '#8a938d',
  campsite: '#5b6861', shelter: '#5b6861', picnic: '#8a938d', toilets: '#8a938d', cave: '#5b6861',
};

/** Our own layers, drawn over whichever base map there is. */
function overlay(isDark: boolean, withText: boolean): { sources: StyleSpecification['sources']; layers: LayerSpecification[] } {
  const p = isDark ? darkTokens : lightTokens;
  const line = { 'line-cap': 'round', 'line-join': 'round' } as const;
  const width = (a: number, b: number): any => ['interpolate', ['linear'], ['zoom'], 8, a, 14, b];
  const layers: LayerSpecification[] = [
    { id: 'sb-region-fill', type: 'fill', source: 'sb-regions', maxzoom: MIN_TRAIL_ZOOM,
      paint: { 'fill-color': p.green, 'fill-opacity': 0.12, 'fill-antialias': false } },
    // paths that are not hikes of their own: thinner, and dashed when they have no name
    { id: 'sb-side-casing', type: 'line', source: 'sb-trails', filter: ['==', ['get', 'h'], 0], layout: line,
      paint: { 'line-color': p.mapCasing, 'line-width': width(2, 4.5), 'line-opacity': 0.8 } },
    { id: 'sb-side', type: 'line', source: 'sb-trails', filter: ['all', ['==', ['get', 'h'], 0], ['==', ['get', 'u'], 0]], layout: line,
      paint: { 'line-color': diffColor, 'line-width': width(1, 2.2), 'line-opacity': 0.85 } },
    { id: 'sb-unnamed', type: 'line', source: 'sb-trails', filter: ['all', ['==', ['get', 'h'], 0], ['==', ['get', 'u'], 1]],
      layout: { 'line-join': 'round' },
      paint: { 'line-color': diffColor, 'line-width': width(1, 2.2), 'line-dasharray': [2, 1.6], 'line-opacity': 0.85 } },
    { id: 'sb-trail-casing', type: 'line', source: 'sb-trails', filter: ['==', ['get', 'h'], 1], layout: line,
      paint: { 'line-color': p.mapCasing, 'line-width': width(3.2, 7) } },
    { id: 'sb-trail', type: 'line', source: 'sb-trails', filter: ['==', ['get', 'h'], 1], layout: line,
      paint: { 'line-color': diffColor, 'line-width': width(1.6, 3.6) } },
    { id: 'sb-hover', type: 'line', source: 'sb-trails', filter: ['==', ['get', 'k'], ''], layout: line,
      paint: { 'line-color': diffColor, 'line-width': width(4, 7) } },
    // likely trails that still need checking: dashed, apart from the hikes
    { id: 'sb-unverified-casing', type: 'line', source: 'sb-unverified', layout: line,
      paint: { 'line-color': p.mapCasing, 'line-width': width(3, 6), 'line-opacity': 0.85 } },
    { id: 'sb-unverified', type: 'line', source: 'sb-unverified', layout: { 'line-join': 'round' },
      paint: { 'line-color': mapColors.unverified, 'line-width': width(1.6, 3), 'line-dasharray': [1.2, 1.4] } },
    // the open trail
    { id: 'sb-selected-casing', type: 'line', source: 'sb-selected', layout: line,
      paint: { 'line-color': p.mapCasing, 'line-width': width(7, 11) } },
    { id: 'sb-selected', type: 'line', source: 'sb-selected', layout: line,
      paint: { 'line-color': diffColor, 'line-width': width(4, 6) } },
    // a planned route, a recording, or a recorded hike being looked at
    { id: 'sb-draw-casing', type: 'line', source: 'sb-draw', layout: line, paint: { 'line-color': p.mapCasing, 'line-width': 8 } },
    { id: 'sb-draw', type: 'line', source: 'sb-draw', layout: line, paint: { 'line-color': isDark ? p.green : p.primary, 'line-width': 4.5 } },
    // off the trail: dots leading back to it
    { id: 'sb-back-casing', type: 'line', source: 'sb-back', layout: line, paint: { 'line-color': mapColors.meRing, 'line-width': 6, 'line-opacity': 0.35 } },
    { id: 'sb-back', type: 'line', source: 'sb-back', layout: line, paint: { 'line-color': mapColors.me, 'line-width': 4, 'line-dasharray': [0.1, 2] } },
    { id: 'sb-highlights', type: 'circle', source: 'sb-highlights', minzoom: 12.5,
      paint: {
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 12.5, 3, 16, 6],
        'circle-color': ['match', ['get', 'kind'], ...Object.entries(HIGHLIGHT_COLORS).flat(), '#5b6861'] as any,
        'circle-stroke-color': p.mapCasing, 'circle-stroke-width': 1.5,
      } },
    { id: 'sb-ends', type: 'circle', source: 'sb-ends',
      paint: {
        'circle-radius': 6.5, 'circle-stroke-width': 2.5,
        'circle-stroke-color': ['match', ['get', 'kind'], 'marker', p.ink, p.mapCasing] as any,
        'circle-color': ['match', ['get', 'kind'], 'start', isDark ? p.green : p.primary, 'end', p.ink, p.card] as any,
      } },
    { id: 'sb-heads', type: 'symbol', source: 'sb-heads', filter: ['!', ['has', 'point_count']],
      layout: { 'icon-image': ['concat', 'pin-', ['get', 'c']], 'icon-allow-overlap': true, 'icon-ignore-placement': true } },
    { id: 'sb-clusters', type: 'symbol', source: 'sb-heads', filter: ['has', 'point_count'],
      layout: { 'icon-image': ['concat', 'cluster-', ['to-string', ['get', 'point_count_abbreviated']]], 'icon-allow-overlap': true, 'icon-ignore-placement': true } },
    { id: 'sb-region-labels', type: 'symbol', source: 'sb-region-labels', maxzoom: MIN_TRAIL_ZOOM,
      layout: { 'icon-image': ['concat', 'label-', ['get', 'label']], 'symbol-sort-key': ['-', 0, ['get', 'trails']], 'icon-padding': 4 } },
    { id: 'sb-chart-point', type: 'circle', source: 'sb-chart-point',
      paint: { 'circle-radius': 6, 'circle-color': p.card, 'circle-stroke-color': p.ink, 'circle-stroke-width': 2.5 } },
    { id: 'sb-me-halo', type: 'circle', source: 'sb-me', paint: { 'circle-radius': 17, 'circle-color': mapColors.me, 'circle-opacity': 0.3 } },
    { id: 'sb-me-heading', type: 'symbol', source: 'sb-me', filter: ['has', 'heading'],
      layout: { 'icon-image': 'me-heading', 'icon-rotate': ['get', 'heading'], 'icon-rotation-alignment': 'map', 'icon-allow-overlap': true, 'icon-ignore-placement': true } },
    { id: 'sb-me', type: 'circle', source: 'sb-me',
      paint: { 'circle-radius': 7.5, 'circle-color': mapColors.me, 'circle-stroke-color': p.mapCasing, 'circle-stroke-width': 3 } },
  ];
  if (withText) {
    // names along the trails need the base map's fonts
    layers.splice(layers.findIndex((l) => l.id === 'sb-hover'), 0, {
      id: 'sb-trail-names', type: 'symbol', source: 'sb-trails', minzoom: 12, filter: ['all', ['==', ['get', 'h'], 1], ['has', 'name']],
      layout: {
        'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5,
        'symbol-spacing': 320, 'text-max-angle': 35, 'text-offset': [0, 0.9], 'text-letter-spacing': 0.02,
      },
      paint: { 'text-color': isDark ? p.green : p.primary, 'text-halo-color': p.mapCasing, 'text-halo-width': 1.6 },
    });
  }
  const geo = () => ({ type: 'geojson' as const, data: EMPTY });
  return {
    sources: {
      'sb-regions': geo(), 'sb-region-labels': geo(), 'sb-trails': { ...geo(), tolerance: 0.3 },
      'sb-heads': { ...geo(), cluster: true, clusterRadius: 42, clusterMaxZoom: 13 },
      'sb-unverified': geo(), 'sb-selected': geo(), 'sb-ends': geo(), 'sb-draw': geo(), 'sb-back': geo(), 'sb-highlights': geo(), 'sb-chart-point': geo(), 'sb-me': geo(),
    },
    layers,
  };
}

/** The outdoor style that comes with the site, with its tiles, fonts and terrain going through the
 *  device's store first (src/map/tilesource.ts). The plain style only if that file can't be read. */
async function buildStyle(full: boolean, isDark: boolean): Promise<{ style: StyleSpecification; full: boolean }> {
  let base: StyleSpecification | null = null;
  if (full) {
    try {
      const res = await fetch(`./styles/${isDark ? 'dark' : 'light'}.json`);
      if (res.ok) base = throughStore((await res.json()) as StyleSpecification);
    } catch { /* fall back to the plain map */ }
  }
  const o = overlay(isDark, !!base);
  const b = base ?? plainStyle(isDark);
  return { style: { ...b, sources: { ...b.sources, ...o.sources }, layers: [...b.layers, ...o.layers] }, full: !!base };
}

async function applyStyle(full: boolean): Promise<void> {
  if (!map) return;
  const token = ++styleToken;
  const { style, full: got } = await buildStyle(full, dark.peek());
  if (token !== styleToken || !map) return;
  ready = false;
  map.setStyle(style, { diff: false });
  map.once('style.load', () => {
    if (token !== styleToken) return;
    ready = true;
    baseMap.value = got ? 'full' : 'plain';
    redraw.value++;
  });
}

/** Bumped whenever the style has been replaced, so every layer's data is set again. */
const redraw = signal(0);

function setData(id: string, data: GeoJSON.FeatureCollection | GeoJSON.Feature): void {
  if (!map || !ready) return;
  (map.getSource(id) as GeoJSONSource | undefined)?.setData(data as any);
}

// ── Data for the layers ───────────────────────────────────────────────────────────────────────────────

/** Fewer points for far-out views: drops points closer than `min` degrees to the last one kept. */
function thin(line: Coord[], min: number): [number, number][] {
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

/** The colour a trail is drawn in: its park's blaze colour where known (white would not show: green then). */
function lineColor(t: Trail): string {
  const c = trailColor(t.tags, t.difficulty, dark.peek());
  return c.toLowerCase() === '#ffffff' ? (dark.peek() ? darkTokens : lightTokens).green : c;
}

function trailFeatures(trails: Trail[], zoom: number): GeoJSON.FeatureCollection {
  // far out, only the hikes, with coarser lines: a whole state stays quick
  const hikesOnly = zoom < 10.5;
  const min = zoom < 9 ? 0.0012 : zoom < 10.5 ? 0.0005 : zoom < 12 ? 0.00015 : 0;
  const features: GeoJSON.Feature[] = [];
  for (const t of trails) {
    if (hikesOnly && !t.isHike) continue;
    features.push({
      type: 'Feature',
      properties: {
        k: t.key, c: lineColor(t), h: t.isHike ? 1 : 0, u: t.tags['switchback:unnamed'] === 'yes' ? 1 : 0,
        ...(t.tags['switchback:unnamed'] === 'yes' ? {} : { name: t.name }),
      },
      geometry: { type: 'MultiLineString', coordinates: (hikesOnly ? [t.path] : t.segments).map((s) => thin(s, min)) },
    });
  }
  return { type: 'FeatureCollection', features };
}

function regionFeatures(): { fill: GeoJSON.FeatureCollection; labels: GeoJSON.FeatureCollection } {
  const fill: GeoJSON.Feature[] = [], labels: GeoJSON.Feature[] = [];
  for (const r of regions.value) {
    const squares = (r.coverage ?? []).map((k) => k.split('_').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
    const polys = squares.map(([lat, lon]) => [[[lon, lat], [lon + 1, lat], [lon + 1, lat + 1], [lon, lat + 1], [lon, lat]]]);
    const [s, w, n, e] = r.bbox;
    fill.push({
      type: 'Feature', properties: { region: r.region },
      geometry: polys.length ? { type: 'MultiPolygon', coordinates: polys } : { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
    });
    // the label sits in the middle of the squares that have trails (a bbox centre can be out at sea)
    let lat = (s + n) / 2, lon = (w + e) / 2;
    if (squares.length) {
      lat = squares.reduce((a, q) => a + q[0] + 0.5, 0) / squares.length;
      lon = squares.reduce((a, q) => a + q[1] + 0.5, 0) / squares.length;
    }
    labels.push({
      type: 'Feature',
      properties: { region: r.region, trails: r.trails ?? 0, label: `${regionName(r)}${r.trails ? `\n${r.trails.toLocaleString()} trails` : ''}` },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  return { fill: { type: 'FeatureCollection', features: fill }, labels: { type: 'FeatureCollection', features: labels } };
}

const lines = (ls: Coord[][], props: Record<string, unknown> = {}): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: ls.filter((l) => l.length > 1).map((l) => ({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: l.map(lngLat) } })),
});
const point = (c: Coord, props: Record<string, unknown> = {}): GeoJSON.Feature =>
  ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: lngLat(c) } });

// ── Planning markers ──────────────────────────────────────────────────────────────────────────────────
const planMarkers: maplibregl.Marker[] = [];

function syncPlanMarkers(points: Coord[], show: boolean): void {
  if (!map) return;
  const want = show ? points.length : 0;
  while (planMarkers.length > want) planMarkers.pop()!.remove();
  for (let i = 0; i < want; i++) {
    let m = planMarkers[i];
    if (!m) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'plan-point';
      m = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lngLat(points[i])).addTo(map);
      const marker = m;
      const move = () => {
        const at = marker.getLngLat(), index = planMarkers.indexOf(marker);
        if (index < 0) return;
        const next = planPoints.peek().slice();
        next[index] = [at.lat, at.lng];
        planPoints.value = next;
      };
      m.on('drag', move);
      m.on('dragend', move);
      // a tap on a point must not add another one under it
      el.addEventListener('click', (e) => e.stopPropagation());
      planMarkers[i] = m;
    } else {
      const at = m.getLngLat();
      if (at.lat !== points[i][0] || at.lng !== points[i][1]) m.setLngLat(lngLat(points[i]));
    }
    const el = m.getElement();
    el.dataset.kind = i === 0 ? 'start' : i === want - 1 ? 'end' : 'mid';
    el.setAttribute('aria-label', `Route point ${i + 1} of ${want}. Drag to move.`);
  }
}

// ── Setting up ────────────────────────────────────────────────────────────────────────────────────────

export function fitTo(box: BBox, maxZoom = 15): void {
  if (!map) return;
  const p = padding(), pad = phone() ? 36 : 64;
  map.fitBounds([[box[1], box[0]], [box[3], box[2]]], {
    padding: { top: p.top + pad + (phone() ? 40 : 0), bottom: p.bottom + pad, left: p.left + pad, right: p.right + pad },
    maxZoom, duration: reducedMotion() ? 0 : 600,
  });
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

export function zoomBy(delta: number): void {
  map?.easeTo({ zoom: map.getZoom() + delta, duration: reducedMotion() ? 0 : 200 });
}

/** Moves the map so a place sits in the middle of the part not covered by the panel. */
export function centerOn(c: Coord, zoom?: number): void {
  if (!map) return;
  const p = padding();
  map.easeTo({
    center: lngLat(c), zoom: zoom ?? map.getZoom(), duration: reducedMotion() ? 0 : 600,
    padding: { top: p.top, bottom: p.bottom, left: p.left, right: p.right },
  });
}

let popup: maplibregl.Popup | null = null;
const KIND_NAMES: Record<string, string> = {
  water: 'Drinking water', waterfall: 'Waterfall', viewpoint: 'Viewpoint', peak: 'Peak', parking: 'Parking',
  campsite: 'Campsite', shelter: 'Shelter', picnic: 'Picnic area', toilets: 'Toilets', cave: 'Cave',
};

function showHighlight(h: { kind: string; name?: string; elevation?: number }, at: [number, number]): void {
  if (!map) return;
  popup?.remove();
  const el = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = h.name || KIND_NAMES[h.kind] || 'Point of interest';
  el.appendChild(title);
  const bits = [h.name ? KIND_NAMES[h.kind] : null,
    typeof h.elevation === 'number' ? (units.peek() === 'imperial' ? `${Math.round(h.elevation * 3.28084).toLocaleString()} ft` : `${Math.round(h.elevation).toLocaleString()} m`) : null]
    .filter(Boolean);
  if (bits.length) {
    const sub = document.createElement('div');
    sub.textContent = bits.join(' · ');
    el.appendChild(sub);
  }
  popup = new maplibregl.Popup({ closeButton: false, offset: 10, className: 'sb-popup' }).setLngLat(at).setDOMContent(el).addTo(map);
}

export function createMap(container: HTMLElement): void {
  maplibregl.setWorkerUrl(new URL(workerUrl, document.baseURI).href);
  maplibregl.addProtocol('sb', mapProtocol);
  const m = new maplibregl.Map({
    container,
    style: plainStyle(dark.peek()),
    center: [initialView.lon, initialView.lat],
    zoom: initialView.zoom,
    attributionControl: false, // our own line of credits is always shown (see MapChrome)
    dragRotate: false,
    pitchWithRotate: false,
    maxZoom: 18,
    minZoom: 2,
    fadeDuration: reducedMotion() ? 0 : 200,
  });
  m.touchZoomRotate.disableRotation();
  m.keyboard.disableRotation();
  map = m;
  (window as any).__switchbackMap = m; // for checking the site by hand and in tests

  // a map tile or font that fails to load is not worth an error: the rest of the map still draws
  m.on('error', (e) => console.warn('map:', e.error?.message ?? e));
  m.setMissingStyleImageResolver((id) => makeImage(m, id, dark.peek()));

  void applyStyle(true);
  let firstTheme = true;
  effect(() => {
    dark.value;
    if (firstTheme) { firstTheme = false; return; }
    void applyStyle(true);
  });

  // ── Where the map is ──
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const moved = () => {
    view.value = visibleView(m);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const c = m.getCenter();
      save('view', { lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5), zoom: +m.getZoom().toFixed(2) });
    }, 500);
  };
  m.on('moveend', moved);
  m.on('load', moved);
  m.on('resize', moved);
  effect(() => { sheet.value; route.value; if (map) queueMicrotask(moved); });

  effect(() => {
    const f = flyTo.value;
    if (!f) return;
    untracked(() => {
      if (f.bounds) fitTo(f.bounds, f.zoom ?? 15);
      else if (f.center) centerOn(f.center, f.zoom);
      flyTo.value = null;
    });
  });

  // ── Layers ──
  effect(() => {
    redraw.value;
    const r = regionFeatures();
    setData('sb-regions', r.fill);
    setData('sb-region-labels', r.labels);
  });

  effect(() => {
    redraw.value;
    const zoom = view.value?.zoom ?? 0;
    // (the zoom only matters in steps: where the amount of detail changes)
    dark.value; // colours follow the theme
    const step = zoom < MIN_TRAIL_ZOOM ? 0 : zoom < 9 ? 1 : zoom < 10.5 ? 2 : zoom < 12 ? 3 : 4;
    setData('sb-trails', step === 0 ? EMPTY : trailFeatures(trailsInView.value, zoom));
  });

  effect(() => {
    redraw.value;
    const zoom = view.value?.zoom ?? 0;
    const open = selected.value?.key;
    const show = zoom >= MIN_TRAIL_ZOOM && (route.value.page === 'explore' || route.value.page === 'trail');
    setData('sb-heads', {
      type: 'FeatureCollection',
      features: show ? hikesInView.value.filter((t) => t.key !== open).map((t) => point(t.start, { k: t.key, c: lineColor(t) })) : [],
    });
  });

  effect(() => {
    redraw.value;
    const page = route.value.page;
    const zoom = view.value?.zoom ?? 0;
    setData('sb-unverified', zoom >= MIN_TRAIL_ZOOM && (page === 'explore' || page === 'trail' || page === 'help')
      ? { type: 'FeatureCollection', features: unverifiedInView.value.map((t) => ({ type: 'Feature', properties: { k: t.key }, geometry: { type: 'MultiLineString', coordinates: t.segments.map((s) => s.map(lngLat)) } })) }
      : EMPTY);
  });

  effect(() => {
    redraw.value;
    const page = route.value.page;
    const t = page === 'trail' ? (shownTrail.value ?? selected.value) : null;
    const f = page === 'record' ? following.value : null;
    if (t) {
      setData('sb-selected', {
        type: 'Feature', properties: { c: lineColor(t) },
        geometry: { type: 'MultiLineString', coordinates: t.segments.map((s) => s.map(lngLat)) },
      });
    } else if (f) {
      // the trail being followed, under the recorded line
      setData('sb-selected', { type: 'Feature', properties: { c: (dark.value ? darkTokens : lightTokens).green }, geometry: { type: 'LineString', coordinates: f.path.map(lngLat) } });
    } else {
      setData('sb-selected', EMPTY);
    }
  });

  // start and end dots for the open trail, a planned route (drawn as markers instead), or a recording
  effect(() => {
    redraw.value;
    const page = route.value.page;
    const ends: GeoJSON.Feature[] = [];
    let drawn: Coord[][] = [];
    if (page === 'trail' && selected.value) {
      const t = shownTrail.value ?? selected.value;
      ends.push(point(t.path[0], { kind: 'start' }));
      if (!t.isLoop) ends.push(point(t.path[t.path.length - 1], { kind: 'end' }));
    } else if (page === 'plan') {
      drawn = [planPoints.value];
    } else if (page === 'record') {
      drawn = recSegments.value.map((s) => s.map((p) => [p.lat, p.lon] as Coord));
      const firstPoint = drawn.find((s) => s.length)?.[0];
      if (firstPoint) ends.push(point(firstPoint, { kind: 'start' }));
      for (const mk of recMarkers.value) ends.push(point([mk.lat, mk.lon], { kind: 'marker' }));
    } else if (page === 'walk') {
      drawn = shownLines.value;
      const flat = drawn.flat();
      if (flat.length) ends.push(point(flat[0], { kind: 'start' }), point(flat[flat.length - 1], { kind: 'end' }));
      for (const mk of shownMarkers.value) ends.push(point(mk, { kind: 'marker' }));
    }
    setData('sb-draw', lines(drawn));
    setData('sb-ends', { type: 'FeatureCollection', features: ends });
    syncPlanMarkers(planPoints.value, page === 'plan');
  });

  effect(() => {
    redraw.value;
    const b = route.value.page === 'record' ? backLine.value : null;
    setData('sb-back', b ? lines([b]) : EMPTY);
  });

  effect(() => {
    redraw.value;
    const c = chartPoint.value;
    setData('sb-chart-point', c ? point(c) : EMPTY);
  });

  effect(() => {
    redraw.value;
    const me = myLocation.value;
    setData('sb-me', me ? point(me.at, me.heading != null ? { heading: me.heading } : {}) : EMPTY);
  });

  effect(() => {
    redraw.value;
    const k = hoverKey.value ?? '';
    if (map && ready && map.getLayer('sb-hover')) map.setFilter('sb-hover', ['==', ['get', 'k'], k]);
  });

  // peak heights in the reader's units (the base style has a layer for each)
  effect(() => {
    redraw.value;
    const u = units.value;
    if (!map || !ready) return;
    for (const [id, on] of [['peak-label-imperial', u === 'imperial'], ['peak-label-metric', u === 'metric']] as const) {
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
  });

  // highlights near the trails (viewpoints, water, parking…) once close in
  let highlightRun = 0;
  effect(() => {
    redraw.value;
    trailsInView.value; // their region files are here by now
    const v = view.value;
    if (!v || v.zoom < 12.5) { setData('sb-highlights', EMPTY); return; }
    const run = ++highlightRun;
    void highlightsIn(v.bounds).then((hs: Highlight[]) => {
      if (run !== highlightRun) return;
      setData('sb-highlights', {
        type: 'FeatureCollection',
        features: hs.map((h) => point([h.lat, h.lon], { kind: h.kind, ...(h.name ? { name: h.name } : {}), ...(h.elevation != null ? { elevation: h.elevation } : {}) })),
      });
    });
  });

  // ── Taps ──
  const open = (key: string) => {
    const i = key.indexOf('/');
    platform.haptics.tap();
    go({ page: 'trail', region: key.slice(0, i), id: key.slice(i + 1) } as Route);
  };
  const near = (pt: maplibregl.Point, r: number): [[number, number], [number, number]] => [[pt.x - r, pt.y - r], [pt.x + r, pt.y + r]];
  const has = (id: string) => !!m.getLayer(id);

  m.on('click', (e) => {
    if (!ready) return;
    const page = route.peek().page;
    if (page === 'plan') {
      planTap.peek()?.([e.lngLat.lat, e.lngLat.lng]);
      return;
    }
    if (page === 'record' || page === 'walk') return;
    const touch = (e.originalEvent as PointerEvent | undefined)?.pointerType === 'touch' || phone();
    const pins = m.queryRenderedFeatures(near(e.point, touch ? 14 : 6), { layers: ['sb-heads', 'sb-clusters'].filter(has) });
    if (pins.length) {
      const f = pins[0];
      if (f.properties.point_count) {
        const at = (f.geometry as GeoJSON.Point).coordinates as [number, number];
        void (m.getSource('sb-heads') as GeoJSONSource).getClusterExpansionZoom(f.properties.cluster_id).then((z) => {
          m.easeTo({ center: at, zoom: Math.min(z + 0.3, 16), duration: reducedMotion() ? 0 : 400 });
        });
      } else open(String(f.properties.k));
      return;
    }
    const hit = m.queryRenderedFeatures(near(e.point, touch ? 12 : 5), { layers: ['sb-trail', 'sb-side', 'sb-unnamed', 'sb-unverified'].filter(has) });
    if (hit.length) {
      // a hike before a side path, when both are under the finger
      const f = hit.find((x) => x.properties.h === 1) ?? hit[0];
      open(String(f.properties.k));
      return;
    }
    const hl = m.queryRenderedFeatures(near(e.point, touch ? 12 : 6), { layers: ['sb-highlights'].filter(has) });
    if (hl.length) {
      showHighlight(hl[0].properties as any, (hl[0].geometry as GeoJSON.Point).coordinates as [number, number]);
      return;
    }
    const region = m.queryRenderedFeatures(e.point, { layers: ['sb-region-labels', 'sb-region-fill'].filter(has) });
    if (region.length && m.getZoom() < MIN_TRAIL_ZOOM) {
      const r = regions.peek().find((x) => x.region === region[0].properties.region);
      if (r) fitTo(r.bbox, 9);
      return;
    }
    // a tap away from any trail closes the open one: back to the whole map and the list
    if (page === 'trail') {
      popup?.remove();
      if (phone()) sheet.value = 'half';
      go({ page: 'explore' });
    }
  });

  // pointing with a mouse: a hand over things that open, and the line under it thickens
  m.on('mousemove', (e) => {
    if (!ready || route.peek().page === 'plan') { m.getCanvas().style.cursor = route.peek().page === 'plan' ? 'crosshair' : ''; return; }
    const layers = ['sb-heads', 'sb-clusters', 'sb-trail', 'sb-side', 'sb-unnamed', 'sb-unverified', 'sb-highlights', 'sb-region-labels'].filter(has);
    const f = m.queryRenderedFeatures(near(e.point, 4), { layers });
    m.getCanvas().style.cursor = f.length ? 'pointer' : '';
    const line = f.find((x) => x.layer.id === 'sb-trail' || x.layer.id === 'sb-side' || x.layer.id === 'sb-unnamed' || x.layer.id === 'sb-heads');
    const key = line && line.properties.k ? String(line.properties.k) : null;
    if (hoverKey.peek() !== key) hoverKey.value = key;
  });
  m.on('mouseout', () => { if (hoverKey.peek()) hoverKey.value = null; });
}

export function resizeMap(): void {
  map?.resize();
}
