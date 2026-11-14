// The Switchback outdoor map (light and dark), generated from the Swift app's style by
// scripts/make-styles.mjs. Both peak label layers are in it; the one for the reader's units is shown.
import type { StyleSpecification } from '@maplibre/maplibre-react-native';
import type { Units } from '@web/lib/format';
import lightJson from './styles/light.json';
import darkJson from './styles/dark.json';

const cache = new Map<string, StyleSpecification>();

export function styleFor(isDark: boolean, units: Units): StyleSpecification {
  const key = `${isDark}-${units}`;
  const have = cache.get(key);
  if (have) return have;
  const base = (isDark ? darkJson : lightJson) as unknown as StyleSpecification;
  const hide = units === 'imperial' ? 'peak-label-metric' : 'peak-label-imperial';
  const style: StyleSpecification = {
    ...base,
    layers: base.layers.map((l) => (l.id === hide ? { ...l, layout: { ...(l as { layout?: object }).layout, visibility: 'none' } } as typeof l : l)),
  };
  cache.set(key, style);
  return style;
}
