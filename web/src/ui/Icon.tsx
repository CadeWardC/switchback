// The icons, drawn inline (24px grid, 1.8px strokes). No icon files or fonts.
import type { JSX } from 'preact';

const PATHS: Record<string, string> = {
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4.5 4.5',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  length: 'M4 17 17 4l3 3L7 20l-3-3Zm5.5-5.5 1.5 1.5m1.5-4.5 1.5 1.5M6.5 14.5 8 16',
  climb: 'M3 18l6-6 4 4 8-9m0 0h-5m5 0v5',
  descent: 'M3 6l6 6 4-4 8 9m0 0h-5m5 0v-5',
  peak: 'M2.5 19 9 8l3.5 5.500L15 10l6.5 9h-19Z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-14v5l3.5 2',
  loop: 'M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1m3 10-3-3 3-3m-3 3h12a4 4 0 0 0 4-4v-1',
  oneway: 'M4 12h15m-5-5 5 5-5 5',
  directions: 'M12 2.5 21.5 12 12 21.5 2.5 12 12 2.500ZM9 14.500V12a1.5 1.5 0 0 1 1.5-1.500H15m-2-2.5 2.5 2.500L13 13',
  download: 'M12 4v11m-4.5-4 4.5 4.500L16.5 11M5 20h14',
  bookmark: 'M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.700l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.700l1-1',
  map: 'M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Zm0 0v14m6-12v14',
  record: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z',
  activity: 'M3 12h4l2.5-7 5 14L17 12h4',
  gear: 'M12 15.500a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.100-1.4-.100-1.4 2-1.5-2-3.4-2.3.900a7.3 7.3 0 0 0-2.4-1.400L14.3 3h-4l-.400 2.200a7.3 7.3 0 0 0-2.4 1.400l-2.3-.900-2 3.4 2 1.5-.100 1.4.100 1.4-2 1.5 2 3.4 2.3-.900c.700.6 1.5 1.1 2.4 1.400l.400 2.200h4l.400-2.200c.900-.300 1.7-.800 2.4-1.400l2.3.900 2-3.4-2-1.500Z',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  locate: 'M12 8.500a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 2v3.500M12 18.500V22M2 12h3.500M18.5 12H22',
  undo: 'M8 5 4 9l4 4M4 9h10a5 5 0 0 1 0 10h-3',
  trash: 'M4 7h16M9 7V4.500h6V7m-8.5 0 1 13h9l1-13M10 11v5.500m4-5.500v5.5',
  pencil: 'M4 20l1-4L16.5 4.500l3 3L8 19l-4 1Zm10-13 3 3',
  play: 'M7 4.500v15l12-7.5-12-7.500Z',
  pause: 'M8 5v14m8-14v14',
  stop: 'M6.5 6.500h11v11h-11z',
  check: 'M5 12.5 10 17.5 19.5 7',
  external: 'M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v6m0-9.500v.500',
  send: 'M12 16V4m-4.5 4.500L12 4l4.5 4.500M5 14v5a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h6.500a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6H16',
  filter: 'M4 6h16M7 12h10m-7 6h4',
  flag: 'M5 21V4m0 1h12l-2.5 4L17 13H5',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0-13v2m0 14v2M3 12h2m14 0h2M5.6 5.6 7 7m10 10 1.4 1.400m0-12.800L17 7M7 17l-1.4 1.4',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, filled = false, ...rest }: { name: string; size?: number; filled?: boolean } & JSX.SVGAttributes<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill={filled ? 'currentColor' : 'none'} stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" {...rest}>
      <path d={PATHS[name] ?? ''} />
    </svg>
  );
}
