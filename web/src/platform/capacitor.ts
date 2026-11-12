// The phone apps' version of the device interface (the site wrapped with Capacitor).
//   Trail files: straight from the GitHub release with native downloads, kept as files on the device.
//   Recording: a background location service (an Android foreground service with a notification; iOS
//   background location), so it carries on with the screen off.
//   Files go to the share sheet; links and directions open outside the app.
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { AppLauncher } from '@capacitor/app-launcher';
import { Browser } from '@capacitor/browser';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';
import { StatusBar, Style } from '@capacitor/status-bar';
import { KeepAwake } from '@capacitor-community/keep-awake';
import type { BackgroundGeolocationPlugin, Location } from '@capacitor-community/background-geolocation';
import type { Fix, FixHandler, LocationProblem, Platform, ProblemHandler } from './types';

const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation');

const RELEASE = 'https://github.com/CadeWardC/switchback/releases/download/trails-us/';
const TRAILS = 'trail-files';
const DOCS = 'documents';
const android = Capacitor.getPlatform() === 'android';

const quiet = <T>(p: Promise<T>): void => { p.catch(() => {}); };

// ── Small values: read into memory at startup (Preferences is asynchronous), written through ──────────
const values = new Map<string, string>();

// ── Location ──────────────────────────────────────────────────────────────────────────────────────────
function toFix(l: Location): Fix {
  return { lat: l.latitude, lon: l.longitude, ele: l.altitude ?? null, accuracy: l.accuracy, time: l.time ?? Date.now() };
}

function problemOf(error: { code?: string } | undefined): LocationProblem {
  return error?.code === 'NOT_AUTHORIZED' ? 'denied' : 'unavailable';
}

let recordingWatcher: string | null = null;
let notificationId = 1;

async function watch(onFix: FixHandler, onProblem: ProblemHandler, background?: { title: string; text: string }): Promise<string> {
  return BackgroundGeolocation.addWatcher(
    {
      ...(background ? { backgroundTitle: background.title, backgroundMessage: background.text } : {}),
      requestPermissions: true,
      stale: false,
      // every few metres is plenty for a walk, and spares the battery
      distanceFilter: background ? 3 : 0,
    },
    (location, error) => {
      if (error) onProblem(problemOf(error));
      else if (location) onFix(toFix(location));
    },
  );
}

async function ensureDir(path: string, directory: Directory): Promise<void> {
  try { await Filesystem.mkdir({ path, directory, recursive: true }); } catch { /* it is there already */ }
}

/** A document's file name: only letters, digits, dots and dashes. */
const safe = (name: string) => name.replace(/[^\w.@-]/g, '_');

