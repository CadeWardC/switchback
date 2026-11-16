// Saved and Log: full-screen native lists over the map (which stays loaded underneath, so going back to it
// is instant). The Log opens with this phone's totals (miles, hikes, climb) for a year or all time. A
// recorded hike opens on the map, its details in the sheet: rename, share GPX, delete.
import { useEffect, useMemo, useState } from 'react';
import { Alert, TextInput, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fmtClock, fmtDate, fmtDistance, fmtDuration, fmtElevation } from '@web/lib/format';
import { exportGpx } from '@web/lib/gpx';
import { bboxOf, distance } from '@web/lib/geo';
import type { Coord } from '@web/lib/polyline';
import { profileOf, type Difficulty } from '@web/lib/trail';
import type { SavedTrail, Walk, WalkSummary } from '@web/lib/storage';
import { findTrail } from '@web/data';
import {
  deleteWalk, flyTo, loadWalk, openTrail, removeSaved, renameWalk, savedTrails, say, shownWalk, storageFailed, tab, units, walks, scrubbing,
} from '../core/state';
import { climbAs, hikesOf, totals, yearsOf } from '../core/stats';
import { split } from '../core/shape';
import { walkGpx } from '../core/gpx';
import { averageSpeed, climbedSoFar, pace } from '../core/hikeMath';
import { useValue } from '../ui/hooks';
import { Ridge } from '../ui/Ridge';
import { SubmissionRow } from './Submit';
import { account } from '../core/server';
import { accountPhotos, loadMyPhotos, myPhotos, pickPhotos, type RemotePhoto } from '../core/myPhotos';
import { PhotoGrid } from '../ui/MyPhotos';
import { Big, Blazes, Button, Card, Icon, Note, Segmented, Stat, T, Tap } from '../ui/kit';
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
      // your own trail is a hike you recorded: it opens as that hike
      if (s.walk) {
        const full = await loadWalk(s.walk);
        if (!full) { say("This hike's file couldn't be read."); return; }
        shownWalk.value = full;
        tab.value = 'log';
        const box = bboxOf(full.segments.map((seg) => seg.map((p) => [p.lat, p.lon] as [number, number])));
        if (box) flyTo.value = { bounds: box };
        return;
      }
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

/** The totals at the top of the Log, for the hikes kept on this phone: a year, or all time. */
function Totals() {
  const t = useTheme();
  const list = useValue(walks);
  const u = useValue(units);
  const years = useMemo(() => yearsOf(list, new Date()), [list]);
  const [year, setYear] = useState<number | 0>(years[0]); // 0: all time
  const sum = useMemo(() => totals(hikesOf(list, year || null)), [list, year]);
  const miles = split(fmtDistance(sum.length, u)), climb = split(fmtElevation(sum.gain, u));
  const as = climbAs(sum.gain);
  return (
    <View style={[{ marginHorizontal: 16, marginBottom: 14, backgroundColor: t.c.card, borderRadius: radius.card, padding: 14, gap: 12 }, shadow(t)]}>
      <Segmented value={year} onChange={setYear}
        options={[...years.slice(0, 3).map((y) => ({ value: y, label: String(y) })), { value: 0, label: 'All time' }]} />
      <Big items={[
        { value: miles.value, unit: miles.unit, label: 'hiked' },
        { value: String(sum.hikes), label: sum.hikes === 1 ? 'hike' : 'hikes' },
        { value: climb.value, unit: climb.unit, label: 'climbed' },
      ]} />
      {sum.hikes > 0 ? (
        <View style={{ gap: 3, paddingTop: 8, borderTopWidth: 1, borderTopColor: t.c.line }}>
          <T v="small" muted><T v="small" style={{ fontFamily: fonts.semibold }}>{fmtDuration(sum.seconds)}</T> on the move, over {sum.days} {sum.days === 1 ? 'day' : 'days'} out</T>
          {sum.longest && sum.hikes > 1 && <T v="small" muted>Longest: <T v="small" style={{ fontFamily: fonts.semibold }}>{fmtDistance(sum.longest.length, u)}</T>, {sum.longest.name}</T>}
          {sum.steepest && sum.hikes > 1 && <T v="small" muted>Most climbing: <T v="small" style={{ fontFamily: fonts.semibold }}>{fmtElevation(sum.steepest.gain ?? 0, u)}</T>, {sum.steepest.name}</T>}
          {sum.trails > 1 && <T v="small" muted><T v="small" style={{ fontFamily: fonts.semibold }}>{sum.trails}</T> different trails{sum.favourite ? `; ${sum.favourite.name} ${sum.favourite.times} times` : ''}</T>}
          {as && <T v="small" muted>All that climbing is <T v="small" style={{ fontFamily: fonts.semibold }}>{as}</T></T>}
        </View>
      ) : (
        <T v="small" muted>No hikes {year ? `in ${year}` : 'yet'}.</T>
      )}
    </View>
  );
}

