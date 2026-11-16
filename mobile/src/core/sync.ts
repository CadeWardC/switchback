// Keeps saved trails and recorded hikes in step with the Switchback server, when signed in.
//
// Everything works on the phone first. This module watches the two lists (savedTrails, walks): whatever is
// added or changed is queued for upload, whatever is removed is queued for deletion. The queue is sent when
// the server can be reached (at launch, on return to the app, when the connection comes back, a couple of
// seconds after a change, and from Settings › Sync now). Then each collection is pulled with ?since= and
// other devices' changes are applied, without being queued again. A change on the phone that hasn't been
// sent yet wins over the server's copy; otherwise the last write wins.
//
// First sync (or after signing in somewhere else): the server's copy is taken first (so a second phone
// can't overwrite the first), then what only this phone has is uploaded.
//
// Collections:  saved_trails  { v: 2, trail: SavedTrail }
//               activities    { v: 2, walk: <a recorded hike, compact: lines as 1e-6° polylines> }
import { effect, signal } from '@preact/signals-core';
import { load, loadDoc, save, saveDoc, summaryOf, walkDoc, type SavedTrail, type Walk, type WalkSummary } from '@web/lib/storage';
import { platform } from '../platform';
import { online, savedTrails, say, walks } from './state';
import { api, fingerprint, isSignedIn, ServerError, serverUrl } from './server';
import { compactWalk, expandWalk, trailDocId, trailKey, walkDocId, type CompactWalk } from './syncFormat';

export { compactWalk, decodeTrack, encodeTrack, expandWalk, trailDocId, trailKey, walkDocId } from './syncFormat';

export type Collection = 'saved_trails' | 'activities';
const COLLECTIONS: Collection[] = ['saved_trails', 'activities'];

export const syncing = signal(false);
export const lastSync = signal<number | null>(null);
export const syncError = signal<string | null>(null);
export const syncOffline = signal(false);
export const pendingCount = signal(0);

interface Pending { c: Collection; doc: string; local: string; del: boolean; seq: number }
interface SyncState { fingerprint: string; since: Partial<Record<Collection, number>>; pending: Pending[]; seq: number; lastSync: number | null }
const STATE_KEY = 'sync-state';
let state: SyncState = load<SyncState>(STATE_KEY, { fingerprint: '', since: {}, pending: [], seq: 0, lastSync: null });
const persist = () => { save(STATE_KEY, state); pendingCount.value = state.pending.length; };

// ── Watching the lists ────────────────────────────────────────────────────────────────────────────────
let seenTrails = new Map<string, string>();
let seenWalks = new Map<string, string>();
let applying = false;

function enqueue(p: Omit<Pending, 'seq'>, quiet = false): void {
  state.seq += 1;
  state.pending = state.pending.filter((x) => !(x.c === p.c && x.doc === p.doc));
  state.pending.push({ ...p, seq: state.seq });
  persist();
  if (!quiet) syncSoon();
}

function watch(): void {
  seenTrails = new Map(savedTrails.peek().map((t) => [trailKey(t), JSON.stringify(t)]));
  seenWalks = new Map(walks.peek().map((w) => [w.id, JSON.stringify(w)]));
  effect(() => {
    const now = new Map(savedTrails.value.map((t) => [trailKey(t), JSON.stringify(t)]));
    if (!applying) {
      for (const [k, v] of now) if (seenTrails.get(k) !== v) enqueue({ c: 'saved_trails', doc: trailDocId(k), local: k, del: false });
      for (const k of seenTrails.keys()) if (!now.has(k)) enqueue({ c: 'saved_trails', doc: trailDocId(k), local: k, del: true });
    }
    seenTrails = now;
  });
  effect(() => {
    const now = new Map(walks.value.map((w) => [w.id, JSON.stringify(w)]));
    if (!applying) {
      for (const [k, v] of now) if (seenWalks.get(k) !== v) enqueue({ c: 'activities', doc: walkDocId(k), local: k, del: false });
      for (const k of seenWalks.keys()) if (!now.has(k)) enqueue({ c: 'activities', doc: walkDocId(k), local: k, del: true });
    }
    seenWalks = now;
  });
}

/** Changes from the server go into the lists without being queued again. */
function quietly(fn: () => void): void {
  applying = true;
  try { fn(); } finally { applying = false; }
}

// ── Applying the server's documents ───────────────────────────────────────────────────────────────────
interface TrailDoc { v: number; trail: SavedTrail }
interface WalkDocBody { v: number; walk: CompactWalk }

function applyTrail(id: string, deleted: boolean, data: TrailDoc | null): void {
  const list = savedTrails.peek();
  if (deleted || !data?.trail) {
    const next = list.filter((t) => trailDocId(trailKey(t)) !== id);
    if (next.length !== list.length) quietly(() => { savedTrails.value = next; });
    return;
  }
  const t = data.trail;
  const rest = list.filter((x) => trailKey(x) !== trailKey(t));
  quietly(() => { savedTrails.value = [...rest, t].sort((a, b) => (b.saved ?? 0) - (a.saved ?? 0)); });
}

async function applyWalk(id: string, deleted: boolean, data: WalkDocBody | null): Promise<void> {
  const list = walks.peek();
  if (deleted || !data?.walk) {
    const gone = list.filter((w) => walkDocId(w.id) === id);
    if (!gone.length) return;
    quietly(() => { walks.value = list.filter((w) => walkDocId(w.id) !== id); });
    for (const w of gone) await platform.documents.remove(walkDoc(w.id));
    return;
  }
  const w = expandWalk(data.walk);
  await saveDoc(walkDoc(w.id), w);
  const s: WalkSummary = summaryOf(w);
  quietly(() => { walks.value = [...walks.peek().filter((x) => x.id !== w.id), s].sort((a, b) => b.started - a.started); });
}

