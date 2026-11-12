// The browser's version of the device interface.
import type { Fix, FixHandler, Platform, PlatformDocuments, PlatformTiles, ProblemHandler } from './types';

const PREFIX = 'switchback:';
const CACHE = 'switchback-trail-files-v1';

function toFix(p: GeolocationPosition): Fix {
  const c = p.coords;
  return {
    lat: c.latitude, lon: c.longitude,
    ele: c.altitude != null && Number.isFinite(c.altitude) ? c.altitude : null,
    accuracy: c.accuracy, time: p.timestamp || Date.now(),
    heading: c.heading != null && Number.isFinite(c.heading) && (c.speed ?? 0) > 0.3 ? c.heading : null,
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

// ── The person's own documents, in IndexedDB ──────────────────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('switchback', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('docs');
      open.result.createObjectStore('logs', { autoIncrement: true }).createIndex('log', 'log');
    };
    open.onblocked = () => reject(new Error('blocked'));
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  dbPromise.catch(() => (dbPromise = null));
  return dbPromise;
}

function tx<T>(store: 'docs' | 'logs', mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = run(t.objectStore(store));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = t.onabort = () => reject(t.error);
  }));
}

export const browserDocuments: PlatformDocuments = {
  async read(name) {
    try { return (await tx<string>('docs', 'readonly', (s) => s.get(name))) ?? null; } catch { return null; }
  },
  async write(name, text) {
    try { await tx('docs', 'readwrite', (s) => { s.put(text, name); }); return true; } catch { return false; }
  },
  async remove(name) {
    try { await tx('docs', 'readwrite', (s) => { s.delete(name); }); } catch { /* not there */ }
  },
  async append(log, line) {
    try { await tx('logs', 'readwrite', (s) => { s.add({ log, line }); }); return true; } catch { return false; }
  },
  async readLog(log) {
    try {
      const rows = await tx<{ log: string; line: string }[]>('logs', 'readonly', (s) => s.index('log').getAll(log));
      return (rows ?? []).map((r) => r.line);
    } catch { return []; }
  },
  async removeLog(log) {
    try {
      await tx('logs', 'readwrite', (s) => {
        const cursor = s.index('log').openKeyCursor(IDBKeyRange.only(log));
        cursor.onsuccess = () => { const c = cursor.result; if (c) { s.delete(c.primaryKey); c.continue(); } };
      });
    } catch { /* nothing to remove */ }
  },
};

// ── Map tiles, in IndexedDB (a database of its own, so clearing maps never touches the person's things) ─
interface TileRow { k: string; d: ArrayBuffer; n: number; t: number }
const DAY = 86_400_000;
let tileDb: Promise<IDBDatabase> | null = null;
let tileBytes: number | null = null;
let tileCap = 400 * 1024 * 1024;
let evicting = false;

function tdb(): Promise<IDBDatabase> {
  tileDb ??= new Promise((resolve, reject) => {
    const open = indexedDB.open('switchback-tiles', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('tiles', { keyPath: 'k' }).createIndex('t', 't');
      open.result.createObjectStore('meta');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
  tileDb.catch(() => (tileDb = null));
  return tileDb;
}

const req = <T>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

async function tileTotal(): Promise<number> {
  if (tileBytes == null) {
    const d = await tdb();
    tileBytes = Number(await req(d.transaction('meta').objectStore('meta').get('bytes'))) || 0;
    // as much as the browser is likely to allow, up to 1.5 GB (the phone apps' cap)
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) tileCap = Math.max(100 * 1024 * 1024, Math.min(1.5 * 1024 ** 3, est.quota * 0.4));
    } catch { /* keep the default */ }
  }
  return tileBytes;
}

/** Past the cap, the tiles unused for longest go, down to nine tenths of it. */
async function evict(): Promise<void> {
  if (evicting) return;
  evicting = true;
  try {
    const d = await tdb();
    await new Promise<void>((resolve) => {
      const t = d.transaction(['tiles', 'meta'], 'readwrite');
      const cursor = t.objectStore('tiles').index('t').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c || (tileBytes ?? 0) <= tileCap * 0.9) { t.objectStore('meta').put(tileBytes ?? 0, 'bytes'); return; }
        tileBytes = Math.max(0, (tileBytes ?? 0) - ((c.value as TileRow).n || 0));
        c.delete();
        c.continue();
      };
      t.oncomplete = t.onerror = t.onabort = () => resolve();
    });
  } finally {
    evicting = false;
  }
}