export const capacitorPlatform: Platform = {
  name: android ? 'android' : 'ios',

  async init() {
    try {
      const { keys } = await Preferences.keys();
      await Promise.all(keys.map(async (key) => {
        const { value } = await Preferences.get({ key });
        if (value != null) values.set(key, value);
      }));
    } catch { /* first launch, or storage unavailable: defaults */ }
    await Promise.all([ensureDir(TRAILS, Directory.Data), ensureDir(DOCS, Directory.Data)]);
  },

  location: {
    recordsInBackground: true,
    current: () => new Promise((resolve, reject) => {
      let last: Fix | null = null, id: string | null = null, done = false;
      const finish = (problem?: LocationProblem) => {
        if (done) return;
        done = true;
        if (id) quiet(BackgroundGeolocation.removeWatcher({ id }));
        if (last) resolve(last);
        else reject(problem ?? 'unavailable');
      };
      BackgroundGeolocation.addWatcher({ requestPermissions: true, stale: true }, (location, error) => {
        if (error) finish(problemOf(error));
        else if (location) { last = toFix(location); if (location.accuracy <= 30) finish(); }
      }).then((watcher) => { id = watcher; if (done) quiet(BackgroundGeolocation.removeWatcher({ id })); }, () => finish('unavailable'));
      setTimeout(() => finish(), 8000);
    }),
    watch(onFix, onProblem) {
      let id: string | null = null, stopped = false;
      watch(onFix, onProblem).then((watcher) => {
        id = watcher;
        if (stopped) quiet(BackgroundGeolocation.removeWatcher({ id }));
      }, () => onProblem('unavailable'));
      return () => {
        stopped = true;
        if (id) quiet(BackgroundGeolocation.removeWatcher({ id }));
      };
    },
    async startRecording(onFix, onProblem, notice) {
      if (recordingWatcher) await BackgroundGeolocation.removeWatcher({ id: recordingWatcher }).catch(() => {});
      recordingWatcher = null;
      try {
        recordingWatcher = await watch(onFix, onProblem, notice);
      } catch {
        onProblem('unavailable');
      }
    },
    async stopRecording() {
      const id = recordingWatcher;
      recordingWatcher = null;
      if (id) await BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
    },
  },

  keepAwake: {
    async on() {
      try { await KeepAwake.keepAwake(); return true; } catch { return false; }
    },
    async off() {
      try { await KeepAwake.allowSleep(); } catch { /* was not on */ }
    },
  },

  files: {
    exportVerb: 'handed to the share sheet',
    async exportText(name, text, _type) {
      // written to the app's temporary files, then offered through the share sheet (Files, mail, AirDrop…)
      const written = await Filesystem.writeFile({ path: safe(name), data: text, directory: Directory.Cache, encoding: Encoding.UTF8 });
      try {
        await Share.share({ title: name, files: [written.uri] });
      } catch { /* the person closed the sheet */ }
    },
    async shareLink(title, url) {
      try {
        await Share.share({ title, url });
        return 'shared';
      } catch {
        return 'failed';
      }
    },
  },

  keyValue: {
    get: (key) => values.get(key) ?? null,
    set(key, value) {
      values.set(key, value);
      quiet(Preferences.set({ key, value }));
      return true;
    },
    remove(key) {
      values.delete(key);
      quiet(Preferences.remove({ key }));
    },
  },

  fileStore: {
    async read(name) {
      try {
        const { uri } = await Filesystem.getUri({ path: `${TRAILS}/${safe(name)}`, directory: Directory.Data });
        // through the app's own file address: the bytes never cross the bridge as text
        const res = await fetch(Capacitor.convertFileSrc(uri));
        return res.ok ? await res.arrayBuffer() : null;
      } catch {
        return null;
      }
    },
    async write(name, data) {
      try {
        let binary = '';
        const bytes = new Uint8Array(data);
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        await Filesystem.writeFile({ path: `${TRAILS}/${safe(name)}`, data: btoa(binary), directory: Directory.Data });
        return true;
      } catch {
        return false;
      }
    },
    async remove(name) {
      try { await Filesystem.deleteFile({ path: `${TRAILS}/${safe(name)}`, directory: Directory.Data }); } catch { /* not there */ }
    },
    async list() {
      try {
        const { files } = await Filesystem.readdir({ path: TRAILS, directory: Directory.Data });
        return files.filter((f) => f.type === 'file' && !f.name.endsWith('.part')).map((f) => f.name);
      } catch {
        return [];
      }
    },
    async download(url, name) {
      // to a temporary name first, so a download cut short never looks like a finished file
      const part = `${TRAILS}/${safe(name)}.part`;
      try {
        await Filesystem.downloadFile({ url, path: part, directory: Directory.Data });
        const stat = await Filesystem.stat({ path: part, directory: Directory.Data });
        if (!(stat.size > 9)) throw new Error('empty download');
        await Filesystem.rename({ from: part, to: `${TRAILS}/${safe(name)}`, directory: Directory.Data, toDirectory: Directory.Data });
      } catch (e) {
        quiet(Filesystem.deleteFile({ path: part, directory: Directory.Data }));
        throw e;
      }
    },
  },

  documents: {
    async read(name) {
      try {
        const { data } = await Filesystem.readFile({ path: `${DOCS}/${safe(name)}`, directory: Directory.Data, encoding: Encoding.UTF8 });
        return typeof data === 'string' ? data : null;
      } catch {
        return null;
      }
    },
    async write(name, text) {
      try {
        await Filesystem.writeFile({ path: `${DOCS}/${safe(name)}`, data: text, directory: Directory.Data, encoding: Encoding.UTF8 });
        return true;
      } catch {
        return false;
      }
    },
    async remove(name) {
      try { await Filesystem.deleteFile({ path: `${DOCS}/${safe(name)}`, directory: Directory.Data }); } catch { /* not there */ }
    },
    async append(log, line) {
      try {
        await Filesystem.appendFile({ path: `${DOCS}/${safe(log)}.log`, data: `${line}\n`, directory: Directory.Data, encoding: Encoding.UTF8 });
        return true;
      } catch {
        return false;
      }
    },
    async readLog(log) {
      try {
        const { data } = await Filesystem.readFile({ path: `${DOCS}/${safe(log)}.log`, directory: Directory.Data, encoding: Encoding.UTF8 });
        return typeof data === 'string' ? data.split('\n').filter(Boolean) : [];
      } catch {
        return [];
      }
    },
    async removeLog(log) {
      try { await Filesystem.deleteFile({ path: `${DOCS}/${safe(log)}.log`, directory: Directory.Data }); } catch { /* not there */ }
    },
  },

  notifications: {
    async request() {
      try {
        const now = await LocalNotifications.checkPermissions();
        if (now.display === 'granted') return true;
        return (await LocalNotifications.requestPermissions()).display === 'granted';
      } catch {
        return false;
      }
    },
    async show(title, body) {
      try {
        await LocalNotifications.schedule({ notifications: [{ id: notificationId++, title, body }] });
      } catch { /* not allowed: the app still shows it on screen */ }
    },
  },

  app: {
    onBack(handler) {
      quiet(App.addListener('backButton', () => {
        if (!handler()) quiet(App.minimizeApp());
      }));
    },
    setTheme(dark) {
      // Style.Dark means light text, for a dark background
      quiet(StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light }));
    },
    onResume(handler) {
      quiet(App.addListener('resume', handler));
    },
  },

  links: {
    open(url) {
      quiet(Browser.open({ url }));
    },
    directionsUrl(lat, lon) {
      const at = `${lat.toFixed(6)},${lon.toFixed(6)}`;
      return android ? `https://www.google.com/maps/dir/?api=1&destination=${at}` : `https://maps.apple.com/?daddr=${at}&dirflg=d`;
    },
    directions(lat, lon) {
      const url = this.directionsUrl(lat, lon);
      // the maps app when there is one, else the page in a browser
      AppLauncher.openUrl({ url }).then((r) => { if (!r.completed) quiet(Browser.open({ url })); }, () => quiet(Browser.open({ url })));
    },
    openSettings() {
      quiet(BackgroundGeolocation.openSettings());
    },
  },

  haptics: {
    tap() {
      quiet(Haptics.impact({ style: ImpactStyle.Light }));
    },
    success() {
      quiet(Haptics.notification({ type: NotificationType.Success }));
    },
  },

  trailFiles: {
    url: (file) => RELEASE + file,
    async getJson(file) {
      const res = await CapacitorHttp.get({
        url: RELEASE + file, responseType: 'json', headers: { Accept: 'application/json' }, connectTimeout: 8000, readTimeout: 15_000,
      });
      if (res.status === 404) return null;
      if (res.status < 200 || res.status >= 300) throw new Error(`${file}: ${res.status}`);
      return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    },
  },
};
