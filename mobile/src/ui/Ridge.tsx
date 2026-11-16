// The ridge: height along a trail as one filled line, the things on the way pinned to it, you on it in yellow
// while walking. Drawn with react-native-svg from the same sums as web/src/ui/ElevationChart.tsx. Drag a finger
// along it to read the height and distance there; the same spot is shown on the map (chartPoint).
// Plus the daylight line: now, when you would be back, and sunset.
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import Svg, { Circle, G, Line, Path, Text as SvgText } from 'react-native-svg';
import { heightAt, type Profile } from '@web/lib/trail';
import { lineLength, pointAlong } from '@web/lib/geo';
import type { Coord } from '@web/lib/polyline';
import type { Stop } from '@web/lib/follow';
import { fmtDistance, fmtElevation, type Units } from '@web/lib/format';
import { chartPoint } from '../core/state';
import { platform } from '../platform';
import { clock, daylight, dur } from '../core/hikeMath';
import { T } from './kit';
import { fonts, mapColors, radius, size, useTheme } from './theme';

const PAD_X = 6, PAD_B = 18;

const bare = (m: number, u: Units) => {
  const v = u === 'imperial' ? m / 1609.344 : m / 1000;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
};

export const Ridge = memo(function Ridge({ profile, path, stops = [], here = null, next = null, height, units: u }: {
  profile: Profile; path: Coord[]; stops?: Stop[]; here?: number | null; next?: Stop | null; height?: number; units: Units;
}) {
  const t = useTheme();
  const [w, setW] = useState(320);
  const walking = here != null;
  const top = stops.length ? (walking ? 22 : 34) : 8;
  const H = height ?? (stops.length ? size.ridge : size.ridge - 28);
  const pathLen = useMemo(() => lineLength(path), [path]);
  const [at, setAt] = useState<number | null>(null); // metres along the profile, while scrubbing
  const lastTick = useRef(-1);
  useEffect(() => { setAt(null); chartPoint.value = null; }, [path]);
  useEffect(() => () => { chartPoint.value = null; }, []);

  const drawn = useMemo(() => {
    const n = profile.distances.length;
    const total = profile.distances[n - 1] || 1;
    let lo = Math.min(...profile.elevations), hi = Math.max(...profile.elevations);
    const spare = Math.max(0, 30 - (hi - lo));
    lo -= spare / 2;
    hi += spare / 2;
    const x = (d: number) => PAD_X + (Math.max(0, Math.min(total, d)) / total) * (w - 2 * PAD_X);
    const y = (e: number) => top + (1 - (e - lo) / (hi - lo)) * (H - top - PAD_B);
    const onProfile = (alongPath: number) => alongPath * (pathLen > 0 ? total / pathLen : 1);
    const pts = profile.distances.map((d, i) => `${x(d).toFixed(1)},${y(profile.elevations[i]).toFixed(1)}`);
    const line = `M${pts.join('L')}`;
    const area = `${line}L${x(total).toFixed(1)},${H - PAD_B}L${x(0).toFixed(1)},${H - PAD_B}Z`;
    const unit = u === 'imperial' ? 1609.344 : 1000;
    const every = total / unit > 12 ? 5 : total / unit > 6 ? 2 : 1;
    const ticks: number[] = [];
    for (let v = every; v * unit < total * 0.9; v += every) ticks.push(v);
    return { total, x, y, onProfile, line, area, ticks, unit };
  }, [profile, w, H, top, pathLen, u]);

  const { total, x, y, onProfile, line, area, ticks, unit } = drawn;
  const youAt = here != null ? Math.max(0, Math.min(total, onProfile(here))) : null;
  let done = '';
  if (youAt != null) {
    const d = [`${x(0).toFixed(1)},${y(profile.elevations[0]).toFixed(1)}`];
    profile.distances.forEach((dd, i) => { if (dd > 0 && dd < youAt) d.push(`${x(dd).toFixed(1)},${y(profile.elevations[i]).toFixed(1)}`); });
    d.push(`${x(youAt).toFixed(1)},${y(heightAt(profile, youAt)).toFixed(1)}`);
    done = `M${d.join('L')}`;
  }
  const show = (d: number | null) => {
    setAt(d);
    chartPoint.value = d == null || pathLen <= 0 ? null : pointAlong(path, (d / total) * pathLen);
  };
  const fromX = (px: number) => {
    const d = Math.max(0, Math.min(1, (px - PAD_X) / (w - 2 * PAD_X))) * total;
    // a light tick each tenth of the way, so the finger feels where it is
    const tenth = Math.floor((d / total) * 10);
    if (tenth !== lastTick.current) { lastTick.current = tenth; platform.haptics.tap(); }
    show(d);
  };
  const clampX = (cx: number, text: string) => { const half = text.length * 3.1 + 4; return Math.max(half, Math.min(w - half, cx)); };
  const fill = t.dark ? 'rgba(79,197,136,0.16)' : 'rgba(35,148,90,0.14)';

  return (
    <View style={{ height: H }} onLayout={(e) => setW(Math.max(200, Math.round(e.nativeEvent.layout.width)))}
      accessibilityLabel={`Elevation along the trail over ${fmtDistance(total, u)}. Drag along it to see a point on the map.`}
      accessibilityRole="adjustable"
      accessibilityValue={at != null ? { text: `${fmtElevation(heightAt(profile, at), u)} at ${fmtDistance(at, u)}` } : undefined}
      onAccessibilityAction={(e) => {
        const step = total / 20;
        if (e.nativeEvent.actionName === 'increment') show(Math.min(total, (at ?? 0) + step));
        else if (e.nativeEvent.actionName === 'decrement') show(Math.max(0, (at ?? total) - step));
      }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      // the chart keeps the finger once it has it, so a sideways drag isn't taken by the sheet's scrolling
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => { lastTick.current = -1; fromX(e.nativeEvent.locationX); }}
      onResponderMove={(e) => fromX(e.nativeEvent.locationX)}>
      <Svg width={w} height={H}>
        <Path d={area} fill={fill} />
        <Path d={line} fill="none" stroke={walking ? t.c.line2 : t.c.green} strokeWidth={2} strokeLinejoin="round" />
        {done ? <Path d={done} fill="none" stroke={t.c.green} strokeWidth={2.6} strokeLinejoin="round" strokeLinecap="round" /> : null}
        {stops.map((s, i) => {
          const d = onProfile(s.along), cx = x(d), cy = y(heightAt(profile, d));
          const isNext = !!next && next.name === s.name && next.along === s.along;
          const passed = youAt != null && d < youAt - 1;
          const row = walking ? 12 : i % 2 ? 26 : 12;
          const text = walking ? s.name : `${s.name} ${bare(s.along, u)}`;
          const showName = !walking || isNext;
          return (
            <G key={`${s.name}-${i}`} opacity={passed ? 0.45 : 1}>
              {showName && <Line x1={cx} x2={cx} y1={row + 4} y2={cy - 5} stroke={t.c.line2} strokeWidth={1} strokeDasharray="2,2" />}
              <Circle cx={cx} cy={cy} r={isNext ? 5 : 4} fill={isNext ? mapColors.me : t.c.card} stroke={isNext ? mapColors.meRing : t.c.green} strokeWidth={2} />
              {showName && (
                <SvgText x={clampX(cx, text)} y={row} fontSize={10.5} fontFamily={fonts.semibold} fill={t.c.ink} textAnchor="middle">{text}</SvgText>
              )}
            </G>
          );
        })}
        <SvgText x={PAD_X} y={H - 3} fontSize={10} fontFamily={fonts.regular} fill={t.c.muted}>0</SvgText>
        {ticks.map((v) => <SvgText key={v} x={x(v * unit)} y={H - 3} fontSize={10} fontFamily={fonts.regular} fill={t.c.muted} textAnchor="middle">{String(v)}</SvgText>)}
        <SvgText x={w - PAD_X} y={H - 3} fontSize={10} fontFamily={fonts.regular} fill={t.c.muted} textAnchor="end">{fmtDistance(total, u)}</SvgText>
        {youAt != null && <Circle cx={x(youAt)} cy={y(heightAt(profile, youAt))} r={7} fill={mapColors.me} stroke={mapColors.meRing} strokeWidth={2} />}
        {at != null && (
          <G>
            <Line x1={x(at)} x2={x(at)} y1={top - 4} y2={H - PAD_B} stroke={t.c.muted} strokeWidth={1} />
            <Circle cx={x(at)} cy={y(heightAt(profile, at))} r={5} fill={t.c.card} stroke={t.c.ink} strokeWidth={2} />
          </G>
        )}
      </Svg>
      {at != null && (
        <View pointerEvents="none" style={{ position: 'absolute', right: 0, top: -4, backgroundColor: t.c.card, paddingLeft: 6 }}>
          <T v="tiny" muted><T v="tiny" style={{ fontFamily: fonts.semibold }}>{fmtElevation(heightAt(profile, at), u)}</T> at {fmtDistance(at, u)}</T>
        </View>
      )}
    </View>
  );
});

