// How the screen is divided: a side panel on wide screens, a sheet over the map and a tab bar on phones.
import { size } from './tokens';
import type { Sheet } from './state';

export const isPhone = () => window.innerWidth < 760;

function safeBottom(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--safe-bottom');
  return parseFloat(v) || 0;
}

/** How many pixels of the sheet show for each position (not counting the tab bar under it). */
export function sheetVisible(state: Sheet): number {
  const h = window.innerHeight;
  const room = h - size.tabBar - safeBottom();
  if (state === 'peek') return 148;
  if (state === 'half') return Math.round(room * 0.48);
  return room - 64;
}

/** The part of the map covered by the sheet on phones (the map itself stops at the tab bar). */
export function coveredBottom(state: Sheet): number {
  return sheetVisible(state === 'full' ? 'half' : state);
}
