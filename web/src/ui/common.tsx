// Pieces shared by the screens.
import type { ComponentChildren, HTMLAttributes } from 'preact';
import { useMemo } from 'preact/hooks';
import { Icon } from './Icon';
import { dark, units, go, type Route } from '../state';
import { fmtDistance, fmtElevation } from '../lib/format';
import { DIFFICULTY_TITLE, type Difficulty } from '../lib/trail';
import { trailColor } from '../tokens';
import type { Coord } from '../lib/polyline';

export const dist = (m: number) => fmtDistance(m, units.value);
export const elev = (m: number) => fmtElevation(m, units.value);

/** Blaze marks: difficulty by count (one easy, two moderate, three hard; three in the hard colour for very
 *  hard), painted in the colour the park paints that trail where the trail says, green otherwise. */
export function Blazes({ difficulty, tags, inline }: { difficulty: Difficulty; tags?: Record<string, string>; inline?: boolean }) {
  const n = difficulty === 'easy' ? 1 : difficulty === 'moderate' ? 2 : 3;
  const color = trailColor(tags ?? {}, difficulty, dark.value);
  const white = color.toLowerCase() === '#ffffff';
  return (
    <span class={`blazes${inline ? ' inline' : ''}${white ? ' outlined' : ''}`} style={{ '--blaze': color }} role="img"
      aria-label={DIFFICULTY_TITLE[difficulty]} title={DIFFICULTY_TITLE[difficulty]}>
      {Array.from({ length: n }, () => <i />)}
    </span>
  );
}

/** A line fitted into a square box as an SVG path (north up, true proportions). */
export function shapePath(path: Coord[], box: number, pad: number): string {
  if (path.length < 2) return '';
  let s = 90, n = -90, w = 180, e = -180;
  for (const [lat, lon] of path) { if (lat < s) s = lat; if (lat > n) n = lat; if (lon < w) w = lon; if (lon > e) e = lon; }
  const k = Math.cos(((s + n) / 2) * Math.PI / 180);
  const width = Math.max(1e-9, (e - w) * k), height = Math.max(1e-9, n - s);
  const scale = (box - 2 * pad) / Math.max(width, height);
  const ox = (box - width * scale) / 2, oy = (box - height * scale) / 2;
  // about forty points are plenty at this size
  const step = Math.max(1, Math.floor(path.length / 40));
  const at = (c: Coord) => `${(ox + (c[1] - w) * k * scale).toFixed(1)} ${(oy + (n - c[0]) * scale).toFixed(1)}`;
  const pts: string[] = [];
  for (let i = 0; i < path.length; i += step) pts.push(at(path[i]));
  pts.push(at(path[path.length - 1]));
  return `M${pts.join('L')}`;
}

/** The trail's own shape, drawn small from its real line. */
export function TrailShape({ path }: { path: Coord[] }) {
  const d = useMemo(() => shapePath(path, 36, 3), [path]);
  return (
    <svg class="shape" viewBox="0 0 36 36" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

/** Two or three big numbers side by side. `unit` is set small after the number. */
export function Big({ items, huge }: { items: { value: string; unit?: string; label: string; late?: boolean }[]; huge?: boolean }) {
  return (
    <div class={`big3${items.length === 2 ? ' two' : ''}${huge ? ' huge' : ''}`}>
      {items.map((i) => (
        <div class={`stat-big${i.late ? ' late' : ''}`}><b>{i.value}{i.unit && <small>{i.unit}</small>}</b><span>{i.label}</span></div>
      ))}
    </div>
  );
}

/** A number and its unit apart ("3.7", "mi"), for the big numbers. */
export function split(text: string): { value: string; unit: string } {
  const m = /^([\d.,:–-]+)\s*(.*)$/.exec(text);
  return m ? { value: m[1], unit: m[2] } : { value: text, unit: '' };
}

/** The switchback mark. */
export function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true">
      <path d="M3 13h8L5 8h8L7 3h6" />
    </svg>
  );
}

/** The one solid spruce button: the switchback mark set in a lighter square on the left. */
export function GoButton({ children, onClick }: { children: ComponentChildren; onClick: () => void }) {
  return <button type="button" class="go" onClick={onClick}><span class="go-mark"><Mark /></span>{children}</button>;
}

/** A small tile: a value over what it is. */
export function Stat({ label, value }: { icon?: string; label: string; value: ComponentChildren }) {
  return (
    <div class="stat">
      <span class="stat-value">{value}</span>
      <span class="stat-label">{label}</span>
    </div>
  );
}

type ButtonProps = {
  kind?: 'primary' | 'secondary' | 'quiet' | 'danger';
  icon?: string;
  href?: string;
  wide?: boolean;
  children?: ComponentChildren;
} & Omit<HTMLAttributes<HTMLButtonElement>, 'icon'> & { disabled?: boolean; type?: string; download?: string; target?: string };

