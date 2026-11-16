import { deflateSync, strToU8 } from 'fflate';
import { encodePolyline, type Coord } from '@web/lib/polyline';
import { makeTrail, type Trail } from '@web/lib/trail';
import { openPack, readBlock, cellKeys } from '../src/core/pack';
import { shapePath, split } from '../src/core/shape';
import { averageSpeed, bigTime, clock, climbedSoFar, daylight, dur, grouped, hikeNumbers, hm, leftLabel, lineLength, pace, speed, speedNow } from '../src/core/hikeMath';
import { backupName, backupText, importSummary, newSaved, newWalks, readBackup, readGpxHike } from '../src/core/backup';
import { stepJourney } from '@web/lib/journey';
import { climbAs, hikesOf, totals, yearsOf } from '../src/core/stats';
import type { SavedTrail, Walk, WalkPoint, WalkSummary } from '@web/lib/storage';
import { EMPTY, headFeatures, lineColor, lineFeature, pickKey, thin, trailFeatures } from '../src/core/trailMap';
import { trailGpx, walkGpx } from '../src/core/gpx';

const line: Coord[] = [[38.9, -92.3], [38.901, -92.301], [38.902, -92.3015], [38.903, -92.302], [38.9, -92.3001]];
function trail(id: string, extra: Record<string, string> = {}, path = line): Trail {
  return makeTrail('mo', { id, name: `Trail ${id}`, source: 'osmWay', segments: [encodePolyline(path)], length: 1200, tags: extra })!;
}

/** A pack as the trail files write it: "SBTP1", a big-endian header length, the header, raw-DEFLATE cells. */
function packBytes(cells: Record<string, unknown>): Uint8Array {
  const bodies: Uint8Array[] = [];
  const index: Record<string, [number, number]> = {};
  let offset = 0;
  for (const [key, value] of Object.entries(cells)) {
    const raw = deflateSync(strToU8(JSON.stringify(value)));
    index[key] = [offset, raw.length];
    bodies.push(raw);
    offset += raw.length;
  }
  const header = strToU8(JSON.stringify({ version: 't', cell: 0.25, cells: index }));
  const out = new Uint8Array(9 + header.length + offset);
  out.set(strToU8('SBTP1'), 0);
  new DataView(out.buffer).setUint32(5, header.length, false);
  out.set(header, 9);
  let at = 9 + header.length;
  for (const b of bodies) { out.set(b, at); at += b.length; }
  return out;
}

describe('trail packs (fflate in place of DecompressionStream)', () => {
  it('reads a raw-DEFLATE cell', async () => {
    const pack = openPack(packBytes({ '155_-370': [{ id: 'a', name: 'A' }], 'p:155_-370': [[1, 2, 'water', null, null, 3]] }));
    expect(pack.header.cell).toBe(0.25);
    expect(await readBlock(pack, '155_-370')).toEqual([{ id: 'a', name: 'A' }]);
    expect(await readBlock(pack, 'p:155_-370')).toEqual([[1, 2, 'water', null, null, 3]]);
    expect(await readBlock(pack, 'nope')).toBeNull();
  });
  it('still exports the rest of the website reader', () => {
    expect(cellKeys([38.9, -92.4, 39.1, -92.2], 0.25).length).toBeGreaterThan(0);
  });
});

