#!/usr/bin/env python3
"""Compares a region's trail pack with the Forest Service's official trail list (read-only: changes nothing).

    check_official_trails.py <region.trails> [south,west,north,east]

Fetches every National Forest System trail in the box from the Forest Service (EDW_TrailNFSPublish_01, the same
service the app uses), matches it to the pack's trails by shape (how much of a line lies within 25 m of the other),
and reports:
  - unnamed lines that follow an official trail (they could take its name and number)
  - named trails whose official name is different
  - official trails with nothing in the pack (missing from OpenStreetMap, or dropped by the builder)
"""
import json, math, sys, time, urllib.parse, urllib.request, zlib
from collections import defaultdict

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build_trail_pack import decode, dist, length  # noqa: E402

URL = "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0/query"
NEAR_M = 25
MATCH = 0.7          # share of a line within NEAR_M of the other to call them the same trail
TILE = 0.5

def read_pack(path):
    b = open(path, "rb").read()
    n = int.from_bytes(b[5:9], "big")
    h = json.loads(b[9:9 + n])
    body = b[9 + n:]
    trails = []
    for k, (o, l) in h["cells"].items():
        if k.startswith("p:"):
            continue
        for t in json.loads(zlib.decompress(body[o:o + l], -15)):
            t["_lines"] = [decode(s) for s in t["segments"]]
            trails.append(t)
    return h, trails

def fetch_usfs(box):
    s, w, n, e = box
    seen, out = set(), []
    lat = s
    while lat < n:
        lon = w
        while lon < e:
            env = f"{lon},{lat},{min(lon + TILE, e)},{min(lat + TILE, n)}"
            offset = 0
            while True:
                q = urllib.parse.urlencode({
                    "where": "1=1", "geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                    "spatialRel": "esriSpatialRelIntersects", "outFields": "OBJECTID,TRAIL_NO,TRAIL_NAME",
                    "returnGeometry": "true", "outSR": 4326, "f": "json",
                    "resultOffset": offset, "resultRecordCount": 1000})
                for attempt in range(4):
                    try:
                        with urllib.request.urlopen(URL + "?" + q, timeout=90) as r:
                            data = json.load(r)
                        break
                    except Exception as ex:
                        if attempt == 3:
                            raise
                        time.sleep(5 * (attempt + 1))
                feats = data.get("features", [])
                for f in feats:
                    a = f["attributes"]
                    if a["OBJECTID"] in seen:
                        continue
                    seen.add(a["OBJECTID"])
                    lines = [[(p[1], p[0]) for p in path] for path in (f.get("geometry") or {}).get("paths", [])]
                    if lines:
                        out.append({"no": (a.get("TRAIL_NO") or "").strip(), "name": (a.get("TRAIL_NAME") or "").strip(),
                                    "lines": lines})
                if not data.get("exceededTransferLimit") or not feats:
                    break
                offset += len(feats)
            lon += TILE
        lat += TILE
    return out

def densify(line, step=10):
    out = [line[0]]
    for a, b in zip(line, line[1:]):
        d = dist(a, b)
        k = max(1, int(d // step))
        for i in range(1, k + 1):
            out.append((a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k))
    return out

class Grid:
    """Points by ~35 m bucket, each tagged with what it belongs to."""
    def __init__(self):
        self.cells = defaultdict(list)

    @staticmethod
    def key(p):
        return (round(p[0] * 3000), round(p[1] * 3000))

    def add(self, line, owner):
        for p in densify(line):
            self.cells[self.key(p)].append((p, owner))

    def near(self, p):
        k = self.key(p)
        found = set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q, owner in self.cells.get((k[0] + dx, k[1] + dy), ()):
                    if owner not in found and dist(p, q) <= NEAR_M:
                        found.add(owner)
        return found

def shares(lines, grid):
    """For each owner in the grid: the share of these lines' points within NEAR_M of it."""
    pts = [p for l in lines for p in densify(l, 20)]
    count = defaultdict(int)
    for p in pts:
        for owner in grid.near(p):
            count[owner] += 1
    return {o: c / len(pts) for o, c in count.items()} if pts else {}

def link(p):
    return f"https://www.openstreetmap.org/?mlat={p[0]:.5f}&mlon={p[1]:.5f}#map=16/{p[0]:.5f}/{p[1]:.5f}"

def main():
    pack, box_arg = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None
    header, trails = read_pack(pack)
    box = [float(x) for x in box_arg.split(",")] if box_arg else header["bbox"]
    print(f"pack: {len(trails)} trails; box {box}")
    official = fetch_usfs(box)
    official = [o for o in official if sum(length(l) for l in o["lines"]) >= 100]
    print(f"Forest Service: {len(official)} official trails in the box "
          f"({sum(sum(length(l) for l in o['lines']) for o in official) / 1609.34:.0f} mi)")

    og = Grid()
    for i, o in enumerate(official):
        for l in o["lines"]:
            og.add(l, i)
    pg = Grid()
    for i, t in enumerate(trails):
        for l in t["_lines"]:
            pg.add(l, i)

    unnamed_named, renamed, unnamed_total = [], [], 0
    for t in trails:
        unnamed = t.get("tags", {}).get("switchback:unnamed") == "yes"
        unnamed_total += unnamed
        s = shares(t["_lines"], og)
        if not s:
            continue
        best, share = max(s.items(), key=lambda kv: kv[1])
        if share < MATCH:
            continue
        o = official[best]
        label = " ".join(x for x in (o["name"].title(), f"#{o['no']}" if o["no"] else "") if x)
        if unnamed:
            unnamed_named.append((t, label, share))
        elif o["name"] and o["name"].lower() not in t["name"].lower() and t["name"].lower() not in o["name"].lower():
            renamed.append((t, label, share))

    missing = []
    for o in official:
        s = shares(o["lines"], pg)
        covered = max(s.values()) if s else 0
        total = sum(length(l) for l in o["lines"])
        if covered < 0.3 and total >= 400:
            missing.append((o, total, covered))

    print(f"\n1. unnamed lines that follow an official trail: {len(unnamed_named)} of {unnamed_total}")
    for t, label, share in sorted(unnamed_named, key=lambda x: -x[0]["length"])[:25]:
        print(f"   {t['name'][:38]:<38} {t['length'] / 1609.34:5.1f} mi  -> {label[:40]:<40} ({share:.0%})  {link(t['_lines'][0][0])}")
    print(f"\n2. named trails whose official name is different: {len(renamed)}")
    for t, label, share in sorted(renamed, key=lambda x: -x[0]["length"])[:25]:
        print(f"   {t['name'][:38]:<38} {t['length'] / 1609.34:5.1f} mi  -> {label[:40]:<40} ({share:.0%})")
    print(f"\n3. official trails with (almost) nothing in the pack: {len(missing)} "
          f"({sum(m[1] for m in missing) / 1609.34:.0f} mi)")
    for o, total, covered in sorted(missing, key=lambda x: -x[1])[:25]:
        label = " ".join(x for x in (o["name"].title() or "(no name)", f"#{o['no']}" if o["no"] else "") if x)
        print(f"   {label[:50]:<50} {total / 1609.34:5.1f} mi  ({covered:.0%} covered)  {link(o['lines'][0][0])}")

if __name__ == "__main__":
    main()
