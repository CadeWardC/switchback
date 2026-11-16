// Your own photos, only ever on hikes you recorded yourself: taken while recording, or added to a kept hike from
// the phone's library. Photos on a hike of a known trail are public: once uploaded they show on that trail's page
// for everyone (core/community.ts). Photos on a hike of no known trail are seen only by you.
//
// A photo is kept on the phone first (a copy at most 1000 px on its short side, re-encoded as JPEG, which also
// drops its metadata: no location or camera details leave the phone inside the file), listed in my-photos.json,
// and uploaded to your account when you are logged in and online: PUT /v1/photos/{id} (where and when, which hike
// they belong to, and its trail), then the display and thumbnail files.
// After a reinstall, photos already on your account still show: they come from the server (/v1/me/photos).
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { uploadAsync, FileSystemUploadType } from 'expo-file-system/legacy';
import { Directory, File, Paths } from 'expo-file-system';
import { signal } from '@preact/signals-core';
import { loadDoc, saveDoc, type Walk } from '@web/lib/storage';
import { myLocation } from './state';
import { account, api, isSignedIn, ServerError } from './server';
import { uuid } from './syncFormat';
import { trailRefOfWalk, type TrailRef } from './syncFormat';

export interface MyPhoto {
  id: string;
  /** The phone's copy (file:// in the app's documents). */
  file: string;
  width: number;
  height: number;
  /** When it was taken (ms), and where, when known. */
  t: number;
  lat?: number;
  lon?: number;
  /** Taken while recording, before the hike had an id: given the hike's id when it is kept. */
  recording?: boolean;
  walk?: string;
  /** The trail the hike followed: the photo is shown publicly on its page. */
  trail?: TrailRef;
  uploaded?: boolean;
}

/** A photo on your account (from the server), for ones this phone doesn't have (after a reinstall or on another phone). */
export interface RemotePhoto {
  id: string; display_name?: string; walk_id: string | null; trail_id: string | null; url: string | null; thumb_url: string | null;
  width?: number | null; height?: number | null; lat: number | null; lon: number | null; taken_at: string | null; created_at?: string;
}

const DOC = 'my-photos.json';
export const myPhotos = signal<MyPhoto[]>([]);
export const photoError = signal<string | null>(null);

let loaded = false;
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  const list = await loadDoc<MyPhoto[]>(DOC, []);
  myPhotos.value = Array.isArray(list) ? list.filter((p) => p && p.id && p.file && new File(p.file).exists) : [];
}
export const loadMyPhotos = ensureLoaded;

async function persist(): Promise<void> {
  await saveDoc(DOC, myPhotos.peek());
}

function photosDir(): Directory {
  const d = new Directory(Paths.document, 'photos');
  if (!d.exists) d.create({ intermediates: true });
  return d;
}

/** "2024:06:01 14:22:05" (EXIF, the phone's local time) → ms. */
function exifTime(exif: Record<string, unknown> | null | undefined): number | null {
  const nested = exif?.['{Exif}'] as Record<string, unknown> | undefined;
  const raw = exif?.DateTimeOriginal ?? nested?.DateTimeOriginal ?? exif?.DateTime;
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
}

function exifPlace(exif: Record<string, unknown> | null | undefined): { lat: number; lon: number } | null {
  if (!exif) return null;
  const gps = (exif['{GPS}'] as Record<string, unknown> | undefined) ?? exif;
  let lat = Number(gps.GPSLatitude ?? gps.Latitude), lon = Number(gps.GPSLongitude ?? gps.Longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (String(gps.GPSLatitudeRef ?? gps.LatitudeRef ?? '').toUpperCase() === 'S') lat = -Math.abs(lat);
  if (String(gps.GPSLongitudeRef ?? gps.LongitudeRef ?? '').toUpperCase() === 'W') lon = -Math.abs(lon);
  return lat === 0 && lon === 0 ? null : { lat, lon };
}

/** Where on a recorded hike you were at a moment (the nearest recorded point in time), if it was during it. */
export function placeOnHike(w: Pick<Walk, 'segments' | 'started' | 'ended'>, t: number): { lat: number; lon: number } | null {
  if (t < w.started - 15 * 60_000 || t > w.ended + 15 * 60_000) return null;
  let best: { lat: number; lon: number } | null = null, gap = Infinity;
  for (const s of w.segments) for (const p of s) {
    const d = Math.abs(p.t - t);
    if (d < gap) { gap = d; best = { lat: p.lat, lon: p.lon }; }
  }
  return best;
}

/** Makes the phone's copy: short side at most 1000 px, JPEG (which leaves the original's metadata behind). */
async function keepCopy(uri: string, width: number, height: number): Promise<{ file: string; width: number; height: number }> {
  const short = Math.min(width || 1000, height || 1000);
  const resize = short > 1000 ? (width <= height ? { width: 1000 } : { height: 1000 }) : null;
  const out = await manipulateAsync(uri, resize ? [{ resize }] : [], { compress: 0.82, format: SaveFormat.JPEG });
  const id = uuid();
  const dest = new File(photosDir(), `${id}.jpg`);
  await new File(out.uri).move(dest);
  return { file: dest.uri, width: out.width, height: out.height };
}

async function add(list: Omit<MyPhoto, 'id'>[]): Promise<void> {
  await ensureLoaded();
  myPhotos.value = [...myPhotos.peek(), ...list.map((p) => ({ ...p, id: uuid() }))];
  await persist();
  void uploadPhotos();
}

/** The camera, while recording: the photo is placed where you are, and joins the hike when it is kept. */
export async function takePhoto(): Promise<boolean> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new Error('Allow Switchback to use the camera in the phone\'s settings to take photos.');
  const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.9, exif: false });
  if (r.canceled || !r.assets?.length) return false;
  const a = r.assets[0];
  const copy = await keepCopy(a.uri, a.width, a.height);
  const me = myLocation.peek();
  await add([{ ...copy, t: Date.now(), ...(me ? { lat: me.at[0], lon: me.at[1] } : {}), recording: true }]);
  return true;
}