describe('shape and numbers', () => {
  it('draws a line inside its box', () => {
    const d = shapePath(line, 36, 3);
    expect(d.startsWith('M')).toBe(true);
    for (const n of d.replace(/[ML]/g, ' ').trim().split(/\s+/).map(Number)) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(36);
    }
    expect(shapePath([[1, 1]], 36, 3)).toBe('');
  });
  it('splits a number from its unit', () => {
    expect(split('3.7 mi')).toEqual({ value: '3.7', unit: 'mi' });
    expect(split('1,246 ft')).toEqual({ value: '1,246', unit: 'ft' });
  });
  it('formats times and pace', () => {
    expect(clock(new Date(2026, 10, 12, 14, 48))).toBe('2:48');
    expect(clock(new Date(2026, 10, 12, 0, 5))).toBe('12:05');
    expect(hm(130)).toBe('2 h 10');
    expect(hm(45)).toBe('45 min');
    expect(dur(-61)).toBe('1 h 1');
    expect(pace(1800, 1609.344, true)).toBe('30:00');
    expect(pace(5, 10, true)).toBe('–');
    expect(bigTime(6300)).toEqual({ value: '1:45', unit: 'h' });
    expect(bigTime(1500)).toEqual({ value: '25', unit: 'min' });
  });
  it('works out the daylight line', () => {
    const now = new Date(2026, 10, 12, 14, 0);
    const sunset = new Date(2026, 10, 12, 17, 0);
    const d = daylight(now, new Date(2026, 10, 12, 16, 0), sunset)!;
    expect(d.spareMin).toBe(60);
    expect(d.late).toBe(false);
    expect(daylight(now, new Date(2026, 10, 12, 18, 0), sunset)!.late).toBe(true);
    expect(daylight(now, now, null)).toBeNull();
  });
  it('smooths climbing from phone heights', () => {
    expect(climbedSoFar([[{ lat: 0, lon: 0, ele: 1, t: 1, acc: 5 }]])).toBeNull();
    const pts = Array.from({ length: 30 }, (_, i) => ({ lat: 0, lon: i / 1e4, ele: i * 2, t: i, acc: 5 }));
    expect(climbedSoFar([pts])!).toBeGreaterThan(40);
  });
});

describe('trails on the map', () => {
  it('colours a trail by its blaze, green otherwise, never white', () => {
    expect(lineColor(trail('a', { 'switchback:blaze': 'blue' }), false)).toBe('#2f6fc0');
    expect(lineColor(trail('b', { 'switchback:blaze': 'white' }), false)).toBe('#23945a');
    expect(lineColor(trail('c'), true)).toBe('#4fc588');
  });
  it('thins lines far out but keeps the ends', () => {
    const many: Coord[] = Array.from({ length: 50 }, (_, i) => [38 + i * 1e-5, -92]);
    const out = thin(many, 0.0005);
    expect(out[0]).toEqual([-92, 38]);
    expect(out[out.length - 1]).toEqual([-92, 38 + 49e-5]);
    expect(out.length).toBeLessThan(5);
  });
  it('builds features with the website properties', () => {
    const side = trail('s', { 'switchback:side': 'yes' });
    const fc = trailFeatures([trail('a'), side], 13, false);
    expect(fc.features).toHaveLength(2);
    expect(fc.features[0].properties).toMatchObject({ k: 'mo/a', h: 1, u: 0, name: 'Trail a' });
    expect(fc.features[1].properties).toMatchObject({ h: 0 });
    // far out: hikes only
    expect(trailFeatures([trail('a'), side], 9.5, false).features).toHaveLength(1);
    expect(headFeatures([trail('a'), trail('b')], 'mo/a', false).features).toHaveLength(1);
    expect(lineFeature([[1, 1]])).toBe(EMPTY);
  });
  it('picks a hike before a side path under the finger, and nothing on empty map', () => {
    expect(pickKey([{ properties: { k: 'side', h: 0 } }, { properties: { k: 'hike', h: 1 } }])).toBe('hike');
    expect(pickKey([{ properties: { k: 'head' } }])).toBe('head');
    expect(pickKey([])).toBeNull();
    expect(pickKey([{ properties: null }])).toBeNull();
  });
  it('groups the list by park in list order', () => {
    const a = trail('a', { 'switchback:area': 'Park A' }), b = trail('b', { 'switchback:area': 'Park B' }), c = trail('c', { 'switchback:area': 'Park A' });
    expect(grouped([a, b, c]).map((g) => [g.area, g.trails.length])).toEqual([['Park A', 2], ['Park B', 1]]);
  });
});