// ── Running ───────────────────────────────────────────────────────────────────────────────────────────
let timer: ReturnType<typeof setTimeout> | undefined;
let running: Promise<void> | null = null;
let again = false;

export function syncSoon(ms = 2000): void {
  clearTimeout(timer);
  timer = setTimeout(() => void syncNow(), ms);
}

/** One sync; if one is already running, one more after it. */
export async function syncNow(): Promise<void> {
  if (!isSignedIn()) { syncError.value = null; return; }
  if (running) { again = true; return running; }
  running = run().finally(() => { running = null; });
  await running;
  if (again) { again = false; await syncNow(); }
}

async function run(): Promise<void> {
  syncing.value = true;
  try {
    if (state.fingerprint !== fingerprint()) {
      state = { fingerprint: fingerprint(), since: {}, pending: [], seq: state.seq, lastSync: null };
      persist();
    }
    for (const c of COLLECTIONS) if (state.since[c] == null) await firstSync(c);
    await push();
    for (const c of COLLECTIONS) await pull(c);
    state.lastSync = Date.now();
    lastSync.value = state.lastSync;
    syncOffline.value = false;
    syncError.value = null;
    persist();
  } catch (e) {
    const err = e as ServerError;
    const message = err.message || 'Sync failed.';
    // tell the person once, not on every retry; being offline is not news
    if (!err.offline && syncError.peek() !== message) say(message);
    syncOffline.value = !!err.offline;
    syncError.value = message;
  } finally {
    syncing.value = false;
  }
}

async function firstSync(c: Collection): Promise<void> {
  if (c === 'saved_trails') {
    const list = await api.list<TrailDoc>(c);
    const there = new Set(list.items.filter((d) => !d.deleted).map((d) => d.id));
    for (const d of list.items) if (!d.deleted) applyTrail(d.id, false, d.data);
    for (const t of savedTrails.peek()) {
      const k = trailKey(t);
      if (!there.has(trailDocId(k))) enqueue({ c, doc: trailDocId(k), local: k, del: false }, true);
    }
    state.since[c] = list.server_time;
  } else {
    const list = await api.list<WalkDocBody>(c);
    const there = new Set(list.items.filter((d) => !d.deleted).map((d) => d.id));
    for (const d of list.items) if (!d.deleted) await applyWalk(d.id, false, d.data);
    for (const w of walks.peek()) if (!there.has(walkDocId(w.id))) enqueue({ c, doc: walkDocId(w.id), local: w.id, del: false }, true);
    state.since[c] = list.server_time;
  }
  persist();
}

async function push(): Promise<void> {
  const skipped: string[] = [];
  while (state.pending.length) {
    const p = state.pending[0];
    try {
      if (p.del) {
        await api.remove(p.c, p.doc);
      } else if (p.c === 'saved_trails') {
        const t = savedTrails.peek().find((x) => trailKey(x) === p.local);
        if (t) await api.put(p.c, p.doc, { v: 2, trail: t } satisfies TrailDoc);
      } else {
        const w = await loadDoc<Walk | null>(walkDoc(p.local), null);
        const summary = walks.peek().find((x) => x.id === p.local);
        // the list holds the latest name and submission; the hike's own file holds its points
        if (w && summary) await api.put(p.c, p.doc, { v: 2, walk: compactWalk({ ...w, ...summary }) } satisfies WalkDocBody);
      }
    } catch (e) {
      const err = e as ServerError;
      if (err.status === 413 || err.status === 400) skipped.push(err.message);
      else throw e;
    }
    // drop it only if nothing newer was queued for the same item while it was being sent
    state.pending = state.pending.filter((x) => x.seq !== p.seq);
    persist();
  }
  if (skipped.length) throw new ServerError(skipped[0] + (skipped.length > 1 ? ` (${skipped.length} items)` : ''), 400);
}

async function pull(c: Collection): Promise<void> {
  const list = c === 'saved_trails'
    ? await api.list<TrailDoc>(c, state.since[c])
    : await api.list<WalkDocBody>(c, state.since[c]);
  const waiting = new Set(state.pending.filter((p) => p.c === c).map((p) => p.doc));
  for (const d of list.items) {
    if (waiting.has(d.id)) continue;
    if (c === 'saved_trails') applyTrail(d.id, d.deleted, d.data as TrailDoc | null);
    else await applyWalk(d.id, d.deleted, d.data as WalkDocBody | null);
  }
  state.since[c] = list.server_time;
  persist();
}

/** After the lists are loaded from the phone: start watching them, and sync now and whenever it may help. */
export function startSync(): void {
  lastSync.value = state.lastSync;
  pendingCount.value = state.pending.length;
  watch();
  syncSoon(500);
  platform.app.onResume(() => syncSoon(0));
  let wasOnline = online.peek();
  effect(() => {
    const now = online.value;
    if (now && !wasOnline) syncSoon(0);
    wasOnline = now;
  });
  // signing in or out
  let first = true;
  effect(() => {
    void serverUrl.value;
    if (first) { first = false; return; }
    syncError.value = null;
    syncOffline.value = false;
    syncSoon(0);
  });
}
