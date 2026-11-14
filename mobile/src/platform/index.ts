// The native device layer. It implements the website's Platform interface (web/src/platform/types.ts), and
// Metro gives it to the website's own logic in place of web/src/platform/index.ts (see metro.config.js), so
// web/src/data.ts, web/src/lib/storage.ts and web/src/lib/gpx.ts run here unchanged.
import { AppState, BackHandler, Linking, Platform as RN, Share } from 'react-native';
import * as Haptics from 'expo-haptics';
import * as Network from 'expo-network';
import * as Notifications from 'expo-notifications';
import * as Sharing from 'expo-sharing';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import type { Platform } from '@web/platform/types';
import { cacheFile, documents, fileStore, keyValue } from './files';
import { location } from './location';

export type * from '@web/platform/types';
export const isNativeApp = true;

const RELEASE = 'https://github.com/CadeWardC/switchback/releases/download/trails-us/';
const android = RN.OS === 'android';
const quiet = (p: Promise<unknown>) => { p.catch(() => {}); };

// ── Notifications: shown as banners even with the app open; buttons on the end-of-trail question ────────
Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});
const CHANNEL = 'hike';
let channelReady: Promise<unknown> | null = null;
const channel = () => (channelReady ??= android
  ? Notifications.setNotificationChannelAsync(CHANNEL, {
    name: 'Your hike', description: 'Leaving the trail and reaching its end', importance: Notifications.AndroidImportance.HIGH,
    vibrationPattern: [0, 250, 150, 250], lightColor: '#f4c430',
  }).catch(() => null)
  : Promise.resolve());
const actionHandlers = new Map<string, (id: string) => void>();
Notifications.addNotificationResponseReceivedListener((r) => {
  const handler = actionHandlers.get(r.notification.request.content.categoryIdentifier ?? '');
  if (!handler) return;
  handler(r.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER ? 'tap' : r.actionIdentifier);
  quiet(Notifications.dismissNotificationAsync(r.notification.request.identifier));
});

const directionsUrl = (lat: number, lon: number) => {
  const at = `${lat.toFixed(6)},${lon.toFixed(6)}`;
  return android ? `https://www.google.com/maps/dir/?api=1&destination=${at}` : `https://maps.apple.com/?daddr=${at}&dirflg=d`;
};

async function shareMessage(title: string, message: string, url?: string): Promise<'shared' | 'failed'> {
  try {
    // iOS takes the link apart from the words; Android has one text
    const r = await Share.share(url && !android ? { title, message, url } : { title, message: url ? `${message}\n${url}`.trim() : message });
    return r.action === Share.dismissedAction ? 'failed' : 'shared';
  } catch {
    return 'failed';
  }
}

export const platform: Platform = {
  name: android ? 'android' : 'ios',
  async init() { /* settings are read the first time they are asked for */ },
  documents,
  keyValue,
  fileStore,
  location,

  notifications: {
    async request() {
      try {
        const have = await Notifications.getPermissionsAsync();
        if (have.granted) return true;
        if (!have.canAskAgain) return false;
        return (await Notifications.requestPermissionsAsync()).granted;
      } catch {
        return false;
      }
    },
    async show(title, body) {
      await channel();
      quiet(Notifications.scheduleNotificationAsync({ content: { title, body }, trigger: android ? { channelId: CHANNEL } : null }));
    },
    async ask(title, body, actions, onAction) {
      await channel();
      const category = 'ask-finish';
      actionHandlers.set(category, onAction);
      try {
        await Notifications.setNotificationCategoryAsync(category, actions.map((a) => ({
          identifier: a.id, buttonTitle: a.title, options: { opensAppToForeground: a.id !== 'keep' },
        })));
      } catch { /* buttons are a nicety: the question still shows */ }
      quiet(Notifications.scheduleNotificationAsync({
        content: { title, body, categoryIdentifier: category }, trigger: android ? { channelId: CHANNEL } : null,
      }));
    },
  },

  app: {
    onBack(handler) {
      BackHandler.addEventListener('hardwareBackPress', handler);
    },
    setTheme() { /* the status bar follows the theme in App.tsx */ },
    onResume(handler) {
      AppState.addEventListener('change', (s) => { if (s === 'active') handler(); });
    },
  },

  keepAwake: {
    async on() {
      try { await activateKeepAwakeAsync('hike'); return true; } catch { return false; }
    },
    async off() {
      try { deactivateKeepAwake('hike'); } catch { /* was not on */ }
    },
  },

  files: {
    exportVerb: 'handed to the share sheet',
    async exportText(name, text, type) {
      const f = cacheFile(name, text);
      await Sharing.shareAsync(f.uri, { mimeType: type, dialogTitle: name, UTI: type === 'application/gpx+xml' ? 'com.topografix.gpx' : undefined });
    },
    shareLink: (title, url) => shareMessage(title, '', url),
    shareText: (text) => shareMessage('Switchback', text),
  },

  links: {
    open(url) { quiet(Linking.openURL(url)); },
    directionsUrl,
    directions(lat, lon) { quiet(Linking.openURL(directionsUrl(lat, lon))); },
    openSettings() { quiet(Linking.openSettings()); },
  },

  haptics: {
    tap() { quiet(Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)); },
    success() { quiet(Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)); },
  },

  trailFiles: {
    url: (file) => RELEASE + file,
    async getJson(file) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 15_000);
      try {
        const res = await fetch(RELEASE + file, { headers: { Accept: 'application/json' }, signal: ctl.signal });
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`${file}: ${res.status}`);
        return await res.json();
      } finally {
        clearTimeout(timer);
      }
    },
  },

  // The base map is cached by MapLibre Native itself (its ambient cache and offline packs: src/core/offline.ts),
  // so the website's tile store is not used in the app.
  tiles: {
    async get() { return null; },
    async put() {},
    async has() { return false; },
    async size() { return 0; },
    async clear() {},
  },

  network: {
    async kind() {
      try {
        const s = await Network.getNetworkStateAsync();
        if (s.isConnected === false) return 'none';
        return s.type === Network.NetworkStateType.WIFI ? 'wifi' : s.type === Network.NetworkStateType.CELLULAR ? 'cellular' : 'unknown';
      } catch {
        return 'unknown';
      }
    },
  },
};
