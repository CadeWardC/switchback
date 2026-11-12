// Explore: search, then the hikes on the map grouped by area, with sorting and filters.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useComputed } from '@preact/signals';
import {
  difficultyFilter, filtersOn, flyTo, go, hikesInView, lengthBands, lengthFilter, loading, loadNote, loopsOnly, MIN_TRAIL_ZOOM, query,
  regions, regionsError, sheet, sort, units, view, type LengthBand, type Sort,
} from '../state';
import { DIFFICULTIES, DIFFICULTY_TITLE, type Trail } from '../lib/trail';
import { regionName, search, type SearchHit } from '../data';
import { Icon } from './Icon';
import { Empty, Note, TrailRow, Button } from './common';
import { isPhone } from '../layout';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'closest', label: 'Closest' },
  { value: 'shortest', label: 'Shortest' },
  { value: 'longest', label: 'Longest' },
  { value: 'leastClimb', label: 'Least climb' },
  { value: 'mostClimb', label: 'Most climb' },
];

const PAGE = 120;

function Filters() {
  const bands = lengthBands(units.value);
  const toggle = (d: (typeof DIFFICULTIES)[number]) => {
    const now = difficultyFilter.value;
    difficultyFilter.value = now.includes(d) ? now.filter((x) => x !== d) : [...now, d];
  };
  return (
    <div class="filters">
      <div class="filter-row">
        <label class="select">
          <span class="visually-hidden">Sort by</span>
          <select value={sort.value} onChange={(e) => (sort.value = (e.currentTarget as HTMLSelectElement).value as Sort)}>
            {SORTS.map((s) => <option value={s.value}>{s.label} first</option>)}
          </select>
        </label>
        <label class="select">
          <span class="visually-hidden">Length</span>
          <select value={lengthFilter.value} onChange={(e) => (lengthFilter.value = (e.currentTarget as HTMLSelectElement).value as LengthBand)}>
            {(Object.keys(bands.labels) as LengthBand[]).map((b) => <option value={b}>{bands.labels[b]}</option>)}
          </select>
        </label>
      </div>
      <div class="chips" role="group" aria-label="Show only">
        {DIFFICULTIES.map((d) => (
          <button type="button" class={`chip chip-${d}`} aria-pressed={difficultyFilter.value.includes(d)} onClick={() => toggle(d)}>
            <span class={`dot dot-${d}`} aria-hidden="true" />{DIFFICULTY_TITLE[d]}
          </button>
        ))}
        <button type="button" class="chip" aria-pressed={loopsOnly.value} onClick={() => (loopsOnly.value = !loopsOnly.value)}>
          <Icon name="loop" size={15} />Loops
        </button>
      </div>
    </div>
  );
}

function sorted(trails: Trail[], by: Sort, center: [number, number] | null): Trail[] {
  const out = trails.slice();
  const climb = (t: Trail) => t.profile?.gain ?? 0;
  if (by === 'shortest') out.sort((a, b) => a.length - b.length);
  else if (by === 'longest') out.sort((a, b) => b.length - a.length);
  else if (by === 'leastClimb') out.sort((a, b) => climb(a) - climb(b) || a.length - b.length);
  else if (by === 'mostClimb') out.sort((a, b) => climb(b) - climb(a) || b.length - a.length);
  else if (center) {
    const k = Math.cos(center[0] * Math.PI / 180);
    const d = (t: Trail) => (t.start[0] - center[0]) ** 2 + ((t.start[1] - center[1]) * k) ** 2;
    const ds = new Map(out.map((t) => [t, d(t)]));
    out.sort((a, b) => ds.get(a)! - ds.get(b)!);
  }
  return out;
}

/** Groups keep the order their first trail has in the sorted list. */
function grouped(trails: Trail[]): { area: string; trails: Trail[] }[] {
  const groups = new Map<string, Trail[]>();
  for (const t of trails) {
    const area = t.area ?? 'Other trails';
    const g = groups.get(area);
    if (g) g.push(t);
    else groups.set(area, [t]);
  }
  return [...groups].map(([area, ts]) => ({ area, trails: ts }));
}

