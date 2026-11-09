#!/usr/bin/env python3
"""Checks every trail in a region's trail pack against official trail lists (read-only: changes nothing).

    check_official_trails.py <region.trails> <state name> [report.md]

Official lists (public ArcGIS services): the USGS National Digital Trails, the Forest Service, the National Park
Service, and the state and local lists in STATE_SOURCES. Each trail in the pack is matched by shape (the share of its
line within 25 m of the official lines); the report says, for named and unnamed trails, which lists confirm them and
under what name, and lists the official trails in the state that the pack is missing.
"""
import json, os, sys, time, urllib.parse, urllib.request, zlib
from collections import Counter, defaultdict

from shapely.geometry import Point, shape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_trail_pack import decode, dist, length  # noqa: E402

NEAR_M = 25
CONFIRM = 0.7      # this share of a trail on official lines: the same trail
TILE = 0.25

NATIONAL = [
    # (label, layer url, name fields, number fields, detail fields)
    ("USGS National Digital Trails", "https://partnerships.nationalmap.gov/arcgis/rest/services/USGSTrails/MapServer/0",
     ["name"], ["trailnumber"], ["primarytrailmaintainer", "sourceoriginator"]),
    ("Forest Service", "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0",
     ["trail_name"], ["trail_no"], ["trail_type"]),
    ("National Park Service", "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0",
     ["trlname", "maplabel"], [], ["unitname", "trltype"]),
]
STATE_SOURCES = {
    "Missouri": [
        ("Missouri State Parks", "https://services1.arcgis.com/g2TonOxuRkIqSOFx/arcgis/rest/services/MissouriStateParkTrailGuide/FeatureServer/2",
         ["trail_name"], [], ["park_name"]),
        ("Missouri Dept. of Conservation", "https://services2.arcgis.com/kNS2ppBA4rwAQQZy/arcgis/rest/services/MO_MDC_Trails/FeatureServer/0",
         ["trail_name"], [], ["area_name"]),
        ("City of Columbia", "https://gis.gocolumbiamo.com/arcgis/rest/services/Open_Data/Park_Trails/MapServer/0",
         ["trail_name"], [], ["park_name"]),
    ],
}
STATES = "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer"

def get(url, params, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url + "?" + urllib.parse.urlencode(params), timeout=120) as r:
                return json.load(r)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(5 * (attempt + 1))

def state_shape(name):
    layers = get(STATES, {"f": "json"})["layers"]
    lid = next(l["id"] for l in layers if l["name"].lower() == "states")
    data = get(f"{STATES}/{lid}/query", {"where": f"NAME='{name}'", "outFields": "NAME", "returnGeometry": "true",
                                         "outSR": 4326, "f": "geojson"})
    return shape(data["features"][0]["geometry"])

def pick(attrs, keys):
    for k in keys:
        v = attrs.get(k)
        if v not in (None, "", " "):
            return str(v).strip()
    return ""

def fetch(source, box):
    label, url, name_f, no_f, detail_f = source
    s, w, n, e = box
    seen, out = set(), []
    lat = s
    while lat < n:
        lon = w
        while lon < e:
            env = f"{lon},{lat},{min(lon + TILE, e)},{min(lat + TILE, n)}"
            offset = 0
            while True:
                data = get(url + "/query", {
                    "where": "1=1", "geometry": env, "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                    "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "returnGeometry": "true",
                    "outSR": 4326, "f": "json", "resultOffset": offset, "resultRecordCount": 1000})
                feats = data.get("features", [])
                new = 0
                for f in feats:
                    a = {k.lower(): v for k, v in f["attributes"].items()}
                    lines = [[(p[1], p[0]) for p in path] for path in (f.get("geometry") or {}).get("paths", [])]
                    if not lines:
                        continue
                    key = (pick(a, name_f), tuple(round(c, 5) for c in lines[0][0]), len(lines[0]))
                    if key in seen:
                        continue
                    seen.add(key)
                    new += 1
                    out.append({"source": label, "name": pick(a, name_f), "no": pick(a, no_f),
                                "detail": " · ".join(x for x in (pick(a, [d]) for d in detail_f) if x), "lines": lines})
                if not data.get("exceededTransferLimit") or not feats or not new:
                    break
                offset += len(feats)
            lon += TILE
        lat += TILE
    return out

