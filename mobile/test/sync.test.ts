// How saved trails and hikes are stored on the Switchback server (src/core/syncFormat.ts), and, when
// SB_URL and SB_KEY are set, a round trip against a real server in throwaway collections (sbtest_*).
// (Node's own modules, loaded without its type definitions, which this app's tsconfig leaves out)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { execFileSync } = require('node:child_process') as { execFileSync: (cmd: string, args: string[]) => { toString(): string } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { writeFileSync } = require('node:fs') as { writeFileSync: (file: string, data: string) => void };
declare const process: { env: Record<string, string | undefined> };
import type { SavedTrail, Walk } from '@web/lib/storage';
import { compactWalk, trailRefOfWalk, decodeTrack, encodeTrack, expandWalk, trailDocId, trailKey, trailProblem, trailSubmission, uuid, validName, walkDocId } from '../src/core/syncFormat';

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
  test('a hike is sent in as a new trail the server takes', () => {
    const d = trailSubmission(longHike(), 'Test hike', { rating: 4, text: 'Nice' }, 'veryHard');
    expect(d.kind).toBe('new_trail');
    expect(d.difficulty).toBe('very_hard');
    expect(d.line.length).toBeLessThanOrEqual(200_000);
    expect(decodeTrack(d.line, 1e5).length).toBeGreaterThan(2);
    expect(d.note).toContain('★★★★☆');
    expect(d.note).toContain('spring (38.51000, -92.31000)');
    expect(d.note).toContain('public');
    expect(d.note.length).toBeLessThanOrEqual(2000);
  });
  test('a problem with a trail carries the trail, what is wrong and the walked line', () => {
    const w = longHike();
    const d = trailProblem(w, trailRefOfWalk(w)!, 'closed', ' Bridge out at the creek ');
    expect(d).toEqual(expect.objectContaining({ kind: 'correction', field: 'closed' }));
    expect(d.trail.id).toBe('missouri/r123');
    expect(decodeTrack(d.line, 1e5).length).toBeGreaterThan(2);
    expect(d.note.startsWith('It is closed.\n\nBridge out at the creek')).toBe(true);
    expect(d.note.length).toBeLessThanOrEqual(2000);
  });
  test('a very long hike is thinned to fit', () => {
    const w = longHike();
    const many = { ...w, segments: [Array.from({ length: 60000 }, (_, i) => ({ ...w.segments[0][i % 4000], lat: 38.5 + i * 1e-5 }))] };
    const d = trailSubmission(many, 'Long', null);
    expect(d.line.length).toBeLessThanOrEqual(200_000);
  });
  test('ids for new records are version 4 UUIDs', () => {
    const ids = new Set(Array.from({ length: 200 }, uuid));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

// ── Against a live server (server/: accounts) ─────────────────────────────────────────────────────────
// SB_URL is the server (e.g. http://localhost:8080 for one run with `go run ./cmd/switchback-api`). Each run
// creates two throwaway accounts.
const URL = process.env.SB_URL;
const live = URL ? describe : describe.skip;

live('live server', () => {
  const run = Date.now().toString(36);
  const call = (method: string, path: string, body?: unknown, token?: string): { status: number; json: any } => {
    const args = ['-sS', '-m', '60', '-X', method, '-w', '\n%{http_code}', `${URL}${path}`];
    if (token) args.push('-H', `Authorization: Bearer ${token}`);
    if (body !== undefined) {
      const file = `/tmp/sbtest-${run}-${Math.random().toString(36).slice(2)}.json`;
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
  const signUp = (who: string) => {
    const r = call('POST', '/v1/auth/register', { email: `${who}-${run}@example.com`, password: 'correct horse battery', display_name: who, device: 'test' });
    expect(r.status).toBe(200);
    return r.json.access_token as string;
  };

  test('register, log in, and the wrong password', () => {
    signUp('ann');
    expect(call('POST', '/v1/auth/register', { email: `ann-${run}@example.com`, password: 'another password' }).status).toBe(409);
    expect(call('POST', '/v1/auth/login', { email: `ann-${run}@example.com`, password: 'correct horse battery' }).status).toBe(200);
    expect(call('POST', '/v1/auth/login', { email: `ann-${run}@example.com`, password: 'wrong wrong' }).json.error.code).toBe('wrong_login');
  });

  test('a hike round-trips through your own documents, and nobody else sees it', () => {
    const me = signUp('bea'), other = signUp('cal');
    const first = call('GET', '/v1/me/docs/activities', undefined, me);
    expect(first.json.items).toEqual([]);
    const w = longHike();
    const id = walkDocId(w.id);
    expect(call('PUT', `/v1/me/docs/activities/${id}`, { v: 2, walk: compactWalk(w) }, me).status).toBe(200);
    const changed = call('GET', `/v1/me/docs/activities?since=${first.json.server_time}`, undefined, me).json;
    expect(changed.items.map((d: any) => d.id)).toEqual([id]);
    expect(expandWalk(changed.items[0].data.walk).segments.flat()).toHaveLength(7500);
    expect(call('GET', '/v1/me/docs/activities', undefined, other).json.items).toEqual([]);
    call('DELETE', `/v1/me/docs/activities/${id}`, undefined, me);
    const gone = call('GET', `/v1/me/docs/activities?since=${changed.server_time}`, undefined, me).json;
    expect(gone.items).toEqual([expect.objectContaining({ id, deleted: true, data: null })]);
  });

  test('a hike is accepted as a new-trail submission and listed as pending', () => {
    const me = signUp('dee');
    const id = uuid();
    const r = call('PUT', `/v1/submissions/${id}`, trailSubmission(longHike(), 'Test hike', { rating: 5, text: 'Lovely' }, 'moderate'), me);
    expect([200, 201]).toContain(r.status);
    const mine = call('GET', '/v1/me/submissions', undefined, me).json.submissions;
    expect(mine).toEqual([expect.objectContaining({ id, status: 'pending', kind: 'new_trail' })]);
  });

  test('a problem with a trail is accepted with its line, as a correction', () => {
    const me = signUp('fay');
    const w = longHike();
    const id = uuid();
    const r = call('PUT', `/v1/submissions/${id}`, trailProblem(w, trailRefOfWalk(w)!, 'line', 'The loop turns left at the creek now'), me);
    expect([200, 201]).toContain(r.status);
    expect(call('GET', '/v1/me/submissions', undefined, me).json.submissions).toEqual([expect.objectContaining({ id, status: 'pending', kind: 'correction' })]);
  });

  test('a review of a trail you hiked is public, one per person, and the owner can hide it', () => {
    const me = signUp('eve');
    const w = longHike();
    const ref = trailRefOfWalk(w)!;
    expect(ref.id).toBe('missouri/r123');
    const id = uuid();
    expect(call('PUT', `/v1/reviews/${id}`, { trail: ref, rating: 4, body: 'Muddy but lovely', hiked_on: '2026-11-01' }, me).status).toBe(201);
    expect(call('PUT', `/v1/reviews/${uuid()}`, { trail: ref, rating: 2, body: 'again' }, me).json.error.code).toBe('already_reviewed');
    expect(call('PUT', `/v1/reviews/${id}`, { trail: ref, rating: 5, body: 'Edited' }, me).status).toBe(200);
    // anyone can read it, without an account
    const pub = call('GET', `/v1/trails/reviews?trail=${encodeURIComponent(ref.id)}`).json;
    expect(pub.reviews).toEqual([expect.objectContaining({ id, rating: 5, body: 'Edited', display_name: 'eve' })]);
    expect(pub.stats).toEqual(expect.objectContaining({ reviews: 1, rating: 5 }));
    const admin = process.env.SB_ADMIN;
    if (!admin) return;
    expect(call('GET', '/v1/admin/reviews?status=shown', undefined, admin).json.reviews.some((r: any) => r.id === id && r.trail_name === 'Test trail')).toBe(true);
    expect(call('POST', `/v1/admin/reviews/${id}`, { hidden: true }, admin).status).toBe(200);
    expect(call('GET', `/v1/trails/reviews?trail=${encodeURIComponent(ref.id)}`).json.reviews).toEqual([]);
    expect(call('POST', `/v1/admin/reviews/${id}`, { hidden: false }, admin).status).toBe(200);
  });

  test('a photo on a hike of a trail shows publicly on that trail once uploaded', () => {
    const photos = process.env.SB_PHOTOS; // a folder with display.jpg and thumb.jpg (JPEG, no EXIF)
    if (!photos) return;
    const me = signUp('fay');
    const w = { ...longHike(), trail: { region: 'missouri', id: 'p' + run, name: 'Photo trail' } };
    const ref = trailRefOfWalk(w)!;
    const id = uuid();
    expect(call('PUT', `/v1/photos/${id}`, { walk_id: walkDocId(w.id), trail: ref, lat: 38.51, lon: -92.31, taken_at: new Date().toISOString() }, me).status).toBe(200);
    for (const size of ['display', 'thumb']) {
      const out = execFileSync('curl', ['-sS', '-o', '/dev/null', '-w', '%{http_code}', '-X', 'PUT', '-H', `Authorization: Bearer ${me}`,
        '-H', 'Content-Type: image/jpeg', '--data-binary', `@${photos}/${size}.jpg`, `${URL}/v1/photos/${id}/file?size=${size}`]).toString();
      expect(Number(out)).toBeLessThan(300);
    }
    const pub = call('GET', `/v1/trails/photos?trail=${encodeURIComponent(ref.id)}`).json.photos;
    expect(pub).toEqual([expect.objectContaining({ id, display_name: 'fay', status: 'ready' })]);
    expect(pub[0].url).toBeTruthy();
  });
});