export function Button({ kind = 'secondary', icon, href, wide, children, class: cls, ...rest }: ButtonProps) {
  const className = `btn btn-${kind}${wide ? ' btn-wide' : ''}${children == null ? ' btn-icon' : ''} ${cls ?? ''}`;
  const inner = <>{icon && <Icon name={icon} size={18} />}{children != null && <span>{children}</span>}</>;
  if (href) {
    const ext = /^https?:/.test(href);
    return <a class={className} href={href} {...(ext ? { target: '_blank', rel: 'noopener' } : {})} {...(rest as any)}>{inner}</a>;
  }
  return <button type="button" class={className} {...(rest as any)}>{inner}</button>;
}

export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div class="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button type="button" role="radio" aria-checked={value === o.value} class={value === o.value ? 'on' : ''}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** The top of a screen below the first level: a way back, a title, and actions. */
export function PageHeader({ back, backLabel, title, children }: { back: Route; backLabel: string; title?: string; children?: ComponentChildren }) {
  return (
    <header class="page-header">
      <button type="button" class="btn btn-quiet back" onClick={() => go(back)}>
        <Icon name="back" size={18} /><span>{backLabel}</span>
      </button>
      {title && <h1 class="page-title-small">{title}</h1>}
      <div class="page-actions">{children}</div>
    </header>
  );
}

export function Empty({ icon, title, children }: { icon: string; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <span class="empty-icon"><Icon name={icon} size={26} /></span>
      <h2>{title}</h2>
      {children && <div class="empty-text">{children}</div>}
    </div>
  );
}

export interface RowTrail {
  region: string; id: string; name: string; length: number; gain: number; difficulty: Difficulty; loop: boolean; key?: string;
  tags?: Record<string, string>;
  /** The trail's line, for its shape. */
  path?: Coord[];
  /** A shorter loop of it: shown as a second line that opens the trail set to it. */
  short?: { id: string; length: number; gain: number }[];
}

/** One trail in a list. Data in, callbacks out: `onOpen` when chosen (with the short loop's id when that
 *  line was the one tapped), `onPoint` when a mouse is over it. */
export function TrailRow({ t, extra, onOpen, onPoint, pointed }: {
  t: RowTrail; extra?: string; onOpen?: (t: RowTrail, shortId?: string) => void; onPoint?: (key: string | null) => void; pointed?: boolean;
}) {
  const key = t.key ?? `${t.region}/${t.id}`;
  const open = onOpen ?? ((x: RowTrail) => go({ page: 'trail', region: x.region, id: x.id }));
  const line = (length: number, gain: number, what: string) => `${dist(length)}${gain >= 1 ? ` · ${elev(gain)}` : ''} · ${what}`;
  return (
    <div class={`trail-card trail-row${pointed ? ' hover' : ''}`}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') onPoint?.(key); }}
      onPointerLeave={() => onPoint?.(null)}>
      <button type="button" class="trail-open" aria-label={`${t.name}, ${DIFFICULTY_TITLE[t.difficulty]}`} onClick={() => open(t)} />
      <Blazes difficulty={t.difficulty} tags={t.tags} />
      <span class="row-main">
        <span class="row-title">{t.name}</span>
        {t.short?.length ? (
          <span class="loop-lines">
            <button type="button" class="loop-line" onClick={() => open(t)}>{line(t.length, t.gain, 'full loop')}</button>
            {t.short.map((x) => <button type="button" class="loop-line" onClick={() => open(t, x.id)}>{line(x.length, x.gain, 'short loop')}</button>)}
          </span>
        ) : (
          <span class="row-sub">
            {dist(t.length)}{t.gain >= 1 ? ` · ${elev(t.gain)}` : ''}{t.loop ? ' · Loop' : ''}{extra ? ` · ${extra}` : ''}
          </span>
        )}
      </span>
      {t.path && t.path.length > 1 && <TrailShape path={t.path} />}
    </div>
  );
}

export interface ResultGroup { title: string; total: number; trails: RowTrail[] }

/** The results, grouped. A different layout (cards, a ticket, a text index…) can take the same props. */
export function ResultsList({ groups, onOpen, onPoint, pointedKey }: {
  groups: ResultGroup[]; onOpen: (t: RowTrail, shortId?: string) => void; onPoint?: (key: string | null) => void; pointedKey?: string | null;
}) {
  return (
    <>
      {groups.map((g) => (
        <section class="group" aria-label={g.title}>
          <h2 class="group-title"><span>{g.title}</span><span class="group-count">{g.total}</span></h2>
          <ul class="list">
            {g.trails.map((t) => <li key={t.key}><TrailRow t={t} onOpen={onOpen} onPoint={onPoint} pointed={pointedKey === t.key} /></li>)}
          </ul>
        </section>
      ))}
    </>
  );
}

export function Note({ kind = 'info', children }: { kind?: 'info' | 'warn'; children: ComponentChildren }) {
  return (
    <p class={`note note-${kind}`}>
      <Icon name="info" size={18} />
      <span>{children}</span>
    </p>
  );
}
