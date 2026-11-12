// Explore, in the sheet: search, filter chips with the choice in plain words, and the hikes on the map
// grouped by park, as Waymark cards (blazes, the trail's own shape, two lines for a short loop).
import { memo, useEffect, useMemo, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { BottomSheetFlatList, BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { DIFFICULTIES, DIFFICULTY_TITLE, shortLoops, type Trail } from '@web/lib/trail';
import { fmtDistance, fmtElevation, type Units } from '@web/lib/format';
import { regionName, search, type SearchHit } from '@web/data';
import {
  climbBands, climbFilter, clearFilters, difficultyFilter, dogsOnly, filters, filterSummary, filtersOn, flyTo, hikesInView, lengthBands,
  lengthFilter, loading, loadNote, locationState, loopsOnly, openTrail, query, regions, regionsError, sheetIndex, sort, sorted, units, view,
  MIN_TRAIL_ZOOM, type ClimbBand, type LengthBand, type Sort,
} from '../core/state';
import { grouped } from '../core/hikeMath';
import { turnOnLocation } from '../core/locate';
import { useValue } from '../ui/hooks';
import { Blazes, Button, Chip, Icon, Note, T, Tap, TrailShape } from '../ui/kit';
import { fonts, radius, shadow, useTheme } from '../ui/theme';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'closest', label: 'Closest first' }, { value: 'shortest', label: 'Shortest first' }, { value: 'longest', label: 'Longest first' },
  { value: 'leastClimb', label: 'Least climb first' }, { value: 'mostClimb', label: 'Most climb first' },
];

type Row =
  | { kind: 'group'; key: string; title: string; total: number }
  | { kind: 'trail'; key: string; trail: Trail }
  | { kind: 'more'; key: string; left: number };

const PAGE = 120;

export function SearchBox() {
  const t = useTheme();
  const q = useValue(query);
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, borderRadius: radius.control, backgroundColor: t.c.card, paddingHorizontal: 12 }, shadow(t)]}>
      <Icon name="search" size={18} color={t.c.muted} />
      <BottomSheetTextInput
        value={q} onChangeText={(s) => { query.value = s; }} placeholder="Search trails and parks" placeholderTextColor={t.c.muted}
        returnKeyType="search" autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing"
        onFocus={() => { sheetIndex.value = 2; }}
        style={{ flex: 1, fontFamily: fonts.regular, fontSize: 16, color: t.c.ink, paddingVertical: 0 }}
      />
      {q ? <Tap onPress={() => { query.value = ''; }} accessibilityLabel="Clear search"><Icon name="close" size={16} color={t.c.muted} /></Tap> : null}
    </View>
  );
}

function FilterChips({ u }: { u: Units }) {
  const t = useTheme();
  const [open, setOpen] = useState<'sort' | 'length' | 'climb' | null>(null);
  const s = useValue(sort), len = useValue(lengthFilter), climb = useValue(climbFilter), loops = useValue(loopsOnly), dogs = useValue(dogsOnly);
  const diff = useValue(difficultyFilter);
  const bands = lengthBands(u), climbs = climbBands(u);
  const toggle = (d: (typeof DIFFICULTIES)[number]) => { difficultyFilter.value = diff.includes(d) ? diff.filter((x) => x !== d) : [...diff, d]; };
  const options = open === 'sort' ? SORTS.map((x) => ({ value: x.value as string, label: x.label, on: s === x.value, pick: () => { sort.value = x.value; } }))
    : open === 'length' ? (Object.keys(bands.labels) as LengthBand[]).map((b) => ({ value: b as string, label: bands.labels[b], on: len === b, pick: () => { lengthFilter.value = b; } }))
    : open === 'climb' ? (Object.keys(climbs.labels) as ClimbBand[]).map((b) => ({ value: b as string, label: climbs.labels[b], on: climb === b, pick: () => { climbFilter.value = b; } }))
    : [];
  const caret = (k: typeof open) => (open === k ? ' ▴' : ' ▾');
  return (
    <View style={{ gap: 8 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingHorizontal: 16 }} keyboardShouldPersistTaps="handled">
        <Chip label={SORTS.find((x) => x.value === s)!.label + caret('sort')} on={s !== 'closest'} onPress={() => setOpen(open === 'sort' ? null : 'sort')} />
        <Chip label={bands.labels[len] + caret('length')} on={len !== 'any'} onPress={() => setOpen(open === 'length' ? null : 'length')} />
        <Chip label="Loops" on={loops} onPress={() => { loopsOnly.value = !loops; }} />
        {DIFFICULTIES.map((d) => (
          <Chip key={d} label={DIFFICULTY_TITLE[d]} on={diff.includes(d)} onPress={() => toggle(d)} left={<Blazes difficulty={d} row />} />
        ))}
        <Chip label={climbs.labels[climb] + caret('climb')} on={climb !== 'any'} onPress={() => setOpen(open === 'climb' ? null : 'climb')} />
        <Chip label="Dogs welcome" on={dogs} onPress={() => { dogsOnly.value = !dogs; }} />
      </ScrollView>
      {open && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16 }}>
          {options.map((o) => <Chip key={o.value} label={o.label} on={o.on} onPress={() => { o.pick(); setOpen(null); }} />)}
        </View>
      )}
      <View style={{ height: 1, backgroundColor: t.c.line, marginHorizontal: 16 }} />
    </View>
  );
}

