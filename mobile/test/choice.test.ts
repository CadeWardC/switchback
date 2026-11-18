import { encodePolyline, type Coord } from '@web/lib/polyline';
import { accessPoints, makeTrail, shortLoops, type Trail } from '@web/lib/trail';
import { distance as distanceOf } from '@web/lib/geo';
import { baseRoute, choose, chosenTrail, defaultStart, highlightLines, joinedProfile, loopChoices, pickStart, shortName, startFeatures, usableStarts } from '../src/core/choice';

// a square loop about 440 m a side, with a cut-across and two trailheads
const loop: Coord[] = [[38.9, -92.3], [38.904, -92.3], [38.904, -92.295], [38.9, -92.295], [38.9, -92.3]];
const west: Coord[] = [[38.9, -92.3], [38.904, -92.3], [38.904, -92.2975], [38.9, -92.2975], [38.9, -92.3]];
const east: Coord[] = [[38.9, -92.2975], [38.904, -92.2975], [38.904, -92.295], [38.9, -92.295], [38.9, -92.2975]];
const walkIn: Coord[] = [[38.898, -92.3], [38.9, -92.3]];
const tags = {
  'switchback:short': JSON.stringify([{ n: 'West loop', m: 1320, l: encodePolyline(west) }, { n: 'East loop', m: 1321, l: encodePolyline(east) }]),
  'switchback:access': JSON.stringify([
    { n: 'North Lot', d: 0, p: [38.904, -92.2975] },
    { n: 'Devils Icebox Trailhead', d: 222, p: [38.898, -92.3], l: encodePolyline(walkIn) },
  ]),
};
// its own mapped piece is only the first side; the rest of the main line runs along other trails
const trail: Trail = makeTrail('mo', { id: 'a', name: 'Spring Brook Trail', source: 'osmWay', segments: [encodePolyline(loop.slice(0, 2))], path: encodePolyline(loop), length: 1760, tags })!;
const shorts = shortLoops(trail), heads = accessPoints(trail);

