#!/usr/bin/env python3
"""Checks a trail someone sent in before any pack may take it (docs/SUBMISSIONS.md).

    verify_submission.py <file.gpx|.gpx.txt|.gz|.zip> [--pack <region>.trails] [--region <id>]
                         [--wanted <region>.wanted.json] [--out data/submissions]

Prints a report. Exits 0 when every check passes (verified), 2 when the trail is likely real but something is
unsure (needs verification), 1 otherwise. With --out, the trail is cleaned (stops and GPS scatter removed,
simplified to 4 m, an out-and-back walked twice folded into one line) and written as
<out>/verified/<region>/<name>.geojson or <out>/needs-verification/<region>/<name>.geojson, with what was checked
and an empty "approved_by" for a maintainer to fill in.
The times of the walk are not kept: only its date.

Needs nothing but Python. The file is read as data: no entity or network lookups.
"""
import argparse, gzip, io, json, math, os, re, statistics, sys, zipfile, zlib
from datetime import datetime, timezone
from xml.etree import ElementTree

MIN_LENGTH_M = 400
MIN_POINTS = 30
WALK_KMH = 9          # the middle speed of someone on foot stays under this
FAST_KMH = 20         # faster than this is a bike or a car
FAST_SHARE = 0.05
JUMP_M = 150          # two points in a row this far apart: the recording lost the sky
STILL_MS = 0.3        # slower than this is standing still; what the GPS draws meanwhile is scatter
STILL_SHARE = 0.10
NEAR_M = 15           # this close to a trail we already have is the same trail
KNOWN_SHARE = 0.80
SIMPLIFY_M = 4.0
MAX_BYTES = 20_000_000
PLACEHOLDERS = {"", "trail", "path", "hike", "walk", "myhike", "mywalk", "mytrail", "untitled", "unnamed", "test",
                "newtrail", "track", "route", "recording", "morninghike", "afternoonhike", "eveninghike",
                "morningwalk", "afternoonwalk", "eveningwalk"}

# ---------------------------------------------------------------- geometry

def dist(a, b):
    la1, la2 = math.radians(a[0]), math.radians(b[0])
    dla, dlo = la2 - la1, math.radians(b[1] - a[1])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * 6371000 * math.asin(min(1, math.sqrt(h)))

def length(pts):
    return sum(dist(pts[i - 1], pts[i]) for i in range(1, len(pts)))

def seg_dist(p, a, b):
    k = math.cos(math.radians(p[0])) * 111320
    ax, ay = (a[1] - p[1]) * k, (a[0] - p[0]) * 111320
    bx, by = (b[1] - p[1]) * k, (b[0] - p[0]) * 111320
    dx, dy = bx - ax, by - ay
    l2 = dx * dx + dy * dy
    t = 0 if l2 == 0 else max(0, min(1, -(ax * dx + ay * dy) / l2))
    return math.hypot(ax + t * dx, ay + t * dy)

def simplify(pts, tol=SIMPLIFY_M):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        worst, at = 0, None
        for i in range(a + 1, b):
            d = seg_dist(pts[i], pts[a], pts[b])
            if d > worst:
                worst, at = d, i
        if at is not None and worst > tol:
            keep[at] = True
            stack += [(a, at), (at, b)]
    return [p for p, k in zip(pts, keep) if k]

def every(pts, step):
    """Points along the line, one every `step` metres."""
    out, left = [pts[0]], step
    for a, b in zip(pts, pts[1:]):
        d = dist(a, b)
        while d >= left and d > 0:
            t = left / d
            a = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            out.append(a)
            d -= left
            left = step
        left -= d
    return out

class Grid:
    """Line pieces by ~110 m square, to ask how far a point is from any of them."""
    SIZE = 0.001

    def __init__(self):
        self.cells = {}

    def add(self, line):
        for a, b in zip(line, line[1:]):
            n = max(1, int(dist(a, b) / 60) + 1)
            seen = set()
            for i in range(n + 1):
                t = i / n
                k = (int(math.floor((a[0] + (b[0] - a[0]) * t) / self.SIZE)),
                     int(math.floor((a[1] + (b[1] - a[1]) * t) / self.SIZE)))
                if k not in seen:
                    seen.add(k)
                    self.cells.setdefault(k, []).append((a, b))

    def near(self, p, within):
        ky, kx = int(math.floor(p[0] / self.SIZE)), int(math.floor(p[1] / self.SIZE))
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for a, b in self.cells.get((ky + dy, kx + dx), ()):
                    if seg_dist(p, a, b) <= within:
                        return True
        return False

