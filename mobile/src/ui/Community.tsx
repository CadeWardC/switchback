// On a trail's page: everyone's photos, big, at the top (TrailPhotos), and further down its rating and reviews
// (public, readable without an account), with Write a review for someone who has recorded a hike of it. The
// editor is the after-hike sheet (screens/AfterHike), where photos are added too.
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { Trail } from '@web/lib/trail';
import { account } from '../core/server';
import { communityChanged, PUBLIC_POSTS, trailPhotos, trailReviews, type Review, type TrailStats } from '../core/community';
import type { RemotePhoto } from '../core/myPhotos';
import { loadWalk, say, walks } from '../core/state';
import { followUp } from '../screens/AfterHike';
import { useValue } from './hooks';
import { Button, Card, T } from './kit';
import { PhotoStrip } from './MyPhotos';

const stars = (n: number) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));

/** The newest recorded hike of this trail on this phone (or synced from your account), if any. */
function hikeOf(key: string, list: ReturnType<typeof walks.peek>) {
  return list.filter((w) => w.trail && `${w.trail.region}/${w.trail.id}` === key).sort((a, b) => b.started - a.started)[0] ?? null;
}

/** Opens the sheet to review a trail and add photos, from your newest hike of it. */
async function reviewFrom(id: string): Promise<void> {
  const walk = await loadWalk(id);
  if (!walk) { say("This hike's file couldn't be read."); return; }
  followUp.value = { walk };
}

/** Everyone's photos of a trail, in one tall row to swipe along; nothing at all when there are none. */
export function TrailPhotos({ trail }: { trail: Trail }) {
  const bump = useValue(communityChanged);
  const [photos, setPhotos] = useState<RemotePhoto[]>([]);
  useEffect(() => {
    let live = true;
    setPhotos((now) => (now.length && now[0].trail_id !== trail.key ? [] : now));
    trailPhotos(trail.key).then((p) => { if (live) setPhotos(p); }, () => {});
    return () => { live = false; };
  }, [trail.key, bump]);
  return <PhotoStrip remote={photos} />;
}

export function TrailCommunity({ trail }: { trail: Trail }) {
  const me = useValue(account);
  const list = useValue(walks);
  const bump = useValue(communityChanged);
  const [stats, setStats] = useState<TrailStats | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    trailReviews(trail.key).then((r) => {
      if (!live) return;
      setStats(r.stats); setReviews(r.reviews);
    }, () => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [trail.key, bump]);

  const hiked = hikeOf(trail.key, list);
  const mine = me ? reviews.find((r) => r.user_id === me.id) : undefined;
  const count = stats?.reviews ?? reviews.length;

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 8 }}>
        <T v="section" style={{ flex: 1 }}>Reviews</T>
        {stats?.rating != null && <T v="strong" color="#e0a400">{stars(stats.rating)}</T>}
        {stats?.rating != null && <T v="small" muted>{stats.rating.toFixed(1)} · {count} {count === 1 ? 'review' : 'reviews'}</T>}
      </View>
      {failed && <T v="small" muted>Reviews can't be loaded right now.</T>}
      {!failed && stats && !reviews.length && <T v="small" muted>{stats.photos ? 'No reviews yet.' : 'No reviews or photos yet.'}</T>}
      {reviews.map((r) => (
        <Card key={r.id} style={{ gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <T v="strong" style={{ flex: 1 }} numberOfLines={1}>{r.display_name}{r.user_id === me?.id ? ' (you)' : ''}</T>
            <T v="small" color="#e0a400">{stars(r.rating)}</T>
          </View>
          <T v="tiny" muted>{r.hiked_on ? `Hiked ${new Date(`${r.hiked_on}T12:00:00`).toLocaleDateString()}` : new Date(r.created_at).toLocaleDateString()}</T>
          {r.body ? <T v="small">{r.body}</T> : null}
        </Card>
      ))}
      {hiked ? (
        <Button icon="pencil" title={mine ? 'Edit your review or add photos' : 'Write a review, add photos'} onPress={() => void reviewFrom(hiked.id)} />
      ) : (
        <T v="tiny" muted>Record a hike of this trail to review it and add photos.</T>
      )}
      {(reviews.length > 0 || !!stats?.photos) && <T v="tiny" muted>{PUBLIC_POSTS}</T>}
    </View>
  );
}
