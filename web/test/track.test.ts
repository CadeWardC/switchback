import { describe, expect, it } from 'vitest';
import { addFix, emptyTrack, newStretch, restoreLog, type Track, type TrackFix } from '../src/lib/track';
import { distanceToLine } from '../src/lib/geo';

const T0 = Date.UTC(2026, 10, 12, 14, 0, 0);
/** A fix `i` steps north (about 11 m a step), ten seconds apart. */
const fix = (i: number, over: Partial<TrackFix> = {}): TrackFix => ({ lat: 38.87 + i * 0.0001, lon: -92.32, ele: 230 + i, accuracy: 6, time: T0 + i * 10_000, ...over });
const feed = (track: Track, fixes: TrackFix[], notBefore = 0) => {
  let kept = 0;
  for (const f of fixes) {
    const r = addFix(track, f, notBefore);
    if (r.kept) { track = r.track; kept++; }
  }
  return { track, kept };
};

describe('recording rules', () => {
  it('adds up a simple walk', () => {
    const { track, kept } = feed(emptyTrack(), Array.from({ length: 11 }, (_, i) => fix(i)));
    expect(kept).toBe(11);
    expect(track.segments).toHaveLength(1);
    expect(track.length).toBeGreaterThan(105);
    expect(track.length).toBeLessThan(117);
  });

  it('leaves out rough fixes, wobble while standing, and fixes from before the start', () => {
    let t = emptyTrack();
    expect(addFix(t, fix(0, { accuracy: 80 }))).toEqual({ kept: false, why: 'rough' });
    expect(addFix(t, fix(0, { accuracy: NaN }))).toEqual({ kept: false, why: 'rough' });
    expect(addFix(t, fix(0), T0 + 5000)).toEqual({ kept: false, why: 'old' });
    t = feed(t, [fix(0)]).track;
    expect(addFix(t, { ...fix(0), lat: 38.87 + 0.00001, time: T0 + 5000 })).toEqual({ kept: false, why: 'still' });
    expect(t.length).toBe(0);
  });

  it('takes a batch delivered late and all at once, by the time on each fix', () => {
    // the page slept for ten minutes while the phone kept locating; then 60 fixes arrive in one go,
    // overlapping the three that had already arrived, and not quite in order
    let { track } = feed(emptyTrack(), [fix(0), fix(1), fix(2)], T0 - 5000);
    const batch = Array.from({ length: 60 }, (_, i) => fix(i + 1));
    [batch[20], batch[21]] = [batch[21], batch[20]]; // two swapped
    const r = feed(track, batch, T0 - 5000);
    track = r.track;
    const points = track.segments.flat();
    // 2 overlapping ones and the out-of-order one are dropped; nothing is counted twice
    expect(r.kept).toBe(57);
    expect(points).toHaveLength(60);
    expect(track.segments).toHaveLength(1);
    // times are the fixes' own, strictly rising
    expect(points.every((p, i) => i === 0 || p.t > points[i - 1].t)).toBe(true);
    expect(points.at(-1)!.t - points[0].t).toBe(600_000);
    // the length is the walk's (60 steps of about 11.1 m), not inflated by the reordering
    expect(track.length).toBeGreaterThan(655);
    expect(track.length).toBeLessThan(680);
    // heights kept
    expect(points.at(-1)!.ele).toBe(290);
  });

  it('starts a new stretch across a gap instead of drawing a straight line', () => {
    const { track } = feed(emptyTrack(), [fix(0), fix(1), fix(40), fix(41)]);
    expect(track.segments.map((s) => s.length)).toEqual([2, 2]);
    expect(track.length).toBeLessThan(25);
  });

  it('starts a new stretch after a pause', () => {
    let { track } = feed(emptyTrack(), [fix(0), fix(1)]);
    track = newStretch(newStretch(track));
    expect(track.segments).toHaveLength(2);
    track = feed(track, [fix(2), fix(3)]).track;
    expect(track.segments.map((s) => s.length)).toEqual([2, 2]);
  });
});

describe('a recording kept as it goes', () => {
  it('comes back from its log, skipping a line cut short', () => {
    const p = (i: number) => ({ lat: 38.87 + i * 0.0001, lon: -92.32, ele: null, t: T0 + i * 10_000, acc: 5 });
    const lines = [
      JSON.stringify({ start: T0, follow: { region: 'missouri', id: 'x', name: 'Bluff Loop', line: '_p~iF~ps|U' } }),
      JSON.stringify({ p: p(0), s: 1 }), JSON.stringify({ p: p(1), s: 11 }), JSON.stringify({ s: 30 }), JSON.stringify({ gap: true }),
      JSON.stringify({ p: p(2), s: 40 }), '{"p":{"lat":38.8', JSON.stringify({ p: p(3), s: 50 }),
    ];
    const r = restoreLog(lines)!;
    expect(r.started).toBe(T0);
    expect(r.seconds).toBe(50);
    expect(r.track.segments.map((s) => s.length)).toEqual([2, 2]);
    expect(r.track.length).toBeGreaterThan(20);
    expect(r.follow?.name).toBe('Bluff Loop');
    expect(restoreLog([])).toBeNull();
    expect(restoreLog([JSON.stringify({ start: T0 })])).toBeNull();
  });
});

