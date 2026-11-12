// Waymark: every design value in one place (docs/design/README.md and waymark-mockups.html are the source).
// Colours, type, radii, spacing and shapes; the CSS custom properties are generated from this file
// (tokensCss, injected at startup) and the map reads the same values, so a change here changes everything.
//
// The rules that matter:
//   - spruce green on cool stone surfaces, soft cards over the map;
//   - sign yellow means YOU: your position, the next thing ahead, the off-trail card. Nothing else is yellow;
//   - dusk is for daylight running out (the end of the light line, "after sunset");
//   - names and numbers are set in Bricolage Grotesque, everything else in Figtree.

/** The colour a park paints a trail's blazes, by the word in the trail's `switchback:blaze` tag. */
export const paint: Record<string, string> = {
  yellow: '#e3b21c', orange: '#e07a1f', blue: '#2f6fc0', red: '#c2452d', white: '#ffffff', green: '#23945a',
  purple: '#7b4bc9', black: '#22292a', pink: '#d9608f', brown: '#8a5a2b',
};

interface Palette {
  /** The page, the sheet and the side panel. */
  bg: string;
  /** Cards and inputs. */
  card: string;
  /** A quiet fill: chips, secondary buttons, the light line. */
  tint: string;
  ink: string;
  muted: string;
  line: string;
  /** A stronger line: dividers between the big numbers, the grabber, outlines. */
  line2: string;
  /** Buttons. */
  primary: string;
  onPrimary: string;
  /** The lighter square behind the mark on the Start button. */
  primaryLift: string;
  /** Green for text, lines and small marks on a surface; also a trail with no known blaze colour. */
  green: string;
  /** Links and quiet buttons. */
  link: string;
  /** You. */
  you: string;
  onYou: string;
  onYouMuted: string;
  /** Daylight running out. */
  dusk: string;
  duskSoft: string;
  /** The hard colour: three blazes for a very hard trail, and things that delete. */
  hard: string;
  hardSoft: string;
  /** The map before the base map draws, and the casing around trail lines. */
  mapLand: string;
  mapCasing: string;
  shadow: string;
  shadowLarge: string;
  focus: string;
}

export const light: Palette = {
  bg: '#edf0ec',
  card: '#ffffff',
  tint: '#dce9e1',
  ink: '#10201a',
  muted: '#5b6861',
  line: '#dde2dc',
  line2: '#b9c2bb',
  primary: '#12543f',
  onPrimary: '#ffffff',
  primaryLift: '#3a7260',
  green: '#23945a',
  link: '#12543f',
  you: '#f4c430',
  onYou: '#231b00',
  onYouMuted: '#5a4700',
  dusk: '#e9a15b',
  duskSoft: '#f8e6d3',
  hard: '#c2452d',
  hardSoft: '#f7e1dc',
  mapLand: '#e6eae3',
  mapCasing: '#edf0ec',
  shadow: '0 1px 2px rgba(16, 32, 26, 0.05), 0 2px 10px rgba(16, 32, 26, 0.05)',
  shadowLarge: '0 2px 8px rgba(16, 32, 26, 0.08), 0 14px 36px rgba(16, 32, 26, 0.14)',
  focus: '#12543f',
};

export const dark: Palette = {
  bg: '#0d1512',
  card: '#15201b',
  tint: '#1b3329',
  ink: '#eaf1ec',
  muted: '#93a39a',
  line: '#223029',
  line2: '#3a4a41',
  primary: '#1d7a5b',
  onPrimary: '#ffffff',
  primaryLift: '#3f937a',
  green: '#4fc588',
  link: '#4fc588',
  you: '#f4c430',
  onYou: '#231b00',
  onYouMuted: '#5a4700',
  dusk: '#d98f4c',
  duskSoft: '#3a2a1a',
  hard: '#ee8168',
  hardSoft: '#3b201a',
  mapLand: '#111a16',
  mapCasing: '#0d1512',
  shadow: '0 1px 2px rgba(0, 0, 0, 0.3), 0 2px 10px rgba(0, 0, 0, 0.25)',
  shadowLarge: '0 2px 8px rgba(0, 0, 0, 0.35), 0 14px 36px rgba(0, 0, 0, 0.5)',
  focus: '#4fc588',
};

/** Colours used only on the map, the same in light and dark (they sit on the map, not on a surface). */
export const mapColors = {
  /** A planned route, a recording, a recorded hike. */
  route: '#12543f',
  /** Where you are, and the dots leading back to the trail. */
  me: '#f4c430',
  meRing: '#231b00',
  /** Trails on the "needs verification" list. */
  unverified: '#8a6a3c',
  start: '#12543f',
  end: '#10201a',
  marker: '#ffffff',
} as const;

/** Kept for code that still asks for a colour by difficulty: every trail is green unless very hard. */
export const difficultyColors = { easy: light.green, moderate: light.green, hard: light.green, veryHard: light.hard } as const;

export const radius = { card: 14, control: 12, chip: 999, sheet: 20, blaze: 2 } as const;
/** A 4px scale. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;
/** Type sizes. `name` and `big` are the trail name and the three numbers: nothing else is as large. */
export const type = { tiny: 12, small: 13.5, body: 15.5, large: 17, title: 22, name: 28, big: 33, huge: 52, label: 11.5 } as const;
export const size = { touch: 44, tabBar: 54, panel: 408, blazeW: 8, blazeH: 14, shape: 46, ridge: 112 } as const;
export const font = '"Figtree Variable", Figtree, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
/** Names and numbers. */
export const fontNum = '"Bricolage Grotesque Variable", "Bricolage Grotesque", "Figtree Variable", system-ui, sans-serif';
export const motion = { fast: '140ms', sheet: '260ms', ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)' } as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const vars = (o: Record<string, string | number>, prefix: string, unit = '') =>
  Object.entries(o).map(([k, v]) => `--${prefix}${kebab(k)}:${v}${unit};`).join('');

export function tokensCss(): string {
  const shared =
    vars(paint, 'paint-') + vars(mapColors, 'map-') + vars(radius, 'radius-', 'px') + vars(space, 'space-', 'px') +
    vars(type, 'text-', 'px') + vars(size, 'size-', 'px') + vars(motion, 'motion-') + `--font:${font};--font-num:${fontNum};`;
  const l = vars(light as unknown as Record<string, string>, 'c-');
  const d = vars(dark as unknown as Record<string, string>, 'c-');
  return `:root{${shared}${l}color-scheme:light}:root[data-theme="dark"]{${d}color-scheme:dark}`;
}

/** The colour to paint a trail's line and blazes: the park's own where the trail says, green otherwise. */
export function trailColor(tags: Record<string, string>, difficulty: string, isDark = false): string {
  const word = (tags['switchback:blaze'] ?? '').toLowerCase().split(/[\s;,/]+/)[0];
  if (word && paint[word]) return paint[word];
  const p = isDark ? dark : light;
  return difficulty === 'veryHard' ? p.hard : p.green;
}
