// Every design value in one place: colours, radii, spacing, type sizes, shadows, difficulty colours.
// The CSS custom properties are generated from this file (tokensCss, injected at startup), and the map
// reads the same values, so a change here changes the whole site. The phone apps share these values.

export const difficultyColors = {
  easy: '#2E9E5B',
  moderate: '#2B7FD9',
  hard: '#D9482B',
  veryHard: '#7B4BC9',
} as const;

export const brand = {
  green: '#1F6B45',
  ink: '#14211A',
  surface: '#F7F6F2',
  amber: '#E8A33D',
} as const;

interface Palette {
  /** Behind everything (the page, the map before it draws). */
  bg: string;
  /** Panels and sheets. */
  surface: string;
  /** Cards and inputs on a panel. */
  card: string;
  /** A quieter fill: chips, stat tiles, hover. */
  sunken: string;
  ink: string;
  /** Secondary text. */
  muted: string;
  line: string;
  /** Buttons and the active tab. */
  primary: string;
  /** Text on a primary button. */
  onPrimary: string;
  /** Primary-coloured text and icons on a surface. */
  primaryText: string;
  /** A tint of the primary colour: selected rows, soft buttons. */
  primarySoft: string;
  accent: string;
  /** Text on the amber accent. */
  onAccent: string;
  accentSoft: string;
  danger: string;
  dangerSoft: string;
  /** The map when the base map cannot be reached. */
  mapPlain: string;
  mapRegion: string;
  /** The casing around trail lines. */
  mapCasing: string;
  shadow: string;
  shadowLarge: string;
  focus: string;
}

export const light: Palette = {
  bg: '#ECEBE4',
  surface: brand.surface,
  card: '#FFFFFF',
  sunken: '#EEEDE6',
  ink: brand.ink,
  muted: '#55635B',
  line: '#DEDDD4',
  primary: brand.green,
  onPrimary: '#FFFFFF',
  primaryText: brand.green,
  primarySoft: '#E0EDE5',
  accent: brand.amber,
  onAccent: '#2B1D05',
  accentSoft: '#FBEFD9',
  danger: '#B93A22',
  dangerSoft: '#FBE6E1',
  mapPlain: '#EEF0E7',
  mapRegion: brand.green,
  mapCasing: '#FFFFFF',
  shadow: '0 1px 2px rgba(20, 33, 26, 0.06), 0 2px 8px rgba(20, 33, 26, 0.06)',
  shadowLarge: '0 2px 6px rgba(20, 33, 26, 0.08), 0 12px 32px rgba(20, 33, 26, 0.14)',
  focus: '#1F6B45',
};

export const dark: Palette = {
  bg: '#0C120F',
  surface: '#121A16',
  card: '#1A2520',
  sunken: '#212E27',
  ink: '#ECF1ED',
  muted: '#A3B2A9',
  line: '#2C3A32',
  primary: '#2F8A5C',
  onPrimary: '#FFFFFF',
  primaryText: '#7FD0A3',
  primarySoft: '#1D3A2B',
  accent: brand.amber,
  onAccent: '#2B1D05',
  accentSoft: '#3B2F17',
  danger: '#F0846E',
  dangerSoft: '#40211B',
  mapPlain: '#131B17',
  mapRegion: '#7FD0A3',
  mapCasing: '#0C120F',
  shadow: '0 1px 2px rgba(0, 0, 0, 0.3), 0 2px 8px rgba(0, 0, 0, 0.3)',
  shadowLarge: '0 2px 6px rgba(0, 0, 0, 0.35), 0 12px 32px rgba(0, 0, 0, 0.5)',
  focus: '#7FD0A3',
};

export const radius = { card: 14, control: 10, chip: 999, sheet: 20 } as const;
/** A 4px scale. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 } as const;
export const type = { tiny: 12, small: 13, body: 15, large: 17, title: 22, stat: 20 } as const;
export const size = { touch: 44, tabBar: 56, panel: 408 } as const;
export const font = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const motion = { fast: '140ms', sheet: '260ms', ease: 'cubic-bezier(0.2, 0.8, 0.2, 1)' } as const;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const vars = (o: Record<string, string | number>, prefix: string, unit = '') =>
  Object.entries(o).map(([k, v]) => `--${prefix}${kebab(k)}:${v}${unit};`).join('');

export function tokensCss(): string {
  const shared =
    vars(difficultyColors, 'diff-') + vars(radius, 'radius-', 'px') + vars(space, 'space-', 'px') +
    vars(type, 'text-', 'px') + vars(size, 'size-', 'px') + vars(motion, 'motion-') + `--font:${font};`;
  const l = vars(light as unknown as Record<string, string>, 'c-');
  const d = vars(dark as unknown as Record<string, string>, 'c-');
  return `:root{${shared}${l}color-scheme:light}:root[data-theme="dark"]{${d}color-scheme:dark}`;
}