function Results() {
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const q = query.value;
  useEffect(() => {
    let live = true;
    setHits(null);
    const timer = setTimeout(() => {
      void search(q, view.peek()?.center ?? null).then((h) => { if (live) setHits(h); }, () => { if (live) setHits([]); });
    }, 150);
    return () => { live = false; clearTimeout(timer); };
  }, [q]);

  if (!hits) return <p class="quiet-line">Searching…</p>;
  if (!hits.length) {
    return (
      <Empty icon="search" title="Nothing found">
        Search looks through trail and park names in the regions you have looked at on the map, and region names.
        Move the map to another state or province to search there.
      </Empty>
    );
  }
  const pick = (h: SearchHit) => {
    if (h.trail) go({ page: 'trail', region: h.trail.region, id: h.trail.id });
    else if (h.bounds) {
      query.value = '';
      if (isPhone()) sheet.value = 'half';
      flyTo.value = { bounds: h.bounds, zoom: h.kind === 'region' ? 9 : 15 };
    }
  };
  return (
    <ul class="list" aria-label="Search results">
      {hits.map((h) => (
        <li>
          <button type="button" class="row" onClick={() => pick(h)}>
            <span class="row-icon"><Icon name={h.kind === 'trail' ? 'route' : h.kind === 'area' ? 'peak' : 'map'} size={18} /></span>
            <span class="row-main">
              <span class="row-title">{h.title}</span>
              <span class="row-sub">{h.kind === 'area' ? `Park or area · ${h.subtitle}` : h.kind === 'region' ? `Region · ${h.subtitle}` : h.subtitle || 'Trail'}</span>
            </span>
            <Icon name="chevron" size={16} class="row-chevron" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function RegionList() {
  const list = regions.value.slice().sort((a, b) => (a.country ?? '').localeCompare(b.country ?? '') * -1 || regionName(a).localeCompare(regionName(b)));
  return (
    <>
      <h2 class="section-title">Pick a place</h2>
      <ul class="region-grid">
        {list.map((r) => (
          <li>
            <button type="button" class="region" onClick={() => { if (isPhone()) sheet.value = 'half'; flyTo.value = { bounds: r.bbox, zoom: 9 }; }}>
              <span class="region-name">{regionName(r)}</span>
              {r.trails ? <span class="region-count">{r.trails.toLocaleString()}</span> : null}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Explore() {
  const [shown, setShown] = useState(PAGE);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const zoomedOut = useComputed(() => (view.value?.zoom ?? 0) < MIN_TRAIL_ZOOM);
  const hikes = hikesInView.value;
  const by = sort.value;
  const center = view.value?.center ?? null;
  const groups = useMemo(() => grouped(sorted(hikes, by, by === 'closest' ? center : null)), [hikes, by, by === 'closest' ? center : null]);
  useEffect(() => setShown(PAGE), [hikes, by]);

  let left = shown;
  const visible = groups.map((g) => {
    const take = g.trails.slice(0, Math.max(0, left));
    left -= take.length;
    return { area: g.area, total: g.trails.length, trails: take };
  }).filter((g) => g.trails.length);

  return (
    <div class="page">
      <div class="page-top">
        <div class="search">
          <Icon name="search" size={18} />
          <input ref={input} type="search" placeholder="Search trails and parks" aria-label="Search trails and parks"
            value={query.value} enterkeyhint="search" autocomplete="off" spellcheck={false}
            onInput={(e) => (query.value = (e.currentTarget as HTMLInputElement).value)}
            onFocus={() => { if (isPhone()) sheet.value = 'full'; }} />
          {query.value && (
            <button type="button" class="search-clear" aria-label="Clear search" onClick={() => { query.value = ''; input.current?.focus(); }}>
              <Icon name="close" size={16} />
            </button>
          )}
        </div>
        {!query.value && !zoomedOut.value && (
          <div class="count-row">
            <p class="count" aria-live="polite">
              {loading.value && !hikes.length ? 'Loading trails…' : `${hikes.length.toLocaleString()} ${hikes.length === 1 ? 'hike' : 'hikes'} on the map`}
              {loading.value && hikes.length > 0 && <span class="spinner" aria-label="Loading" />}
            </p>
            <button type="button" class={`chip filter-toggle${filtersOn.value ? ' active' : ''}`} aria-expanded={filtersOpen} onClick={() => setFiltersOpen(!filtersOpen)}>
              <Icon name="filter" size={15} />Sort and filter{filtersOn.value ? ' •' : ''}
            </button>
          </div>
        )}
      </div>

      <div class="page-scroll">
        {regionsError.value && <Note kind="warn">{regionsError.value}</Note>}
        {query.value.trim() ? <Results /> : zoomedOut.value ? (
          <>
            <div class="hint-card">
              <span class="hint-icon"><Icon name="map" size={22} /></span>
              <div>
                <h2>Zoom in to see trails</h2>
                <p>Trails appear when you zoom in on the map. Pinch or scroll the map, tap a region on it, or pick a place below.</p>
              </div>
            </div>
            <RegionList />
          </>
        ) : (
          <>
            {filtersOpen && <Filters />}
            {loadNote.value && <Note kind="warn">{loadNote.value}</Note>}
            {!loading.value && !hikes.length && (
              <Empty icon="peak" title={filtersOn.value ? 'No hikes match' : 'No hikes here'}>
                {filtersOn.value
                  ? <>Nothing on this part of the map passes your filters. <button type="button" class="link" onClick={() => { difficultyFilter.value = []; lengthFilter.value = 'any'; loopsOnly.value = false; }}>Clear filters</button></>
                  : 'Move or zoom the map to look somewhere else.'}
              </Empty>
            )}
            {visible.map((g) => (
              <section class="group" aria-label={g.area}>
                <h2 class="group-title"><span>{g.area}</span><span class="group-count">{g.total}</span></h2>
                <ul class="list card">
                  {g.trails.map((t) => <li key={t.key}><TrailRow t={{ ...t, gain: t.profile?.gain ?? 0, loop: t.isLoop }} /></li>)}
                </ul>
              </section>
            ))}
            {hikes.length > shown && (
              <Button wide onClick={() => setShown(shown + PAGE)}>Show more ({(hikes.length - shown).toLocaleString()} left)</Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
