// How saved trails and hikes are stored on the Switchback server (src/core/syncFormat.ts), and, when
// SB_URL and SB_KEY are set, a round trip against a real server in throwaway collections (sbtest_*).
// (Node's own modules, loaded without its type definitions, which this app's tsconfig leaves out)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require('node:child_process') as { execFileSync: (cmd: string, args: string[]) => { toString(): string } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeFileSync } = require('node:fs') as { writeFileSync: (file: string, data: string) => void };
declare const process: { env: Record<string, string | undefined> };
import type { SavedTrail, Walk } from '@web/lib/storage';
import { compactWalk, decodeTrack, encodeTrack, expandWalk, submissionDoc, trailDocId, trailKey, validName, walkDocId } from '../src/core/syncFormat';

// a 30 km hike, a point every 4 m, in two stretches, with heights (some missing) and two marked spots
function longHike(): Walk {
  const n = 7500, t0 = 1794800000000;
  const pts = Array.from({ length: n }, (_, i) => ({
    lat: 38.5 + 0.000036 * i * Math.cos(i / 300), lon: -92.3 + 0.000036 * i * Math.sin(i / 300),
    ele: i % 97 ? Math.round((200 + 50 * Math.sin(i / 500)) * 10) / 10 : null, t: t0 + i * 2500, acc: 5 + (i % 7),
  }));
  return {
    id: 'mhx3k2abc123', name: 'Test hike', started: t0, ended: t0 + n * 2500, seconds: 18000, length: 30000, gain: 812,
    trail: { region: 'missouri', id: 'r123', name: 'Test trail' },
    segments: [pts.slice(0, 4000), pts.slice(4000)],
    markers: [{ lat: 38.51, lon: -92.31, ele: 210, t: t0 + 600000, name: 'spring' }, { lat: 38.52, lon: -92.32, ele: null, t: t0 + 900000, name: 'junction' }],
  };
}

