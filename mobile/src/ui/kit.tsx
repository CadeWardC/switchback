// The pieces the screens are made of, drawn to the Waymark mock-ups (docs/design/waymark-mockups.html).
import { memo, useMemo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type TextProps, type TextStyle, type ViewProps, type ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { DIFFICULTY_TITLE, type Difficulty } from '@web/lib/trail';
import type { Coord } from '@web/lib/polyline';
import { shapePath } from '../core/shape';
import { fonts, radius, shadow, trailColor, type as ts, useTheme } from './theme';

// ── Icons (the website's, web/src/ui/Icon.tsx: a 24px grid, 1.8px strokes) ─────────────────────────────
const PATHS: Record<string, string> = {
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4.5 4.5',
  close: 'M6 6l12 12M18 6 6 18',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  directions: 'M12 2.5 21.5 12 12 21.5 2.5 12 12 2.5ZM9 14.5V12a1.5 1.5 0 0 1 1.5-1.5H15m-2-2.5 2.5 2.5L13 13',
  download: 'M12 4v11m-4.5-4 4.5 4.5L16.5 11M5 20h14',
  bookmark: 'M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1Z',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  locate: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 2v3.5M12 18.5V22M2 12h3.5M18.5 12H22',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.4-2.1.1-1.4-.1-1.4 2-1.5-2-3.4-2.3.9a7.3 7.3 0 0 0-2.4-1.4L14.3 3h-4l-.4 2.2a7.3 7.3 0 0 0-2.4 1.4l-2.3-.9-2 3.4 2 1.5-.1 1.4.1 1.4-2 1.5 2 3.4 2.3-.9c.7.6 1.5 1.1 2.4 1.4l.4 2.2h4l.4-2.2c.9-.3 1.7-.8 2.4-1.4l2.3.9 2-3.4-2-1.5Z',
  trash: 'M4 7h16M9 7V4.5h6V7m-8.5 0 1 13h9l1-13M10 11v5.5m4-5.5v5.5',
  pencil: 'M4 20l1-4L16.5 4.5l3 3L8 19l-4 1Zm10-13 3 3',
  check: 'M5 12.5 10 17.5 19.5 7',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-10v6m0-9.5v.5',
  flag: 'M5 21V4m0 1h12l-2.5 4L17 13H5',
  map: 'M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4Zm0 0v14m6-12v14',
  peak: 'M2.5 19 9 8l3.5 5.5L15 10l6.5 9h-19Z',
  route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm12-10a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM8 17h6.5a3 3 0 0 0 0-6h-5a3 3 0 0 1 0-6H16',
  loop: 'M17 3l3 3-3 3M20 6H8a4 4 0 0 0-4 4v1m3 10-3-3 3-3m-3 3h12a4 4 0 0 0 4-4v-1',
  oneway: 'M4 12h15m-5-5 5 5-5 5',
  external: 'M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
};

export const Icon = memo(function Icon({ name, size = 20, color, filled }: { name: string; size?: number; color: string; filled?: boolean }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? color : 'none'} stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d={PATHS[name] ?? ''} />
    </Svg>
  );
});

