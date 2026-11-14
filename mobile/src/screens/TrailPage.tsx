// A trail, in the sheet: its photos, name, park line, the three big numbers, the ridge card with its pins and
// the daylight line, the full loop or one of its short loops, where to start (radio rows, in step with the
// radio markers on the map), Start hike, Directions, Share GPX, Save, and "Ready offline".
import { useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { BottomSheetScrollView } from '@gorhom/bottom-sheet';
import {
  accessPoints, estimatedSeconds, facts, isUnwalked, lineCredit, needsVerification, officialFacts, routeType, shortLoops, summary,
  type Trail,
} from '@web/lib/trail';
import { fmtDistance, fmtElevation } from '@web/lib/format';
import { exportGpx } from '@web/lib/gpx';
import { sunTimes, type Stop } from '@web/lib/follow';
import { platform } from '../platform';
import {
  chosenShort, chosenStart, closeTrail, flyTo, isSaved, recState, savedTrails, say, selected, shownTrail, tab, toggleSaved, trailRest, units,
} from '../core/state';
import { start } from '../core/recorder';
import { stopsFor } from '../core/stops';
import { trailGpx } from '../core/gpx';
import { bigTime } from '../core/hikeMath';
import { split } from '../core/shape';
import { chosenTrail, loopChoices } from '../core/choice';
import { packStates, trailMapState } from '../core/offline';
import { useValue } from '../ui/hooks';
import { Big, Blazes, Button, Card, Chip, GoButton, Icon, Note, RadioRow, Segmented, T, Tap } from '../ui/kit';
import { PhotoStrip } from '../ui/Photos';
import { LightLine, Ridge } from '../ui/Ridge';
import { fonts, useTheme } from '../ui/theme';

const WEBSITE = 'https://cadewardc.github.io/switchback/';
const trailLink = (t: Trail) => `${WEBSITE}#/trail/${encodeURIComponent(t.region)}/${encodeURIComponent(t.id)}`;

/** Starts recording while following a trail's line. */
export async function follow(t: Trail, stops: Stop[]): Promise<void> {
  if (recState.peek() !== 'idle') {
    say('A hike is already being recorded. Finish it first.');
    tab.value = 'hike';
    return;
  }
  tab.value = 'hike';
  await start({ region: t.region, id: t.id, name: t.name, path: t.path, profile: t.profile, stops, loop: t.isLoop });
}

function OfflineTick({ trailKey }: { trailKey: string }) {
  const t = useTheme();
  const live = useValue(packStates)[`trail:${trailKey}`];
  const [state, setState] = useState<Awaited<ReturnType<typeof trailMapState>>>(null);
  useEffect(() => {
    let on = true;
    void trailMapState(trailKey).then((s) => { if (on) setState(s); });
    return () => { on = false; };
  }, [trailKey, live?.state]);
  const s = live ?? state;
  if (s?.state === 'ready') {
    return <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}><Icon name="check" size={16} color={t.c.green} /><T v="small" color={t.c.green} style={{ fontFamily: fonts.semibold }}>Ready offline</T></View>;
  }
  if (s?.state === 'saving') return <T v="small" muted>Saving map for offline… {s.percent}%</T>;
  return <T v="small" muted>Map not saved for offline yet</T>;
}