/** One trail in the list. */
export const TrailCard = memo(function TrailCard({ trail, u }: { trail: Trail; u: Units }) {
  const t = useTheme();
  const shorts = useMemo(() => shortLoops(trail), [trail]);
  const gain = trail.profile?.gain ?? 0;
  const line = (length: number, g: number, what: string) => `${fmtDistance(length, u)}${g >= 1 ? ` · ${fmtElevation(g, u)}` : ''} · ${what}`;
  return (
    <Tap onPress={() => openTrail(trail)} accessibilityRole="button" accessibilityLabel={`${trail.name}, ${DIFFICULTY_TITLE[trail.difficulty]}`}
      style={[{ marginHorizontal: 16, marginBottom: 10, backgroundColor: t.c.card, borderRadius: radius.card, padding: 14, flexDirection: 'row', alignItems: 'center', gap: 12, overflow: 'hidden' }, shadow(t)]}>
      <Blazes difficulty={trail.difficulty} tags={trail.tags} />
      <View style={{ flex: 1, gap: 4 }}>
        <T v="strong" numberOfLines={2} style={{ fontFamily: fonts.numSemibold, fontSize: 16.5 }}>{trail.name}</T>
        {shorts.length ? (
          <View style={{ gap: 6, alignItems: 'flex-start' }}>
            <Tap onPress={() => openTrail(trail)} style={{ backgroundColor: t.c.tint, borderRadius: radius.chip, paddingHorizontal: 10, paddingVertical: 3 }}>
              <T v="tiny" style={{ fontFamily: fonts.semibold }}>{line(trail.length, gain, 'full loop')}</T>
            </Tap>
            {shorts.map((x) => (
              <Tap key={x.id} onPress={() => openTrail(trail, x.id)}
                style={{ borderWidth: 1.2, borderColor: t.c.line2, borderRadius: radius.chip, paddingHorizontal: 10, paddingVertical: 2 }}>
                <T v="tiny" style={{ fontFamily: fonts.semibold }}>{line(x.length, x.profile?.gain ?? 0, 'short loop')}</T>
              </Tap>
            ))}
          </View>
        ) : (
          <T v="small" muted>{fmtDistance(trail.length, u)}{gain >= 1 ? ` · ${fmtElevation(gain, u)}` : ''}{trail.isLoop ? ' · Loop' : ''}</T>
        )}
      </View>
      {trail.path.length > 1 && <TrailShape path={trail.path} color={t.c.muted} />}
    </Tap>
  );
});

function SearchResults({ q }: { q: string }) {
  const t = useTheme();
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    let live = true;
    setHits(null);
    const timer = setTimeout(() => {
      void search(q, view.peek()?.center ?? null).then((h) => { if (live) setHits(h); }, () => { if (live) setHits([]); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);
  const pick = (h: SearchHit) => {
    if (h.trail) { query.value = ''; openTrail(h.trail); return; }
    if (h.bounds) { query.value = ''; sheetIndex.value = 1; flyTo.value = { bounds: h.bounds }; }
  };
  if (!hits) return <T v="small" muted style={{ padding: 16 }}>Searching…</T>;
  if (!hits.length) {
    return (
      <View style={{ padding: 16, gap: 6 }}>
        <T v="section">Nothing found</T>
        <T v="small" muted>Search looks through trail and park names in the regions you have looked at on the map, and region names.</T>
      </View>
    );
  }
  return (
    <BottomSheetFlatList
      data={hits} keyExtractor={(h, i) => `${h.kind}-${h.title}-${i}`} keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 40 }}
      renderItem={({ item: h }) => (
        <Tap onPress={() => pick(h)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12 }}>
          <Icon name={h.kind === 'trail' ? 'route' : h.kind === 'area' ? 'peak' : 'map'} size={18} color={t.c.green} />
          <View style={{ flex: 1 }}>
            <T v="strong" numberOfLines={1}>{h.title}</T>
            <T v="small" muted numberOfLines={1}>{h.kind === 'area' ? `Park or area · ${h.subtitle}` : h.kind === 'region' ? `Region · ${h.subtitle}` : h.subtitle || 'Trail'}</T>
          </View>
        </Tap>
      )}
    />
  );
}

