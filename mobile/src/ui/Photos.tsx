// Photos of a trail: a small square on a list card, a swipeable strip at the top of the trail page, and a
// full-screen viewer with pinch zoom. Pictures come from src/core/photos.ts (photosFor) and are shown from
// the phone's own copy (src/core/imageCache.ts). Until a picture is here nothing is drawn: no spinners, and
// with no connection or no photos the screens look as they did.
import { memo, useEffect, useState } from 'react';
import { FlatList, Image, Modal, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Trail } from '@web/lib/trail';
import { credit, knownPhotos, photosFor, type TrailPhoto } from '../core/photos';
import { cachedImage, cachedNow } from '../core/imageCache';
import { platform } from '../platform';
import { Icon, T, Tap } from './kit';
import { fonts, radius, useTheme } from './theme';

/** The phone's own copy of a picture, once it is here (null until then, and when it can't be had).
 *  `fallback`: another address to try when the first can't be had (a size the server refuses). */
export function useLocalImage(url: string | null | undefined, fallback?: string): string | null {
  const [uri, setUri] = useState<string | null>(() => (url ? cachedNow(url) : null));
  useEffect(() => {
    let live = true;
    const have = url ? cachedNow(url) : null;
    setUri(have);
    if (url && !have) {
      void cachedImage(url).then((u) => u ?? (fallback ? cachedImage(fallback) : null)).then((u) => { if (live) setUri(u); });
    }
    return () => { live = false; };
  }, [url, fallback]);
  return uri;
}

/** A trail's photos. `active`: look them up now (a card only does once it is on screen). */
export function useTrailPhotos(trail: Trail, active: boolean, first: boolean): TrailPhoto[] {
  const [photos, setPhotos] = useState<TrailPhoto[]>(() => knownPhotos(trail.key) ?? []);
  useEffect(() => {
    let live = true;
    setPhotos(knownPhotos(trail.key) ?? []);
    if (active) void photosFor(trail, first).then((p) => { if (live) setPhotos(p); });
    return () => { live = false; };
  }, [trail, active, first]);
  return photos;
}

/** The square on a list card: the trail's photo when it has one, else `fallback` (the trail's shape). */
export const CardPhoto = memo(function CardPhoto({ trail, active, fallback }: { trail: Trail; active: boolean; fallback: React.ReactNode }) {
  const t = useTheme();
  const photo = useTrailPhotos(trail, active, true)[0];
  const uri = useLocalImage(photo?.small, photo?.url);
  if (!uri) return <>{fallback}</>;
  return <Image source={{ uri }} style={{ width: 56, height: 56, borderRadius: 10, backgroundColor: t.c.tint }} accessibilityIgnoresInvertColors />;
});

function StripPhoto({ photo, width, index, total, onPress }: { photo: TrailPhoto; width: number; index: number; total: number; onPress: () => void }) {
  const t = useTheme();
  const uri = useLocalImage(photo.url);
  return (
    <Tap onPress={onPress} accessibilityRole="imagebutton" accessibilityLabel={`Photo ${index + 1} of ${total}. ${credit(photo)}`}
      style={{ width, height: 150, borderRadius: radius.card, overflow: 'hidden', backgroundColor: t.c.tint }}>
      {uri ? <Image source={{ uri }} style={StyleSheet.absoluteFill} resizeMode="cover" accessibilityIgnoresInvertColors /> : null}
      <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0, flexDirection: 'row', alignItems: 'flex-end', padding: 8, gap: 8 }}>
        <View style={{ flex: 1 }}>
          <T v="tiny" numberOfLines={1} color="#ffffff" style={styles.onPhoto}>{credit(photo)}</T>
        </View>
        <View style={{ backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: radius.chip, paddingHorizontal: 8, paddingVertical: 2 }}>
          <T v="tiny" color="#ffffff" style={{ fontFamily: fonts.semibold }}>{index + 1} of {total}</T>
        </View>
      </View>
    </Tap>
  );
}

/** The strip at the top of a trail page. Draws nothing (and takes no room) when the trail has no photos. */
export function PhotoStrip({ trail }: { trail: Trail }) {
  const { width: screen } = useWindowDimensions();
  const photos = useTrailPhotos(trail, true, false);
  const [open, setOpen] = useState<number | null>(null);
  if (!photos.length) return null;
  const one = photos.length === 1;
  const w = one ? screen - 32 : Math.round((screen - 32) * 0.86);
  return (
    <View style={{ marginHorizontal: -16 }}>
      <FlatList
        horizontal data={photos} keyExtractor={(p) => `${p.source}:${p.id}`} showsHorizontalScrollIndicator={false}
        snapToInterval={w + 8} decelerationRate="fast" contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
        initialNumToRender={2} windowSize={3}
        renderItem={({ item, index }) => <StripPhoto photo={item} width={w} index={index} total={photos.length} onPress={() => setOpen(index)} />}
      />
      {open != null && <PhotoViewer photos={photos} start={open} onClose={() => setOpen(null)} />}
    </View>
  );
}

