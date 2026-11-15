import { describe, expect, it } from 'vitest';
import { climbBetween, climbOver, planOf, stepJourney, type Journey } from '../src/lib/journey';
import { progressOn } from '../src/lib/follow';
import type { Coord } from '../src/lib/polyline';
import type { Profile } from '../src/lib/trail';

/** Walks along the line through each of `to` in turn, a fix every 8 m. Returns the journey and how often it asked. */
function walk(j: Journey | null, from: number, to: number[], total: number, loop = false): { j: Journey; asks: number; at: number } {
  let at = from, asks = 0;
  const step = (a: number) => {
    const r = stepJourney(j, loop ? ((a % total) + total) % total : a, total, loop);
    j = r.journey;
    if (r.ask) asks++;
  };
  if (!j) step(at);
  for (const goal of to) {
    while (at !== goal) {
      at += Math.sign(goal - at) * Math.min(8, Math.abs(goal - at));
      step(at);
    }
  }
  return { j: j!, asks, at };
}

describe('a hike joined in the middle of a trail', () => {
  const total = 2000;

  it('is out to the end and back to where you joined', () => {
    const start = stepJourney(null, 1000, total, false).journey;
    expect(start.mid).toBe(true);
    // nothing walked yet: to the end of the line and back
    expect(planOf(start, total, false)).toMatchObject({ left: 2000, kind: 'out-back' });
    const out = walk(start, 1000, [1400], total);
    expect(planOf(out.j, total, false)).toMatchObject({ left: 600 + 1000, kind: 'out-back', legs: [[1400, 2000], [2000, 1000]] });
    expect(out.asks).toBe(0);
  });

  it('follows you when you set off the other way', () => {
    const out = walk(null, 1000, [700], total);
    expect(out.j.dir).toBe(-1);
    expect(planOf(out.j, total, false)).toMatchObject({ left: 700 + 1000, kind: 'out-back', legs: [[700, 0], [0, 1000]] });
  });

  it('counts down to where you joined once you turn back, and asks there', () => {
    const turned = walk(null, 1000, [2000, 1500], total);
    expect(planOf(turned.j, total, false)).toMatchObject({ left: 500, kind: 'home' });
    expect(turned.asks).toBe(0);
    const home = walk(turned.j, 1500, [1010], total);
    expect(home.asks).toBe(1);
    expect(planOf(home.j, total, false).left).toBeLessThan(40);
  });

  it('turning round early is heading home too', () => {
    const turned = walk(null, 1000, [1300, 1200], total);
    expect(planOf(turned.j, total, false)).toMatchObject({ left: 200, kind: 'home' });
  });

  it('walking on past where you joined is the other half, out and back', () => {
    const past = walk(null, 1000, [2000, 800], total);
    expect(past.asks).toBe(1);
    expect(planOf(past.j, total, false)).toMatchObject({ left: 800 + 1000, kind: 'out-back' });
    // and it asks again when that half is done
    const done = walk(past.j, 800, [0, 1000], total);
    expect(done.asks).toBe(1);
  });

  it('does not ask while you stand about where you joined', () => {
    expect(walk(null, 1000, [1060, 990, 1050, 1000], total).asks).toBe(0);
  });

  it('a wobble in the position is not a turn', () => {
    const j = walk(null, 1000, [1200, 1180, 1300, 1285, 1400], total).j;
    expect(j.dir).toBe(1);
  });
});

describe('a hike begun at an end of a trail', () => {
  const total = 2000;
  it('is the trail one way, then the way back once you turn round; the journey never asks', () => {
    const start = stepJourney(null, 12, total, false).journey;
    expect(start.mid).toBe(false);
    expect(planOf(start, total, false)).toMatchObject({ left: 1988, kind: 'onward' });
    const out = walk(start, 12, [900], total);
    expect(planOf(out.j, total, false)).toMatchObject({ left: 1100, kind: 'onward' });
    const back = walk(out.j, 900, [2000, 600], total);
    expect(planOf(back.j, total, false)).toMatchObject({ left: 588, kind: 'home' });
    expect(walk(back.j, 600, [12], total).asks + back.asks + out.asks).toBe(0);
  });
  it('begun at the far end, it is walked towards the start', () => {
    const start = stepJourney(null, 1990, total, false).journey;
    expect(start.dir).toBe(-1);
    expect(planOf(start, total, false)).toMatchObject({ left: 1990, kind: 'onward' });
  });
});

describe('a loop', () => {
  const total = 3000;
  it('from its start is what is left of the way round, either way round', () => {
    expect(planOf(walk(null, 0, [1000], total, true).j, total, true)).toMatchObject({ left: 2000, kind: 'onward', legs: [[1000, 3000]] });
    const against = walk(null, 0, [-1000], total, true).j;
    expect(against.along).toBe(2000);
    expect(planOf(against, total, true)).toMatchObject({ left: 2000, kind: 'onward', legs: [[2000, 0]] });
  });
  it('joined part way round is the whole loop back to there, across its join', () => {
    const start = stepJourney(null, 2000, total, true).journey;
    expect(planOf(start, total, true)).toMatchObject({ left: 3000, legs: [[2000, 3000], [0, 2000]] });
    const on = walk(start, 2000, [3500], total, true);
    expect(planOf(on.j, total, true)).toMatchObject({ left: 1500, legs: [[500, 2000]] });
    expect(on.asks).toBe(0);
    expect(walk(on.j, 3500, [4995], total, true).asks).toBe(1);
  });
  it('turning back is the way you came', () => {
    const j = walk(null, 2000, [2600, 2400], total, true).j;
    expect(planOf(j, total, true)).toMatchObject({ left: 400, kind: 'home', legs: [[2400, 2000]] });
  });
});

describe('climbing over what is left', () => {
  // up 100 m in the first kilometre, down 40 m in the second
  const p: Profile = { distances: [0, 500, 1000, 1500, 2000], elevations: [200, 250, 300, 280, 260], gain: 100, loss: 40, min: 200, max: 300 };
  it('counts descents as climbs when the profile is walked backwards', () => {
    expect(climbBetween(p, 0, 2000)).toBeCloseTo(100);
    expect(climbBetween(p, 2000, 0)).toBeCloseTo(40);
    expect(climbBetween(p, 500, 1000)).toBeCloseTo(50);
    expect(climbBetween(p, 1500, 1000)).toBeCloseTo(20);
    expect(climbBetween(p, 700, 700)).toBe(0);
  });
  it('adds up the stretches of an out-and-back', () => {
    const j = walk(null, 1000, [1500], 2000).j;
    // down to the end (nothing to climb), then back up 40 m to where you joined
    expect(climbOver(p, planOf(j, 2000, false), 2000)).toBeCloseTo(40);
  });
});

describe('finding yourself on a line walked backwards', () => {
  // out along a stem, round a small loop, back along the same stem
  const stem: Coord[] = Array.from({ length: 11 }, (_, i) => [38.9 + i * 0.0002, -92.3]);
  const path: Coord[] = [...stem, [38.9022, -92.2995], [38.9024, -92.299], [38.9022, -92.2985], [38.902, -92.299], ...stem.slice().reverse()];
  const total = progressOn(path, path[0]).total;
  it('keeps to the stretch you are on', () => {
    const here: Coord = [38.901, -92.3];
    const late = progressOn(path, here, total - 100, true);
    expect(late.along).toBeGreaterThan(total / 2);
    const early = progressOn(path, here, 120);
    expect(early.along).toBeLessThan(total / 2);
    // with nowhere to go from, the nearest point either way
    expect(progressOn(path, here, -Infinity, true).off).toBeLessThan(1);
  });
});
