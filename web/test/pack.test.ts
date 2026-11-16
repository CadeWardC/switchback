import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodeInts, decodePolyline, encodePolyline } from '../src/lib/polyline';
import { cellKeyOf, cellKeys, openPack, readBlock, regionCovers, type Region } from '../src/lib/pack';
import { difficultyOf, estimatedSeconds, isHikeTags, makeTrail, unpackProfile, type RawTrail } from '../src/lib/trail';
import { lineLength } from '../src/lib/geo';
import { buildGpx } from '../src/lib/gpx';
import { submissionGpx } from '../src/lib/submit';

describe('polyline', () => {
  it("decodes Google's documented example", () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]);
  });
  it('round-trips', () => {
    const line: [number, number][] = [[38.87123, -92.32456], [38.87, -92.3], [-12.5, 170.00001], [0, 0]];
    expect(decodePolyline(encodePolyline(line))).toEqual(line);
  });
  it('decodes signed integers', () => {
    expect(decodeInts('?')).toEqual([0]);
    expect(decodeInts('A@C')).toEqual([1, -1, 2]);
    expect(decodeInts('')).toEqual([]);
  });
});

describe('elevation', () => {
  it('unpacks (steps, metres) deltas', () => {
    // from Hinkson Creek Trail in the Missouri file
    const p = unpackProfile({ s: 10.09, p: '?sK[Nq@@EQA?SBc@SIIg@A', g: 16, l: 6, mn: 193, mx: 216 })!;
    expect(p.distances[0]).toBe(0);
    expect(p.elevations[0]).toBe(202);
    expect(p.distances.at(-1)).toBeGreaterThan(900);
    expect(p.distances.at(-1)).toBeLessThan(1000);
    expect(Math.max(...p.elevations)).toBeLessThanOrEqual(216);
    expect(Math.min(...p.elevations)).toBeGreaterThanOrEqual(193);
    expect(p.gain).toBe(16);
  });
});

describe('rules shared with the apps', () => {
  it('difficulty from length and climb', () => {
    expect(difficultyOf(3000, 100, {})).toBe('easy');
    expect(difficultyOf(8000, 0, {})).toBe('moderate');
    expect(difficultyOf(10000, 700, {})).toBe('hard');
    expect(difficultyOf(20000, 1000, {})).toBe('veryHard');
    expect(difficultyOf(1000, 0, { sac_scale: 'demanding_mountain_hiking' })).toBe('hard');
    expect(difficultyOf(1000, 0, { 'usfs:trail_class': 'TC1' })).toBe('moderate');
  });
  it('which trails are hikes', () => {
    expect(isHikeTags({})).toBe(true);
    expect(isHikeTags({ 'switchback:hike': 'no' })).toBe(false);
    expect(isHikeTags({ 'switchback:side': 'yes' })).toBe(false);
    expect(isHikeTags({ 'switchback:unnamed': 'yes' })).toBe(false);
  });
  it("Naismith's rule", () => {
    expect(estimatedSeconds({ length: 4500, profile: null })).toBe(3600);
  });
});

describe('regions and cells', () => {
  const r: Region = { region: 'x', version: '1', bbox: [36, -96, 41, -89], coverage: ['38_-93'] };
  it('covers only where it has trails', () => {
    expect(regionCovers(r, [38.8, -92.4, 38.9, -92.3])).toBe(true);
    expect(regionCovers(r, [36.1, -90.4, 36.2, -90.3])).toBe(false);
    expect(regionCovers(r, [50, -92.4, 51, -92.3])).toBe(false);
  });
  it('names cells by row and column', () => {
    expect(cellKeyOf(38.87, -92.32, 0.25)).toBe('155_-370');
    expect(cellKeys([38.7, -92.6, 38.9, -92.3], 0.25)).toEqual(['154_-371', '154_-370', '155_-371', '155_-370']);
  });
});