describe('GPX', () => {
  it('writes a trail and a recorded hike', () => {
    const g = trailGpx(trail('a'));
    expect(g).toContain('<name>Trail a</name>');
    expect(g.match(/<trkpt /g)).toHaveLength(line.length);
    const w = walkGpx({
      id: 'w', name: 'Morning <hike>', started: 0, ended: 1000, seconds: 1, length: 10,
      segments: [[{ lat: 1, lon: 2, ele: 3, t: 0, acc: 5 }, { lat: 1.0001, lon: 2, ele: null, t: 1000, acc: 5 }]],
      markers: [{ lat: 1, lon: 2, ele: null, t: 0, name: 'Spring' }],
    });
    expect(w).toContain('Morning &lt;hike&gt;');
    expect(w).toContain('<wpt lat="1.0000000" lon="2.0000000"><time>1970-01-01T00:00:00Z</time><name>Spring</name></wpt>');
  });
});

describe('what is left of a hike', () => {
  // about 2 km due north
  const path: Coord[] = Array.from({ length: 21 }, (_, i) => [38.9 + i * 0.0009, -92.3]);
  const total = lineLength(path);
  const now = new Date(2026, 10, 15, 13, 0);
  it('is the whole trail before you are on it', () => {
    const n = hikeNumbers({ path, profile: null }, null, 0, 0, now);
    expect(n.left).toBeCloseTo(total);
    expect(n.kind).toBe('onward');
    // an easy 4.5 km/h
    expect((n.back.getTime() - now.getTime()) / 60000).toBeCloseTo(total / 75, 0);
  });
  it('joined half way, is out to the end and back, then the way back', () => {
    let j = stepJourney(null, total / 2, total, false).journey;
    const n = hikeNumbers({ path, profile: null }, j, 0, 0, now);
    expect(n.left).toBeCloseTo(total);
    expect(leftLabel(n.kind)).toBe('Left, out and back');
    for (let a = total / 2; a <= total; a += 10) j = stepJourney(j, a, total, false).journey;
    for (let a = total; a >= total * 0.75; a -= 10) j = stepJourney(j, a, total, false).journey;
    const back = hikeNumbers({ path, profile: null }, j, total * 0.75, 1200, now);
    expect(back.left).toBeGreaterThan(total * 0.24);
    expect(back.left).toBeLessThan(total * 0.26);
    expect(leftLabel(back.kind)).toBe('Back to your start');
  });
});

describe('totals in the Log', () => {
  const hike = (id: string, when: Date, length: number, gain: number, trailId?: string): WalkSummary => ({
    id, name: `Hike ${id}`, started: when.getTime(), ended: when.getTime() + 3600_000, seconds: 3000, length, gain,
    ...(trailId ? { trail: { region: 'mo', id: trailId, name: `Trail ${trailId}` } } : {}),
  });
  const log = [
    hike('a', new Date(2026, 10, 15, 12), 4000, 60, 't1'),
    hike('b', new Date(2026, 10, 15, 16), 2000, 10, 't1'),
    hike('c', new Date(2026, 3, 2, 9), 9000, 400, 't2'),
    hike('d', new Date(2025, 6, 4, 9), 5000, 150),
    hike('e', new Date(2025, 6, 5, 9), 1000, 0),
  ];
  it('counts the hikes of a year or of all time', () => {
    expect(hikesOf(log, 2026).map((w) => w.id)).toEqual(['a', 'b', 'c']);
    expect(hikesOf(log, 2025).map((w) => w.id)).toEqual(['d', 'e']);
    expect(hikesOf(log, null)).toHaveLength(5);
    expect(hikesOf(log, 2024)).toEqual([]);
  });
  it('adds them up', () => {
    const year = totals(hikesOf(log, 2026));
    expect(year).toMatchObject({ hikes: 3, length: 15000, gain: 470, seconds: 9000, days: 2, trails: 2, favourite: { name: 'Trail t1', times: 2 } });
    expect(year.longest?.id).toBe('c');
    const all = totals(log);
    expect(all).toMatchObject({ hikes: 5, length: 21000, gain: 620, days: 4, trails: 2 });
    expect(all.steepest?.id).toBe('c');
    expect(totals([])).toMatchObject({ hikes: 0, length: 0, gain: 0, longest: null, steepest: null, favourite: null });
  });
  it('lists the years, this one first even with nothing in it', () => {
    expect(yearsOf(log, new Date(2027, 0, 3))).toEqual([2027, 2026, 2025]);
    expect(yearsOf([], new Date(2026, 5, 1))).toEqual([2026]);
  });
  it('says the climbing as something tall', () => {
    expect(climbAs(50)).toBeNull();
    expect(climbAs(100)).toBe('once up the Statue of Liberty');
    expect(climbAs(620)).toBe('1.4 times up the Empire State Building');
    expect(climbAs(8849 * 12)).toBe('12 times up Mount Everest');
  });
});