/** Photos from the phone's library, for one of your kept hikes. Returns how many were added. */
export async function pickPhotos(to: { walk: Walk }): Promise<number> {
  const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!perm.granted && perm.accessPrivileges !== 'limited') throw new Error('Allow Switchback to see your photos in the phone\'s settings to add them.');
  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: 20, quality: 1, exif: true });
  if (r.canceled || !r.assets?.length) return 0;
  const out: Omit<MyPhoto, 'id'>[] = [];
  const trail = trailRefOfWalk(to.walk) ?? undefined;
  for (const a of r.assets) {
    const t = exifTime(a.exif) ?? to.walk.started;
    const place = exifPlace(a.exif) ?? placeOnHike(to.walk, t);
    const copy = await keepCopy(a.uri, a.width, a.height);
    out.push({ ...copy, t, ...(place ?? {}), walk: to.walk.id, ...(trail ? { trail } : {}) });
  }
  await add(out);
  return out.length;
}

/** When a hike is kept: the photos taken while recording it become its photos. */
export async function claimRecordingPhotos(w: Walk): Promise<void> {
  await ensureLoaded();
  let changed = false;
  const trail = trailRefOfWalk(w) ?? undefined;
  myPhotos.value = myPhotos.peek().map((p) => {
    if (!p.recording || p.walk) return p;
    changed = true;
    return { ...p, recording: false, walk: w.id, ...(trail ? { trail } : {}), ...(p.lat == null ? placeOnHike(w, p.t) ?? {} : {}) };
  });
  if (changed) { await persist(); void uploadPhotos(); }
}

/** A recording thrown away: its photos stay on the phone, but belong to no hike (they are not uploaded). */
export async function releaseRecordingPhotos(): Promise<void> {
  await ensureLoaded();
  myPhotos.value = myPhotos.peek().map((p) => (p.recording ? { ...p, recording: false } : p));
  await persist();
}

export async function deletePhoto(id: string): Promise<void> {
  await ensureLoaded();
  const p = myPhotos.peek().find((x) => x.id === id);
  myPhotos.value = myPhotos.peek().filter((x) => x.id !== id);
  await persist();
  if (p) { try { new File(p.file).delete(); } catch { /* already gone */ } }
  if (isSignedIn()) await api.call('DELETE', `/v1/photos/${id}`).catch(() => {});
}

export async function deleteRemotePhoto(id: string): Promise<void> {
  await api.call('DELETE', `/v1/photos/${id}`);
}

// ── Uploading ─────────────────────────────────────────────────────────────────────────────────────────
let uploading: Promise<void> | null = null;

/** Sends photos not yet on your account (when logged in). Safe to call any time; one run at a time. */
export function uploadPhotos(): Promise<void> {
  if (!account.peek() || !isSignedIn()) return Promise.resolve();
  uploading ??= run().finally(() => { uploading = null; });
  return uploading;
}

async function run(): Promise<void> {
  await ensureLoaded();
  for (const p of myPhotos.peek()) {
    if (p.uploaded || p.recording || !p.walk) continue;
    try {
      await api.call('PUT', `/v1/photos/${p.id}`, {
        walk_id: p.walk,
        ...(p.trail ? { trail: p.trail } : {}),
        ...(p.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon } : {}),
        taken_at: new Date(p.t).toISOString(),
      });
      await sendFile(p.id, 'display', p.file);
      const thumb = await manipulateAsync(p.file, [{ resize: p.width <= p.height ? { width: 400 } : { height: 400 } }], { compress: 0.75, format: SaveFormat.JPEG });
      try { await sendFile(p.id, 'thumb', thumb.uri); } finally { try { new File(thumb.uri).delete(); } catch { /* cache */ } }
      myPhotos.value = myPhotos.peek().map((x) => (x.id === p.id ? { ...x, uploaded: true } : x));
      await persist();
      photoError.value = null;
    } catch (e) {
      const err = e as ServerError;
      photoError.value = err.offline ? null : `A photo couldn't be uploaded: ${err.message}`;
      if (err.offline || err.status === 401) return; // try again later
    }
  }
}

async function sendFile(id: string, size: 'display' | 'thumb', file: string): Promise<void> {
  const send = async () => {
    const { base, token } = await api.token();
    return uploadAsync(`${base}/v1/photos/${id}/file?size=${size}`, file, {
      httpMethod: 'PUT', uploadType: FileSystemUploadType.BINARY_CONTENT,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' },
    });
  };
  let r;
  try { r = await send(); } catch { throw new ServerError('No connection.', null, true); }
  if (r.status === 401) { api.forgetAccessToken(); r = await send(); }
  if (r.status < 200 || r.status >= 300) {
    let msg = `something went wrong (${r.status})`;
    try { msg = (JSON.parse(r.body) as { error?: { message?: string } }).error?.message ?? msg; } catch { /* not json */ }
    throw new ServerError(msg, r.status);
  }
}

// ── Photos on your account (after a reinstall, or from another phone) ─────────────────────────────────
export async function accountPhotos(walkId?: string): Promise<RemotePhoto[]> {
  if (!isSignedIn()) return [];
  const r = (await api.call('GET', `/v1/me/photos${walkId ? `?walk=${encodeURIComponent(walkId)}` : ''}`)) as { photos: RemotePhoto[] };
  return r.photos ?? [];
}