export function LogScreen({ onSettings, onAccount }: { onSettings: () => void; onAccount: () => void }) {
  const me = useValue(account);
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
      {!me && (
        <Tap onPress={onAccount} accessibilityRole="button" style={{ marginHorizontal: 16, marginBottom: 8, padding: 12, borderRadius: radius.control, backgroundColor: t.c.tint }}>
          <T v="strong">Create an account to save your hikes</T>
          <T v="small" muted>Keep them safe if you reinstall or change phones, and add photos. Optional: they stay on this phone either way.</T>
        </Tap>
      )}
      {failed && <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}><Note warn>A hike could not be written to this phone (is it full?). Share GPX files to keep them.</Note></View>}
      <FlashList
        data={list}
        keyExtractor={(w) => w.id}
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={list.length ? <Totals /> : null}
        ListEmptyComponent={<Empty title="No hikes yet" text="Hikes you record are kept here, on this phone." action={{ title: 'Go to Hike', onPress: () => { tab.value = 'hike'; } }} />}
        renderItem={({ item: w }) => (
          <Tap onPress={() => void open(w)}
            style={[{ marginHorizontal: 16, marginBottom: 10, backgroundColor: t.c.card, borderRadius: radius.card, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' }, shadow(t)]}>
            <View style={{ flex: 1 }}>
              <T v="strong" style={{ fontFamily: fonts.numSemibold, fontSize: 16.5 }} numberOfLines={1}>{w.name}</T>
              <T v="small" muted numberOfLines={1}>{fmtDate(w.started)} · {fmtDistance(w.length, u)} · {fmtClock(w.seconds)}</T>
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
  const scrub = useValue(scrubbing);
  const t = useTheme();
  const w = useValue(shownWalk)!;
  const u = useValue(units);
  const [name, setName] = useState<string | null>(null);
  const climbed = climbedSoFar(w.segments);
  const eles = w.segments.flat().map((p) => p.ele).filter((e): e is number => e != null);
  const prof = eles.length > 1 ? profileOf(eles.map((_, i) => i), eles, 5) : null;
  // the chart: height against distance walked, the same sums as the website's hike page
  const flat = useMemo(() => w.segments.flat(), [w.id]);
  const path = useMemo(() => flat.map((p) => [p.lat, p.lon] as Coord), [flat]);
  const ridge = useMemo(() => {
    const withEle = flat.filter((p) => p.ele != null);
    if (withEle.length < 10 || withEle.length < flat.length * 0.8) return null;
    const ds: number[] = [], es: number[] = [];
    let run = 0;
    flat.forEach((p, i) => {
      if (i > 0) run += distance([flat[i - 1].lat, flat[i - 1].lon], [p.lat, p.lon]);
      if (p.ele != null) { ds.push(run); es.push(p.ele); }
    });
    // phone heights jump about: smooth over five points, and ignore wiggles under 5 m
    const smooth = es.map((_, i) => { const a = es.slice(Math.max(0, i - 2), i + 3); return a.reduce((x, y) => x + y, 0) / a.length; });
    return profileOf(ds, smooth, 5);
  }, [flat]);
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
    <BottomSheetScrollView scrollEnabled={!scrub} contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, gap: 14 }} keyboardShouldPersistTaps="handled">
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
        <Stat label={`Average, ${u === 'imperial' ? 'mph' : 'km/h'}`} value={averageSpeed(w.seconds, w.length, u === 'imperial')} />
        <Stat label={`Pace, min/${u === 'imperial' ? 'mi' : 'km'}`} value={pace(w.seconds, w.length, u === 'imperial')} />
        <Stat label="On the trail" value={fmtClock((w.ended - w.started) / 1000)} />
        <Stat label="Highest" value={prof ? fmtElevation(prof.max, u) : '–'} />
        <Stat label="Spots marked" value={String(w.markers?.length ?? 0)} />
      </View>
      {ridge && path.length > 1 ? <Card><Ridge profile={ridge} path={path} height={84} units={u} /></Card> : null}
      {w.markers?.length ? <Card><T v="small">{w.markers.map((m) => m.name).join(', ')}</T></Card> : null}
      <HikePhotos walk={w} />
      <SubmissionRow walk={w} />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button icon="download" title="Share GPX" onPress={() => void exportGpx(w.name, walkGpx(w)).catch(() => say("The GPX file couldn't be shared."))} style={{ flex: 1 }} />
        <Button icon="trash" kind="danger" title="Delete" onPress={del} style={{ flex: 1 }} />
      </View>
    </BottomSheetScrollView>
  );
}

/** A kept hike's photos: taken on the way or added from the library; also ones on your account (a reinstall). */
function HikePhotos({ walk }: { walk: Walk }) {
  const mine = useValue(myPhotos).filter((p) => p.walk === walk.id);
  const me = useValue(account);
  const [remote, setRemote] = useState<RemotePhoto[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void loadMyPhotos();
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
      <PhotoGrid mine={mine} remote={remote} />
      <Button icon="camera" title={busy ? 'Adding…' : mine.length || remote.length ? 'Add more photos' : 'Add photos'} onPress={() => void add()} disabled={busy} />
      {!me && (mine.length > 0) && <T v="tiny" muted>Kept on this phone. Log in (Settings › Account) to keep them on your account too.</T>}
    </View>
  );
}
