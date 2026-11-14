import { encodePolyline, type Coord } from '@web/lib/polyline';
import { accessPoints, makeTrail, shortLoops, type Trail } from '@web/lib/trail';
import { chosenTrail, defaultStart, highlightLines, loopChoices, pickStart, shortName, startFeatures } from '../src/core/choice';
import { commonsTitle, credit, linkedTitles, photoFromPage, sampleSpots, sized } from '../src/core/photos';

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

describe('photos from Wikimedia Commons', () => {
  const page = (over: Record<string, unknown> = {}, title = 'File:Rock Bridge.jpg') => ({
    title,
    imageinfo: [{
      thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Rock_Bridge.jpg/960px-Rock_Bridge.jpg',
      descriptionurl: 'https://commons.wikimedia.org/wiki/File:Rock_Bridge.jpg', mime: 'image/jpeg', width: 4000, height: 3000,
      extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:X">Jane &amp; Co</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } },
      ...over,
    }],
  });
  it('reads a photo with its author and licence', () => {
    const p = photoFromPage(page())!;
    expect(p).toMatchObject({ id: 'File:Rock Bridge.jpg', author: 'Jane & Co', license: 'CC BY-SA 4.0', source: 'Wikimedia Commons' });
    expect(p.small).toBe('https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Rock_Bridge.jpg/250px-Rock_Bridge.jpg');
    expect(credit(p)).toBe('Jane & Co · CC BY-SA 4.0 · Wikimedia Commons');
  });
  it('leaves out maps, logos, small pictures and anything that is not a photo', () => {
    expect(photoFromPage(page({}, 'File:Park trail map.jpg'))).toBeNull();
    expect(photoFromPage(page({ mime: 'image/svg+xml' }))).toBeNull();
    expect(photoFromPage(page({ width: 320 }))).toBeNull();
    expect(photoFromPage({ title: 'File:X.jpg' })).toBeNull();
  });
  it('finds the files the tags point to', () => {
    expect(commonsTitle('https://commons.wikimedia.org/wiki/File:Devil%27s_Icebox.jpg')).toBe("File:Devil's Icebox.jpg");
    expect(commonsTitle('Category:Rock Bridge')).toBeNull();
    expect(linkedTitles({ wikimedia_commons: 'File:A.jpg', image: 'https://commons.wikimedia.org/wiki/File:A.jpg' })).toEqual(['File:A.jpg']);
    expect(sized('https://x/thumb/a/ab/A.jpg/960px-A.jpg', 250)).toBe('https://x/thumb/a/ab/A.jpg/250px-A.jpg');
  });
  it('samples places along the line', () => {
    const spots = sampleSpots(loop, 3);
    expect(spots).toHaveLength(3);
    for (const [lat, lon] of spots) { expect(lat).toBeGreaterThanOrEqual(38.9); expect(lon).toBeLessThanOrEqual(-92.295); }
  });
});
