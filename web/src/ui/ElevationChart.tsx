// Height along a line: one filled area, a crosshair that follows the pointer or finger, and the matching
// point shown on the map. Works with touch (drag across it) and the keyboard (arrow keys).
import { useEffect, useRef, useState } from 'preact/hooks';
import { heightAt, type Profile } from '../lib/trail';
import { units, chartPoint } from '../state';
import { fmtDistance, fmtElevation } from '../lib/format';
import { lineLength, pointAlong } from '../lib/geo';
import type { Coord } from '../lib/polyline';

const H = 150, PAD_L = 4, PAD_R = 4, PAD_T = 12, PAD_B = 22;

export function ElevationChart({ profile, path }: { profile: Profile; path: Coord[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(340);
  const [at, setAt] = useState<number | null>(null); // metres along
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

  const n = profile.distances.length;
  const total = profile.distances[n - 1] || 1;
  const u = units.value;
  // a flat trail should look flat: the height axis spans at least 30 m
  let lo = Math.min(...profile.elevations), hi = Math.max(...profile.elevations);
  const spare = Math.max(0, 30 - (hi - lo));
  lo -= spare / 2;
  hi += spare / 2;
  const x = (d: number) => PAD_L + (d / total) * (w - PAD_L - PAD_R);
  const y = (e: number) => PAD_T + (1 - (e - lo) / (hi - lo)) * (H - PAD_T - PAD_B);
  const pts = profile.distances.map((d, i) => `${x(d).toFixed(1)},${y(profile.elevations[i]).toFixed(1)}`);
  const line = `M${pts.join('L')}`;
  const area = `${line}L${x(total).toFixed(1)},${H - PAD_B}L${x(0).toFixed(1)},${H - PAD_B}Z`;

  const show = (d: number | null) => {
    setAt(d);
    chartPoint.value = d == null ? null : pointAlong(path, (d / total) * pathLength.current);
  };
  const fromEvent = (e: PointerEvent) => {
    const r = box.current!.getBoundingClientRect();
    const t = (e.clientX - r.left - PAD_L) / (r.width - PAD_L - PAD_R);
    show(Math.max(0, Math.min(1, t)) * total);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = total / 40;
    if (e.key === 'ArrowRight') show(Math.min(total, (at ?? 0) + step));
    else if (e.key === 'ArrowLeft') show(Math.max(0, (at ?? total) - step));
    else if (e.key === 'Escape') show(null);
    else return;
    e.preventDefault();
  };

  const here = at == null ? null : heightAt(profile, at);
  const highAt = profile.distances[profile.elevations.indexOf(Math.max(...profile.elevations))];
  return (
    <figure class="chart">
      <figcaption class="chart-head">
        <span class="chart-title">Elevation</span>
        <span class="chart-readout" aria-live="polite">
          {at == null
            ? `${fmtElevation(profile.min, u)} to ${fmtElevation(profile.max, u)}`
            : <><strong>{fmtElevation(here!, u)}</strong> at {fmtDistance(at, u)}</>}
        </span>
      </figcaption>
      <div class="chart-box" ref={box} tabIndex={0} role="img"
        aria-label={`Elevation along the trail, from ${fmtElevation(profile.min, u)} to ${fmtElevation(profile.max, u)} over ${fmtDistance(total, u)}. Use the left and right arrow keys to move along it.`}
        onPointerDown={(e) => { (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId); fromEvent(e); }}
        onPointerMove={(e) => { if (e.pointerType === 'mouse' || e.buttons || e.pressure > 0) fromEvent(e); }}
        onPointerLeave={(e) => { if (e.pointerType === 'mouse') show(null); }}
        onKeyDown={onKey} onBlur={() => show(null)}>
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
          <defs>
            <linearGradient id="chart-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stop-color="var(--c-primary-text)" stop-opacity="0.32" />
              <stop offset="1" stop-color="var(--c-primary-text)" stop-opacity="0.04" />
            </linearGradient>
          </defs>
          <line class="chart-grid" x1={PAD_L} x2={w - PAD_R} y1={y(Math.max(...profile.elevations))} y2={y(Math.max(...profile.elevations))} />
          <line class="chart-axis" x1={PAD_L} x2={w - PAD_R} y1={H - PAD_B} y2={H - PAD_B} />
          <path d={area} fill="url(#chart-fill)" />
          <path d={line} class="chart-line" />
          {at == null && n > 2 && (
            <circle class="chart-dot" cx={x(highAt)} cy={y(Math.max(...profile.elevations))} r="3.5" />
          )}
          <text class="chart-label" x={PAD_L} y={H - 6}>{fmtDistance(0, u).replace(/^0 \w+$/, '0')}</text>
          <text class="chart-label" x={w - PAD_R} y={H - 6} text-anchor="end">{fmtDistance(total, u)}</text>
          {at != null && (
            <g>
              <line class="chart-cross" x1={x(at)} x2={x(at)} y1={PAD_T - 6} y2={H - PAD_B} />
              <circle class="chart-here" cx={x(at)} cy={y(here!)} r="5.5" />
            </g>
          )}
        </svg>
      </div>
    </figure>
  );
}
