// Photos as a row of squares (yours and, on a trail, everyone's), opening full screen when tapped. Your own
// photos on this phone can be removed with a long press.
import { useState } from 'react';
import { Alert, Image, Modal, Pressable, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deletePhoto, type MyPhoto, type RemotePhoto } from '../core/myPhotos';
import { Icon, T, Tap } from './kit';
import { radius, useTheme } from './theme';

interface Shown { key: string; thumb: string; full: string; mine?: MyPhoto; waiting?: boolean }

export function PhotoGrid({ mine = [], remote = [] }: { mine?: MyPhoto[]; remote?: RemotePhoto[] }) {
  const t = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [open, setOpen] = useState<Shown | null>(null);
  const local = new Set(mine.map((p) => p.id));
  const items: Shown[] = [
    ...mine.map((p) => ({ key: p.id, thumb: p.file, full: p.file, mine: p, waiting: !p.uploaded })),
    ...remote.filter((r) => !local.has(r.id) && (r.thumb_url || r.url)).map((r) => ({ key: r.id, thumb: (r.thumb_url ?? r.url)!, full: (r.url ?? r.thumb_url)! })),
  ];
  if (!items.length) return null;
  const side = Math.floor((width - 32 - 3 * 6) / 4);
  const remove = (p: MyPhoto) => Alert.alert('Remove this photo?', 'It is removed from this phone and from your account.', [
    { text: 'Keep', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => void deletePhoto(p.id) },
  ]);
  return (
    <>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {items.map((p) => (
          <Tap key={p.key} onPress={() => setOpen(p)} onLongPress={p.mine ? () => remove(p.mine!) : undefined}
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
      <Modal visible={!!open} transparent animationType="fade" onRequestClose={() => setOpen(null)}>
        <Pressable onPress={() => setOpen(null)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', justifyContent: 'center' }} accessibilityLabel="Close photo">
          {open && <Image source={{ uri: open.full }} resizeMode="contain" style={{ width, height: height - insets.top - insets.bottom }} />}
          <View style={{ position: 'absolute', top: insets.top + 8, right: 12 }}>
            <Icon name="close" size={28} color="#fff" />
          </View>
        </Pressable>
      </Modal>
    </>
  );
}