describe('the open trail as chosen', () => {
  it('offers the full loop, then every short loop by its own name', () => {
    expect(shorts).toHaveLength(2);
    expect(loopChoices(trail, shorts).map((c) => [c.index, c.name, Math.round(c.length)])).toEqual([[-1, 'Full loop', 1760], [0, 'West loop', 1320], [1, 'East loop', 1321]]);
    expect(loopChoices(trail, [])).toEqual([]);
  });
  it('starts at the trailhead nearest you, else the one nearest the trail', () => {
    expect(defaultStart(heads, null)).toBe(0);
    expect(defaultStart(heads, [38.8975, -92.3])).toBe(1);
    expect(defaultStart(heads, [45, -100])).toBe(0); // far from all of them
    expect(defaultStart([], [38.9, -92.3])).toBe(-1);
  });
  it('never picks a trailhead with a much longer walk in just because it is on your side', () => {
    const far = [{ ...heads[0], distance: 83, point: [38.9, -92.3] as Coord }, { ...heads[1], distance: 712, point: [38.89, -92.3] as Coord }];
    expect(defaultStart(far, [38.8, -92.3])).toBe(0);        // south of both: still the 83 m walk
    expect(defaultStart(far, [38.8901, -92.3])).toBe(1);     // standing at the far one: that one
  });
  it('walks a loop on a stem back down the stem, so the trailhead at its foot can be used', () => {
    // Devil's Icebox Trail as its trail file has it: down a stem, round a loop, ending where the loop meets the stem
    const icebox: Coord[] = [[38.87259, -92.32651], [38.8724, -92.32634], [38.87226, -92.32668], [38.87219, -92.32669], [38.87211, -92.32657],
      [38.87188, -92.32652], [38.8718, -92.32669], [38.87172, -92.32671], [38.87159, -92.32664], [38.87157, -92.3265], [38.87139, -92.32628],
      [38.87108, -92.32607], [38.87084, -92.32609], [38.87051, -92.3263], [38.87041, -92.32624], [38.87011, -92.32647], [38.87011, -92.32658],
      [38.87075, -92.32688], [38.87076, -92.32709], [38.87131, -92.32695], [38.87164, -92.32666]];
    const lot: Coord[] = [[38.87312, -92.32596], [38.87294, -92.32618], [38.87279, -92.32651], [38.87259, -92.32651]];
    const sinkhole: Coord[] = [[38.87008, -92.32555], [38.871, -92.32591], [38.87099, -92.32608]];
    const t = makeTrail('mo', { id: 'i', name: "Devil's Icebox Trail", source: 'osmWay', segments: [encodePolyline(icebox)], pathIndex: 0, length: 562.3, tags: {
      'switchback:access': JSON.stringify([{ n: "Devil's Icebox Trail", d: 83, p: lot[0], l: encodePolyline(lot) }, { n: 'Sinkhole Trail', d: 712, p: sinkhole[0], l: encodePolyline(sinkhole) }]),
    } })!;
    expect(t.isLoop).toBe(true);
    expect(t.path[t.path.length - 1]).toEqual(t.path[0]);
    expect(t.length).toBeGreaterThan(680);
    const its = accessPoints(t);
    expect(usableStarts(t, its)).toEqual([true, true]);
    expect(defaultStart(its, null, usableStarts(t, its))).toBe(0);
    for (const start of [0, 1]) {
      const walked = choose(t, [], -1, its, start).trail;
      expect(walked.path[0]).toEqual(its[start].line[0]);
      expect(walked.path[walked.path.length - 1]).toEqual(its[start].line[0]);
      for (let i = 1; i < walked.path.length; i++) expect(distanceOf(walked.path[i - 1], walked.path[i])).toBeLessThanOrEqual(110);
    }
  });
  it('adds the walk in from the chosen trailhead to the line and the length', () => {
    expect(chosenTrail(trail, shorts, -1, heads, -1)).toBe(trail);
    const walked = chosenTrail(trail, shorts, -1, heads, 1);
    expect(walked.length).toBeCloseTo(1760 + 2 * 222, 0);
    expect(walked.path[0]).toEqual(walkIn[0]);
    // a start on the trail itself has no walk in: the trail is unchanged
    expect(chosenTrail(trail, shorts, -1, heads, 0)).toBe(trail);
    const short = chosenTrail(trail, shorts, 1, heads, -1);
    expect(short.length).toBe(1321);
    expect(short.path).toEqual(east);
  });
  it('highlights the whole main line, not only the trail\'s own sections', () => {
    const lines = highlightLines(trail, trail, -1);
    expect(lines[0]).toEqual(loop); // the joined line, including where it follows other trails
    expect(lines).toHaveLength(2); // plus its own section
    // a short loop: that loop's line only (the rest of the trail stays faded with the others)
    const short = chosenTrail(trail, shorts, 0, heads, -1);
    expect(highlightLines(trail, short, 0)).toEqual([west]);
    // walking in: the walk is part of the highlighted line
    expect(highlightLines(trail, chosenTrail(trail, shorts, -1, heads, 1), -1)[0][0]).toEqual(walkIn[0]);
  });
  it('draws the starts as radio markers and finds the one under a tap', () => {
    const fc = startFeatures(heads, 1);
    expect(fc.features.map((f) => f.properties)).toEqual([{ start: 0, on: 0, name: 'North Lot' }, { start: 1, on: 1, name: 'Devils Icebox' }]);
    expect(fc.features[1].geometry).toEqual({ type: 'Point', coordinates: [-92.3, 38.898] });
    expect(pickStart([{ properties: { k: 'mo/a', h: 1 } }, { properties: { start: 1, on: 1 } }])).toBe(1);
    expect(pickStart([{ properties: { k: 'mo/a' } }])).toBeNull();
    expect(shortName('A very long name for a car park beside the road')).toHaveLength(25);
  });
});