function ZoomedOut() {
  const t = useTheme();
  const list = useValue(regions);
  const sortedList = useMemo(() => list.slice().sort((a, b) => (b.country ?? '').localeCompare(a.country ?? '') || regionName(a).localeCompare(regionName(b))), [list]);
  return (
    <BottomSheetFlatList
      data={sortedList} keyExtractor={(r) => r.region} numColumns={2} columnWrapperStyle={{ gap: 8, paddingHorizontal: 16 }}
      contentContainerStyle={{ gap: 8, paddingBottom: 40 }}
      ListHeaderComponent={
        <View style={{ padding: 16, gap: 4 }}>
          <T v="section">Zoom in to see trails</T>
          <T v="small" muted>Trails appear when you zoom in on the map. Pinch the map, or pick a place below.</T>
        </View>
      }
      renderItem={({ item: r }) => (
        <Tap onPress={() => { sheetIndex.value = 1; flyTo.value = { bounds: r.bbox }; }}
          style={{ flex: 1, backgroundColor: t.c.card, borderRadius: radius.control, padding: 12, flexDirection: 'row', justifyContent: 'space-between' }}>
          <T v="small" style={{ fontFamily: fonts.semibold, flex: 1 }} numberOfLines={1}>{regionName(r)}</T>
          {r.trails ? <T v="tiny" muted>{r.trails.toLocaleString()}</T> : null}
        </Tap>
      )}
    />
  );
}

export function ExploreSheet() {
  const t = useTheme();
  const u = useValue(units);
  const q = useValue(query).trim();
  const v = useValue(view);
  const hikes = useValue(hikesInView);
  const by = useValue(sort);
  const f = useValue(filters);
  const on = useValue(filtersOn);
  const busy = useValue(loading);
  const note = useValue(loadNote);
  const err = useValue(regionsError);
  const loc = useValue(locationState);
  const [shown, setShown] = useState(PAGE);
  const zoomedOut = (v?.zoom ?? 0) < MIN_TRAIL_ZOOM;
  const center = by === 'closest' ? v?.center ?? null : null;

  useEffect(() => setShown(PAGE), [hikes, by]);
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let left = shown;
    for (const g of grouped(sorted(hikes, by, center))) {
      if (left <= 0) break;
      out.push({ kind: 'group', key: `g:${g.area}`, title: g.area, total: g.trails.length });
      for (const tr of g.trails.slice(0, left)) out.push({ kind: 'trail', key: tr.key, trail: tr });
      left -= g.trails.length;
    }
    if (hikes.length > shown) out.push({ kind: 'more', key: 'more', left: hikes.length - shown });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hikes, by, center?.[0], center?.[1], shown]);

  const header = (
    <View style={{ gap: 10, paddingTop: 4, paddingBottom: 8 }}>
      <View style={{ paddingHorizontal: 16 }}><SearchBox /></View>
      {!q && !zoomedOut && <FilterChips u={u} />}
      {!q && !zoomedOut && (
        <View style={{ paddingHorizontal: 16 }}>
          <T v="small">
            <T v="small" style={{ fontFamily: fonts.semibold }}>{busy && !hikes.length ? 'Loading trails…' : `${hikes.length.toLocaleString()} ${hikes.length === 1 ? 'hike' : 'hikes'} on the map`}</T>
            <T v="small" muted>{` · ${filterSummary(f, u)}`}</T>
          </T>
          {on && <Tap onPress={clearFilters}><T v="small" color={t.c.link} style={{ fontFamily: fonts.semibold, marginTop: 4 }}>Clear filters</T></Tap>}
        </View>
      )}
      {loc === 'denied' && (
        <View style={{ paddingHorizontal: 16 }}><Button kind="quiet" icon="locate" title="Turn on location" onPress={turnOnLocation} style={{ alignSelf: 'flex-start' }} /></View>
      )}
      {err && <View style={{ paddingHorizontal: 16 }}><Note warn>{err}</Note></View>}
      {!q && !zoomedOut && note && <View style={{ paddingHorizontal: 16 }}><Note warn>{note}</Note></View>}
      {!q && !zoomedOut && !busy && !hikes.length && (
        <View style={{ paddingHorizontal: 16, gap: 4 }}>
          <T v="section">{on ? 'No hikes match' : 'No hikes here'}</T>
          <T v="small" muted>{on ? 'Nothing on this part of the map passes your filters.' : 'Move or zoom the map to look somewhere else.'}</T>
        </View>
      )}
    </View>
  );

  if (q) return <View style={{ flex: 1 }}>{header}<SearchResults q={q} /></View>;
  if (zoomedOut) return <View style={{ flex: 1 }}>{header}<ZoomedOut /></View>;
  return (
    <BottomSheetFlatList
      data={rows}
      keyExtractor={(r) => r.key}
      ListHeaderComponent={header}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      initialNumToRender={12}
      windowSize={9}
      removeClippedSubviews
      contentContainerStyle={{ paddingBottom: 40 }}
      renderItem={({ item }) => {
        if (item.kind === 'group') {
          return (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }}>
              <T v="label" muted numberOfLines={1} style={{ flex: 1 }}>{item.title}</T>
              <T v="label" muted>{item.total}</T>
            </View>
          );
        }
        if (item.kind === 'more') {
          return <Button title={`Show more (${item.left.toLocaleString()} left)`} onPress={() => setShown((n) => n + PAGE)} style={{ marginHorizontal: 16 }} />;
        }
        return <TrailCard trail={item.trail} u={u} />;
      }}
    />
  );
}
