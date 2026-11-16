// Waymark for React Native: the website's tokens (web/src/tokens.ts, imported as they are) as a theme that
// follows the system's light or dark setting, and the two type faces as named families.
import { light, dark as darkPalette, radius, space, type as typeSizes, size, mapColors, paint, trailColor } from '@web/tokens';
import { dark } from '../core/state';
import { useValue } from './hooks';

export type Palette = typeof light;
export interface Theme { c: Palette; dark: boolean }
const LIGHT: Theme = { c: light, dark: false };
const DARK: Theme = { c: darkPalette, dark: true };

export function useTheme(): Theme {
  return useValue(dark) ? DARK : LIGHT;
}

/** Families as loaded by App.tsx (static weights: Android cannot pick weights out of one variable file). */
export const fonts = {
  regular: 'Figtree',
  medium: 'Figtree-Medium',
  semibold: 'Figtree-SemiBold',
  bold: 'Figtree-Bold',
  /** Names and numbers. */
  numSemibold: 'Bricolage-SemiBold',
  num: 'Bricolage-Bold',
  numHeavy: 'Bricolage-ExtraBold',
};

export const fontFiles = {
  [fonts.regular]: require('../../assets/fonts/Figtree_400Regular.ttf'),
  [fonts.medium]: require('../../assets/fonts/Figtree_500Medium.ttf'),
  [fonts.semibold]: require('../../assets/fonts/Figtree_600SemiBold.ttf'),
  [fonts.bold]: require('../../assets/fonts/Figtree_700Bold.ttf'),
  [fonts.numSemibold]: require('../../assets/fonts/BricolageGrotesque_600SemiBold.ttf'),
  [fonts.num]: require('../../assets/fonts/BricolageGrotesque_700Bold.ttf'),
  [fonts.numHeavy]: require('../../assets/fonts/BricolageGrotesque_800ExtraBold.ttf'),
};

/** A soft card shadow (the CSS one, as native shadow props). */
export const shadow = (t: Theme) => ({
  shadowColor: '#000', shadowOpacity: t.dark ? 0.3 : 0.07, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 2,
});

export { radius, space, typeSizes as type, size, mapColors, paint, trailColor };
