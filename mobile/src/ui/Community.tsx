// On a trail's page: its rating, everyone's photos and reviews (public, readable without an account), and Write a
// review for someone who has recorded a hike of it. The review editor is a sheet of its own (ReviewModal, in App).
import { useEffect, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, ScrollView, Switch, TextInput, View } from 'react-native';
import { signal } from '@preact/signals-core';
import type { Trail } from '@web/lib/trail';
import { account, isSignedIn } from '../core/server';
import { deleteReview, PUBLIC_POSTS, saveReview, trailPhotos, trailRefOf, trailReviews, type Review, type TrailRef, type TrailStats } from '../core/community';
import type { RemotePhoto } from '../core/myPhotos';
import { say, walks } from '../core/state';
import { platform } from '../platform';
import { useValue } from './hooks';
import { Button, Card, Icon, Note, T, Tap } from './kit';
import { PhotoGrid } from './MyPhotos';
import { fonts, radius, useTheme } from './theme';

interface Writing { ref: TrailRef; hikedOn: number | null; mine: Review | null }
/** The review being written (null when the editor is closed). */
export const reviewing = signal<Writing | null>(null);
/** Bumped when a review is saved or deleted, so the trail page shows it at once. */
const changed = signal(0);

const stars = (n: number) => '★★★★★'.slice(0, Math.round(n)) + '☆☆☆☆☆'.slice(0, 5 - Math.round(n));

/** Opens the editor for a trail: your review of it if you have one, else a new one. */
export async function writeReview(ref: TrailRef, hikedOn: number | null): Promise<void> {
  if (!account.peek() || !isSignedIn()) {
    Alert.alert('Log in to write a review', 'Reviews are posted with your account. Create one or log in under Settings › Account.');
    return;
  }
  let mine: Review | null = null;
  try {
    const me = account.peek()?.id;
    mine = (await trailReviews(ref.id)).reviews.find((r) => r.user_id === me) ?? null;
  } catch { /* offline: start a new one; the server says if there's one already */ }
  reviewing.value = { ref, hikedOn, mine };
}

/** The newest recorded hike of this trail on this phone (or synced from your account), if any. */
function hikeOf(key: string, list: ReturnType<typeof walks.peek>) {
  return list.filter((w) => w.trail && `${w.trail.region}/${w.trail.id}` === key).sort((a, b) => b.started - a.started)[0] ?? null;
}

export function TrailCommunity({ trail }: { trail: Trail }) {
  const me = useValue(account);
  const list = useValue(walks);
  const bump = useValue(changed);
  const [stats, setStats] = useState<TrailStats | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [photos, setPhotos] = useState<RemotePhoto[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setFailed(false);
    Promise.all([trailReviews(trail.key), trailPhotos(trail.key)]).then(([r, p]) => {
      if (!live) return;
      setStats(r.stats); setReviews(r.reviews); setPhotos(p);
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
      {photos.length > 0 && <PhotoGrid remote={photos} />}
      {failed && <T v="small" muted>Reviews and photos can't be loaded right now.</T>}
      {!failed && stats && !reviews.length && !photos.length && <T v="small" muted>No reviews or photos yet.</T>}
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
        <Button icon="pencil" title={mine ? 'Edit your review' : 'Write a review'} onPress={() => void writeReview(trailRefOf(trail), hiked.started)} />
      ) : (
        <T v="tiny" muted>Record a hike of this trail to review it and add photos.</T>
      )}
      {(reviews.length > 0 || photos.length > 0) && <T v="tiny" muted>{PUBLIC_POSTS}</T>}
    </View>
  );
}

export function ReviewModal() {
  const t = useTheme();
  const w = useValue(reviewing);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!w) return;
    setRating(w.mine?.rating ?? 0); setBody(w.mine?.body ?? ''); setAgree(!!w.mine); setError(null); setBusy(false);
  }, [w]);
  if (!w) return null;
  const close = () => { reviewing.value = null; };
  const send = async () => {
    if (!rating || !agree || busy) return;
    setBusy(true); setError(null);
    try {
      await saveReview(w.ref, rating, body, w.hikedOn, w.mine?.id);
      changed.value++;
      platform.haptics.success();
      say(w.mine ? 'Review updated' : 'Review posted');
      close();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = () => Alert.alert('Delete your review?', 'It is taken off the trail for everyone.', [
    { text: 'Keep', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: async () => {
      try { await deleteReview(w.mine!.id); changed.value++; say('Review deleted'); close(); } catch (e) { setError((e as Error).message); }
    } },
  ]);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: t.c.bg }}>
        <ScrollView contentContainerStyle={{ padding: 20, gap: 16, paddingBottom: 48 }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <T v="name" style={{ flex: 1 }} numberOfLines={2}>{w.mine ? 'Your review' : 'Review'} of {w.ref.name}</T>
            <Tap onPress={close} accessibilityLabel="Close" style={{ padding: 6 }}><Icon name="close" size={22} color={t.c.muted} /></Tap>
          </View>
          <View style={{ flexDirection: 'row', gap: 6 }} accessibilityRole="adjustable" accessibilityLabel={`Rating: ${rating || 'none'} of 5`}>
            {[1, 2, 3, 4, 5].map((i) => (
              <Tap key={i} onPress={() => setRating(i)} accessibilityLabel={`${i} star${i === 1 ? '' : 's'}`} style={{ padding: 4 }}>
                <T v="title" color={i <= rating ? '#e0a400' : t.c.line2}>{i <= rating ? '★' : '☆'}</T>
              </Tap>
            ))}
          </View>
          <TextInput value={body} onChangeText={setBody} placeholder="How was it? Conditions, highlights, what to know." placeholderTextColor={t.c.muted}
            multiline maxLength={4000} accessibilityLabel="Review"
            style={{ minHeight: 120, borderRadius: radius.control, backgroundColor: t.c.card, paddingHorizontal: 12, paddingTop: 10, textAlignVertical: 'top', color: t.c.ink, fontFamily: fonts.regular, fontSize: 16 }} />
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <T v="strong" style={{ flex: 1 }}>I agree</T>
              <Switch value={agree} onValueChange={setAgree} trackColor={{ true: t.c.primary, false: t.c.line2 }} accessibilityLabel="I agree to public use" />
            </View>
            <T v="small" muted>{PUBLIC_POSTS}</T>
          </View>
          {error && <Note warn>{error}</Note>}
          <View style={{ flexDirection: 'row', gap: 10 }}>
            {w.mine && <Button big kind="danger" title="Delete" onPress={remove} style={{ flex: 1 }} />}
            <Button big kind="primary" title={busy ? 'Posting…' : w.mine ? 'Save' : 'Post review'} onPress={() => void send()}
              disabled={!rating || !agree || busy} style={{ flex: 1 }} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
