// How the screen is divided: a panel over the left of the map on wide screens (narrower between 700 and
// 1024 px), a sheet over the map and a row of four words on phones.
import { size } from './tokens';
import type { Sheet } from './state';

export const isPhone = () => window.innerWidth < 700;

const cssPx = (name: string) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name)) || 0;

/** The side panel's width now (it is narrower on mid-sized screens). */
export const panelWidth = () => (window.innerWidth < 1024 ? 344 : size.panel);

/** The row of words at the bottom: it steps away while a hike is being recorded. */
export function tabBarHeight(): number {
  const app = document.querySelector<HTMLElement>('.app');
  return app && 'hiking' in app.dataset ? 0 : size.tabBar;
}

/** How many pixels of the sheet show for each position (not counting the row of words under it). */
export function sheetVisible(state: Sheet): number {
  const room = window.innerHeight - tabBarHeight() - cssPx('--safe-bottom');
  if (state === 'peek') return 132;
  // "half" leaves most of the screen to the map
  if (state === 'half') return Math.round(Math.max(300, room * 0.44));
  return room - 64;
}

/** The part of the map covered by the sheet on phones (the map itself stops at the row of words). */
export function coveredBottom(state: Sheet): number {
  return sheetVisible(state === 'full' ? 'half' : state);
}
