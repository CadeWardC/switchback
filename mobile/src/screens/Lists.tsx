// Saved and Log: full-screen native lists over the map (which stays loaded underneath, so going back to it
// is instant). A recorded hike opens on the map, its details in the sheet: rename, share GPX, delete.
import { useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fmtClock, fmtDate, fmtDistance, fmtElevation } from '@web/lib/format';
import { exportGpx } from '@web/lib/gpx';
import { bboxOf } from '@web/lib/geo';
import { profileOf, type Difficulty } from '@web/lib/trail';
import type { SavedTrail, WalkSummary } from '@web/lib/storage';
import { findTrail } from '@web/data';
import {
  deleteWalk, flyTo, loadWalk, openTrail, removeSaved, renameWalk, savedTrails, say, shownWalk, storageFailed, tab, units, walks,
} from '../core/state';
import { walkGpx } from '../core/gpx';
import { climbedSoFar } from '../core/hikeMath';
import { useValue } from '../ui/hooks';
import { Blazes, Button, Card, Icon, Note, Stat, T, Tap } from '../ui/kit';
import { fonts, radius, shadow, useTheme } from '../ui/theme';

function Header({ title, onSettings }: { title: string; onSettings: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8 }}>
      <T v="name">{title}</T>
      <Tap onPress={onSettings} accessibilityRole="button" accessibilityLabel="Settings" style={{ padding: 10 }}>
        <Icon name="gear" size={22} color={t.c.muted} />
      </Tap>
    </View>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: { title: string; onPress: () => void } }) {
  return (
    <View style={{ padding: 24, gap: 8, alignItems: 'flex-start' }}>
      <T v="section">{title}</T>
      <T v="body" muted>{text}</T>
      {action && <Button kind="primary" title={action.title} onPress={action.onPress} style={{ marginTop: 8 }} />}
    </View>
  );
}