describe('speed', () => {
  // a point every 5 s, about 1.4 m/s north (0.0000629° of latitude is 7 m)
  const walked = (n: number, t0 = 1_000_000): WalkPoint[] =>
    Array.from({ length: n }, (_, i) => ({ lat: 38.9 + i * 0.0000629, lon: -92.3, ele: 200, t: t0 + i * 5000, acc: 5 }));
  it('comes from the newest points', () => {
    const s = walked(12);
    const now = s[s.length - 1].t + 2000;
    expect(speedNow([s], now)).toBeCloseTo(1.4, 1);
    // a slow first stretch does not hold the number down: only the last 20 s count
    const slow: WalkPoint[] = [{ lat: 38.8990, lon: -92.3, ele: 200, t: 0, acc: 5 }, ...s];
    expect(speedNow([slow], now)).toBeCloseTo(1.4, 1);
  });
  it('is nothing before two points, and zero once you have stopped', () => {
    expect(speedNow([], 0)).toBeNull();
    expect(speedNow([walked(1)], 1_000_000)).toBeNull();
    const s = walked(6);
    expect(speedNow([s], s[5].t + 60_000)).toBe(0);
    // a new stretch (after a pause) starts from nothing
    expect(speedNow([s, []], s[5].t)).toBeNull();
  });
  it('is said in miles or kilometres an hour', () => {
    expect(speed(1.4, true)).toBe('3.1');
    expect(speed(1.4, false)).toBe('5.0');
    expect(speed(0, true)).toBe('0.0');
    expect(speed(null, true)).toBe('–');
    expect(averageSpeed(3600, 5000, false)).toBe('5.0');
    expect(averageSpeed(3600, 1609.344 * 3, true)).toBe('3.0');
    expect(averageSpeed(5, 20, true)).toBe('–');
  });
});

