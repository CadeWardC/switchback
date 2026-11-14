// The filters and the sort order, in one small store that any way of showing results can read and write.
// Nothing here knows about the map, the screens or the device: it takes trails and says which pass, in
// what order, and what the choice is in plain words ("Loops under 5 mi, closest first").
import { computed, signal } from '@preact/signals';
import { DIFFICULTIES, DIFFICULTY_TITLE, type Difficulty, type Trail } from './lib/trail';
import type { Units } from './lib/format';
import type { Coord } from './lib/polyline';

export type Sort = 'closest' | 'shortest' | 'longest' | 'leastClimb' | 'mostClimb';
export type LengthBand = 'any' | 'short' | 'medium' | 'long';
export type ClimbBand = 'any' | 'low' | 'medium' | 'high';

export interface Filters {
  sort: Sort;
  difficulty: Difficulty[];
  length: LengthBand;
  climb: ClimbBand;
  loopsOnly: boolean;
  /** Only trails the data says welcome dogs (few trails say either way). */
  dogs: boolean;
}

export const DEFAULT_FILTERS: Filters = { sort: 'closest', difficulty: [], length: 'any', climb: 'any', loopsOnly: false, dogs: false };

export const sort = signal<Sort>(DEFAULT_FILTERS.sort);
export const difficultyFilter = signal<Difficulty[]>([]);
export const lengthFilter = signal<LengthBand>('any');
export const climbFilter = signal<ClimbBand>('any');
export const loopsOnly = signal(false);
export const dogsOnly = signal(false);

/** Everything at once, for a presentation that wants one value. */
export const filters = computed<Filters>(() => ({
  sort: sort.value, difficulty: difficultyFilter.value, length: lengthFilter.value, climb: climbFilter.value,
  loopsOnly: loopsOnly.value, dogs: dogsOnly.value,
}));

export function setFilters(f: Partial<Filters>): void {
  if (f.sort !== undefined) sort.value = f.sort;
  if (f.difficulty !== undefined) difficultyFilter.value = f.difficulty;
  if (f.length !== undefined) lengthFilter.value = f.length;
  if (f.climb !== undefined) climbFilter.value = f.climb;
  if (f.loopsOnly !== undefined) loopsOnly.value = f.loopsOnly;
  if (f.dogs !== undefined) dogsOnly.value = f.dogs;
}

/** Clears the filters; the sort order stays. */
export function clearFilters(): void {
  setFilters({ ...DEFAULT_FILTERS, sort: sort.peek() });
}

export const filtersOn = computed(() =>
  difficultyFilter.value.length > 0 || lengthFilter.value !== 'any' || climbFilter.value !== 'any' || loopsOnly.value || dogsOnly.value);

/** Length bands in the reader's units: under 3 mi / 5 km, up to 8 mi / 13 km, longer. */
export function lengthBands(u: Units): { short: number; long: number; labels: Record<LengthBand, string> } {
  return u === 'imperial'
    ? { short: 3 * 1609.344, long: 8 * 1609.344, labels: { any: 'Any length', short: 'Under 3 mi', medium: '3 to 8 mi', long: 'Over 8 mi' } }
    : { short: 5000, long: 13000, labels: { any: 'Any length', short: 'Under 5 km', medium: '5 to 13 km', long: 'Over 13 km' } };
}

/** Climb bands: under 500 ft / 150 m, up to 1,500 ft / 450 m, more. */
export function climbBands(u: Units): { low: number; high: number; labels: Record<ClimbBand, string> } {
  return u === 'imperial'
    ? { low: 500 / 3.28084, high: 1500 / 3.28084, labels: { any: 'Any climb', low: 'Under 500 ft climb', medium: '500 to 1,500 ft climb', high: 'Over 1,500 ft climb' } }
    : { low: 150, high: 450, labels: { any: 'Any climb', low: 'Under 150 m climb', medium: '150 to 450 m climb', high: 'Over 450 m climb' } };
}

export function passes(t: Trail, f: Filters, u: Units): boolean {
  if (f.difficulty.length && !f.difficulty.includes(t.difficulty)) return false;
  if (f.loopsOnly && !t.isLoop) return false;
  if (f.dogs && !/^(yes|leashed|designated|permissive)$/.test(t.tags.dog ?? '')) return false;
  if (f.length !== 'any') {
    const b = lengthBands(u);
    if (f.length === 'short' && t.length >= b.short) return false;
    if (f.length === 'medium' && (t.length < b.short || t.length > b.long)) return false;
    if (f.length === 'long' && t.length <= b.long) return false;
  }
  if (f.climb !== 'any') {
    const b = climbBands(u), gain = t.profile?.gain ?? 0;
    if (f.climb === 'low' && gain >= b.low) return false;
    if (f.climb === 'medium' && (gain < b.low || gain > b.high)) return false;
    if (f.climb === 'high' && gain <= b.high) return false;
  }
  return true;
}

/** The trails in the chosen order. `center`: where "closest" is measured from. */
export function sorted(trails: Trail[], by: Sort, center: Coord | null): Trail[] {
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

export const SORT_LABELS: Record<Sort, string> = {
  closest: 'closest first', shortest: 'shortest first', longest: 'longest first', leastClimb: 'least climb first', mostClimb: 'most climb first',
};

/** The choice in plain words: "Loops under 5 mi, closest first", "All hikes, shortest first". */
export function filterSummary(f: Filters, u: Units): string {
  const parts: string[] = [];
  if (f.difficulty.length && f.difficulty.length < DIFFICULTIES.length) {
    parts.push(DIFFICULTIES.filter((d) => f.difficulty.includes(d)).map((d) => DIFFICULTY_TITLE[d].toLowerCase()).join(' or '));
  }
  let what = f.loopsOnly ? 'loops' : 'hikes';
  if (f.length !== 'any') what += ` ${lengthBands(u).labels[f.length].toLowerCase()}`;
  const extra: string[] = [];
  if (f.climb !== 'any') extra.push(climbBands(u).labels[f.climb].toLowerCase());
  if (f.dogs) extra.push('dogs welcome');
  const head = parts.length ? `${parts.join(' ')} ${what}` : !f.loopsOnly && f.length === 'any' && !extra.length ? 'all hikes' : what;
  const text = [head, ...extra].join(', ') + `, ${SORT_LABELS[f.sort]}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}
