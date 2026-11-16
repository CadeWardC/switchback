// What everyone shares about a trail: reviews (stars and words, with the reviewer's name) and photos taken on
// hikes of it. Anyone can read them, signed in or not; writing needs an account, and a review or photo only comes
// from someone who recorded a hike of that trail. Both are public as soon as they are sent; the owner can hide
// any of them on the review page.
import type { Trail } from '@web/lib/trail';
import { signal } from '@preact/signals-core';
import { api } from './server';
import { uuid } from './syncFormat';
import type { RemotePhoto } from './myPhotos';

export { trailRefOfWalk, type TrailRef } from './syncFormat';
import type { TrailRef } from './syncFormat';

/** Bumped when a review or photo is posted or removed, so a trail's page shows it at once. */
export const communityChanged = signal(0);

export const trailRefOf = (t: Trail): TrailRef => ({ id: t.key, name: t.name, start: [t.start[0], t.start[1]], bbox: t.bbox });

export interface Review {
  id: string; trail_id: string; user_id: string; display_name: string; rating: number; body: string;
  hiked_on: string | null; created_at: string; updated_at: string;
}
export interface TrailStats { reviews: number; rating: number | null; photos: number; hikers: number }

export async function trailReviews(trailId: string): Promise<{ stats: TrailStats; reviews: Review[] }> {
  const r = (await api.call('GET', `/v1/trails/reviews?trail=${encodeURIComponent(trailId)}`, undefined, { auth: false })) as
    { stats: TrailStats; reviews: Review[] };
  return { stats: r.stats, reviews: r.reviews ?? [] };
}

/** Oldest first, newest last: by when each photo was taken (when it was uploaded, if that isn't known). */
export function oldestFirst<P>(list: P[], when: (p: P) => number): P[] {
  return list.map((p, i) => ({ p, i, t: when(p) })).sort((a, b) => (a.t - b.t) || (a.i - b.i)).map((x) => x.p);
}
export const remoteTime = (p: Pick<RemotePhoto, 'taken_at' | 'created_at'>): number => {
  const t = Date.parse(p.taken_at ?? p.created_at ?? '');
  return Number.isFinite(t) ? t : Infinity;
};

/** Every photo of a trail (the server hands them over 30 at a time), the earliest first and the latest last. */
export async function trailPhotos(trailId: string): Promise<RemotePhoto[]> {
  const all: RemotePhoto[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const r = (await api.call('GET', `/v1/trails/photos?trail=${encodeURIComponent(trailId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      undefined, { auth: false })) as { photos: RemotePhoto[]; cursor?: string | null };
    all.push(...(r.photos ?? []));
    cursor = r.cursor ?? null;
    if (!cursor) break;
  }
  const seen = new Set<string>();
  return oldestFirst(all.filter((p) => !seen.has(p.id) && !!seen.add(p.id)), remoteTime);
}

/** Writes your review of a trail (or changes it: one each per trail). */
export async function saveReview(ref: TrailRef, rating: number, body: string, hikedOn: number | null, id?: string): Promise<Review> {
  const day = hikedOn ? new Date(hikedOn) : null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return (await api.call('PUT', `/v1/reviews/${id ?? uuid()}`, {
    trail: ref, rating, body: body.trim(),
    ...(day ? { hiked_on: `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}` } : {}),
  })) as Review;
}

export async function deleteReview(id: string): Promise<void> {
  await api.call('DELETE', `/v1/reviews/${id}`);
}

export const PUBLIC_POSTS = 'Reviews and photos of a trail are public: anyone using Switchback can see them, with your name, and photos are for public use (anyone may see, share and reuse them).';
