// The ridge: height along a trail as one filled line, the things on the way pinned to it with their
// distance, you on it in yellow while walking, and a dot that follows the pointer or finger (and shows on
// the map). The same picture before and during a hike. Works with touch and the arrow keys.
import { useEffect, useRef, useState } from 'preact/hooks';
import { heightAt, type Profile } from '../lib/trail';
import { units, chartPoint } from '../state';
import { fmtDistance, fmtElevation, type Units } from '../lib/format';
import { lineLength, pointAlong } from '../lib/geo';
import type { Coord } from '../lib/polyline';
import type { Stop } from '../lib/follow';
import { size } from '../tokens';

const PAD_X = 6, PAD_B = 18;

/** Distance as a bare number in the reader's units ("0.6"), for the pins. */
const bare = (m: number, u: Units) => {
  const v = u === 'imperial' ? m / 1609.344 : m / 1000;
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
};

export interface RidgeProps {
  profile: Profile;
  path: Coord[];
  /** The things on the way (already chosen so they do not crowd). Distances are metres along the path. */
  stops?: Stop[];
  /** Metres along the path where you are, while following the trail. */
  here?: number | null;
  /** The stop to name in yellow (the next one ahead). */
  next?: Stop | null;
  height?: number;
}

export function ElevationChart({ profile, path, stops = [], here: you = null, next = null, height }: RidgeProps) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340);
  const [at, setAt] = useState<number | null>(null); // metres along the profile
  const pathLength = useRef(0);

  useEffect(() => {
    pathLength.current = lineLength(path);
    setAt(null);
  }, [path]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)));
    ro.observe(el);
    setW(Math.max(200, el.clientWidth));
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => { chartPoint.value = null; }, []);

  const u = units.value;
  const n = profile.distances.length;
  const total = profile.distances[n - 1] || 1;
  const walking = you != null;
  // room above the line for the names: two rows when there are pins, one while walking
  const top = stops.length ? (walking ? 22 : 34) : 8;
  // (shorter when there is nothing to pin above the line)
  const H = height ?? (stops.length ? size.ridge : size.ridge - 28);
  // a flat trail should look flat: the height axis spans at least 30 m
  let lo = Math.min(...profile.elevations), hi = Math.max(...profile.elevations);
  const spare = Math.max(0, 30 - (hi - lo));
  lo -= spare / 2;
  hi += spare / 2;
  const x = (d: number) => PAD_X + (Math.max(0, Math.min(total, d)) / total) * (w - 2 * PAD_X);
  const y = (e: number) => top + (1 - (e - lo) / (hi - lo)) * (H - top - PAD_B);
  // stops are measured along the path; the profile may be a touch longer or shorter
  const scale = pathLength.current > 0 ? total / pathLength.current : 1;
  const onProfile = (alongPath: number) => alongPath * (lineLength(path) > 0 ? total / lineLength(path) : scale);
  const pts = profile.distances.map((d, i) => `${x(d).toFixed(1)},${y(profile.elevations[i]).toFixed(1)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${x(total).toFixed(1)},${H - PAD_B}L${x(0).toFixed(1)},${H - PAD_B}Z`;
  // the part already walked, drawn heavier
  const youAt = you != null ? Math.max(0, Math.min(total, onProfile(you))) : null;
  let done = '';
  if (youAt != null) {
    const d = [`${x(0).toFixed(1)},${y(profile.elevations[0]).toFixed(1)}`];
    profile.distances.forEach((dd, i) => { if (dd > 0 && dd < youAt) d.push(`${x(dd).toFixed(1)},${y(profile.elevations[i]).toFixed(1)}`); });
    d.push(`${x(youAt).toFixed(1)},${y(heightAt(profile, youAt)).toFixed(1)}`);
    done = `M${d.join('L')}`;
  }

  const show = (d: number | null) => {
    setAt(d);
    chartPoint.value = d == null ? null : pointAlong(path, (d / total) * pathLength.current);
  };
  const fromEvent = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    show(Math.max(0, Math.min(1, (e.clientX - r.left - PAD_X) / (r.width - 2 * PAD_X))) * total);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = total / 40;
    if (e.key === 'ArrowRight') show(Math.min(total, (at ?? 0) + step));
    else if (e.key === 'ArrowLeft') show(Math.max(0, (at ?? total) - step));
    else if (e.key === 'Escape') show(null);
    else return;
    e.preventDefault();
  };

  // whole-number marks along the bottom, in the reader's units
  const unit = u === 'imperial' ? 1609.344 : 1000;
  const every = total / unit > 12 ? 5 : total / unit > 6 ? 2 : 1;
  const ticks: number[] = [];
  for (let v = every; v * unit < total * 0.9; v += every) ticks.push(v);
  // names sit in two rows, alternating, and are kept inside the card
  const clampX = (cx: number, text: string) => { const half = text.length * 3.1 + 4; return Math.max(half, Math.min(w - half, cx)); };

  return (
    <div class="ridge" ref={box} tabIndex={0} role="img" style={{ height: `${H}px` }}
      aria-label={`Elevation along the trail, from ${fmtElevation(profile.min, u)} to ${fmtElevation(profile.max, u)} over ${fmtDistance(total, u)}.${stops.length ? ` On the way: ${stops.map((s) => `${s.name} at ${fmtDistance(s.along, u)}`).join(', ')}.` : ''} Use the left and right arrow keys to move along it.`}
      onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); fromEvent(e); }}
      onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) fromEvent(e); }}
      onPointerLeave={(e) => { if (e.pointerType === 'mouse') show(null); }}
      onKeyDown={onKey} onBlur={() => show(null)}>
      <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
        <path d={area} class="ridge-fill" />
        <path d={line} class={`ridge-line${walking ? ' ahead' : ''}`} />
        {done && <path d={done} class="ridge-line done" />}
        {stops.map((s, i) => {
          const d = onProfile(s.along), cx = x(d), cy = y(heightAt(profile, d));
          const isNext = !!next && next.name === s.name && next.along === s.along;
          const passed = youAt != null && d < youAt - 1;
          const row = walking ? 12 : i % 2 ? 26 : 12;
          const text = walking ? s.name : `${s.name} ${bare(s.along, u)}`;
          return (
            <g opacity={passed ? 0.45 : 1}>
              {(!walking || isNext) && <line class="ridge-drop" x1={cx} x2={cx} y1={row + 4} y2={cy - 5} />}
              <circle class={`ridge-pin${isNext ? ' next' : ''}`} cx={cx} cy={cy} r={isNext ? 5 : 4} />
              {(!walking || isNext) && <text class={`ridge-name${isNext ? ' next' : ''}`} x={clampX(cx, text)} y={row} text-anchor="middle">{text}</text>}
            </g>
          );
        })}
        <text class="ridge-tick" x={PAD_X} y={H - 3}>0</text>
        {ticks.map((v) => <text class="ridge-tick" x={x(v * unit)} y={H - 3} text-anchor="middle">{v}</text>)}
        <text class="ridge-tick" x={w - PAD_X} y={H - 3} text-anchor="end">{fmtDistance(total, u)}</text>
        {youAt != null && <circle class="ridge-you" cx={x(youAt)} cy={y(heightAt(profile, youAt))} r="7" />}
        {at != null && (
          <g>
            <line class="ridge-cross" x1={x(at)} x2={x(at)} y1={top - 4} y2={H - PAD_B} />
            <circle class="ridge-here" cx={x(at)} cy={y(heightAt(profile, at))} r="5" />
          </g>
        )}
      </svg>
      {at != null && (
        <span class="ridge-readout" aria-live="polite"><strong>{fmtElevation(heightAt(profile, at), u)}</strong> at {fmtDistance(at, u)}</span>
      )}
    </div>
  );
}