/** The switchback mark. */
export function Mark({ size = 22, color }: { size?: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M3 13h8L5 8h8L7 3h6" />
    </Svg>
  );
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────────────────
type Variant = 'body' | 'small' | 'tiny' | 'label' | 'large' | 'title' | 'name' | 'big' | 'huge' | 'strong' | 'section';

export function T({ v = 'body', muted, color, style, ...rest }: TextProps & { v?: Variant; muted?: boolean; color?: string }) {
  const t = useTheme();
  const base: TextStyle = VARIANTS[v];
  return <Text allowFontScaling maxFontSizeMultiplier={1.6} {...rest} style={[base, { color: color ?? (muted ? t.c.muted : t.c.ink) }, style]} />;
}

const VARIANTS: Record<Variant, TextStyle> = {
  body: { fontFamily: fonts.regular, fontSize: ts.body, lineHeight: ts.body * 1.4 },
  strong: { fontFamily: fonts.semibold, fontSize: ts.body, lineHeight: ts.body * 1.35 },
  small: { fontFamily: fonts.regular, fontSize: ts.small, lineHeight: ts.small * 1.4 },
  tiny: { fontFamily: fonts.regular, fontSize: ts.tiny, lineHeight: ts.tiny * 1.35 },
  label: { fontFamily: fonts.semibold, fontSize: ts.label, letterSpacing: 0.9, textTransform: 'uppercase' },
  large: { fontFamily: fonts.semibold, fontSize: ts.large, lineHeight: ts.large * 1.3 },
  section: { fontFamily: fonts.numSemibold, fontSize: ts.large, lineHeight: ts.large * 1.3 },
  title: { fontFamily: fonts.num, fontSize: ts.title, lineHeight: ts.title * 1.2 },
  name: { fontFamily: fonts.num, fontSize: ts.name, lineHeight: ts.name * 1.12, letterSpacing: -0.3 },
  big: { fontFamily: fonts.num, fontSize: ts.big, lineHeight: ts.big * 1.05, letterSpacing: -0.5 },
  huge: { fontFamily: fonts.numHeavy, fontSize: ts.huge, lineHeight: ts.huge * 1.02, letterSpacing: -1.2 },
};

// ── Blazes and the trail's shape ────────────────────────────────────────────────────────────────────────
/** Difficulty by count (one easy, two moderate, three hard or very hard), in the park's colour or green. */
export const Blazes = memo(function Blazes({ difficulty, tags, row }: { difficulty: Difficulty; tags?: Record<string, string>; row?: boolean }) {
  const t = useTheme();
  const n = difficulty === 'easy' ? 1 : difficulty === 'moderate' ? 2 : 3;
  const color = trailColor(tags ?? {}, difficulty, t.dark);
  const white = color.toLowerCase() === '#ffffff';
  return (
    <View accessibilityLabel={DIFFICULTY_TITLE[difficulty]} style={{ flexDirection: row ? 'row' : 'column', gap: 3 }}>
      {Array.from({ length: n }, (_, i) => (
        <View key={i} style={{ width: 8, height: 14, borderRadius: radius.blaze, backgroundColor: color, borderWidth: white ? 1 : 0, borderColor: t.c.line2 }} />
      ))}
    </View>
  );
});

export const TrailShape = memo(function TrailShape({ path, size = 40, color }: { path: Coord[]; size?: number; color: string }) {
  const d = useMemo(() => shapePath(path, 36, 3), [path]);
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36">
      <Path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
});

// ── Surfaces and buttons ────────────────────────────────────────────────────────────────────────────────
export function Card({ children, style, onLayout }: { children: ReactNode; style?: StyleProp<ViewStyle>; onLayout?: ViewProps['onLayout'] }) {
  const t = useTheme();
  return <View onLayout={onLayout} style={[{ backgroundColor: t.c.card, borderRadius: radius.card, padding: 14 }, shadow(t), style]}>{children}</View>;
}

/** A pressable that answers at once: a quick dim on iOS, the ripple on Android. */
export function Tap({ style, children, ...rest }: PressableProps & { style?: StyleProp<ViewStyle>; children: ReactNode }) {
  const t = useTheme();
  return (
    <Pressable
      android_ripple={{ color: t.dark ? 'rgba(255,255,255,0.12)' : 'rgba(16,32,26,0.08)', borderless: false }}
      style={({ pressed }) => [style, pressed && { opacity: 0.72 }]}
      hitSlop={4}
      {...rest}
    >
      {children}
    </Pressable>
  );
}

export function Button({ title, icon, kind = 'secondary', onPress, big, style, disabled }: {
  title?: string; icon?: string; kind?: 'primary' | 'secondary' | 'quiet' | 'danger'; onPress: () => void; big?: boolean;
  style?: StyleProp<ViewStyle>; disabled?: boolean;
}) {
  const t = useTheme();
  const bg = kind === 'primary' ? t.c.primary : kind === 'secondary' ? t.c.tint : kind === 'danger' ? t.c.hardSoft : 'transparent';
  const fg = kind === 'primary' ? t.c.onPrimary : kind === 'danger' ? t.c.hard : kind === 'quiet' ? t.c.link : t.c.ink;
  return (
    <Tap onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={title}
      style={[{
        minHeight: big ? 52 : 44, paddingHorizontal: title ? 16 : 10, borderRadius: radius.control, backgroundColor: bg,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, opacity: disabled ? 0.45 : 1, overflow: 'hidden',
      }, style]}>
      {icon && <Icon name={icon} size={18} color={fg} filled={icon === 'bookmark' && kind === 'primary'} />}
      {title != null && <T v="strong" color={fg} numberOfLines={1}>{title}</T>}
    </Tap>
  );
}

/** The one solid spruce button: the switchback mark in a lighter square on the left. */
export function GoButton({ title, onPress }: { title: string; onPress: () => void }) {
  const t = useTheme();
  return (
    <Tap onPress={onPress} accessibilityRole="button" accessibilityLabel={title}
      style={{ height: 56, borderRadius: radius.card, backgroundColor: t.c.primary, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, overflow: 'hidden' }}>
      <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: t.c.primaryLift, alignItems: 'center', justifyContent: 'center' }}>
        <Mark color={t.c.onPrimary} />
      </View>
      <T v="large" color={t.c.onPrimary} style={{ flex: 1, textAlign: 'center', marginRight: 40 }}>{title}</T>
    </Tap>
  );
}