export function TrailSheet() {
  const t = useTheme();
  const whole = useValue(selected)!;
  const u = useValue(units);
  useValue(savedTrails);
  const short = useValue(chosenShort);
  const from = useValue(chosenStart);
  const shorts = useMemo(() => shortLoops(whole), [whole]);
  const heads = useMemo(() => accessPoints(whole), [whole]);
  const choices = useMemo(() => loopChoices(whole, shorts), [whole, shorts]);
  // the trail as chosen: a short loop or the whole, in from the chosen trailhead or on its own
  const tr = useMemo(() => chosenTrail(whole, shorts, short, heads, from), [whole, shorts, short, heads, from]);
  useEffect(() => { shownTrail.value = tr !== whole ? tr : null; }, [tr, whole]);
  useEffect(() => () => { shownTrail.value = null; }, []);
  // the map fits a newly chosen loop (opening the trail has already fitted it; choosing a start leaves the map be)
  const fitted = useRef(short);
  useEffect(() => {
    if (fitted.current !== short) { fitted.current = short; flyTo.value = { bounds: tr.bbox }; }
  }, [short, tr]);
  const pickShort = (i: number) => { if (i !== chosenShort.peek()) { platform.haptics.tap(); chosenShort.value = i; } };
  const pickStart = (i: number) => { if (i !== chosenStart.peek()) { platform.haptics.tap(); chosenStart.value = i; } };
  const [stops, setStops] = useState<Stop[]>([]);
  useEffect(() => {
    let live = true;
    setStops([]);
    void stopsFor(tr, whole, short < 0).then((x) => { if (live) setStops(x); }, () => {});
    return () => { live = false; };
  }, [tr, whole, short, from]);

  const p = tr.profile;
  const now = new Date();
  const seconds = estimatedSeconds(tr);
  const sun = sunTimes(now, tr.start);
  const saved = isSaved(whole);
  const head = heads[from] ?? null;
  const to = (head ?? heads[0])?.point ?? tr.start;
  const climbOf = (g: number | null) => (g != null && g >= 1 ? ` · ${fmtElevation(g, u)}` : '');
  const blaze = (whole.tags['switchback:blaze'] ?? '').toLowerCase().split(/[\s;,/]+/)[0];
  const unwalked = isUnwalked(whole), unverified = needsVerification(whole);
  const length = split(fmtDistance(tr.length, u)), climb = split(fmtElevation(p?.gain ?? 0, u)), time = bigTime(seconds);
  const dist = (m: number) => fmtDistance(m, u);
  const details = facts(tr, dist), official = officialFacts(tr, dist), about = summary(tr);

  const onSave = () => {
    const now2 = toggleSaved(whole);
    platform.haptics.tap();
    say(now2 ? 'Saved' : 'Removed from Saved');
  };
  const onShare = async () => { await platform.files.shareLink(whole.name, trailLink(whole)); };

  return (
    <BottomSheetScrollView contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 48, gap: 14 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Tap onPress={closeTrail} accessibilityRole="button" accessibilityLabel="Back to trails" style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 8, paddingRight: 8 }}>
          <Icon name="back" size={18} color={t.c.link} />
          <T v="strong" color={t.c.link}>Trails</T>
        </Tap>
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <Button kind="quiet" icon="link" onPress={() => void onShare()} />
          <Button kind={saved ? 'primary' : 'quiet'} icon="bookmark" onPress={onSave} />
        </View>
      </View>

      <PhotoStrip trail={whole} />

      <View style={{ gap: 4 }}>
        <T v="name">{tr.name}</T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Blazes difficulty={tr.difficulty} tags={whole.tags} row />
          <T v="small" muted style={{ flex: 1 }} numberOfLines={2}>{[tr.area, blaze ? `${blaze} blazes` : null].filter(Boolean).join(' · ') || routeType(tr)}</T>
        </View>
      </View>

      {choices.length === 2 && (
        <Segmented value={short} onChange={pickShort}
          options={choices.map((c) => ({ value: c.index, label: c.name, sub: `${dist(c.length)}${climbOf(c.gain)}` }))} />
      )}
      {choices.length > 2 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginHorizontal: -16 }} contentContainerStyle={{ paddingHorizontal: 16, gap: 8 }}
          accessibilityRole="radiogroup">
          {choices.map((c) => <Chip key={c.index} on={c.index === short} onPress={() => pickShort(c.index)} label={`${c.name} · ${dist(c.length)}${climbOf(c.gain)}`} />)}
        </ScrollView>
      )}

      <Big items={[
        { value: length.value, unit: length.unit, label: 'Distance' },
        { value: p ? climb.value : '–', unit: p ? climb.unit : '', label: 'Climb' },
        { value: time.value, unit: time.unit, label: 'Easy pace' },
      ]} />

      {(p && p.distances.length > 1) || sun ? (
        <Card onLayout={(e) => { trailRest.value = Math.round(e.nativeEvent.layout.y + e.nativeEvent.layout.height); }}>
          {p && p.distances.length > 1 ? <Ridge profile={p} path={tr.path} stops={stops} units={u} /> : null}
          <LightLine now={now} back={new Date(now.getTime() + seconds * 1000)} sunset={sun?.sunset ?? null} />
        </Card>
      ) : null}

      <GoButton title={unwalked || unverified ? 'I walked this: record it' : 'Start hike'} onPress={() => void follow(tr, stops)} />
      <OfflineTick trailKey={whole.key} />

      {unwalked && <Note warn>Not yet walked. {about ?? "This trail was placed on the map from the park's own trail list; nobody has sent in a walk of it yet."}</Note>}
      {unverified && <Note warn>Needs verification. This is probably a trail, but it has not been checked well enough to list as a hike.</Note>}

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button icon="directions" title="Directions" onPress={() => platform.links.directions(to[0], to[1])} style={{ flex: 1 }} />
        <Button icon="download" title="Share GPX" onPress={() => void exportGpx(tr.name, trailGpx(tr)).catch(() => say("The GPX file couldn't be shared."))} style={{ flex: 1 }} />
      </View>

      {p && (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {[['Descent', fmtElevation(p.loss, u)], ['Highest point', fmtElevation(p.max, u)], ['Lowest point', fmtElevation(p.min, u)]].map(([label, value]) => (
            <View key={label} style={{ flex: 1, backgroundColor: t.c.card, borderRadius: 12, padding: 10 }}>
              <T v="strong" style={{ fontFamily: fonts.num }}>{value}</T>
              <T v="tiny" muted>{label}</T>
            </View>
          ))}
        </View>
      )}

      {about && !unwalked ? <T v="body">{about}</T> : null}

      {heads.length > 0 && (
        <View style={{ gap: 8 }}>
          <T v="section">Where to start</T>
          <Card style={{ padding: 0, overflow: 'hidden' }}>
            {heads.map((h, i) => (
              <RadioRow key={`${h.name}-${i}`} first={i === 0} on={i === from} onPress={() => pickStart(i)} title={h.name}
                sub={h.distance < 15 || h.line.length < 2 ? 'On the trail' : `${dist(h.distance)} walk in`}
                right={i === from ? (
                  <Tap onPress={() => platform.links.directions(h.point[0], h.point[1])} accessibilityRole="button" accessibilityLabel={`Directions to ${h.name}`}>
                    <T v="small" color={t.c.link} style={{ fontFamily: fonts.semibold }}>Directions</T>
                  </Tap>
                ) : undefined} />
            ))}
            <RadioRow on={from < 0} onPress={() => pickStart(-1)} title="The trail on its own" sub="No walk in" />
          </Card>
          {head && head.line.length > 1 && head.distance >= 15 ? (
            <T v="tiny" muted>The distance, climb, time and ridge above include the walk in from {head.name}{whole.isLoop ? ' and back out' : ''}.</T>
          ) : null}
        </View>
      )}

      {[...official, ...details].length > 0 && (
        <View style={{ gap: 8 }}>
          <T v="section">Details</T>
          <Card style={{ gap: 10 }}>
            {[...official, ...details].map((f) => (
              <Tap key={f.title} disabled={!f.href} onPress={() => f.href && platform.links.open(f.href)}>
                <T v="tiny" muted>{f.title}</T>
                <T v="small" color={f.href ? t.c.link : undefined}>{f.value}</T>
              </Tap>
            ))}
          </Card>
        </View>
      )}

      <T v="tiny" muted>
        {lineCredit(tr)} Elevation from open terrain data. Difficulty and time are estimates worked out from length and climb: check conditions before you go.
      </T>
    </BottomSheetScrollView>
  );
}
