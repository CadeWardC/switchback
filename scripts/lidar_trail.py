#!/usr/bin/env python3
"""Does the ground show a trail where a line says there is one? And where exactly does it run?

    lidar_trail.py <line.geojson|file.gpx> [--picture out.png] [--write snapped.geojson]

Uses the USGS 3D Elevation Program's 1 m lidar heights (public domain; United States only, and only where 1 m data
exists). A footpath is a groove or bench a metre or two wide and a few centimetres deep: invisible in an ordinary
hillshade, but it stands out once the shape of the hill is subtracted (a "local relief" picture).

The line is taken in pieces of about 400 m. For each piece:
  1. the cheapest way from one end to the other is found inside a corridor around the line, where walking along a
     groove is cheap and crossing plain ground is dear. That is the line "snapped" to the ground: the points given
     can be sparse, or a few metres off (within 15 m of the trail);
  2. the same is done for the line pushed 50 m aside in eight directions, where there should be no trail. If the
     real corridor is clearly cheaper than all of those, the ground shows a trail there.

Then all the pieces are weighed together: one piece of footpath is easy to miss, a mile of it is not.

Prints, per piece and overall, whether the lidar agrees. This is evidence, not proof: flat or rocky ground, a new
trail, or dense brush in the lidar leave no groove (it agrees with about four real trails in ten), and an old
road bed, a ditch or an ATV track leaves one where nobody hikes. So a trail is never added on this alone
(docs/SUBMISSIONS.md).

Needs numpy and Pillow.
"""
import argparse, heapq, io, json, math, os, sys, time, urllib.parse, urllib.request

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import verify_submission as vs  # noqa: E402

SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
PIECE_M = 400
MARGIN_M = 90        # room around a piece for the pushed-aside copies
SHIFT_M = 50
HALF_M = 15          # the corridor: this far either side of the line
AGREE_Z = 1.5        # the real corridor must be this many spreads cheaper than the pushed-aside ones, and cheaper
                     # than every one of them. Tried on Missouri (November 2026) with 15 m either side: of 47
                     # pieces of ground where we have no trail it agreed with 1; of 60 pieces of trails official
                     # lists confirm, with 25 (42%). So "agrees" is strong evidence and "does not agree" says
                     # little. With 30 m either side it is no use (8 of 60, and 2 of 47): keep points near the trail.

WHOLE_Z = 2.0        # ...and for a whole line, all its pieces together (see evidence). Tried on 40 Missouri trails of
                     # half a mile to a mile and a half that official lists confirm: it agreed with 16 as mapped
                     # (40%) and with 17 when given only a point every 60 m, each 5 m off (42%); and with none of
                     # 11 copies of those lines pushed 220 m aside onto ground where we have no trail.

