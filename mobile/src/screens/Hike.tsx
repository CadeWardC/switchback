// Hike: where a hike is recorded. While walking it is one card (the ridge with you on it in yellow and the
// next thing named, two big numbers, one quiet line); pulled up, the six tiles, coordinates with Share and
// GPS accuracy, then Pause, Mark a spot and Finish (Finish asks once). Off the trail, the card turns yellow.
import { useEffect, useMemo, useState } from 'react';
import { TextInput, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { fmtClock, fmtDistance, fmtDuration, fmtElevation } from '@web/lib/format';
import { climbLeft, nextStop, progressOn, secondsLeft, sunTimes } from '@web/lib/follow';
import { MAX_ACCURACY } from '@web/lib/track';
import { platform } from '../platform';
import {
  endReached, following, flyTo, myLocation, offTrail, offTrailInfo, recAccuracy, recError, recLength, recMarkers, recSeconds, recSegments,
  recStarted, recState, say, units, walks, tab,
} from '../core/state';
import { discard, dropMarker, finish, headBack, keepGoing, pause, resume, showFinished, start, stopFollowing } from '../core/recorder';
import { climbedSoFar, clock, hm, pace } from '../core/hikeMath';
import { split } from '../core/shape';
import { useValue } from '../ui/hooks';
import { Big, Button, Card, GoButton, Note, Stat, T, Tap } from '../ui/kit';
import { LightLine, Ridge } from '../ui/Ridge';
import { fonts, mapColors, radius, useTheme } from '../ui/theme';

function Coordinates() {
  const me = useValue(myLocation);
  const u = useValue(units);
  if (!me) return null;
  const share = () => {
    const text = `My location: ${me.at[0].toFixed(5)}, ${me.at[1].toFixed(5)} (within about ${fmtDistance(me.accuracy, u)}${me.ele != null ? `, elevation ${fmtElevation(me.ele, u)}` : ''}). `
      + `https://www.google.com/maps?q=${me.at[0].toFixed(5)},${me.at[1].toFixed(5)}`;
    void platform.files.shareText(text);
  };
  return (
    <Card style={{ flexDirection: 'row', alignItems: 'center' }}>
      <View style={{ flex: 1 }}>
        <T v="strong" style={{ fontFamily: fonts.num }} selectable>{`${me.at[0].toFixed(4)}, ${me.at[1].toFixed(4)}`}</T>
        <T v="tiny" muted>You are here · good to {fmtDistance(me.accuracy, u)}</T>
      </View>
      <Button kind="quiet" title="Share" onPress={share} />
    </Card>
  );
}

function EndCard({ onFinish }: { onFinish: () => void }) {
  const t = useTheme();
  const at = useValue(endReached);
  const u = useValue(units);
  const len = useValue(recLength), secs = useValue(recSeconds);
  return (
    <View style={{ gap: 12, paddingVertical: 8 }} accessibilityRole="alert">
      <T v="name" style={{ fontSize: 26 }}>{at === 'start' ? 'You are back at the trailhead' : 'You have reached the end of the trail'}</T>
      <T v="body" muted>{fmtDistance(len, u)} in {fmtDuration(secs)}. Finish this hike?</T>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button big title="Keep going" onPress={keepGoing} style={{ flex: 1 }} />
        <Button big kind="primary" title="Finish hike" onPress={onFinish} style={{ flex: 1 }} />
      </View>
      <View style={{ height: 1, backgroundColor: t.c.line }} />
    </View>
  );
}

function Idle() {
  const err = useValue(recError);
  const list = useValue(walks);
  return (
    <BottomSheetScrollView contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 48 }}>
      <T v="name">Hike</T>
      <T v="body" muted>Open a trail and press Start hike to follow it: how far is left, when you will be back, and a nudge if you leave it. Or record where you walk:</T>
      <GoButton title="Start recording" onPress={() => void start()} />
      {err && <Note warn>{err}</Note>}
      <Coordinates />
      <Note>Recording carries on with the screen off and the phone in your pocket. It needs no signal: GPS works anywhere under open sky.</Note>
      {list.length > 0 && <Button kind="quiet" title={`Your log: ${list.length} ${list.length === 1 ? 'hike' : 'hikes'}`} onPress={() => { tab.value = 'log'; }} />}
    </BottomSheetScrollView>
  );
}

export function HikeSheet() {
  const state = useValue(recState);
  return state === 'idle' ? <Idle /> : <Walking />;
}

