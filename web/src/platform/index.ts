// The one place that decides which device implementation the site uses: the phone apps' when the site
// runs inside them (Capacitor), the browser's otherwise.
import { Capacitor } from '@capacitor/core';
import { browserPlatform } from './browser';
import { capacitorPlatform } from './capacitor';
import type { Platform } from './types';

export const isNativeApp = Capacitor.isNativePlatform();
export const platform: Platform = isNativeApp ? capacitorPlatform : browserPlatform;
export type * from './types';