def densify(line, step):
    out = [line[0]]
    for a, b in zip(line, line[1:]):
        k = max(1, int(dist(a, b) // step))
        out += [(a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k) for i in range(1, k + 1)]
    return out

class Grid:
    def __init__(self):
        self.cells = defaultdict(list)

    @staticmethod
    def key(p):
        return (round(p[0] * 3000), round(p[1] * 3000))

    def add(self, line, owner):
        for p in densify(line, 10):
            self.cells[self.key(p)].append((p, owner))

    def near(self, p):
        k, found = self.key(p), set()
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for q, owner in self.cells.get((k[0] + dx, k[1] + dy), ()):
                    if owner not in found and dist(p, q) <= NEAR_M:
                        found.add(owner)
        return found

def match(lines, grid):
    """(share of the lines on any of the grid's owners, the owner most of it lies on)"""
    pts = [p for l in lines for p in densify(l, 20)]
    hits, by_owner = 0, Counter()
    for p in pts:
        owners = grid.near(p)
        if owners:
            hits += 1
            by_owner.update(owners)
    return (hits / len(pts) if pts else 0), (by_owner.most_common(1)[0][0] if by_owner else None)

def read_pack(path):
    b = open(path, "rb").read()
    n = int.from_bytes(b[5:9], "big")
    h = json.loads(b[9:9 + n])
    body, trails = b[9 + n:], []
    for k, (o, l) in h["cells"].items():
        if not k.startswith("p:"):
            for t in json.loads(zlib.decompress(body[o:o + l], -15)):
                t["_lines"] = [decode(s) for s in t["segments"]]
                trails.append(t)
    return h, trails

def label(o):
    return " ".join(x for x in (o["name"] or "(no name)", f"#{o['no']}" if o["no"] else "") if x)

def link(p):
    return f"https://www.openstreetmap.org/?mlat={p[0]:.5f}&mlon={p[1]:.5f}#map=16/{p[0]:.5f}/{p[1]:.5f}"

def same_name(a, b):
    a, b = a.lower(), b.lower()
    return a in b or b in a

def main():
    pack, state = sys.argv[1], sys.argv[2]
    report = sys.argv[3] if len(sys.argv) > 3 else "report.md"
    header, trails = read_pack(pack)
    area = state_shape(state)
    w, s, e, n = area.bounds
    box = [s, w, n, e]
    sources = NATIONAL + STATE_SOURCES.get(state, [])
    md = [f"# {state}: trail pack vs official trail lists", ""]
    def say(line=""):
        print(line)
        md.append(line)

    official, grids = {}, {}
    say(f"Pack: {len(trails)} trails. Official lists, inside {state}:")
    say()
    for src in sources:
        try:
            feats = fetch(src, box)
        except Exception as ex:
            say(f"- **{src[0]}**: couldn't fetch ({ex})")
            continue
        feats = [f for f in feats if area.intersects(Point(f["lines"][0][len(f["lines"][0]) // 2][1], f["lines"][0][len(f["lines"][0]) // 2][0]))]
        official[src[0]] = feats
        g = Grid()
        for i, f in enumerate(feats):
            for l in f["lines"]:
                g.add(l, i)
        grids[src[0]] = g
        miles = sum(length(l) for f in feats for l in f["lines"]) / 1609.34
        say(f"- **{src[0]}**: {len(feats)} pieces, {miles:.0f} mi")
    say()

    # every trail in the pack against every list
    rows = []
    for t in trails:
        unnamed = t.get("tags", {}).get("switchback:unnamed") == "yes"
        mid = t["_lines"][0][len(t["_lines"][0]) // 2]
        if not area.intersects(Point(mid[1], mid[0])):
            continue
        hits = {}
        for name, g in grids.items():
            share, owner = match(t["_lines"], g)
            if share >= 0.3:
                hits[name] = (share, official[name][owner])
        rows.append((t, unnamed, hits))

    def confirmed(hits):
        return {k: v for k, v in hits.items() if v[0] >= CONFIRM}

    for kind, want in (("Named trails", False), ("Unnamed lines", True)):
        group = [r for r in rows if r[1] == want]
        conf = [r for r in group if confirmed(r[2])]
        part = [r for r in group if not confirmed(r[2]) and r[2]]
        none = [r for r in group if not r[2]]
        say(f"## {kind}: {len(group)}")
        say(f"- confirmed by at least one official list (≥{CONFIRM:.0%} of the line): **{len(conf)}**")
        say(f"- partly on official trails (30–70%): {len(part)}")
        say(f"- on no official list: **{len(none)}**")
        by = Counter(k for r in conf for k in confirmed(r[2]))
        say("- confirmed by: " + ", ".join(f"{k} {v}" for k, v in by.most_common()))
        if want:
            nameable = [r for r in conf if any(v[1]["name"] for v in confirmed(r[2]).values())]
            say(f"- **can take an official name: {len(nameable)}**")
            say()
            for t, _, hits in sorted(nameable, key=lambda r: -r[0]["length"])[:40]:
                best = max(confirmed(hits).items(), key=lambda kv: (bool(kv[1][1]["name"]), kv[1][0]))
                say(f"  - {t['name']} ({t['length'] / 1609.34:.1f} mi) → **{label(best[1][1])}** "
                    f"({best[0]}, {best[1][0]:.0%}) {link(t['_lines'][0][0])}")
            none_kinds = Counter("in a park" if r[0].get("tags", {}).get("switchback:area") else "outside parks" for r in none)
            say()
            say(f"- on no list, by place: {dict(none_kinds)}")
        else:
            differ = [(t, k, v) for t, _, hits in conf for k, v in confirmed(hits).items()
                      if v[1]["name"] and not same_name(t["name"], v[1]["name"])]
            say(f"- official name differs (per list): {len(differ)}")
            say()
            for t, k, v in sorted(differ, key=lambda x: -x[0]["length"])[:25]:
                say(f"  - {t['name']} → {label(v[1])} ({k})")
            say()
            say(f"- on no list (longest first):")
            for t, _, _ in sorted(none, key=lambda r: -r[0]["length"])[:15]:
                say(f"  - {t['name']} ({t['length'] / 1609.34:.1f} mi, {t.get('tags', {}).get('switchback:area') or 'no park'}) "
                    f"{link(t['_lines'][0][0])}")
        say()

    # official trails the pack is missing
    pg = Grid()
    for i, t in enumerate(trails):
        for l in t["_lines"]:
            pg.add(l, i)
    say("## Official trails missing from the pack")
    for name, feats in official.items():
        missing = []
        for f in feats:
            total = sum(length(l) for l in f["lines"])
            if total < 400:
                continue
            share, _ = match(f["lines"], pg)
            if share < 0.3:
                missing.append((f, total))
        miles = sum(m[1] for m in missing) / 1609.34
        say(f"- **{name}**: {len(missing)} ({miles:.0f} mi)")
        for f, total in sorted(missing, key=lambda m: -m[1])[:10]:
            say(f"  - {label(f)} ({total / 1609.34:.1f} mi{', ' + f['detail'] if f['detail'] else ''}) {link(f['lines'][0][0])}")
    open(report, "w").write("\n".join(md) + "\n")

if __name__ == "__main__":
    main()
