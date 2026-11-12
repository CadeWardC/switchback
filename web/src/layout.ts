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
  if (state === 'half') {
    // the resting height suits the page: the list leaves most of the screen to the map; a trail page shows
    // its name, numbers, ridge and Start button; a hike shows the ridge, two numbers and one line
    const app = document.querySelector<HTMLElement>('.app');
    const page = app?.dataset.page;
    const share = app && 'hiking' in app.dataset && page === 'record' ? 0.36 : page === 'trail' ? 0.64 : page === 'explore' ? 0.42 : 0.5;
    return Math.round(Math.max(290, room * share));
  }
  return room - 64;
}

/** The part of the map covered by the sheet on phones (the map itself stops at the row of words). */
export function coveredBottom(state: Sheet): number {
  return sheetVisible(state === 'full' ? 'half' : state);
}