/** The daylight line: the hike as a block from now, how much light is to spare, back by and sunset. */
export function LightLine({ now, back, sunset, started }: { now: Date; back: Date; sunset: Date | null; started?: boolean }) {
  const t = useTheme();
  const d = daylight(now, back, sunset);
  if (!d || !sunset) return null;
  const tone = d.late ? t.c.dusk : t.c.ink;
  return (
    <View style={{ gap: 6, marginTop: 8 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <T v="label" muted>Light</T>
        <View style={{ flex: 1, height: 10, borderRadius: radius.chip, backgroundColor: t.c.tint, overflow: 'hidden', flexDirection: 'row' }}>
          <View style={{ width: `${(d.share * 100).toFixed(1)}%` as `${number}%`, backgroundColor: d.late ? t.c.dusk : t.c.primary, borderRadius: radius.chip }} />
          <View style={{ flex: 1 }} />
          <View style={{ width: '22%', backgroundColor: t.c.dusk, opacity: 0.55 }} />
        </View>
        <T v="small" color={tone} style={{ fontFamily: fonts.semibold }}>
          {d.dark ? 'After sunset' : d.late ? `${dur(d.spareMin)} after sunset` : `${dur(d.spareMin)} to spare`}
        </T>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T v="tiny" muted color={d.late && !d.dark ? t.c.dusk : undefined}>
          {d.late && !d.dark ? `You would finish in the dark: back by ${clock(back)}` : `Back by ${clock(back)}${started ? '' : ' if you start now'}`}
        </T>
        <T v="tiny" muted>Sunset {clock(sunset)}</T>
      </View>
    </View>
  );
}
