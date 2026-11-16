// The app's own files: settings, the person's documents (hikes, saved trails), and the trail files.
// Everything lives under the app's document directory, which the system keeps until the app is removed.
import { Directory, File, Paths } from 'expo-file-system';
import type { PlatformDocuments, PlatformFileStore, PlatformKeyValue } from '@web/platform/types';

function dir(name: string): Directory {
  const d = new Directory(Paths.document, name);
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

let docsDir: Directory | null = null;
let trailsDir: Directory | null = null;
export const docs = () => (docsDir ??= dir('docs'));
export const trails = () => (trailsDir ??= dir('trails'));

/** Writes a whole file safely: to a ".part" beside it, then moved over the old one. */
function writeWhole(target: File, content: string | Uint8Array): void {
  const part = new File(target.parentDirectory, `${target.name}.part`);
  if (part.exists) part.delete();
  part.create();
  part.write(content);
  if (target.exists) target.delete();
  part.move(target);
}

// ── Settings: read once, kept in memory, written a moment after each change ─────────────────────────────
let values: Record<string, string> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function settings(): Record<string, string> {
  if (values) return values;
  values = {};
  try {
    const f = new File(docs(), 'settings.json');
    if (f.exists) {
      const parsed = JSON.parse(f.textSync());
      if (parsed && typeof parsed === 'object') values = parsed as Record<string, string>;
    }
  } catch { /* a broken file: start again */ }
  return values!;
}

function saveSettings(): void {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeWhole(new File(docs(), 'settings.json'), JSON.stringify(settings())); } catch { /* tried again next change */ }
  }, 150);
}

export const keyValue: PlatformKeyValue = {
  get: (key) => settings()[key] ?? null,
  set(key, value) {
    settings()[key] = value;
    saveSettings();
    return true;
  },
  remove(key) {
    if (key in settings()) {
      delete settings()[key];
      saveSettings();
    }
  },
};

// ── Documents ───────────────────────────────────────────────────────────────────────────────────────────
/** Names stay as given (web/src/data.ts compares them), except that they cannot reach another folder. */
const safe = (name: string) => name.replace(/[/\\]/g, '_');

export const documents: PlatformDocuments = {
  async read(name) {
    try {
      const f = new File(docs(), safe(name));
      return f.exists ? await f.text() : null;
    } catch {
      return null;
    }
  },
  async write(name, text) {
    try {
      writeWhole(new File(docs(), safe(name)), text);
      return true;
    } catch {
      return false;
    }
  },
  async remove(name) {
    try {
      const f = new File(docs(), safe(name));
      if (f.exists) f.delete();
    } catch { /* gone already */ }
  },
  async append(log, line) {
    try {
      const f = new File(docs(), `${safe(log)}.log`);
      if (!f.exists) f.create();
      f.write(`${line}\n`, { append: true });
      return true;
    } catch {
      return false;
    }
  },
  async readLog(log) {
    try {
      const f = new File(docs(), `${safe(log)}.log`);
      return f.exists ? (await f.text()).split('\n').filter((l) => l.length > 0) : [];
    } catch {
      return [];
    }
  },
  async removeLog(log) {
    try {
      const f = new File(docs(), `${safe(log)}.log`);
      if (f.exists) f.delete();
    } catch { /* gone already */ }
  },
};

/** Synchronous log reading, for the background task that may run before anything else has loaded. */
export function readLogSync(log: string): string[] {
  try {
    const f = new File(docs(), `${safe(log)}.log`);
    return f.exists ? f.textSync().split('\n').filter((l) => l.length > 0) : [];
  } catch {
    return [];
  }
}

// ── Trail files ─────────────────────────────────────────────────────────────────────────────────────────
const asBuffer = (u: Uint8Array): ArrayBuffer =>
  (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength ? u.buffer : u.slice().buffer) as ArrayBuffer;

export const fileStore: PlatformFileStore = {
  async read(name) {
    try {
      const f = new File(trails(), safe(name));
      return f.exists ? asBuffer(await f.bytes()) : null;
    } catch {
      return null;
    }
  },
  async write(name, data) {
    try {
      writeWhole(new File(trails(), safe(name)), new Uint8Array(data));
      return true;
    } catch {
      return false;
    }
  },
  async remove(name) {
    try {
      const f = new File(trails(), safe(name));
      if (f.exists) f.delete();
    } catch { /* gone already */ }
  },
  async list() {
    try {
      return trails().list().filter((x): x is File => x instanceof File && !x.name.endsWith('.part')).map((f) => f.name);
    } catch {
      return [];
    }
  },
  async download(url, name) {
    const target = new File(trails(), safe(name));
    const part = new File(trails(), `${safe(name)}.part`);
    if (part.exists) part.delete();
    const got = await File.downloadFileAsync(url, part, { idempotent: true });
    if (target.exists) target.delete();
    got.move(target);
  },
};

/** Bytes kept in a folder (for Settings). */
export function folderBytes(d: Directory): number {
  try {
    return d.list().reduce((n, x) => n + (x instanceof File ? x.size ?? 0 : 0), 0);
  } catch {
    return 0;
  }
}

/** A text file in the cache, for handing to the share sheet. */
export function cacheFile(name: string, text: string): File {
  const f = new File(Paths.cache, name);
  if (f.exists) f.delete();
  f.create();
  f.write(text);
  return f;
}
