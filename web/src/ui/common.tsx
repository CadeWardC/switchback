// Pieces shared by the screens.
import type { ComponentChildren, HTMLAttributes } from 'preact';
import { Icon } from './Icon';
import { units, go, hoverKey, type Route } from '../state';
import { fmtDistance, fmtElevation } from '../lib/format';
import { DIFFICULTY_TITLE, type Difficulty } from '../lib/trail';

export const dist = (m: number) => fmtDistance(m, units.value);
export const elev = (m: number) => fmtElevation(m, units.value);

export function Badge({ difficulty }: { difficulty: Difficulty }) {
  return <span class={`badge badge-${difficulty}`}>{DIFFICULTY_TITLE[difficulty]}</span>;
}

export function Stat({ icon, label, value }: { icon: string; label: string; value: ComponentChildren }) {
  return (
    <div class="stat">
      <span class="stat-icon"><Icon name={icon} size={18} /></span>
      <span class="stat-text">
        <span class="stat-value">{value}</span>
        <span class="stat-label">{label}</span>
      </span>
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

export interface RowTrail { region: string; id: string; name: string; length: number; gain: number; difficulty: Difficulty; loop: boolean; key?: string }

export function TrailRow({ t, extra }: { t: RowTrail; extra?: string }) {
  const key = t.key ?? `${t.region}/${t.id}`;
  return (
    <button type="button" class={`row trail-row${hoverKey.value === key ? ' hover' : ''}`}
      onClick={() => go({ page: 'trail', region: t.region, id: t.id })}
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') hoverKey.value = key; }}
      onPointerLeave={() => { if (hoverKey.peek() === key) hoverKey.value = null; }}>
      <span class={`dot dot-${t.difficulty}`} aria-hidden="true" />
      <span class="row-main">
        <span class="row-title">{t.name}</span>
        <span class="row-sub">
          {dist(t.length)}{t.gain >= 1 ? ` · ${elev(t.gain)} climb` : ''}{t.loop ? ' · Loop' : ''}{extra ? ` · ${extra}` : ''}
        </span>
      </span>
      <Badge difficulty={t.difficulty} />
    </button>
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
