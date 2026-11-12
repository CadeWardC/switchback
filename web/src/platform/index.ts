// The one place that decides which device implementation the site uses.
// When the site is wrapped as a phone app, add ./capacitor.ts (implementing Platform) and pick it here, e.g.
//   export const platform = isNativeApp() ? capacitorPlatform : browserPlatform;
import { browserPlatform } from './browser';
import type { Platform } from './types';

export const platform: Platform = browserPlatform;
export type * from './types';