describe('document ids', () => {
  const trail = (region: string, id: string) => ({ region, id }) as SavedTrail;
  test('plain trail ids stay readable', () => {
    expect(trailDocId(trailKey(trail('missouri', 'r12345')))).toBe('t.missouri.r12345');
  });
  test.each([['missouri', 'u123|456'], ['own', 'a.b'], ['missouri', 'x'.repeat(200)], ['new-york', 'w1/2']])('%s %s is hashed to a valid id', (r, id) => {
    const d = trailDocId(trailKey(trail(r, id)));
    expect(d).toMatch(/^h\.[0-9a-f]{28}$/);
    expect(validName(d)).toBe(true);
  });
  test('different trails never share an id', () => {
    const ids = ['a|b', 'a|c', 'b|a', 'a.b', 'a_b'].map((id) => trailDocId(`own/${id}`));
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('hike ids', () => {
    expect(walkDocId('mhx3k2abc123')).toBe('w.mhx3k2abc123');
    expect(validName(walkDocId('mhx3k2abc123'))).toBe(true);
  });
});

describe('compact hikes', () => {
  test('a line round-trips within 0.2 m', () => {
    const pts = longHike().segments[0];
    const back = decodeTrack(encodeTrack(pts));
    expect(back).toHaveLength(pts.length);
    expect(Math.max(...back.map(([la, lo], i) => Math.abs(la - pts[i].lat) + Math.abs(lo - pts[i].lon)))).toBeLessThan(2e-6);
  });
  test('a 30 km hike is well under the 2 MB limit, and comes back the same', () => {
    const w = longHike();
    const body = JSON.stringify({ v: 2, walk: compactWalk(w) });
    expect(body.length).toBeLessThan(400_000);
    const back = expandWalk(JSON.parse(body).walk);
    expect(back.name).toBe(w.name);
    expect(back.markers).toEqual(w.markers);
    expect(back.segments.map((s) => s.length)).toEqual([4000, 3500]);
    const a = w.segments[1][123], b = back.segments[1][123];
    expect(Math.abs(a.lat - b.lat)).toBeLessThan(1e-6);
    expect(b.ele).toBe(a.ele);
    expect(Math.abs(b.t - a.t)).toBeLessThanOrEqual(100);
    expect(back.segments[0][97].ele).toBeNull();
  });
  test('a submission has the shape the review page reads', () => {
    const d = submissionDoc(longHike(), 'Test hike', { rating: 4, text: 'Nice' }, 'test', 1794900000000);
    expect(d.status).toBe('pending');
    expect(d.public_use_consent).toBe(true);
    expect(d.hike.points.map((p) => p.note)).toEqual(['spring', 'junction']);
    expect(d.hike.segments).toHaveLength(2);
    expect(d.gpx).toContain('<sb:kind>walked</sb:kind>');
    expect(JSON.stringify(d).length).toBeLessThan(2_000_000);
  });
});

// ── Against a live server ─────────────────────────────────────────────────────────────────────────────
const URL = process.env.SB_URL, KEY = process.env.SB_KEY;
const live = URL && KEY ? describe : describe.skip;

live('live server', () => {
  const run = Date.now().toString(36);
  const T = `sbtest_${run}_saved_trails`, A = `sbtest_${run}_activities`;
  // plain curl, as the manual checks used (the tunnel in front of the server turns some clients away)
  const call = (method: string, path: string, body?: unknown, auth = true): { status: number; json: any } => {
    const args = ['-sS', '-m', '60', '-X', method, '-w', '\n%{http_code}', `${URL}${path}`];
    if (auth) args.push('-H', `Authorization: Bearer ${KEY}`);
    if (body !== undefined) {
      const file = `/tmp/sbtest-${run}.json`;
      writeFileSync(file, JSON.stringify(body));
      args.push('-H', 'Content-Type: application/json', '--data-binary', `@${file}`);
    }
    const out = execFileSync('curl', args).toString();
    const at = out.lastIndexOf('\n');
    const text = out.slice(0, at);
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: Number(out.slice(at + 1)), json };
  };
  afterAll(() => {
    for (const [c, id] of [[T, trailDocId('own/a|b')], [A, walkDocId('mhx3k2abc123')]]) call('DELETE', `/v1/${c}/${id}`);
  });

  test('health, and a key is needed', () => {
    expect(call('GET', '/health', undefined, false).json).toBe('ok');
    expect(call('GET', `/v1/${T}`, undefined, false).status).toBe(401);
  });

  test('first sync, upload, the since feed, a rename elsewhere, and a deletion', () => {
    const first = call('GET', `/v1/${A}`);
    expect(first.status).toBe(200);
    expect(first.json.items).toEqual([]);
    const since = first.json.server_time;

    const w = longHike();
    const id = walkDocId(w.id);
    expect(call('PUT', `/v1/${A}/${id}`, { v: 2, walk: compactWalk(w) }).status).toBe(200);
    const own = { region: 'own', id: 'a|b', walk: 'a|b', name: 'Mine', area: null, length: 1, gain: 0, difficulty: 'easy', loop: false, start: [38, -92], saved: 1 };
    expect(call('PUT', `/v1/${T}/${trailDocId('own/a|b')}`, { v: 2, trail: own }).status).toBe(200);

    const changed = call('GET', `/v1/${A}?since=${since}`).json;
    expect(changed.items.map((d: any) => d.id)).toEqual([id]);
    const back = expandWalk(changed.items[0].data.walk);
    expect(back.segments.flat()).toHaveLength(7500);
    expect(back.markers).toEqual(w.markers);
    expect(call('GET', `/v1/${A}?since=${changed.server_time}`).json.items).toEqual([]);
    expect(call('GET', `/v1/${T}`).json.items[0].data.trail).toEqual(own);

    // another phone renames it: the whole document is replaced, and the change comes through the feed
    call('PUT', `/v1/${A}/${id}`, { v: 2, walk: compactWalk({ ...w, name: 'Renamed on the other phone' }) });
    const renamed = call('GET', `/v1/${A}?since=${changed.server_time}`).json;
    expect(renamed.items[0].data.walk.name).toBe('Renamed on the other phone');

    call('DELETE', `/v1/${A}/${id}`);
    const gone = call('GET', `/v1/${A}?since=${renamed.server_time}`).json;
    expect(gone.items).toEqual([expect.objectContaining({ id, deleted: true, data: null })]);
    expect(call('GET', `/v1/${A}/${id}`).status).toBe(404);
  });

  test('a submission is accepted as the app builds it', () => {
    const d = submissionDoc(longHike(), 'Test hike', { rating: 4, text: 'Nice' }, 'test');
    const sid = `sbtest-${run}`;
    expect(call('PUT', `/v1/sbtest_${run}_submissions/${sid}`, d).status).toBe(200);
    expect(call('GET', `/v1/sbtest_${run}_submissions/${sid}`).json.data).toEqual(d);
    call('DELETE', `/v1/sbtest_${run}_submissions/${sid}`);
    // for the review page check
    if (process.env.SB_DOC_OUT) writeFileSync(process.env.SB_DOC_OUT, JSON.stringify(d));
  });
});