class Ground:
    """1 m heights for a box, and how cheap each square metre is to walk along (cheap in a groove)."""

    def __init__(self, south, west, north, east):
        self.s, self.w, self.n, self.e = south, west, north, east
        k = math.cos(math.radians((south + north) / 2)) * 111320
        self.W = max(8, round((east - west) * k))
        self.H = max(8, round((north - south) * 111320))
        q = urllib.parse.urlencode({
            "bbox": f"{west},{south},{east},{north}", "bboxSR": 4326, "imageSR": 4326, "size": f"{self.W},{self.H}",
            "format": "tiff", "pixelType": "F32", "interpolation": "RSP_BilinearInterpolation",
            "renderingRule": json.dumps({"rasterFunction": "None"}), "f": "image"})
        req = urllib.request.Request(SERVICE + "?" + q, headers={"User-Agent": "Switchback trail checks (github.com/CadeWardC/switchback)"})
        for attempt in range(4):
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    z = np.array(Image.open(io.BytesIO(r.read())), dtype=np.float64)
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
        if z.shape != (self.H, self.W):
            raise ValueError("the elevation service sent a picture of the wrong size")
        self.ok = bool(np.isfinite(z).all() and z.max() - z.min() > 0.01 and z.min() > -500)
        self.relief = z - blur(z, 3)
        # a groove only helps someone walking ALONG it: one cost for each of the four ways a step can point
        # (east-west, north-south and the two diagonals), from the groove measured across that way
        across = {(1, 0): (0, 1), (0, 1): (1, 0), (1, 1): (1, -1), (1, -1): (1, 1)}
        strength = {step: groove(self.relief, cross) for step, cross in across.items()}
        scale = max(float(np.percentile(np.maximum.reduce(list(strength.values())), 90)), 1e-6)
        self.costs = {step: 1 / (0.15 + np.minimum(g / scale, 3)) for step, g in strength.items()}
        # is this really 1 m data? Coarser data resampled to 1 m is smooth: almost no small bumps at all
        self.fine = float(np.percentile(np.abs(self.relief), 75)) > 0.004

    def xy(self, p):
        return ((p[1] - self.w) / (self.e - self.w) * self.W, (self.n - p[0]) / (self.n - self.s) * self.H)

    def latlon(self, x, y):
        return (self.n - (y + 0.5) / self.H * (self.n - self.s), self.w + (x + 0.5) / self.W * (self.e - self.w))

    def cheapest(self, line, half):
        """The cheapest way along the line's corridor: (cost a metre, [(lat, lon)]), or None if it leaves the box."""
        pts = [self.xy(p) for p in vs.every(line, 2)]
        mask = np.zeros((self.H, self.W), bool)
        for x, y in pts:
            x0, y0 = int(x), int(y)
            if not (0 <= x0 < self.W and 0 <= y0 < self.H):
                return None
            mask[max(0, y0 - half):y0 + half + 1, max(0, x0 - half):x0 + half + 1] = True
        (sx, sy), (ex, ey) = (int(pts[0][0]), int(pts[0][1])), (int(pts[-1][0]), int(pts[-1][1]))
        best, prev, heap = {(sx, sy): 0.0}, {}, [(0.0, sx, sy)]
        c = self.costs
        steps = ((1, 0, 1, c[(1, 0)]), (-1, 0, 1, c[(1, 0)]), (0, 1, 1, c[(0, 1)]), (0, -1, 1, c[(0, 1)]),
                 (1, 1, 1.414, c[(1, 1)]), (-1, -1, 1.414, c[(1, 1)]), (1, -1, 1.414, c[(1, -1)]), (-1, 1, 1.414, c[(1, -1)]))
        while heap:
            c0, x, y = heapq.heappop(heap)
            if (x, y) == (ex, ey):
                break
            if c0 > best[(x, y)]:
                continue
            for dx, dy, step, cost in steps:
                X, Y = x + dx, y + dy
                if 0 <= X < self.W and 0 <= Y < self.H and mask[Y, X]:
                    nc = c0 + cost[Y, X] * step
                    if nc < best.get((X, Y), 1e18):
                        best[(X, Y)] = nc
                        prev[(X, Y)] = (x, y)
                        heapq.heappush(heap, (nc, X, Y))
        if (ex, ey) not in best:
            return None
        path = [(ex, ey)]
        while path[-1] != (sx, sy):
            path.append(prev[path[-1]])
        path.reverse()
        metres = sum(math.hypot(a[0] - b[0], a[1] - b[1]) for a, b in zip(path, path[1:])) or 1
        return best[(ex, ey)] / metres, [self.latlon(x, y) for x, y in path]

def blur(a, r):
    for _ in range(2):
        p = np.pad(a, r, mode="edge")
        c = np.pad(np.cumsum(np.cumsum(p, 0), 1), ((1, 0), (1, 0)))
        k = 2 * r + 1
        a = (c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]) / (k * k)
    return a

def groove(f, cross, k=2):
    """How much lower each square metre is than the ground 2 m either side of it, measured across `cross`: a
    narrow groove running the other way, or the inside of a bench cut into a slope."""
    dx, dy = cross
    a, b = np.roll(f, (k * dy, k * dx), (0, 1)), np.roll(f, (-k * dy, -k * dx), (0, 1))
    return np.maximum(np.minimum(a, b) - f, 0)

def pieces(line, size=PIECE_M):
    """The line cut into pieces of about `size` metres."""
    total = vs.length(line)
    n = max(1, round(total / size))
    dense = vs.every(line, 5)
    if dense[-1] != line[-1]:
        dense.append(line[-1])
    step = max(2, math.ceil(len(dense) / n))
    out = [dense[i:i + step + 1] for i in range(0, len(dense) - 1, step)]
    return [p for p in out if len(p) >= 2 and vs.length(p) >= 40]

def shifted(line, north_m, east_m):
    k = math.cos(math.radians(line[0][0])) * 111320
    return [(p[0] + north_m / 111320, p[1] + east_m / k) for p in line]

def look(piece, half=HALF_M):
    """One piece against the ground: {agrees, z, cost, others, line (snapped), ground, why}."""
    lats, lons = [p[0] for p in piece], [p[1] for p in piece]
    k = math.cos(math.radians(lats[0])) * 111320
    m = MARGIN_M + half
    ground = Ground(min(lats) - m / 111320, min(lons) - m / k, max(lats) + m / 111320, max(lons) + m / k)
    out = {"agrees": False, "ground": ground, "line": piece, "z": None}
    if not ground.ok or not ground.fine:
        out["why"] = "no 1 m lidar here"
        return out
    real = ground.cheapest(piece, half)
    if not real:
        out["why"] = "the line could not be followed"
        return out
    d = SHIFT_M * 0.707
    others, each = [], []
    for north, east in ((SHIFT_M, 0), (-SHIFT_M, 0), (0, SHIFT_M), (0, -SHIFT_M), (d, d), (-d, -d), (d, -d), (-d, d)):
        r = ground.cheapest(shifted(piece, north, east), half)
        each.append(r[0] if r else None)
        if r:
            others.append(r[0])
    if len(others) < 6:
        out["why"] = "not enough ground around it to compare"
        return out
    out["given"] = piece
    spread = float(np.std(others)) or 1e-6
    z = (float(np.mean(others)) - real[0]) / spread
    out.update(z=round(z, 1), cost=round(real[0], 2), others=[round(o, 2) for o in sorted(others)], line=real[1],
               each=each,
               agrees=bool(z >= AGREE_Z and real[0] < min(others)))
    out["why"] = "a groove runs along it" if out["agrees"] else "the ground beside it looks the same"
    return out

