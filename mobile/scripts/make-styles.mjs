// Writes src/map/styles/light.json and dark.json from the Swift app's outdoor map style
// (../Switchback/Resources/switchback-style*.json: OpenMapTiles schema, OpenFreeMap tiles, hillshade from the
// AWS terrain tiles). The same adaptation as web/scripts/make-styles.mjs: the Swift app draws its point-of-
// interest icons ("sb-…") at runtime and this app has no sprite, so icon layers are dropped or reduced to
// their text. Both peak label layers (feet and metres) are kept; the app shows the one for the units setting.
// Run with `npm run styles`; the output is committed so a plain checkout bundles without running it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'src', 'map', 'styles');
mkdirSync(out, { recursive: true });

for (const [from, to] of [['switchback-style.json', 'light.json'], ['switchback-style-dark.json', 'dark.json']]) {
  const style = JSON.parse(readFileSync(join(here, '..', '..', 'Switchback', 'Resources', from), 'utf8'));
  const layers = [];
  for (const layer of style.layers) {
    const layout = layer.layout;
    if (layout && 'icon-image' in layout) {
      if (!('text-field' in layout)) continue; // an icon and nothing else
      for (const key of Object.keys(layout)) if (key.startsWith('icon-')) delete layout[key];
      delete layout['text-optional'];
      if (layout['text-anchor'] === 'top') { delete layout['text-anchor']; delete layout['text-offset']; }
      if (layer.paint) for (const key of Object.keys(layer.paint)) if (key.startsWith('icon-')) delete layer.paint[key];
      if (layer.id === 'poi') layer.minzoom = Math.max(layer.minzoom ?? 0, 15);
    }
    layers.push(layer);
  }
  style.layers = layers;
  delete style.sprite;
  writeFileSync(join(out, to), JSON.stringify(style));
  console.log(`src/map/styles/${to}: ${layers.length} layers`);
}