# ---------------------------------------------------------------- reading

def raw_bytes(path):
    b = open(path, "rb").read(MAX_BYTES + 1)
    if len(b) > MAX_BYTES:
        raise ValueError("the file is too big")
    if b[:2] == b"\x1f\x8b":
        b = gzip.GzipFile(fileobj=io.BytesIO(b)).read(MAX_BYTES + 1)
    elif b[:2] == b"PK":
        z = zipfile.ZipFile(io.BytesIO(b))
        names = [n for n in z.namelist() if n.lower().endswith((".gpx", ".gpx.txt", ".xml"))]
        if len(names) != 1 or z.getinfo(names[0]).file_size > MAX_BYTES:
            raise ValueError("the zip must hold exactly one GPX file")
        b = z.read(names[0])
    if len(b) > MAX_BYTES:
        raise ValueError("the file is too big")
    return b

def local(tag):
    return tag.rsplit("}", 1)[-1].lower()

def when(text):
    try:
        t = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
        return (t if t.tzinfo else t.replace(tzinfo=timezone.utc)).timestamp()
    except (ValueError, AttributeError):
        return None

def read_gpx(data):
    """{name, notes, kind, app, access, segments: [[(lat, lon, ele, time)]]}"""
    if b"<!DOCTYPE" in data[:4096].upper() or b"<!ENTITY" in data.upper():
        raise ValueError("the file declares entities; a GPX file has none")
    root = ElementTree.fromstring(data)
    if local(root.tag) != "gpx":
        raise ValueError("not a GPX file")
    out = {"name": "", "notes": "", "kind": "", "app": "", "access": "", "segments": []}
    for el in root.iter():
        tag, text = local(el.tag), (el.text or "").strip()
        if tag in ("kind", "app", "access") and text and not out[tag]:
            out[tag] = text.lower()[:40]
    for parent in root:
        if local(parent.tag) == "metadata":
            for el in parent:
                if local(el.tag) == "name":
                    out["name"] = (el.text or "").strip()
                elif local(el.tag) == "desc":
                    out["notes"] = (el.text or "").strip()
        elif local(parent.tag) in ("trk", "rte"):
            for el in parent:
                if local(el.tag) == "name" and not out["name"]:
                    out["name"] = (el.text or "").strip()
            groups = [g for g in parent if local(g.tag) == "trkseg"] or [parent]
            for g in groups:
                seg = []
                for p in g:
                    if local(p.tag) not in ("trkpt", "rtept"):
                        continue
                    try:
                        lat, lon = float(p.get("lat")), float(p.get("lon"))
                    except (TypeError, ValueError):
                        continue
                    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                        continue
                    ele = t = None
                    for c in p:
                        if local(c.tag) == "ele":
                            try:
                                ele = float(c.text)
                            except (TypeError, ValueError):
                                pass
                        elif local(c.tag) == "time":
                            t = when(c.text)
                    seg.append((lat, lon, ele, t))
                if len(seg) > 1:
                    out["segments"].append(seg)
    out["name"] = re.sub(r"\s+", " ", out["name"])[:80]
    out["notes"] = re.sub(r"\s+", " ", out["notes"])[:600]
    return out

def decode(s):
    out, i, lat, lon = [], 0, 0, 0
    b = s.encode()
    while i < len(b):
        for which in (0, 1):
            result = shift = 0
            while True:
                c = b[i] - 63
                i += 1
                result |= (c & 0x1f) << shift
                shift += 5
                if c < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lon += d
        out.append((lat / 1e5, lon / 1e5))
    return out

def read_pack(path):
    """(the box the file's cells cover, a Grid of every line in it)"""
    b = open(path, "rb").read()
    if b[:5] != b"SBTP1":
        raise ValueError(f"{path} is not a trail file")
    n = int.from_bytes(b[5:9], "big")
    header, body = json.loads(b[9:9 + n]), b[9 + n:]
    size, grid, rows, cols = header["cell"], Grid(), [], []
    for key, (o, l) in header["cells"].items():
        if key.startswith("p:"):
            continue
        r, c = (int(x) for x in key.split("_"))
        rows.append(r)
        cols.append(c)
        for t in json.loads(zlib.decompress(body[o:o + l], -15)):
            for s in t.get("segments", []):
                grid.add(decode(s))
    box = (min(rows) * size, min(cols) * size, (max(rows) + 1) * size, (max(cols) + 1) * size)
    return box, grid