export function SavedScreen({ onSettings }: { onSettings: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const list = useValue(savedTrails);
  const u = useValue(units);
  const [opening, setOpening] = useState<string | null>(null);
  const open = async (s: SavedTrail) => {
    const key = `${s.region}/${s.id}`;
    setOpening(key);
    try {
      const tr = await findTrail(s.region, s.id);
      if (tr) openTrail(tr);
      else say("This trail isn't in the current trail files. It may have been renamed or removed.");
    } catch {
      say("The trail couldn't be loaded. Check your connection.");
    } finally {
      setOpening(null);
    }
  };
  const remove = (s: SavedTrail) => Alert.alert('Remove from Saved?', s.name, [
    { text: 'Keep', style: 'cancel' },
    { text: 'Remove', style: 'destructive', onPress: () => removeSaved(s.region, s.id) },
  ]);
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg, paddingTop: insets.top + 8 }}>
      <Header title="Saved" onSettings={onSettings} />
      <FlashList
        data={list}
        keyExtractor={(s) => `${s.region}/${s.id}`}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={<Empty title="No saved trails" text="Save a trail from its page to keep it here. Its map is saved for when there is no signal." action={{ title: 'Find a trail', onPress: () => { tab.value = 'explore'; } }} />}
        renderItem={({ item: s }) => (
          <Tap onPress={() => void open(s)} onLongPress={() => remove(s)}
            style={[{ marginHorizontal: 16, marginBottom: 10, backgroundColor: t.c.card, borderRadius: radius.card, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' }, shadow(t)]}>
            <Blazes difficulty={s.difficulty as Difficulty} />
            <View style={{ flex: 1 }}>
              <T v="strong" style={{ fontFamily: fonts.numSemibold, fontSize: 16.5 }} numberOfLines={2}>{s.name}</T>
              <T v="small" muted numberOfLines={1}>
                {[s.area, `${fmtDistance(s.length, u)}${s.gain >= 1 ? ` · ${fmtElevation(s.gain, u)}` : ''}${s.loop ? ' · Loop' : ''}`].filter(Boolean).join(' · ')}
              </T>
            </View>
            {opening === `${s.region}/${s.id}` ? <T v="tiny" muted>Opening…</T> : (
              <Tap onPress={() => remove(s)} accessibilityLabel={`Remove ${s.name}`} style={{ padding: 6 }}><Icon name="close" size={18} color={t.c.muted} /></Tap>
            )}
          </Tap>
        )}
      />
    </View>
  );
}

export function LogScreen({ onSettings }: { onSettings: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const list = useValue(walks);
  const failed = useValue(storageFailed);
  const u = useValue(units);
  const open = async (w: WalkSummary) => {
    const full = await loadWalk(w.id);
    if (!full) { say("This hike's file couldn't be read."); return; }
    shownWalk.value = full;
    const box = bboxOf(full.segments.map((s) => s.map((p) => [p.lat, p.lon] as [number, number])));
    if (box) flyTo.value = { bounds: box };
  };
  return (
    <View style={{ flex: 1, backgroundColor: t.c.bg, paddingTop: insets.top + 8 }}>
      <Header title="Log" onSettings={onSettings} />
      {failed && <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}><Note warn>A hike could not be written to this phone (is it full?). Share GPX files to keep them.</Note></View>}
      <FlashList
        data={list}
        keyExtractor={(w) => w.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListEmptyComponent={<Empty title="No hikes yet" text="Hikes you record are kept here, on this phone." action={{ title: 'Go to Hike', onPress: () => { tab.value = 'hike'; } }} />}
        renderItem={({ item: w }) => (
          <Tap onPress={() => void open(w)}
            style={[{ marginHorizontal: 16, marginBottom: 10, backgroundColor: t.c.card, borderRadius: radius.card, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' }, shadow(t)]}>
            <View style={{ flex: 1 }}>
              <T v="strong" style={{ fontFamily: fonts.numSemibold, fontSize: 16.5 }} numberOfLines={1}>{w.name}</T>
              <T v="small" muted>{fmtDate(w.started)} · {fmtDistance(w.length, u)} · {fmtClock(w.seconds)}</T>
            </View>
            <Icon name="chevron" size={16} color={t.c.muted} />
          </Tap>
        )}
      />
    </View>
  );
}

/** One recorded hike, in the sheet over its line on the map. */
export function WalkSheet() {
  const t = useTheme();
  const w = useValue(shownWalk)!;
  const u = useValue(units);
  const [name, setName] = useState<string | null>(null);
  const climbed = climbedSoFar(w.segments);
  const eles = w.segments.flat().map((p) => p.ele).filter((e): e is number => e != null);
  const prof = eles.length > 1 ? profileOf(eles.map((_, i) => i), eles, 5) : null;
  const close = () => { shownWalk.value = null; };
  const del = () => Alert.alert('Delete this hike?', 'It is removed from this phone. Share the GPX first to keep a copy.', [
    { text: 'Keep', style: 'cancel' },
    { text: 'Delete', style: 'destructive', onPress: () => { void deleteWalk(w.id); close(); say('Hike deleted'); } },
  ]);
  const save = () => {
    const n = (name ?? '').trim();
    if (n && n !== w.name) { void renameWalk(w.id, n); shownWalk.value = { ...w, name: n }; }
    setName(null);
  };
  return (
    <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, gap: 14 }} keyboardShouldPersistTaps="handled">
      <Tap onPress={close} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 8, alignSelf: 'flex-start' }}>
        <Icon name="back" size={18} color={t.c.link} />
        <T v="strong" color={t.c.link}>Log</T>
      </Tap>
      {name != null ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <TextInput value={name} onChangeText={setName} autoFocus onSubmitEditing={save} returnKeyType="done" maxLength={80}
            style={{ flex: 1, height: 46, borderRadius: radius.control, backgroundColor: t.c.card, paddingHorizontal: 12, color: t.c.ink, fontFamily: fonts.semibold, fontSize: 17 }} />
          <Button kind="primary" title="Save" onPress={save} />
        </View>
      ) : (
        <Tap onPress={() => setName(w.name)} accessibilityLabel="Rename this hike" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T v="name" style={{ flexShrink: 1 }}>{w.name}</T>
          <Icon name="pencil" size={18} color={t.c.muted} />
        </Tap>
      )}
      <T v="small" muted>{fmtDate(w.started)}{w.trail ? ` · ${w.trail.name}` : ''}</T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Stat label="Distance" value={fmtDistance(w.length, u)} />
        <Stat label="Moving" value={fmtClock(w.seconds)} />
        <Stat label="Climbed" value={climbed != null ? fmtElevation(climbed, u) : '–'} />
        <Stat label="On the trail" value={fmtClock((w.ended - w.started) / 1000)} />
        <Stat label="Highest" value={prof ? fmtElevation(prof.max, u) : '–'} />
        <Stat label="Spots marked" value={String(w.markers?.length ?? 0)} />
      </View>
      {w.markers?.length ? <Card><T v="small">{w.markers.map((m) => m.name).join(', ')}</T></Card> : null}
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button icon="download" title="Share GPX" onPress={() => void exportGpx(w.name, walkGpx(w)).catch(() => say("The GPX file couldn't be shared."))} style={{ flex: 1 }} />
        <Button icon="trash" kind="danger" title="Delete" onPress={del} style={{ flex: 1 }} />
      </View>
    </BottomSheetScrollView>
  );
}