export function Chip({ label, on, onPress, left }: { label: string; on?: boolean; onPress: () => void; left?: ReactNode }) {
  const t = useTheme();
  return (
    <Tap onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: !!on }}
      style={{
        height: 36, paddingHorizontal: 13, borderRadius: radius.chip, flexDirection: 'row', alignItems: 'center', gap: 6, overflow: 'hidden',
        backgroundColor: on ? t.c.primary : t.c.card, borderWidth: on ? 0 : StyleSheet.hairlineWidth, borderColor: t.c.line2,
      }}>
      {left}
      <T v="small" color={on ? t.c.onPrimary : t.c.ink} style={{ fontFamily: fonts.medium }}>{label}</T>
    </Tap>
  );
}

/** Two or three big numbers side by side, with a line between them. */
export function Big({ items, huge }: { items: { value: string; unit?: string; label: string; late?: boolean }[]; huge?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row' }}>
      {items.map((i, n) => (
        <View key={n} style={{ flex: 1, paddingLeft: n ? 12 : 0, borderLeftWidth: n ? 1 : 0, borderLeftColor: t.c.line2, marginLeft: n ? 12 : 0 }}>
          <Text style={{ flexDirection: 'row' }}>
            <T v={huge ? 'huge' : 'big'}>{i.value}</T>
            {i.unit ? <T v={huge ? 'title' : 'strong'} style={{ fontFamily: fonts.numSemibold }}>{huge ? ' ' : ' '}{i.unit}</T> : null}
          </Text>
          <T v="small" muted color={i.late ? t.c.dusk : undefined}>{i.label}</T>
        </View>
      ))}
    </View>
  );
}

/** A small tile: a value over what it is. */
export function Stat({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <View style={[{ flexBasis: '31%', flexGrow: 1, backgroundColor: t.c.card, borderRadius: radius.control, padding: 12, minHeight: 64 }, shadow(t)]}>
      <T v="large" style={{ fontFamily: fonts.num }}>{value}</T>
      <T v="tiny" muted>{label}</T>
    </View>
  );
}

export function Note({ children, warn }: { children: ReactNode; warn?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: radius.control, backgroundColor: warn ? t.c.duskSoft : t.c.tint }}>
      <Icon name="info" size={18} color={warn ? t.c.dusk : t.c.green} />
      <T v="small" style={{ flex: 1 }}>{children}</T>
    </View>
  );
}

export function Segmented<V extends string | number>({ value, options, onChange }: {
  value: V; options: { value: V; label: string; sub?: string }[]; onChange: (v: V) => void;
}) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', backgroundColor: t.c.tint, borderRadius: radius.control, padding: 3, gap: 3 }} accessibilityRole="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Tap key={String(o.value)} onPress={() => onChange(o.value)} accessibilityRole="radio" accessibilityState={{ selected: on }}
            style={[{ flex: 1, minHeight: o.sub ? 48 : 38, borderRadius: radius.control - 3, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, paddingVertical: 4 },
              on && { backgroundColor: t.c.card }, on && shadow(t)]}>
            <T v="small" numberOfLines={1} style={{ fontFamily: on ? fonts.semibold : fonts.medium }}>{o.label}</T>
            {o.sub ? <T v="tiny" muted numberOfLines={1}>{o.sub}</T> : null}
          </Tap>
        );
      })}
    </View>
  );
}

/** A radio row: a ring (filled with a dot when chosen), a name and a line under it. */
export function RadioRow({ on, title, sub, onPress, right, first }: {
  on: boolean; title: string; sub?: string; onPress: () => void; right?: ReactNode; first?: boolean;
}) {
  const t = useTheme();
  const mark = t.dark ? t.c.green : t.c.primary;
  return (
    <Tap onPress={onPress} accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={sub ? `${title}, ${sub}` : title}
      style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12, borderTopWidth: first ? 0 : 1, borderTopColor: t.c.line }}>
      <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: on ? 2.5 : 2, borderColor: on ? mark : t.c.line2, alignItems: 'center', justifyContent: 'center' }}>
        {on ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: mark }} /> : null}
      </View>
      <View style={{ flex: 1 }}>
        <T v="strong" numberOfLines={1}>{title}</T>
        {sub ? <T v="small" muted numberOfLines={1}>{sub}</T> : null}
      </View>
      {right}
    </Tap>
  );
}

/** The grabber: the small mountain line at the top of a sheet. */
export function Grabber() {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingTop: 8, paddingBottom: 4 }}>
      <Svg width={30} height={10} viewBox="0 0 30 10" fill="none" stroke={t.c.line2} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M2 8 9 3l6 4 6-4 7 5" />
      </Svg>
    </View>
  );
}
