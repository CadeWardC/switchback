// The browser's version of the device interface.
import type { Fix, FixHandler, Platform, ProblemHandler } from './types';

const PREFIX = 'switchback:';
const CACHE = 'switchback-trail-files-v1';

function toFix(p: GeolocationPosition): Fix {
  const c = p.coords;
  return {
    lat: c.latitude, lon: c.longitude,
    ele: c.altitude != null && Number.isFinite(c.altitude) ? c.altitude : null,
    accuracy: c.accuracy, time: p.timestamp || Date.now(),
  };
}

function problem(e: GeolocationPositionError): 'denied' | 'unavailable' {
  return e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable';
}

function follow(onFix: FixHandler, onProblem: ProblemHandler): () => void {
  if (!('geolocation' in navigator)) {
    onProblem('unsupported');
    return () => {};
  }
  const id = navigator.geolocation.watchPosition((p) => onFix(toFix(p)), (e) => onProblem(problem(e)),
    { enableHighAccuracy: true, maximumAge: 2000, timeout: 30_000 });
  return () => navigator.geolocation.clearWatch(id);
}

let stopRecordingWatch: (() => void) | null = null;
let wakeLock: WakeLockSentinel | null = null;
let wantAwake = false;

async function requestWake(): Promise<boolean> {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    return true;
  } catch {
    return false;
  }
}

if (typeof document !== 'undefined') {
  // the browser drops the lock whenever the tab is hidden: take it again on coming back
  document.addEventListener('visibilitychange', () => {
    if (wantAwake && document.visibilityState === 'visible') void requestWake();
  });
}

const cacheUrl = (name: string) => new URL(`trail-files/${encodeURIComponent(name)}`, document.baseURI).href;

export const browserPlatform: Platform = {
  name: 'web',

  location: {
    recordsInBackground: false,
    current: () => new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject('unsupported');
      navigator.geolocation.getCurrentPosition((p) => resolve(toFix(p)), (e) => reject(problem(e)),
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
    }),
    watch: follow,
    async startRecording(onFix, onProblem) {
      stopRecordingWatch?.();
      stopRecordingWatch = follow(onFix, onProblem);
    },
    async stopRecording() {
      stopRecordingWatch?.();
      stopRecordingWatch = null;
    },
  },

  keepAwake: {
    async on() {
      wantAwake = true;
      return requestWake();
    },
    async off() {
      wantAwake = false;
      try { await wakeLock?.release(); } catch { /* already gone */ }
      wakeLock = null;
    },
  },

  files: {
    exportVerb: 'saved to your downloads',
    async exportText(name, text, type) {
      const url = URL.createObjectURL(new Blob([text], { type }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
  },

  keyValue: {
    get(key) {
      try { return localStorage.getItem(PREFIX + key); } catch { return null; }
    },
    set(key, value) {
      try { localStorage.setItem(PREFIX + key, value); return true; } catch { return false; }
    },
    remove(key) {
      try { localStorage.removeItem(PREFIX + key); } catch { /* nothing to remove */ }
    },
  },

  fileStore: {
    async read(name) {
      try {
        const hit = await (await caches.open(CACHE)).match(cacheUrl(name));
        return hit ? await hit.arrayBuffer() : null;
      } catch {
        return null; // no Cache Storage here (private mode, plain http)
      }
    },
    async write(name, data) {
      try {
        await (await caches.open(CACHE)).put(cacheUrl(name), new Response(data, { headers: { 'Content-Type': 'application/octet-stream' } }));
        return true;
      } catch {
        return false;
      }
    },
    async remove(name) {
      try { await (await caches.open(CACHE)).delete(cacheUrl(name)); } catch { /* not there */ }
    },
    async list() {
      try {
        const keys = await (await caches.open(CACHE)).keys();
        return keys.map((k) => decodeURIComponent(k.url.slice(k.url.lastIndexOf('/') + 1)));
      } catch {
        return [];
      }
    },
  },

  links: {
    open(url) {
      window.open(url, '_blank', 'noopener');
    },
    directionsUrl(lat, lon) {
      const at = `${lat.toFixed(6)},${lon.toFixed(6)}`;
      // Apple's maps app on Apple devices, Google Maps elsewhere
      return /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)
        ? `https://maps.apple.com/?daddr=${at}&dirflg=d`
        : `https://www.google.com/maps/dir/?api=1&destination=${at}`;
    },
    directions(lat, lon) {
      window.open(this.directionsUrl(lat, lon), '_blank', 'noopener');
    },
  },

  haptics: {
    tap() {},
    success() {},
  },

  trailFiles: {
    url: (file) => new URL(`data/${file}`, document.baseURI).href,
  },
};