describe('a start must meet the route that is chosen', () => {
  // heights every 110 m: the loop rolls gently around 200 m; the walk in has its own heights, 10 m lower where they meet
  const pack = (pts: [number, number][]) => {
    let s0 = 0, h0 = 0;
    return encodePolyline(pts.map(([steps, m]) => { const d: Coord = [(steps - s0) / 1e5, (m - h0) / 1e5]; s0 = steps; h0 = m; return d; })
      .reduce<Coord[]>((acc, d) => { const last = acc[acc.length - 1] ?? [0, 0]; acc.push([last[0] + d[0], last[1] + d[1]]); return acc; }, []));
  };
  const rolling = (n: number) => Array.from({ length: n + 1 }, (_, i) => [i, Math.round(200 + 10 * Math.sin((i / n) * 2 * Math.PI))] as [number, number]);
  const withHeights = (walkInHeights: boolean) => makeTrail('mo', {
    id: 'b', name: 'Deer Run Trail', source: 'osmWay', segments: [encodePolyline(loop)], path: encodePolyline(loop), length: 1760,
    elev: { s: 110, p: pack(rolling(16)) },
    tags: {
      'switchback:short': JSON.stringify([{ n: 'West loop', m: 1320, l: encodePolyline(west), e: { s: 110, p: pack(rolling(12)) } }, { n: 'East loop', m: 1321, l: encodePolyline(east), e: { s: 110, p: pack(rolling(12)) } }]),
      'switchback:access': JSON.stringify([
        { n: 'West car park', d: 222, p: [38.898, -92.3], l: encodePolyline(walkIn), ...(walkInHeights ? { e: { s: 111, p: pack([[0, 185], [1, 188], [2, 190]]) } } : {}) },
      ]),
    },
  })!;
  const deer = withHeights(true), deerShorts = shortLoops(deer), deerHeads = accessPoints(deer);

  it('offers a start only for routes its walk in ends on', () => {
    expect(usableStarts(baseRoute(deer, deerShorts, -1), deerHeads)).toEqual([true]);
    expect(usableStarts(baseRoute(deer, deerShorts, 0), deerHeads)).toEqual([true]); // the west loop passes it
    expect(usableStarts(baseRoute(deer, deerShorts, 1), deerHeads)).toEqual([false]); // the east loop is 200 m away
    expect(defaultStart(deerHeads, null, [false])).toBe(-1);
    expect(startFeatures(deerHeads, 0, [false]).features).toHaveLength(0);
  });
  it('never joins a walk in to a loop it does not meet', () => {
    const far = choose(deer, deerShorts, 1, deerHeads, 0);
    expect(far.trail).toBe(far.base);
    expect(far.trail.path).toEqual(east);
    expect(far.trail.length).toBe(1321);
  });
  it('has no straight join longer than 60 m in any line it makes', () => {
    for (const short of [-1, 0, 1]) {
      const t = choose(deer, deerShorts, short, deerHeads, 0).trail;
      const base = baseRoute(deer, deerShorts, short);
      const own = Math.max(...base.path.slice(1).map((c, i) => distanceOf(base.path[i], c)));
      for (let i = 1; i < t.path.length; i++) expect(distanceOf(t.path[i - 1], t.path[i])).toBeLessThanOrEqual(Math.max(own, 222) + 1);
    }
  });
  it('joins the heights where the walk in meets the loop, with no cliffs', () => {
    const c = choose(deer, deerShorts, -1, deerHeads, 0);
    const p = c.trail.profile!;
    expect(c.trailOnly).toBe(false);
    expect(p.distances[p.distances.length - 1]).toBeCloseTo(1760 + 2 * 222, 0);
    for (let i = 1; i < p.distances.length; i++) {
      const dd = p.distances[i] - p.distances[i - 1], de = Math.abs(p.elevations[i] - p.elevations[i - 1]);
      expect(dd).toBeGreaterThanOrEqual(0);
      expect(de).toBeLessThanOrEqual(0.1 * Math.max(dd, 1) + 0.01); // nothing steeper than the ground itself
    }
    // out and back: it ends at the height it started
    expect(p.elevations[p.elevations.length - 1]).toBeCloseTo(p.elevations[0], 5);
    // the walk in keeps its own shape (5 m up), set at the loop's height where they meet (200 m)
    expect(p.elevations[0]).toBeCloseTo(195, 5);
  });
  it('charts the trail alone when the walk in has no heights', () => {
    const bare = withHeights(false);
    const c = choose(bare, shortLoops(bare), -1, accessPoints(bare), 0);
    expect(c.trailOnly).toBe(true);
    expect(c.base.profile).toBe(bare.profile);
    expect(c.trail.length).toBeCloseTo(1760 + 2 * 222, 0);
    // (while walking, the walk in is level at the height of the join: still no cliff)
    const j = joinedProfile(c.base, accessPoints(bare)[0])!;
    expect(j.level).toBe(true);
    expect(j.profile.elevations[0]).toBe(j.profile.elevations[1]);
  });
});