# ---------------------------------------------------------------- cleaning

def without_stops(seg):
    """The walk without what the GPS drew while standing still."""
    out = [seg[0]]
    for p in seg[1:]:
        q = out[-1]
        d = dist(q, p)
        dt = (p[3] - q[3]) if p[3] is not None and q[3] is not None else None
        if d < 3 or (dt and dt > 0 and d / dt < STILL_MS and d < 25):
            continue
        out.append(p)
    return out

def folded(line):
    """An out-and-back walked both ways is one line: the way out. Returns (line, was it folded)."""
    total = length(line)
    if total < 2 * MIN_LENGTH_M or dist(line[0], line[-1]) > 60:
        return line, False
    # the far end: the point farthest from the start
    far = max(range(len(line)), key=lambda i: dist(line[0], line[i]))
    out, back = line[:far + 1], line[far:]
    if len(out) < 2 or len(back) < 2 or not 0.35 <= length(out) / total <= 0.65:
        return line, False
    grid = Grid()
    grid.add(out)
    samples = every(back, 10)
    share = sum(grid.near(p, 20) for p in samples) / len(samples)
    return (out, True) if share >= 0.9 else (line, False)

def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60] or "trail"

# ---------------------------------------------------------------- the checks

def named_by_park(name, line, wanted):
    """The trail on the region's wanted list (a park's own list or map names it) that this is, if any."""
    mine = re.sub(r"[^a-z0-9]", "", re.sub(r"\b(trail|loop|path)\b", "", name.lower()))
    for w in wanted or ():
        theirs = re.sub(r"[^a-z0-9]", "", re.sub(r"\b(trail|loop|path)\b", "", w["trail"].lower()))
        if mine and mine == theirs and ("lat" not in w or dist(line[0], (w["lat"], w["lon"])) <= 8000):
            return w
    return None

def placed(sub, segs, raw, pack, wanted, check, checks):
    """A trail placed on a map and not walked. The points may be few and a little off; what matters is that the
    trail is a trail: a park's own list or map names it there, and the ground (USGS 1 m lidar) shows it."""
    line = [(p[0], p[1]) for p in max(segs, key=length)]
    check("Long enough", raw >= MIN_LENGTH_M, f"{raw:.0f} m")
    inside = not pack or all(pack[0][0] <= p[0] <= pack[0][2] and pack[0][1] <= p[1] <= pack[0][3] for p in line)
    check("A real place", inside, "inside the region" if inside else "some of it is outside this region's file")
    plain = re.sub(r"[^a-z0-9]", "", sub["name"].lower())
    check("Named", plain not in PLACEHOLDERS and len(plain) >= 3 and not plain.isdigit(),
          f'"{sub["name"]}"' if sub["name"] else "no name")
    hit = named_by_park(sub["name"], line, wanted)
    check("Named by the park", hit, f'{hit["park"]} lists "{hit["trail"]}"' if hit
          else "no park's list or map names a trail like this here" if wanted is not None else "no wanted list given (--wanted)")
    z = None
    try:
        import lidar_trail
        r = lidar_trail.evidence(line)
        z = r["z"]
        check("The ground shows it", r["agrees"],
              ("the lidar shows a trail along this line" if r["agrees"] else
               "there is no 1 m lidar for most of it" if z is None else
               "the lidar does not show a trail along this line (it misses many real ones: walk it instead)")
              + ("" if z is None else f" (z={z})"))
        if r["agrees"]:
            line = r["line"]
    except Exception as ex:
        check("The ground shows it", False, f"the lidar could not be looked at ({ex})")
    known = None
    if pack:
        samples = every(line, 10)
        known = sum(pack[1].near(p, NEAR_M) for p in samples) / len(samples)
        check("New", known < KNOWN_SHARE, f"{100 * known:.0f}% of it follows trails already in the file")
    line = simplify(line)
    trail = {
        "name": sub["name"], "notes": sub["notes"], "kind": "placed", "app": sub["app"],
        "access_stated": sub["access"], "length_m": round(length(line)),
        "loop": dist(line[0], line[-1]) <= 40 and length(line) >= MIN_LENGTH_M, "out_and_back": False,
        "lidar_z": z,
        "park": hit["park"] if hit else None, "park_source": (hit.get("source") or hit.get("map")) if hit else None,
        "already_known_share": None if known is None else round(known, 2), "line": line,
    }
    return checks, trail