function ZoomPhoto({ photo, width, height, onZoom }: { photo: TrailPhoto; width: number; height: number; onZoom: (zoomed: boolean) => void }) {
  const uri = useLocalImage(photo.url);
  const [zoomed, setZoomed] = useState(false);
  const scale = useSharedValue(1), saved = useSharedValue(1);
  const x = useSharedValue(0), y = useSharedValue(0), sx = useSharedValue(0), sy = useSharedValue(0);
  const report = (z: boolean) => { setZoomed(z); onZoom(z); };

  const pinch = Gesture.Pinch()
    .onUpdate((e) => { scale.value = Math.max(1, Math.min(5, saved.value * e.scale)); })
    .onEnd(() => {
      saved.value = scale.value;
      if (scale.value <= 1.02) {
        scale.value = withTiming(1); saved.value = 1; x.value = withTiming(0); y.value = withTiming(0); sx.value = 0; sy.value = 0;
        runOnJS(report)(false);
      } else runOnJS(report)(true);
    });
  const pan = Gesture.Pan().enabled(zoomed).minPointers(1)
    .onUpdate((e) => {
      const mx = (width * (scale.value - 1)) / 2, my = (height * (scale.value - 1)) / 2;
      x.value = Math.max(-mx, Math.min(mx, sx.value + e.translationX));
      y.value = Math.max(-my, Math.min(my, sy.value + e.translationY));
    })
    .onEnd(() => { sx.value = x.value; sy.value = y.value; });
  const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(() => {
    const out = scale.value > 1.02;
    scale.value = withTiming(out ? 1 : 2.5); saved.value = out ? 1 : 2.5;
    x.value = withTiming(0); y.value = withTiming(0); sx.value = 0; sy.value = 0;
    runOnJS(report)(!out);
  });
  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.value }, { translateY: y.value }, { scale: scale.value }] }));

  return (
    <GestureDetector gesture={Gesture.Simultaneous(pinch, pan, doubleTap)}>
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        {uri ? <Animated.Image source={{ uri }} style={[{ width, height }, style]} resizeMode="contain" /> : null}
      </View>
    </GestureDetector>
  );
}

/** Full screen: swipe between photos, pinch or double-tap to zoom, the author and licence under each. */
function PhotoViewer({ photos, start, onClose }: { photos: TrailPhoto[]; start: number; onClose: () => void }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [at, setAt] = useState(start);
  const [zoomed, setZoomed] = useState(false);
  const photo = photos[at] ?? photos[0];
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent presentationStyle="fullScreen">
      <GestureHandlerRootView style={{ flex: 1, backgroundColor: '#000000' }}>
        <FlatList
          horizontal pagingEnabled data={photos} keyExtractor={(p) => `${p.source}:${p.id}`} showsHorizontalScrollIndicator={false}
          initialScrollIndex={start} getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          scrollEnabled={!zoomed} initialNumToRender={1} windowSize={3}
          onMomentumScrollEnd={(e) => setAt(Math.round(e.nativeEvent.contentOffset.x / width))}
          renderItem={({ item }) => <ZoomPhoto photo={item} width={width} height={height} onZoom={setZoomed} />}
        />
        <Tap onPress={onClose} accessibilityRole="button" accessibilityLabel="Close"
          style={{ position: 'absolute', top: insets.top + 8, right: 12, width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="close" size={22} color="#ffffff" />
        </Tap>
        <View pointerEvents="box-none" style={{ position: 'absolute', left: 16, right: 16, bottom: insets.bottom + 12, gap: 2 }}>
          <T v="small" color="#ffffff" style={styles.onPhoto}>{at + 1} of {photos.length}</T>
          <T v="small" color="#ffffff" style={styles.onPhoto} onPress={photo.page ? () => platform.links.open(photo.page!) : undefined}>
            {credit(photo)}
          </T>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  onPhoto: { fontFamily: fonts.semibold, textShadowColor: 'rgba(0,0,0,0.85)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } },
});