export const browserTiles: PlatformTiles = {
  async get(key) {
    try {
      const d = await tdb();
      const row = (await req(d.transaction('tiles').objectStore('tiles').get(key))) as TileRow | undefined;
      if (!row) return null;
      // note that it was used, at most once a day (a write on every read would be wasteful)
      if (Date.now() - row.t > DAY) d.transaction('tiles', 'readwrite').objectStore('tiles').put({ ...row, t: Date.now() });
      return row.d;
    } catch {
      return null;
    }
  },
  async put(key, data) {
    try {
      const d = await tdb();
      await tileTotal();
      const t = d.transaction(['tiles', 'meta'], 'readwrite');
      const store = t.objectStore('tiles');
      const old = (await req(store.get(key))) as TileRow | undefined;
      store.put({ k: key, d: data, n: data.byteLength, t: Date.now() } satisfies TileRow);
      tileBytes = Math.max(0, (tileBytes ?? 0) - (old?.n ?? 0) + data.byteLength);
      t.objectStore('meta').put(tileBytes, 'bytes');
      if (tileBytes > tileCap) void evict();
    } catch { /* storage full or blocked: the map still works from the network */ }
  },
  async has(key) {
    try {
      const d = await tdb();
      return (await req(d.transaction('tiles').objectStore('tiles').count(key))) > 0;
    } catch {
      return false;
    }
  },
  async size() {
    try { return await tileTotal(); } catch { return 0; }
  },
  async clear() {
    try {
      const d = await tdb();
      const t = d.transaction(['tiles', 'meta'], 'readwrite');
      t.objectStore('tiles').clear();
      t.objectStore('meta').put(0, 'bytes');
      tileBytes = 0;
      await new Promise<void>((resolve) => { t.oncomplete = t.onerror = () => resolve(); });
    } catch { /* nothing to clear */ }
  },
};

const cacheUrl = (name: string) => new URL(`trail-files/${encodeURIComponent(name)}`, document.baseURI).href;

export const browserPlatform: Platform = {
  name: 'web',
  async init() {},
  documents: browserDocuments,
  notifications: {
    async request() { return false; },
    async show() {},
  },
  app: {
    onBack() {},
    setTheme() {},
    onResume(handler) {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') handler(); });
    },
  },

  location: {
    recordsInBackground: false,
    current: () => new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject('unsupported');
      navigator.geolocation.getCurrentPosition((p) => resolve(toFix(p)), (e) => reject(problem(e)),
        { enableHighAccuracy: true, maximumAge: 10_000, timeout: 20_000 });
    }),
    watch: follow,
    async startRecording(onFix, onProblem, _notice) {
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
    async shareLink(_title, url) {
      try {
        await navigator.clipboard.writeText(url);
        return 'copied';
      } catch {
        return 'failed';
      }
    },
    async shareText(text) {
      try {
        await navigator.clipboard.writeText(text);
        return 'copied';
      } catch {
        return 'failed';
      }
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
    openSettings() {},
  },

  haptics: {
    tap() {},
    success() {},
  },

  tiles: browserTiles,

  network: {
    async kind() {
      if (navigator.onLine === false) return 'none';
      const c = (navigator as any).connection;
      if (c?.type === 'cellular' || c?.saveData) return 'cellular';
      if (c?.type === 'wifi' || c?.type === 'ethernet') return 'wifi';
      return 'unknown';
    },
  },

  trailFiles: {
    url: (file) => new URL(`data/${file}`, document.baseURI).href,
    async getJson(file) {
      const res = await fetch(new URL(`data/${file}`, document.baseURI).href, { cache: 'no-cache', signal: AbortSignal.timeout(8000) });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`${file}: ${res.status}`);
      // a static host may answer a missing file with its own page
      const text = await res.text();
      try { return JSON.parse(text); } catch { return null; }
    },
  },
};