def verify(sub, pack=None, wanted=None):
    """[(check, passed, what was found)], and the cleaned trail (or None)."""
    checks = []

    def check(name, ok, found):
        checks.append((name, bool(ok), found))
        return ok

    segs = sub["segments"]
    pts = [p for s in segs for p in s]
    if not check("Readable", pts, f"{len(pts)} points in {len(segs)} piece{'s' if len(segs) != 1 else ''}"):
        return checks, None

    timed = sum(p[3] is not None for p in pts)
    kind = sub["kind"] or ("walked" if timed >= 0.9 * len(pts) else "drawn")
    raw = sum(length(s) for s in segs)
    if kind != "walked":
        return placed(sub, segs, raw, pack, wanted, check, checks)
    check("Walked", timed >= 0.9 * len(pts), f"{timed} of {len(pts)} points have a time")
    check("Long enough", raw >= MIN_LENGTH_M and len(pts) >= MIN_POINTS, f"{raw:.0f} m, {len(pts)} points")

    speeds, fast, still, jumps = [], 0.0, 0.0, 0
    for s in segs:
        for a, b in zip(s, s[1:]):
            d = dist(a, b)
            if d > JUMP_M:
                jumps += 1
            if a[3] is None or b[3] is None or b[3] <= a[3]:
                continue
            v = d / (b[3] - a[3])
            if v < STILL_MS:
                still += d
            else:
                speeds.append(v)
                if v * 3.6 > FAST_KMH:
                    fast += d
    if speeds:
        mid = statistics.median(speeds) * 3.6
        check("On foot", mid <= WALK_KMH and fast <= FAST_SHARE * raw,
              f"middle speed {mid:.1f} km/h; {100 * fast / max(raw, 1):.0f}% of the way faster than {FAST_KMH} km/h")
    else:
        check("On foot", False, "no times to work out a speed from")
    check("Clean recording", jumps == 0 and still <= STILL_SHARE * raw,
          f"{jumps} jump{'s' if jumps != 1 else ''} over {JUMP_M} m; {100 * still / max(raw, 1):.0f}% drawn while standing still")

    lats, lons = [p[0] for p in pts], [p[1] for p in pts]
    spread = dist((min(lats), min(lons)), (max(lats), max(lons)))
    inside = True
    if pack:
        box = pack[0]
        inside = all(box[0] <= p[0] <= box[2] and box[1] <= p[1] <= box[3] for p in pts)
    check("A real place", spread >= 100 and inside,
          f"{spread:.0f} m across" + ("" if inside else "; some of it is outside this region's file"))

    plain = re.sub(r"[^a-z0-9]", "", sub["name"].lower())
    check("Named", plain not in PLACEHOLDERS and len(plain) >= 3 and not plain.isdigit(),
          f'"{sub["name"]}"' if sub["name"] else "no name")

    # the cleaned line: the longest piece after stops are taken out (pieces are pauses; they join when they meet)
    cleaned = []
    for s in segs:
        c = without_stops(s)
        if cleaned and dist(cleaned[-1][-1], c[0]) <= 60:
            cleaned[-1] += c
        else:
            cleaned.append(c)
    line = [(p[0], p[1]) for p in max(cleaned, key=length)]
    line, out_and_back = folded(line)
    line = simplify(line)
    loop = not out_and_back and dist(line[0], line[-1]) <= 40 and length(line) >= MIN_LENGTH_M

    known = None
    if pack:
        samples = every(line, 10)
        known = sum(pack[1].near(p, NEAR_M) for p in samples) / len(samples)
        check("New", known < KNOWN_SHARE,
              f"{100 * known:.0f}% of it follows trails already in the file"
              + ("; offer it as a confirmation of those trails instead" if known >= KNOWN_SHARE else ""))

    first = min((p[3] for p in pts if p[3] is not None), default=None)
    trail = {
        "name": sub["name"], "notes": sub["notes"], "kind": kind, "app": sub["app"],
        "access_stated": sub["access"], "length_m": round(length(line)), "loop": loop, "out_and_back": out_and_back,
        "walked_on": datetime.fromtimestamp(first, timezone.utc).strftime("%Y-%m-%d") if first else None,
        "already_known_share": None if known is None else round(known, 2),
        "line": line,
    }
    return checks, trail

