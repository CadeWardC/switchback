// The map: MapLibre Native with the Switchback outdoor style (light or dark, hillshade), and the trails drawn
// over it as GeoJSON line layers in their own colours, with casing, names along the lines and trailhead
// circles. A tap on a trail or a trailhead opens it; a tap on empty map closes the open trail.
import { memo, useEffect, useMemo, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { Camera, GeoJSONSource, Layer, Map, type CameraRef, type MapRef } from '@maplibre/maplibre-react-native';
import { effect } from '@preact/signals-core';
import { save } from '@web/lib/storage';
import type { BBox } from '@web/lib/geo';
import { light as lightTokens, dark as darkTokens, mapColors } from '@web/tokens';
import {
  backLine, closeTrail, flyTo, following, hikesInView, initialView, myLocation, openTrail, recSegments, recState, selected, shownTrail, shownWalk,
  tab, trailsInView, unverifiedInView, units, view, MIN_TRAIL_ZOOM,
} from '../core/state';
import { EMPTY, headFeatures, lineColor, lineFeature, linesFeature, pickKey, pointFeatures, trailFeatures } from '../core/trailMap';
import { useValue } from '../ui/hooks';
import { useTheme } from '../ui/theme';
import { styleFor } from './style';

/** Trails are drawn under the base map's labels. */
const UNDER_LABELS = 'housenumber';
const TAP_LAYERS = ['sb-heads', 'sb-trail', 'sb-side', 'sb-unnamed', 'sb-unverified'];
const width = (a: number, b: number) => ['interpolate', ['linear'], ['zoom'], 8, a, 14, b] as const;
const round = { 'line-cap': 'round', 'line-join': 'round' } as const;

/** The zoom bands the trail lines are simplified for (redrawn only when the band changes). */
const band = (z: number) => (z < 9 ? 0 : z < 10.5 ? 1 : z < 12 ? 2 : 3);

/** The map moved (or first drew): where it is now, for the trails to load and for next launch. */
function setView(s: { center: [number, number]; zoom: number; bounds: [number, number, number, number] }): void {
  const [w, south, east, n] = s.bounds;
  view.value = { center: [s.center[1], s.center[0]], zoom: s.zoom, bounds: [south, w, n, east] };
  save('view', { lat: s.center[1], lon: s.center[0], zoom: s.zoom });
}

export const TrailMap = memo(function TrailMap({ bottomInset }: { bottomInset: number }) {
  const t = useTheme();
  const map = useRef<MapRef>(null);
  const camera = useRef<CameraRef>(null);
  const insetRef = useRef(bottomInset);
  insetRef.current = bottomInset;

  const u = useValue(units);
  const trails = useValue(trailsInView);
  const unverified = useValue(unverifiedInView);
  const hikes = useValue(hikesInView);
  const v = useValue(view);
  const zoom = v?.zoom ?? initialView.zoom;
  const zoomBand = band(zoom);
  const open = useValue(selected);
  const shown = useValue(shownTrail);
  const me = useValue(myLocation);
  const back = useValue(backLine);
  const segs = useValue(recSegments);
  const rec = useValue(recState);
  const follow = useValue(following);
  const walk = useValue(shownWalk);
  const currentTab = useValue(tab);

  const style = useMemo(() => styleFor(t.dark, u), [t.dark, u]);
  const p = t.dark ? darkTokens : lightTokens;

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const trailData = useMemo(() => (zoom >= MIN_TRAIL_ZOOM ? trailFeatures(trails, zoom, t.dark) : EMPTY), [trails, zoomBand, t.dark]);
  const heads = useMemo(() => (zoom >= 11 && rec === 'idle' ? headFeatures(hikes, open?.key ?? null, t.dark) : EMPTY),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hikes, open?.key, t.dark, rec, zoomBand]);
  const unverifiedData = useMemo(() => linesFeature(unverified.flatMap((x) => x.segments), {}), [unverified]);
  const openLine = shown ?? open;
  const selectedData = useMemo(() => {
    if (rec !== 'idle' && follow) return lineFeature(follow.path, { c: t.dark ? p.green : p.primary });
    if (currentTab === 'explore' && openLine) return linesFeature(openLine === shown ? [openLine.path] : openLine.segments, { c: lineColor(openLine, t.dark) });
    return EMPTY;
  }, [openLine, shown, follow, rec, currentTab, t.dark, p]);
  const recData = useMemo(() => {
    if (rec !== 'idle') return linesFeature(segs.map((s) => s.map((x) => [x.lat, x.lon] as [number, number])));
    if (currentTab === 'log' && walk) return linesFeature(walk.segments.map((s) => s.map((x) => [x.lat, x.lon] as [number, number])));
    return EMPTY;
  }, [segs, rec, walk, currentTab]);
  const meData = useMemo(() => (me ? pointFeatures([{ at: me.at }]) : EMPTY), [me]);
  const backData = useMemo(() => (back ? lineFeature(back) : EMPTY), [back]);

  // camera requests from anywhere in the app
  useEffect(() => effect(() => {
    const f = flyTo.value;
    if (!f) return;
    const pad = { top: 90, left: 40, right: 40, bottom: insetRef.current + 30 };
    if (f.bounds) {
      const b: BBox = f.bounds;
      camera.current?.fitBounds([b[1], b[0], b[3], b[2]], { padding: pad, duration: 650 });
    } else if (f.center) {
      camera.current?.easeTo({ center: [f.center[1], f.center[0]], zoom: f.zoom, duration: 650, padding: { top: 0, left: 0, right: 0, bottom: insetRef.current * 0.6 } });
    }
  }), []);

  const onPress = async (e: { nativeEvent: { point: [number, number] } }) => {
    const [x, y] = e.nativeEvent.point;
    if (recState.peek() !== 'idle' || tab.peek() !== 'explore') return;
    let features: GeoJSON.Feature[] = [];
    try {
      features = await map.current!.queryRenderedFeatures([[x - 14, y - 14], [x + 14, y + 14]], { layers: TAP_LAYERS });
    } catch { /* treated as empty map */ }
    const key = pickKey(features.map((f) => ({ properties: f.properties as Record<string, unknown> | null })));
    const hit = key ? trailsInView.peek().find((tr) => tr.key === key) ?? unverifiedInView.peek().find((tr) => tr.key === key) : null;
    if (hit) openTrail(hit);
    else closeTrail(); // a tap on empty map closes the open trail
  };

  return (
    <Map
      ref={map}
      style={StyleSheet.absoluteFill}
      mapStyle={style}
      onPress={onPress}
      onRegionDidChange={(e) => setView(e.nativeEvent)}
      onDidFinishLoadingMap={() => { void map.current?.getViewState().then(setView, () => {}); }}
      attributionPosition={{ bottom: bottomInset + 8, right: 8 }}
      logo={false}
      compass
      compassPosition={{ top: 110, right: 12 }}
      touchPitch={false}
      preferredFramesPerSecond={60}
    >
      <Camera ref={camera} initialViewState={{ center: [initialView.lon, initialView.lat], zoom: initialView.zoom }} />

      <GeoJSONSource id="sb-trails" data={trailData}>
        <Layer id="sb-side-casing" type="line" beforeId={UNDER_LABELS} filter={['==', ['get', 'h'], 0]} layout={round}
          paint={{ 'line-color': p.mapCasing, 'line-width': width(2, 4.5) as never, 'line-opacity': 0.8 }} />
        <Layer id="sb-side" type="line" beforeId={UNDER_LABELS} filter={['all', ['==', ['get', 'h'], 0], ['==', ['get', 'u'], 0]]} layout={round}
          paint={{ 'line-color': ['get', 'c'], 'line-width': width(1, 2.2) as never, 'line-opacity': 0.85 }} />
        <Layer id="sb-unnamed" type="line" beforeId={UNDER_LABELS} filter={['all', ['==', ['get', 'h'], 0], ['==', ['get', 'u'], 1]]}
          layout={{ 'line-join': 'round' }}
          paint={{ 'line-color': ['get', 'c'], 'line-width': width(1, 2.2) as never, 'line-dasharray': [2, 1.6], 'line-opacity': 0.85 }} />
        <Layer id="sb-trail-casing" type="line" beforeId={UNDER_LABELS} filter={['==', ['get', 'h'], 1]} layout={round}
          paint={{ 'line-color': p.mapCasing, 'line-width': width(3.2, 7) as never }} />
        <Layer id="sb-trail" type="line" beforeId={UNDER_LABELS} filter={['==', ['get', 'h'], 1]} layout={round}
          paint={{ 'line-color': ['get', 'c'], 'line-width': width(1.6, 3.6) as never }} />
        <Layer id="sb-trail-names" type="symbol" minzoom={12} filter={['all', ['==', ['get', 'h'], 1], ['has', 'name']]}
          layout={{
            'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Bold'], 'text-size': 11.5,
            'symbol-spacing': 320, 'text-max-angle': 35, 'text-offset': [0, 0.9], 'text-letter-spacing': 0.02,
          }}
          paint={{ 'text-color': t.dark ? p.green : p.primary, 'text-halo-color': p.mapCasing, 'text-halo-width': 1.6 }} />
      </GeoJSONSource>

      <GeoJSONSource id="sb-unverified" data={unverifiedData}>
        <Layer id="sb-unverified-casing" type="line" beforeId={UNDER_LABELS} layout={round}
          paint={{ 'line-color': p.mapCasing, 'line-width': width(3, 6) as never, 'line-opacity': 0.85 }} />
        <Layer id="sb-unverified" type="line" beforeId={UNDER_LABELS} layout={{ 'line-join': 'round' }}
          paint={{ 'line-color': mapColors.unverified, 'line-width': width(1.6, 3) as never, 'line-dasharray': [1.2, 1.4] }} />
      </GeoJSONSource>

      <GeoJSONSource id="sb-selected" data={selectedData}>
        <Layer id="sb-selected-casing" type="line" layout={round} paint={{ 'line-color': p.mapCasing, 'line-width': width(7, 11) as never }} />
        <Layer id="sb-selected" type="line" layout={round} paint={{ 'line-color': ['get', 'c'], 'line-width': width(4, 6) as never }} />
      </GeoJSONSource>

      <GeoJSONSource id="sb-heads" data={heads}>
        <Layer id="sb-heads" type="circle"
          paint={{ 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 15, 7], 'circle-color': ['get', 'c'], 'circle-stroke-color': p.mapCasing, 'circle-stroke-width': 2 }} />
      </GeoJSONSource>

      <GeoJSONSource id="sb-rec" data={recData}>
        <Layer id="sb-rec-casing" type="line" layout={round} paint={{ 'line-color': p.mapCasing, 'line-width': 8 }} />
        <Layer id="sb-rec" type="line" layout={round} paint={{ 'line-color': t.dark ? p.green : mapColors.route, 'line-width': 4.5 }} />
      </GeoJSONSource>

      <GeoJSONSource id="sb-back" data={backData}>
        <Layer id="sb-back-casing" type="line" layout={round} paint={{ 'line-color': mapColors.meRing, 'line-width': 6, 'line-opacity': 0.35 }} />
        <Layer id="sb-back" type="line" layout={round} paint={{ 'line-color': mapColors.me, 'line-width': 4, 'line-dasharray': [0.1, 2] }} />
      </GeoJSONSource>

      <GeoJSONSource id="sb-me" data={meData}>
        <Layer id="sb-me-halo" type="circle" paint={{ 'circle-radius': 17, 'circle-color': mapColors.me, 'circle-opacity': 0.3 }} />
        <Layer id="sb-me" type="circle" paint={{ 'circle-radius': 7.5, 'circle-color': mapColors.me, 'circle-stroke-color': p.mapCasing, 'circle-stroke-width': 3 }} />
      </GeoJSONSource>
    </Map>
  );
});
