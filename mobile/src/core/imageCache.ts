// Pictures kept on the phone: each address is downloaded once into the cache folder and shown from there, so
// photos already seen show with no signal. A few at a time; a failure resolves to null (nothing is shown).
import { Directory, File, Paths } from 'expo-file-system';

const HEADERS = { 'User-Agent': 'Switchback/1.0 (hiking app; https://github.com/cadewardc/switchback)' };
const MAX_AT_ONCE = 3;
/** The folder is trimmed to about this many files when it grows past it. */
const MAX_FILES = 900;

let dir: Directory | null = null;
function folder(): Directory {
  if (!dir) {
    dir = new Directory(Paths.cache, 'photos');
    if (!dir.exists) dir.create({ intermediates: true });
  }
  return dir;
}

/** A short, stable file name for an address. */
export function nameFor(url: string): string {
  let a = 5381, b = 52711;
  for (let i = 0; i < url.length; i++) {
    const c = url.charCodeAt(i);
    a = ((a * 33) ^ c) >>> 0;
    b = ((b * 31) + c) >>> 0;
  }
  return `${a.toString(36)}${b.toString(36)}.jpg`;
}

const ready = new Map<string, string>();
const jobs = new Map<string, Promise<string | null>>();
let active = 0;
const waiting: (() => void)[] = [];

/** The file for an address if it is already here (no download). */
export function cachedNow(url: string): string | null {
  const have = ready.get(url);
  if (have) return have;
  try {
    const f = new File(folder(), nameFor(url));
    if (f.exists && f.size > 0) { ready.set(url, f.uri); return f.uri; }
  } catch { /* not here */ }
  return null;
}

/** The local file for a picture, downloading it if needed. Null when it can't be had. */
export function cachedImage(url: string): Promise<string | null> {
  const have = cachedNow(url);
  if (have) return Promise.resolve(have);
  let job = jobs.get(url);
  if (!job) {
    job = (async () => {
      if (active >= MAX_AT_ONCE) await new Promise<void>((r) => waiting.push(r));
      active++;
      try {
        const target = new File(folder(), nameFor(url));
        const part = new File(folder(), `${nameFor(url)}.part`);
        if (part.exists) part.delete();
        const got = await File.downloadFileAsync(url, part, { idempotent: true, headers: HEADERS });
        if (target.exists) target.delete();
        got.move(target);
        ready.set(url, target.uri);
        if (ready.size % 50 === 0) trim();
        return target.uri;
      } catch {
        return null;
      } finally {
        active--;
        waiting.shift()?.();
        jobs.delete(url);
      }
    })();
    jobs.set(url, job);
  }
  return job;
}

function trim(): void {
  try {
    const files = folder().list().filter((x): x is File => x instanceof File);
    if (files.length <= MAX_FILES) return;
    files.sort((x, y) => (x.modificationTime ?? 0) - (y.modificationTime ?? 0));
    for (const f of files.slice(0, files.length - Math.round(MAX_FILES * 0.7))) { try { f.delete(); } catch { /* in use */ } }
    ready.clear();
  } catch { /* next time */ }
}