def geojson(trail, checks):
    props = {k: v for k, v in trail.items() if k != "line" and v not in (None, "")}
    props["checks"] = {name: found for name, _, found in checks}
    # a maintainer fills these in after looking at the line over aerial photos, the park's map and who owns the land
    props["approved_by"] = ""
    props["approved_on"] = ""
    props["area"] = ""
    return {"type": "Feature", "properties": props,
            "geometry": {"type": "LineString", "coordinates": [[round(p[1], 6), round(p[0], 6)] for p in trail["line"]]}}

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("file")
    ap.add_argument("--pack", help="the region's trail file, to check the trail is in the region and is new")
    ap.add_argument("--region", help="the region's id (default: the pack's file name)")
    ap.add_argument("--wanted", help="the region's wanted list (<region>.wanted.json), for a trail placed on a map")
    ap.add_argument("--out", help="the submissions folder (data/submissions): a trail is written to verified/ or "
                                  "needs-verification/ under it")
    a = ap.parse_args()
    try:
        sub = read_gpx(raw_bytes(a.file))
    except Exception as ex:
        print(f"FAIL  Readable: {ex}")
        return 1
    pack = read_pack(a.pack) if a.pack else None
    wanted = json.load(open(a.wanted)).get("wanted", []) if a.wanted else None
    checks, trail = verify(sub, pack, wanted)
    for name, ok, found in checks:
        print(f"{'ok  ' if ok else 'FAIL'}  {name}: {found}")
    verdict = tier(checks, trail)
    if trail:
        if trail["kind"] == "placed":
            print("      Placed on a map, not walked: it is marked so until someone walks it")
        shape = "out and back" if trail["out_and_back"] else "loop" if trail["loop"] else "one way"
        print(f"      Cleaned line: {trail['length_m']} m, {len(trail['line'])} points, {shape}")
    if not a.pack:
        print("      (no --pack given: not checked against the region's file)")
    print({"verified": "PASSED: ready for a maintainer to approve",
           "needs-verification": "NEEDS VERIFICATION: likely a trail, but not sure. A maintainer can accept it, or someone can walk it",
           "rejected": "NOT PASSED"}[verdict])
    if verdict != "rejected" and a.out:
        region = a.region or (os.path.basename(a.pack).split(".")[0].split("-2")[0] if a.pack else "unsorted")
        folder = os.path.join(a.out, verdict, region)
        os.makedirs(folder, exist_ok=True)
        path = os.path.join(folder, slug(trail["name"]) + ".geojson")
        n = 2
        while os.path.exists(path):
            path = os.path.join(folder, f"{slug(trail['name'])}-{n}.geojson")
            n += 1
        feature = geojson(trail, checks)
        if verdict == "needs-verification":
            feature["properties"]["unsure"] = [f"{name}: {found}" for name, ok, found in checks if not ok]
        json.dump(feature, open(path, "w"), indent=1, ensure_ascii=False)
        print(f"wrote {path}")
    return {"verified": 0, "needs-verification": 2, "rejected": 1}[verdict]

# What may be unsure in a trail that is still worth keeping on the "needs verification" list. Everything else
# (not readable, too short, not on foot, no name, already in the file, outside the region) is a plain no.
SOFT = {"Clean recording", "Named by the park", "The ground shows it"}

def tier(checks, trail):
    """verified: every check passed. needs-verification: likely a trail, but something is unsure; it is kept on
    its own list until a maintainer accepts it or someone walks it. rejected: anything else."""
    failed = {name for name, ok, _ in checks if not ok}
    if not failed:
        return "verified"
    if not trail or failed - SOFT:
        return "rejected"
    if trail["kind"] == "placed":
        # one of the two has to hold: the park's own list names it, or the ground shows it. A line with
        # neither is only a drawing
        return "needs-verification" if len(failed & {"Named by the park", "The ground shows it"}) < 2 else "rejected"
    return "needs-verification"

if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    sys.exit(main())