describe('GPX', () => {
  it('escapes names and writes points', () => {
    const text = buildGpx({ creator: 'test', name: 'A & B <loop>', tracks: [{ name: 'A & B', segments: [[{ lat: 1, lon: 2, ele: 3 }]] }] });
    expect(text).toContain('<name>A &amp; B &lt;loop&gt;</name>');
    expect(text).toContain('<trkpt lat="1.0000000" lon="2.0000000"><ele>3.0</ele></trkpt>');
  });
  it('writes the shared submission format', () => {
    const t = Date.UTC(2026, 10, 12, 14, 1, 2);
    const text = submissionGpx({
      name: 'Bluff Loop', notes: 'Rocky near the top.', kind: 'walked', publicAccess: true, lengthMetres: 20,
      points: [{ lat: 38.8712345, lon: -92.3212345, ele: 231.4, time: t }, { lat: 38.8713, lon: -92.3213, ele: null, time: t + 5000 }],
    }, t);
    expect(text).toContain('xmlns:sb="https://github.com/CadeWardC/switchback/submission/1"');
    expect(text).toContain('<sb:kind>walked</sb:kind>');
    expect(text).toMatch(/<sb:app>web \S+<\/sb:app>/);
    expect(text).toContain('<sb:access>public</sb:access>');
    expect(text).toContain('<desc>Rocky near the top.</desc>');
    expect(text).toContain('<trkpt lat="38.8712345" lon="-92.3212345"><ele>231.4</ele><time>2026-11-12T14:01:02Z</time></trkpt>');
    expect(text).toContain('<trkpt lat="38.8713000" lon="-92.3213000"><time>2026-11-12T14:01:07Z</time></trkpt>');
    const placed = submissionGpx({ name: 'X', notes: '', kind: 'placed', publicAccess: true, lengthMetres: 20, points: [{ lat: 1, lon: 2, time: t }] }, t);
    expect(placed).toContain('<sb:kind>placed</sb:kind>');
    expect(placed).toContain('<trkpt lat="1.0000000" lon="2.0000000"/>');
  });
});

// The real Missouri file, when it has been copied in for development (public/data is not in git).
const file = fileURLToPath(new URL('../public/data/missouri.trails', import.meta.url));
describe.skipIf(!existsSync(file))('the Missouri trail file', () => {
  const pack = existsSync(file) ? openPack(new Uint8Array(readFileSync(file))) : null!;

  it('has a header with 0.25° cells', () => {
    expect(pack.header.cell).toBe(0.25);
    expect(Object.keys(pack.header.cells).length).toBeGreaterThan(100);
    expect(pack.header.version).toMatch(/^\d{8,}/);
  });

  it('unpacks every block into trails that make sense', async () => {
    let trails = 0, hikes = 0, highlights = 0, withElevation = 0;
    for (const key of Object.keys(pack.header.cells)) {
      if (key.startsWith('p:')) {
        const rows = (await readBlock<unknown[][]>(pack, key))!;
        highlights += rows.length;
        expect(rows.every((r) => r.length >= 6 && typeof r[2] === 'string')).toBe(true);
        continue;
      }
      const [row, col] = key.split('_').map(Number);
      for (const raw of (await readBlock<RawTrail[]>(pack, key))!) {
        const t = makeTrail('missouri', raw)!;
        expect(t, raw.id).not.toBeNull();
        trails++;
        if (t.isHike) hikes++;
        // stored in the cell where it starts
        expect(Math.floor(t.start[0] / 0.25)).toBe(row);
        expect(Math.floor(t.start[1] / 0.25)).toBe(col);
        // inside Missouri, give or take
        expect(t.start[0]).toBeGreaterThan(35.5);
        expect(t.start[0]).toBeLessThan(41);
        expect(t.start[1]).toBeGreaterThan(-96.5);
        expect(t.start[1]).toBeLessThan(-88.5);
        // the stored length matches the decoded main line (within a tenth, or 30 m)
        const measured = lineLength(t.path);
        // (a trail network's length is all of its trails, not just the main line)
        if (t.tags['switchback:network'] !== 'yes') {
          expect(Math.abs(measured - t.length), `${t.id}: ${measured} vs ${t.length}`).toBeLessThan(Math.max(30, t.length * 0.1));
        }
        if (t.profile) {
          withElevation++;
          expect(Math.abs(t.profile.distances.at(-1)! - measured)).toBeLessThan(Math.max(40, measured * 0.1));
          expect(Math.max(...t.profile.elevations)).toBeLessThanOrEqual(t.profile.max + 1);
          expect(Math.min(...t.profile.elevations)).toBeGreaterThanOrEqual(t.profile.min - 1);
        }
      }
    }
    expect(trails).toBeGreaterThan(2000);
    expect(hikes).toBeGreaterThan(1000);
    expect(hikes).toBeLessThan(trails);
    expect(withElevation).toBeGreaterThan(trails * 0.9);
    expect(highlights).toBeGreaterThan(500);
  });

  it('finds Rock Bridge trails in their cell', async () => {
    const rows = (await readBlock<RawTrail[]>(pack, cellKeyOf(38.87, -92.32, 0.25)))!;
    const areas = new Set(rows.map((r) => r.tags?.['switchback:area']));
    expect([...areas].some((a) => a?.includes('Rock Bridge'))).toBe(true);
  });
});