def evidence(line, half=HALF_M, report=None):
    """The whole line: {agrees, z (all its pieces together against the ground beside them), share (of its length
    in pieces that agree on their own), checked (share with 1 m lidar), line (snapped where a piece agrees, or
    everywhere when the whole agrees), pieces}."""
    results, total, agreed, checked = [], 0.0, 0.0, 0.0
    real, beside = 0.0, [0.0] * 8
    for piece in pieces(line):
        length = vs.length(piece)
        try:
            r = look(piece, half)
        except Exception as ex:
            r = {"agrees": False, "z": None, "why": f"the elevation service failed ({ex})", "line": piece, "ground": None}
        r["length"] = length
        total += length
        if r["z"] is not None:
            checked += length
            real += r["cost"] * length
            mean = sum(o for o in r["each"] if o is not None) / sum(o is not None for o in r["each"])
            beside = [b + (o if o is not None else mean) * length for b, o in zip(beside, r["each"])]
        if r["agrees"]:
            agreed += length
        results.append(r)
        if report:
            report(f"  {length:4.0f} m  {'agrees ' if r['agrees'] else 'no     '} z={r['z']}  {r['why']}")
    # every piece together: one piece of footpath is easy to miss, a mile of it is not
    z, whole = None, False
    if checked >= 0.8 * total and checked > 0:
        spread = float(np.std(beside)) or 1e-6
        z = (float(np.mean(beside)) - real) / spread
        whole = bool(z >= WHOLE_Z and real < min(beside))
    snapped = []
    for r in results:
        part = vs.simplify(r["line"], 2.0) if (r["agrees"] or (whole and r["z"] is not None and r["z"] > 0)) else r["line"]
        snapped += part if not snapped else part[1:]
    return {"agrees": whole, "z": None if z is None else round(z, 1), "share": agreed / total if total else 0,
            "checked": checked / total if total else 0, "line": snapped, "pieces": results}

def picture(result, path):
    """The local relief picture of each piece, with the line as given (red) and as snapped (green)."""
    tiles = []
    for r in result["pieces"]:
        g = r.get("ground")
        if g is None:
            continue
        v = np.clip(g.relief / 0.25, -1, 1)
        im = Image.fromarray(((v + 1) * 127.5).astype(np.uint8)).convert("RGB").resize((g.W * 2, g.H * 2), Image.BILINEAR)
        draw = ImageDraw.Draw(im)
        if r["agrees"]:
            draw.line([tuple(2 * c for c in g.xy(p)) for p in r["line"]], fill=(40, 200, 80), width=1)
        tiles.append(im)
    if not tiles:
        return
    sheet = Image.new("RGB", (max(t.width for t in tiles), sum(t.height for t in tiles) + 6 * len(tiles)), "white")
    y = 0
    for t in tiles:
        sheet.paste(t, (0, y))
        y += t.height + 6
    sheet.save(path)

def read_line(path):
    if path.lower().endswith((".geojson", ".json")):
        g = json.load(open(path))
        g = g["features"][0] if g.get("type") == "FeatureCollection" else g
        geom = g.get("geometry", g)
        coords = geom["coordinates"] if geom["type"] == "LineString" else max(geom["coordinates"], key=len)
        return [(c[1], c[0]) for c in coords]
    sub = vs.read_gpx(vs.raw_bytes(path))
    return [(p[0], p[1]) for p in max(sub["segments"], key=len)]

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("file")
    ap.add_argument("--picture", help="write the lidar picture of each piece here (PNG)")
    ap.add_argument("--write", help="write the line snapped to the ground here (GeoJSON)")
    a = ap.parse_args()
    line = read_line(a.file)
    print(f"{vs.length(line):.0f} m, {len(line)} points")
    r = evidence(line, report=print)
    print(f"All together: z={r['z']}: the lidar {'shows a trail along this line' if r['agrees'] else 'does not show a trail here'}"
          f" ({100 * r['checked']:.0f}% of it has 1 m lidar)")
    if a.picture:
        picture(r, a.picture)
    if a.write:
        json.dump({"type": "Feature", "properties": {"lidar_z": r["z"], "lidar_agrees": r["agrees"]},
                   "geometry": {"type": "LineString", "coordinates": [[round(p[1], 6), round(p[0], 6)] for p in r["line"]]}},
                  open(a.write, "w"))
    return 0 if r["agrees"] else 1

if __name__ == "__main__":
    sys.exit(main())