describe('backup', () => {
  const points = (t0: number, n = 12, lat0 = 38.9): WalkPoint[] =>
    Array.from({ length: n }, (_, i) => ({ lat: lat0 + i * 0.0001, lon: -92.3, ele: 200 + i, t: t0 + i * 10_000, acc: 6 }));
  const t0 = Date.UTC(2026, 4, 2, 15, 0, 5);
  const hike: Walk = {
    id: 'abc123', name: 'Rock <Bridge> & back', started: t0 - 5000, ended: t0 + 400_000, seconds: 220, length: 244, gain: 11,
    segments: [points(t0), points(t0 + 300_000, 11, 38.9012)],
    markers: [{ lat: 38.9005, lon: -92.3, ele: 205, t: t0 + 50_000, name: 'Spring' }],
    trail: { region: 'missouri', id: 't1', name: 'Rock Bridge' },
  };
  const saved: SavedTrail = { region: 'missouri', id: 't1', name: 'Rock Bridge', area: 'A park', length: 1200, gain: 30, difficulty: 'easy', loop: true, start: [38.9, -92.3], saved: 5 };

  it('writes everything and reads it back', () => {
    const text = backupText([hike], [saved], t0);
    expect(readBackup(text)).toEqual({ walks: [hike], saved: [saved] });
    expect(backupName(new Date(2026, 10, 6))).toBe('Switchback-backup-2026-11-06.json');
  });
  it('turns away what is not a backup, and leaves out what is broken inside one', () => {
    expect(readBackup('not json')).toBeNull();
    expect(readBackup('{"walks":[]}')).toBeNull();
    expect(readBackup('[1,2]')).toBeNull();
    const text = JSON.stringify({ app: 'switchback', walks: [hike, { id: 'x' }, null, { ...hike, id: 'short', segments: [[hike.segments[0][0]]] }], saved: [saved, { name: 'no id' }] });
    expect(readBackup(text)).toEqual({ walks: [hike], saved: [saved] });
  });
  it('reads a hike back from the GPX file it shared', () => {
    const back = readGpxHike(walkGpx(hike), 'file.gpx')!;
    expect(back.name).toBe(hike.name);
    expect(back.started).toBe(Math.floor(hike.started / 1000) * 1000);
    expect(back.segments.map((s) => s.length)).toEqual([12, 11]);
    expect(back.segments[0][3]).toMatchObject({ lat: hike.segments[0][3].lat, lon: -92.3, ele: 203, t: hike.segments[0][3].t });
    expect(back.seconds).toBe(210);
    expect(back.length).toBeGreaterThan(200);
    expect(back.markers).toEqual([{ lat: 38.9005, lon: -92.3, ele: 205, t: t0 + 50_000, name: 'Spring' }]);
    // the same file twice is the same hike
    expect(readGpxHike(walkGpx(hike), 'file.gpx')!.id).toBe(back.id);
  });
  it('does not take a trail line (no times) or other text for a hike', () => {
    expect(readGpxHike(trailGpx(trail('1')), 'trail.gpx')).toBeNull();
    expect(readGpxHike('hello', 'x.txt')).toBeNull();
    expect(readGpxHike('<gpx><trk><trkseg><trkpt lat="1" lon="2"><time>2026-05-02T15:00:00Z</time></trkpt></trkseg></trk></gpx>', 'x.gpx')).toBeNull();
  });
  it('names a hike after its file when the track has no name', () => {
    const text = '<gpx><trk><trkseg><trkpt lat="1" lon="2"><time>2026-05-02T15:00:00Z</time></trkpt><trkpt lat="1.001" lon="2"><time>2026-05-02T15:01:00Z</time></trkpt></trkseg></trk></gpx>';
    expect(readGpxHike(text, 'Sunday walk.gpx')).toMatchObject({ name: 'Sunday walk', started: Date.UTC(2026, 4, 2, 15), seconds: 60 });
  });
  it('only adds what is not here already', () => {
    const other: Walk = { ...hike, id: 'zzz', started: t0 + 86_400_000 };
    expect(newWalks([hike], [hike, other, other]).map((w) => w.id)).toEqual(['zzz']);
    // the same hike from its GPX file (another id, the same start) is not added twice
    expect(newWalks([hike], [readGpxHike(walkGpx(hike), 'f.gpx')!])).toEqual([]);
    expect(newSaved([saved], [saved, { ...saved, id: 't2' }, { ...saved, id: 't2' }]).map((s) => s.id)).toEqual(['t2']);
  });
  it('says what an import did', () => {
    expect(importSummary(2, 1, 0)).toBe('Added 2 hikes and 1 saved trail.');
    expect(importSummary(1, 0, 1)).toBe('Added 1 hike. 1 file was not a Switchback backup or a recorded GPX track.');
    expect(importSummary(0, 0, 0)).toBe('Nothing new: everything in there is already on this phone.');
    expect(importSummary(0, 0, 2)).toBe('2 files were not a Switchback backup or a recorded GPX track.');
  });
});