function Walking() {
  const t = useTheme();
  const state = useValue(recState);
  const u = useValue(units);
  const imperial = u === 'imperial';
  const f = useValue(following);
  const segs = useValue(recSegments);
  const len = useValue(recLength);
  const secs = useValue(recSeconds);
  const startedAt = useValue(recStarted);
  const acc = useValue(recAccuracy);
  const err = useValue(recError);
  const markers = useValue(recMarkers);
  const ended = useValue(endReached);
  const off = useValue(offTrail) ? offTrailInfo.value : null;
  useValue(offTrailInfo);
  const me = useValue(myLocation);
  const [asking, setAsking] = useState<'finish' | 'discard' | null>(null);
  const [marking, setMarking] = useState(false);
  const [markName, setMarkName] = useState('');

  const lastSeg = segs[segs.length - 1];
  const newest = lastSeg && lastSeg.length ? lastSeg[lastSeg.length - 1] : null;
  // keep the newest point on screen while recording (zoomed in once; after that the zoom is yours)
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    if (state !== 'recording' || !newest) return;
    flyTo.value = { center: [newest.lat, newest.lon], ...(zoomed ? {} : { zoom: 15.5 }) };
    if (!zoomed) setZoomed(true);
  }, [state, newest?.t]);

  const total = useMemo(() => (f ? progressOn(f.path, f.path[0]).total : 0), [f]);
  const [along, setAlong] = useState<number | null>(null);
  useEffect(() => setAlong(null), [f]);
  useEffect(() => {
    if (f && newest && !offTrail.peek()) setAlong((was) => progressOn(f.path, [newest.lat, newest.lon], was ?? -Infinity).along);
  }, [newest?.t, f]);

  const done = async () => {
    setAsking(null);
    await showFinished(await finish());
  };

  const left = Math.max(0, total - (along ?? 0));
  const profileTotal = f?.profile ? f.profile.distances[f.profile.distances.length - 1] ?? 0 : 0;
  const onChart = f?.profile && total > 0 ? ((along ?? 0) / total) * profileTotal : 0;
  const climbAhead = f?.profile ? climbLeft(f.profile, onChart) : 0;
  const now = new Date();
  const back = new Date(now.getTime() + secondsLeft(left, climbAhead, len, secs) * 1000);
  const place = newest ? [newest.lat, newest.lon] as [number, number] : f ? f.path[0] : me?.at ?? null;
  const sun = place ? sunTimes(now, place) : null;
  const late = !!f && !!sun && back > sun.sunset;
  const next = f?.stops && along != null ? nextStop(f.stops, along) : f?.stops?.[0] ?? null;
  const climbed = f?.profile ? Math.max(0, f.profile.gain - climbAhead) : climbedSoFar(segs);
  const onTrail = startedAt ? (Date.now() - startedAt) / 1000 : secs;
  const leftText = split(fmtDistance(left, u)), walkedText = split(fmtDistance(len, u));
  const spare = sun ? (sun.sunset.getTime() - (f ? back.getTime() : now.getTime())) / 60000 : null;
  const height = me?.ele ?? newest?.ele ?? null;

  return (
    <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, gap: 12 }} keyboardShouldPersistTaps="handled">
      {ended && <EndCard onFinish={() => void done()} />}

      {off && (
        <View style={{ backgroundColor: mapColors.me, borderRadius: radius.card, padding: 16, gap: 4 }} accessibilityRole="alert">
          <T v="label" color={t.c.onYouMuted}>Off the trail</T>
          <T v="big" color={t.c.onYou}>{fmtDistance(off.metres, u)} <T v="large" color={t.c.onYou}>{off.way}</T></T>
          <T v="small" color={t.c.onYou}>Follow the dots back. Your own track is saved if you need to retrace it.</T>
        </View>
      )}

      {f?.profile && f.profile.distances.length > 1 && !ended ? (
        <View>
          {next && <T v="small" style={{ fontFamily: fonts.semibold }}>{next.name} <T v="small" muted>in {fmtDistance(Math.max(0, next.along - (along ?? 0)), u)}</T></T>}
          <Ridge profile={f.profile} path={f.path} stops={f.stops ?? []} here={along ?? 0} next={next} height={next || f.stops?.length ? 92 : 78} units={u} />
        </View>
      ) : null}

      {f ? (
        <Big huge items={[
          { value: leftText.value, unit: leftText.unit, label: 'left' },
          { value: clock(back), label: late ? 'back by, after sunset' : 'back by', late },
        ]} />
      ) : (
        <Big huge items={[
          { value: walkedText.value, unit: walkedText.unit, label: 'walked' },
          { value: fmtClock(secs), label: state === 'paused' ? 'paused' : 'moving' },
        ]} />
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14, rowGap: 2, paddingTop: 6, borderTopWidth: 1, borderTopColor: t.c.line }}>
        <T v="small" muted><T v="small" style={{ fontFamily: fonts.semibold }}>{fmtClock(onTrail)}</T> on the trail</T>
        {f && <T v="small" muted><T v="small" style={{ fontFamily: fonts.semibold }}>{fmtDistance(len, u)}</T> walked</T>}
        {climbed != null && <T v="small" muted><T v="small" style={{ fontFamily: fonts.semibold }}>{fmtElevation(climbed, u)}</T> climbed</T>}
      </View>

      {err && (
        <Note warn>
          {err}{/allowed/.test(err) ? ' ' : ''}
          {/allowed/.test(err) ? <T v="small" color={t.c.link} onPress={() => platform.links.openSettings()}>Open Settings</T> : null}
        </Note>
      )}
      {state === 'paused' && !err && <Note>Paused. Nothing is being recorded until you resume.</Note>}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Stat label="Moving" value={fmtClock(secs)} />
        <Stat label={`Pace, min/${imperial ? 'mi' : 'km'}`} value={pace(secs, len, imperial)} />
        {f?.profile ? <Stat label="Climb left" value={fmtElevation(climbAhead, u)} /> : <Stat label="Walked" value={fmtDistance(len, u)} />}
        <Stat label="Sunset" value={sun ? clock(sun.sunset) : '–'} />
        <Stat label={spare != null && spare < 0 ? 'After sunset' : 'Light to spare'} value={spare != null ? hm(Math.abs(spare)) : '–'} />
        <Stat label="Height now" value={height != null ? fmtElevation(height, u) : '–'} />
      </View>
      {f && sun ? <Card><LightLine now={now} back={back} sunset={sun.sunset} started /></Card> : null}

      <Coordinates />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: state !== 'recording' || acc == null ? t.c.line2 : acc <= 15 ? t.c.green : acc <= MAX_ACCURACY ? mapColors.me : t.c.hard }} />
        <T v="tiny" muted>
          {state !== 'recording' ? 'Not recording' : acc == null ? 'Finding your position…'
            : acc <= MAX_ACCURACY ? `GPS good to about ${fmtDistance(acc, u)}` : `GPS is too rough right now (about ${fmtDistance(acc, u)}), so these points are left out`}
        </T>
      </View>

      {marking ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <TextInput value={markName} onChangeText={setMarkName} maxLength={60} placeholder="Name it: spring, junction, view" placeholderTextColor={t.c.muted}
            autoFocus returnKeyType="done"
            onSubmitEditing={() => { say(dropMarker(markName) ? 'Marked' : 'No position yet, so nothing was marked.'); setMarking(false); setMarkName(''); }}
            style={{ flex: 1, height: 46, borderRadius: radius.control, backgroundColor: t.c.card, paddingHorizontal: 12, color: t.c.ink, fontFamily: fonts.regular, fontSize: 16 }} />
          <Button kind="primary" title="Mark" onPress={() => { say(dropMarker(markName) ? 'Marked' : 'No position yet, so nothing was marked.'); setMarking(false); setMarkName(''); }} />
          <Button kind="quiet" icon="close" onPress={() => setMarking(false)} />
        </View>
      ) : asking === 'finish' ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <T v="strong" style={{ flex: 1 }}>Finish this hike?</T>
          <Button title="Not yet" onPress={() => setAsking(null)} />
          <Button kind="primary" title="Finish" onPress={() => void done()} />
        </View>
      ) : (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {state === 'recording'
            ? <Button big title="Pause" onPress={() => void pause()} style={{ flex: 1 }} />
            : <Button big title="Resume" onPress={() => void resume()} style={{ flex: 1 }} />}
          <Button big title="Mark a spot" onPress={() => setMarking(true)} style={{ flex: 1.2 }} />
          <Button big kind="primary" title="Finish" onPress={() => { platform.haptics.tap(); setAsking('finish'); }} style={{ flex: 1 }} />
        </View>
      )}
      {markers.length > 0 && <T v="small" muted>{markers.length} {markers.length === 1 ? 'spot' : 'spots'} marked: {markers.map((m) => m.name).join(', ')}</T>}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 16 }}>
        {segs.some((s) => s.length > 1) && (!f || !!f.id) && (
          <Tap onPress={() => { if (headBack()) say('Following your own track back to the start'); }}><T v="small" color={t.c.link}>Head back the way you came</T></Tap>
        )}
        {f && <Tap onPress={stopFollowing}><T v="small" color={t.c.link}>Stop following</T></Tap>}
        {state === 'paused' && asking !== 'discard' && <Tap onPress={() => setAsking('discard')}><T v="small" color={t.c.hard}>Discard this hike</T></Tap>}
      </View>
      {asking === 'discard' && (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <T v="strong" style={{ flex: 1 }}>Throw this hike away?</T>
          <Button title="Keep" onPress={() => setAsking(null)} />
          <Button kind="danger" title="Discard" onPress={() => { void discard(); setAsking(null); }} />
        </View>
      )}
    </BottomSheetScrollView>
  );
}
