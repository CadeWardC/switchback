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