/** The daylight line: now, when you would be back, and sunset; how much light is to spare. */
export function LightLine({ now, back, sunset, started }: { now: Date; back: Date; sunset: Date | null; started?: boolean }) {
  const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).replace(/\s?[AP]M$/i, '');
  if (!sunset) return null;
  const spare = (sunset.getTime() - back.getTime()) / 60000; // minutes
  const dur = (min: number) => { const m = Math.round(Math.abs(min)); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}` : `${m} min`; };
  const dark = now.getTime() >= sunset.getTime();
  const late = spare < 0;
  // the bar runs from now to a little after sunset; the hike is the dark block at its start
  const span = Math.max(sunset.getTime() + 20 * 60000, back.getTime()) - now.getTime();
  const share = Math.max(0.04, Math.min(1, (back.getTime() - now.getTime()) / Math.max(1, span)));
  return (
    <div class="light">
      <div class="light-row">
        <span class="light-label">Light</span>
        <div class={`light-bar${late ? ' late' : ''}`}><i style={{ width: `${(share * 100).toFixed(1)}%` }} /></div>
        <span class={`light-spare${late ? ' late' : ''}`}>{dark ? 'After sunset' : late ? `${dur(spare)} after sunset` : `${dur(spare)} to spare`}</span>
      </div>
      <div class="light-foot">
        <span class={late ? 'late' : ''}>
          {late && !dark ? `You would finish in the dark: back by ${clock(back)}` : `Back by ${clock(back)}${started ? '' : ' if you start now'}`}
        </span>
        <span>Sunset {clock(sunset)}</span>
      </div>
    </div>
  );
}
