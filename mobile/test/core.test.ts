import { deflateSync, strToU8 } from 'fflate';
import { encodePolyline, type Coord } from '@web/lib/polyline';
import { makeTrail, type Trail } from '@web/lib/trail';
import { openPack, readBlock, cellKeys } from '../src/core/pack';
import { shapePath, split } from '../src/core/shape';
import { bigTime, clock, climbedSoFar, daylight, dur, grouped, hm, pace } from '../src/core/hikeMath';
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
