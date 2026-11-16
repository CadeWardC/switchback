// Photos, three ways: a tall strip to swipe along at the top of a trail's page (PhotoStrip), a grid of squares on
// one of your hikes (PhotoGrid), and full screen (PhotoViewer), where you swipe from one photo to the next and only
// the close button (or the phone's back) leaves. Everywhere the earliest photo comes first and the latest last.
// Your own photos on this phone can be removed with a long press.
import { useEffect, useState } from 'react';
import { Alert, FlatList, Image, Modal, ScrollView, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { accountPhotos, deletePhoto, loadMyPhotos, myPhotos, photoError, pickPhotos, uploadPhotos, type MyPhoto, type RemotePhoto } from '../core/myPhotos';
import type { Walk } from '@web/lib/storage';
import { account } from '../core/server';
import { say } from '../core/state';
import { useValue } from './hooks';
import { oldestFirst, remoteTime } from '../core/community';
import { Button, Icon, T, Tap } from './kit';
import { radius, useTheme } from './theme';

interface Shown {
  key: string; thumb: string; full: string;
  /** When it was taken (ms; Infinity when nobody knows), and its shape, when known. */
  t: number; width?: number | null; height?: number | null;
  /** Who took it (other people's photos). */
  by?: string;
  mine?: MyPhoto; waiting?: boolean;
}

/** Your photos on this phone and photos from the server, as one list without repeats, the earliest first. */
function shownPhotos(mine: MyPhoto[], remote: RemotePhoto[]): Shown[] {
  const local = new Set(mine.map((p) => p.id));
  return oldestFirst<Shown>([
    ...mine.map((p) => ({ key: p.id, thumb: p.file, full: p.file, t: p.t, width: p.width, height: p.height, mine: p, waiting: !p.uploaded })),
    ...remote.filter((r) => !local.has(r.id) && (r.thumb_url || r.url)).map((r) => ({
      key: r.id, thumb: (r.thumb_url ?? r.url)!, full: (r.url ?? r.thumb_url)!, t: remoteTime(r), width: r.width, height: r.height, by: r.display_name,
    })),
  ], (p) => p.t);
}

const dateOf = (t: number) => (Number.isFinite(t) ? new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : null);

/** Full screen: swipe left and right through the photos. Touching a photo never closes it. */
function PhotoViewer({ items, at, onClose }: { items: Shown[]; at: number | null; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [i, setI] = useState(at ?? 0);
  useEffect(() => { if (at != null) setI(at); }, [at]);
  if (at == null || !items.length) return null;
  const now = items[Math.min(i, items.length - 1)];
  const caption = [now.by ?? (now.mine ? 'Your photo' : null), dateOf(now.t)].filter(Boolean).join(' · ');
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <FlatList
          key={width}
          data={items}
          keyExtractor={(p) => p.key}
          horizontal pagingEnabled showsHorizontalScrollIndicator={false}
          initialScrollIndex={Math.min(at, items.length - 1)}
          getItemLayout={(_, k) => ({ length: width, offset: width * k, index: k })}
          initialNumToRender={1} windowSize={3}
          scrollEventThrottle={32}
          onScroll={(e) => setI(Math.max(0, Math.min(items.length - 1, Math.round(e.nativeEvent.contentOffset.x / width))))}
          renderItem={({ item }) => (
            <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
              <Image source={{ uri: item.full }} resizeMode="contain" style={{ width, height: height - insets.top - insets.bottom - 96 }} accessibilityLabel={item.mine ? 'Your photo' : 'Photo'} />
            </View>
          )}
        />
        <View pointerEvents="box-none" style={{ position: 'absolute', top: insets.top + 6, left: 16, right: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <T v="strong" color="#fff" accessibilityLiveRegion="polite">{items.length > 1 ? `${Math.min(i, items.length - 1) + 1} of ${items.length}` : ''}</T>
          <Tap onPress={onClose} accessibilityRole="button" accessibilityLabel="Close photos" hitSlop={12}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name="close" size={24} color="#fff" />
          </Tap>
        </View>
        {caption ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 14, alignItems: 'center' }}>
            <T v="small" color="#fff" numberOfLines={1}>{caption}</T>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const removePhoto = (p: MyPhoto) => Alert.alert('Remove this photo?', 'It is removed from this phone and from your account.', [
  { text: 'Keep', style: 'cancel' },
  { text: 'Remove', style: 'destructive', onPress: () => void deletePhoto(p.id) },
]);

/** Squares, four to a row: the photos of one of your hikes. */
export function PhotoGrid({ mine = [], remote = [], inset = 32 }: { mine?: MyPhoto[]; remote?: RemotePhoto[]; inset?: number }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState<number | null>(null);
  const items = shownPhotos(mine, remote);
  if (!items.length) return null;
  const side = Math.floor((width - inset - 3 * 6) / 4);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {items.map((p, i) => (
          <Tap key={p.key} onPress={() => setOpen(i)} onLongPress={p.mine ? () => removePhoto(p.mine!) : undefined}
            accessibilityRole="imagebutton" accessibilityLabel={p.mine ? 'Your photo' : 'Photo'}>
            <Image source={{ uri: p.thumb }} style={{ width: side, height: side, borderRadius: radius.control, backgroundColor: t.c.tint }} />
            {p.waiting && (
              <View style={{ position: 'absolute', right: 4, bottom: 4, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 8, paddingHorizontal: 5, paddingVertical: 1 }}>
                <T v="tiny" color="#fff">not uploaded</T>
              </View>
            )}
          </Tap>
        ))}
      </View>
      <PhotoViewer items={items} at={open} onClose={() => setOpen(null)} />
    </>
  );
}

/**
 * A trail's photos, big, at the top of its page: one tall row to swipe along (each photo keeps its own shape), the
 * earliest on the left. A tap opens them full screen at that photo.
 */
export function PhotoStrip({ remote, height = 210 }: { remote: RemotePhoto[]; height?: number }) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const [open, setOpen] = useState<number | null>(null);
  const items = shownPhotos([], remote);
  if (!items.length) return null;
  const one = items.length === 1;
  const widthOf = (p: Shown) => {
    if (one) return width - 32;
    const shape = p.width && p.height ? p.width / p.height : 4 / 3;
    return Math.round(Math.max(height * 0.7, Math.min(width - 72, height * shape)));
  };
  return (
    <>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} decelerationRate="fast"
        style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        accessibilityLabel={`${items.length} ${one ? 'photo' : 'photos'} of this trail`}>
        {items.map((p, i) => (
          <Tap key={p.key} onPress={() => setOpen(i)} accessibilityRole="imagebutton" accessibilityLabel={`Photo ${i + 1} of ${items.length}${p.by ? `, by ${p.by}` : ''}`}>
            <Image source={{ uri: p.full }} resizeMode="cover" style={{ width: widthOf(p), height, borderRadius: radius.card, backgroundColor: t.c.tint }} />
            {i === 0 && !one && (
              <View style={{ position: 'absolute', left: 8, bottom: 8, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2, flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Icon name="camera" size={13} color="#fff" />
                <T v="tiny" color="#fff">{items.length} photos</T>
              </View>
            )}
          </Tap>
        ))}
      </ScrollView>
      <PhotoViewer items={items} at={open} onClose={() => setOpen(null)} />
    </>
  );
}

/**
 * A kept hike's photos: taken on the way or added from the phone's library; also ones on your account (after a
 * reinstall). `inset` is the room either side of the grid (the sheet's padding, twice).
 */
export function HikePhotos({ walk, inset = 32 }: { walk: Walk; inset?: number }) {
  const mine = useValue(myPhotos).filter((p) => p.walk === walk.id);
  const me = useValue(account);
  const failed = useValue(photoError);
  const t = useTheme();
  const [remote, setRemote] = useState<RemotePhoto[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    // opening the hike tries again for any photo still waiting to go up
    void loadMyPhotos().then(() => uploadPhotos());
    if (me) void accountPhotos(walk.id).then((p) => { if (live) setRemote(p); }, () => {});
    return () => { live = false; };
  }, [walk.id, me?.id]);
  const add = async () => {
    setBusy(true);
    try {
      const n = await pickPhotos({ walk });
      if (n) say(n === 1 ? 'Photo added' : `${n} photos added`);
    } catch (e) {
      Alert.alert("Couldn't add photos", (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={{ gap: 8 }}>
      <PhotoGrid mine={mine} remote={remote} inset={inset} />
      <Button icon="camera" title={busy ? 'Adding…' : mine.length || remote.length ? 'Add more photos' : 'Add photos'} onPress={() => void add()} disabled={busy} />
      {!me && (mine.length > 0) && <T v="tiny" muted>Kept on this phone. Log in (Settings › Account) to upload them.</T>}
      {me && failed && mine.some((p) => !p.uploaded) && <T v="tiny" color={t.c.hard}>{failed}</T>}
      <T v="tiny" muted>{walk.trail
        ? `Photos you add here are shown publicly on ${walk.trail.name}'s page: anyone may see, share and reuse them.`
        : 'Photos here are seen only by you, until this hike is added as a trail.'}</T>
    </View>
  );
}