describe('distance to a line', () => {
  it('measures to the nearest part, not the nearest corner', () => {
    const line: [number, number][] = [[38.87, -92.32], [38.87, -92.31]];
    expect(distanceToLine([38.8709, -92.315], line)).toBeGreaterThan(95);
    expect(distanceToLine([38.8709, -92.315], line)).toBeLessThan(105);
    expect(distanceToLine([38.87, -92.315], line)).toBeLessThan(1);
    expect(distanceToLine([38.87, -92.33], line)).toBeGreaterThan(800);
  });
});

import { climbLeft, progressOn, secondsLeft, sunTimes } from '../src/lib/follow';
import { profileOf } from '../src/lib/trail';

describe('following a trail', () => {
  const path: [number, number][] = [[38.87, -92.32], [38.88, -92.32], [38.88, -92.31]];
  it('finds how far along and how far off you are', () => {
    const p = progressOn(path, [38.875, -92.3195]);
    expect(p.along).toBeGreaterThan(540);
    expect(p.along).toBeLessThan(570);
    expect(p.off).toBeGreaterThan(38);
    expect(p.off).toBeLessThan(48);
    expect(p.total).toBeGreaterThan(1950);
    expect(p.total).toBeLessThan(2000);
    expect(progressOn(path, [38.88, -92.31]).along).toBeCloseTo(p.total, 0);
  });
  it('on a loop, takes the end when you have walked most of it', () => {
    const loop: [number, number][] = [[38.87, -92.32], [38.88, -92.32], [38.88, -92.31], [38.87, -92.31], [38.87, -92.32]];
    const total = progressOn(loop, [38.87, -92.32]).total;
    expect(progressOn(loop, [38.87, -92.3201]).along).toBeLessThan(20);
    expect(progressOn(loop, [38.87, -92.3201], total - 100).along).toBeGreaterThan(total - 20);
  });
  it('adds up the climb still to do', () => {
    const p = profileOf([0, 1000, 2000, 3000], [100, 200, 150, 250]);
    expect(p.gain).toBe(200);
    expect(climbLeft(p, 0)).toBeCloseTo(200, 0);
    expect(climbLeft(p, 1500)).toBeCloseTo(100, 0);
    expect(climbLeft(p, 3000)).toBe(0);
  });
  it('estimates the time left from your own pace once there is one', () => {
    expect(secondsLeft(4500, 0, 0, 0)).toBeCloseTo(3600, 0);
    expect(secondsLeft(1000, 0, 1000, 500)).toBeCloseTo(500, 0);
    expect(secondsLeft(0, 600, 0, 0)).toBeCloseTo(3600, 0);
  });
  it('works out sunset without a network', () => {
    // Columbia, Missouri on 12 November 2026: sunrise about 6:49 and sunset about 4:57 pm Central (UTC-6)
    const s = sunTimes(new Date(Date.UTC(2026, 10, 12, 18)), [38.95, -92.33])!;
    const minutes = (d: Date) => ((d.getTime() / 60000) % 1440 + 1440) % 1440; // minutes after midnight UTC
    expect(Math.abs(minutes(s.sunset) - (22 * 60 + 57))).toBeLessThan(6);
    expect(Math.abs(minutes(s.sunrise) - (12 * 60 + 49))).toBeLessThan(6);
    expect(sunTimes(new Date(Date.UTC(2026, 5, 21, 12)), [80, 20])).toBeNull();
  });
});

import { DEFAULT_FILTERS, filterSummary, passes } from '../src/filters';
import type { Trail } from '../src/lib/trail';

describe('filters', () => {
  const trail = (over: Partial<Trail>): Trail => ({
    key: 'm/x', region: 'm', id: 'x', name: 'X', source: 'osmWay', segments: [], path: [], length: 3000, tags: {}, profile: null,
    start: [0, 0], bbox: [0, 0, 0, 0], difficulty: 'easy', isLoop: false, isHike: true, area: null, ...over,
  });
  it('says the choice in plain words', () => {
    expect(filterSummary(DEFAULT_FILTERS, 'imperial')).toBe('All hikes, closest first');
    expect(filterSummary({ ...DEFAULT_FILTERS, loopsOnly: true, length: 'short' }, 'metric')).toBe('Loops under 5 km, closest first');
    expect(filterSummary({ ...DEFAULT_FILTERS, difficulty: ['hard', 'easy'], sort: 'shortest', dogs: true }, 'imperial')).toBe('Easy or hard hikes, dogs welcome, shortest first');
    expect(filterSummary({ ...DEFAULT_FILTERS, climb: 'low' }, 'imperial')).toBe('Hikes, under 500 ft climb, closest first');
  });
  it('filters by length, climb, loops, difficulty and dogs', () => {
    const f = DEFAULT_FILTERS;
    expect(passes(trail({}), f, 'metric')).toBe(true);
    expect(passes(trail({}), { ...f, length: 'short' }, 'metric')).toBe(true);
    expect(passes(trail({ length: 9000 }), { ...f, length: 'short' }, 'metric')).toBe(false);
    expect(passes(trail({}), { ...f, loopsOnly: true }, 'metric')).toBe(false);
    expect(passes(trail({ difficulty: 'hard' }), { ...f, difficulty: ['easy'] }, 'metric')).toBe(false);
    expect(passes(trail({}), { ...f, dogs: true }, 'metric')).toBe(false);
    expect(passes(trail({ tags: { dog: 'leashed' } }), { ...f, dogs: true }, 'metric')).toBe(true);
    expect(passes(trail({ profile: { distances: [], elevations: [], gain: 300, loss: 0, min: 0, max: 0 } }), { ...f, climb: 'low' }, 'metric')).toBe(false);
  });
});
