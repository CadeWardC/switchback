#!/usr/bin/env python3
"""Checks every trail in a region's trail pack against official trail lists (read-only: changes nothing).

    check_official_trails.py <region.trails> <region.json> [report.md] [summary.json]

Official lists (public ArcGIS services): in the US the USGS National Digital Trails, the Forest Service and the
National Park Service; in Canada the Trans Canada Trail; for each province the official lists picked by hand in STATE_SOURCES (BC Recreation
Sites and Trails, the Ontario Trail Network, the Governments of PEI, Manitoba and Yukon, …); plus, for every state or
province, the trail lists its agencies publish (state parks, conservation, cities), found in ArcGIS Online's public
catalogue. Each trail in the pack is matched by shape (the share of its
line within 25 m of the official lines); the report says, for named and unnamed trails, which lists confirm them and
under what name, and lists the official trails in the state that the pack is missing.
"""
import json, math, os, sys, time, urllib.parse, urllib.request, zlib
from collections import Counter, defaultdict

from shapely.geometry import Point, box, shape
from shapely.ops import unary_union

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_trail_pack import decode, dist, length  # noqa: E402

NEAR_M = 25
CONFIRM = 0.7      # this share of a trail on official lines: the same trail
TILE = 0.25

NATIONAL_US = [
    # (label, layer url, name fields, number fields, detail fields)
    ("USGS National Digital Trails", "https://partnerships.nationalmap.gov/arcgis/rest/services/USGSTrails/MapServer/0",
     ["name"], ["trailnumber"], ["primarytrailmaintainer", "sourceoriginator"]),
    ("Forest Service", "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0",
     ["trail_name"], ["trail_no"], ["trail_type"]),
    ("National Park Service", "https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails/FeatureServer/0",
     ["trlname", "maplabel"], [], ["unitname", "trltype"]),
]
NATIONAL_CA = [
    ("Trans Canada Trail", "https://services2.arcgis.com/rDdKyyk7uludsLpI/arcgis/rest/services/ExploreTheMap_EN_2026/FeatureServer/15",
     ["name_trail"], [], ["category"]),
]
NATIONAL = {"US": NATIONAL_US, "CA": NATIONAL_CA}
NCC = ("National Capital Commission", "https://services2.arcgis.com/WLyMuW006nKOfa5Z/arcgis/rest/services/NCC_Paths_and_Trails/FeatureServer/1",
       ["trail_name"], ["trail_numb"], ["trail_type"])
STATE_SOURCES = {
    # Canada: the official provincial lists, picked by hand (the catalogue search finds too little there)
    "British Columbia, Canada": [
        ("Recreation Sites and Trails BC", "https://openmaps.gov.bc.ca/geo/pub/wfs|pub:WHSE_FOREST_TENURE.FTEN_RECREATION_LINES_SVW",
         ["project_name", "map_label"], ["forest_file_id"], ["project_type"]),
    ],
    "Alberta, Canada": [
        ("Alberta Designated and Provincial Trails", "https://services8.arcgis.com/6kIlVR1bamkFDOCe/arcgis/rest/services/Alberta_Designated_and_Provincial_Trails/FeatureServer/0",
         ["name"], [], ["designatio"]),
    ],
    "Manitoba, Canada": [
        ("Manitoba WMA Official Trails", "https://services.arcgis.com/mMUesHYPkXjaFGfS/arcgis/rest/services/Manitoba_Wildlife_Management_Areas_Official_Trails_and_Points_of_Interest/FeatureServer/0",
         ["trail_name"], [], ["wma_name"]),
    ],
    "Ontario, Canada": [
        ("Ontario Trail Network", "https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open04/MapServer/19",
         ["trail_name"], [], ["trail_association"]),
        NCC,
    ],
    "Quebec, Canada": [NCC],
    "New Brunswick, Canada": [
        ("New Brunswick trails (NBSE)", "https://services2.arcgis.com/EFg39h3DBNzpxORa/arcgis/rest/services/Trails_NBSE/FeatureServer/3",
         ["name"], [], ["owner"]),
        ("NB Parks trail centrelines", "https://services3.arcgis.com/cad8jHNOhWwbUlHP/arcgis/rest/services/Fundy_Interpretive_Map_3_WFL1/FeatureServer/86",
         ["name"], [], ["facility_type"]),
    ],
    "Nova Scotia, Canada": [
        ("Kings County trails", "https://services8.arcgis.com/EKgs6jOgtqEQoqHR/arcgis/rest/services/Trails_Public_View/FeatureServer/12",
         ["name"], [], ["owner"]),
    ],
    "Prince Edward Island, Canada": [
        ("Government of PEI trails", "https://services9.arcgis.com/zow9Ot3ujGSyJI3C/arcgis/rest/services/Rec_PEI_Trail_Data_online/FeatureServer/0",
         ["t_name", "trail"], [], ["manager"]),
    ],
    "Yukon, Canada": [
        ("Yukon government trails 1:50k", "https://mapservices.gov.yk.ca/arcgis/rest/services/GeoYukon/GY_Transportation/MapServer/25",
         [], [], ["feature_description"]),
        ("Yukon government Whitehorse trails", "https://mapservices.gov.yk.ca/arcgis/rest/services/GeoYukon/GY_Transportation/MapServer/26",
         [], [], ["feature"]),
    ],
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
CATALOGUE = "https://www.arcgis.com/sharing/rest/search"
NAME_FIELDS = ["trail_name", "trailname", "trlname", "trl_name", "trail_nm", "name_trail", "t_name", "name", "trail", "maplabel", "label",
               "name_en", "nom", "name1", "full_name"]
DETAIL_FIELDS = ["park_name", "area_name", "unitname", "parkname", "park", "site_name", "property", "managing_agency",
                 "agency", "owner", "jurisdiction"]
TRAILISH = ("trail", "path", "sentier", "greenway", "hik")

def get(url, params, tries=4):
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url + "?" + urllib.parse.urlencode(params), timeout=120) as r:
                return json.load(r)
        except Exception:
            if attempt == tries - 1:
                raise
            time.sleep(5 * (attempt + 1))

def region_area(region):
    """The state's outline from the Census in the US; elsewhere the 1° squares the region's pack covers."""
    if region.get("country", "US") == "US":
        try:
            layers = get(STATES, {"f": "json"})["layers"]
            lid = next(l["id"] for l in layers if l["name"].lower() == "states")
            data = get(f"{STATES}/{lid}/query", {"where": f"NAME='{region['name']}'", "outFields": "NAME",
                                                 "returnGeometry": "true", "outSR": 4326, "f": "geojson"})
            return shape(data["features"][0]["geometry"]), "Census outline"
        except Exception as ex:
            print(f"  no Census outline ({ex}); using the pack's squares")
    squares = [box(int(c.split("_")[1]), int(c.split("_")[0]), int(c.split("_")[1]) + 1, int(c.split("_")[0]) + 1)
               for c in region.get("coverage", [])]
    return unary_union(squares), "the pack's 1° squares"

def squares_of(area):
    """1° squares (south, west) that touch the area."""
    w, s, e, n = area.bounds
    out = []
    for lat in range(math.floor(s), math.ceil(n)):
        for lon in range(math.floor(w), math.ceil(e)):
            if area.intersects(box(lon, lat, lon + 1, lat + 1)):
                out.append((lat, lon))
    return out

def layer_source(label, url, info):
    fields = {f["name"].lower(): f["name"] for f in info.get("fields", [])}
    name_f = [f for f in NAME_FIELDS if f in fields]
    if not name_f:
        return None
    return (label, url, name_f[:1] + [f for f in ("maplabel",) if f in fields and f not in name_f[:1]],
            [f for f in ("trail_no", "trailnumber", "trail_number", "trlnumber") if f in fields],
            [f for f in DETAIL_FIELDS if f in fields][:1])

def count_in(url, area):
    w, s, e, n = area.bounds
    try:
        return get(url + "/query", {"where": "1=1", "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
                                   "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "returnCountOnly": "true",
                                   "f": "json"}, tries=2).get("count") or 0
    except Exception:
        return 0

def discover(region, area, known_urls):
    """Trail layers the region's agencies publish, from ArcGIS Online's public catalogue."""
    name = region["name"].split(",")[0]
    if region.get("country") == "CA-national":
        words = [name]
    elif region.get("country", "US") == "US":
        words = [f"{name} state park trails", f"{name} trails", f"{name} conservation trails"]
    else:
        words = [f"{name} trails", f"{name} provincial park trails", f"{name} sentiers"]
    found = []
    for q in words:
        try:
            res = get(CATALOGUE, {"q": f'{q} (type:"Feature Service" OR type:"Map Service")', "num": 30, "f": "json"}, tries=2)
        except Exception:
            continue
        for item in res.get("results", []):
            url = (item.get("url") or "").rstrip("/")
            if not url or url in known_urls:
                continue
            known_urls.add(url)
            try:
                info = get(url, {"f": "json"}, tries=2)
            except Exception:
                continue
            layers = [(f"{url}/{l['id']}", l) for l in info.get("layers", []) or []] if "layers" in info else [(url, info)]
            for lurl, l in layers:
                if l.get("geometryType") != "esriGeometryPolyline" or not any(w in l.get("name", "").lower() for w in TRAILISH):
                    continue
                try:
                    linfo = get(lurl, {"f": "json"}, tries=2)
                except Exception:
                    continue
                src = layer_source(f"{item.get('title')} [{item.get('owner')}]", lurl, linfo)
                n = count_in(lurl, area) if src else 0
                if src and n >= 10:
                    found.append((n, src))
    found.sort(key=lambda x: -x[0])
    return [src for _, src in found[:8]]

def pick(attrs, keys):
    for k in keys:
        v = attrs.get(k.lower())
        if v not in (None, "", " "):
            return str(v).strip()
    return ""

def fetch_wfs(source, area):
    """A WFS layer (written "url|typename"), square by square, page by page."""
    label, spec, name_f, no_f, detail_f = source
    url, typename = spec.split("|")
    seen, out = set(), []
    for lat, lon in squares_of(area):
        start = 0
        while True:
            data = get(url, {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": typename,
                             "outputFormat": "json", "srsName": "EPSG:4326", "count": 2000, "startIndex": start,
                             "bbox": f"{lat},{lon},{lat + 1},{lon + 1},urn:ogc:def:crs:EPSG::4326"})
            feats = data.get("features", [])
            for f in feats:
                a = {k.lower(): v for k, v in (f.get("properties") or {}).items()}
                g = f.get("geometry") or {}
                paths = [g["coordinates"]] if g.get("type") == "LineString" else g.get("coordinates", []) if g.get("type") == "MultiLineString" else []
                lines = [[(p[1], p[0]) for p in path] for path in paths if len(path) >= 2]
                if not lines:
                    continue
                key = (f.get("id"), tuple(round(c, 5) for c in lines[0][0]))
                if key in seen:
                    continue
                seen.add(key)
                out.append({"source": label, "name": pick(a, name_f), "no": pick(a, no_f),
                            "detail": " · ".join(x for x in (pick(a, [d]) for d in detail_f) if x), "lines": lines,
                            "use": trail_use(a)})
            if len(feats) < 2000:
                break
            start += len(feats)
    return out

def fetch(source, area):
    if "|" in source[1]:
        return fetch_wfs(source, area)
    label, url, name_f, no_f, detail_f = source
    seen, out = set(), []
    def grab(w, s, e, n, depth=0):
        offset = 0
        while True:
            data = get(url + "/query", {
                "where": "1=1", "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                "spatialRel": "esriSpatialRelIntersects", "outFields": "*", "returnGeometry": "true",
                "outSR": 4326, "f": "json", "resultOffset": offset, "resultRecordCount": 1000})
            if "error" in data:
                raise RuntimeError(data["error"].get("message"))
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
                            "detail": " · ".join(x for x in (pick(a, [d]) for d in detail_f) if x), "lines": lines,
                            "use": trail_use(a)})
            if not data.get("exceededTransferLimit") or not feats:
                return
            if not new:          # the service ignores paging: split the square instead
                if depth < 4:
                    mx, my = (w + e) / 2, (s + n) / 2
                    for q in ((w, s, mx, my), (mx, s, e, my), (w, my, mx, n), (mx, my, e, n)):
                        grab(*q, depth + 1)
                return
            offset += len(feats)
    for lat, lon in squares_of(area):
        grab(lon, lat, lon + 1, lat + 1)
    return out

NOT_FOR_HIKERS = ("water", "paddl", "canoe", "kayak", "float", "snowmob", "snow trail", "ski", "ohv", "orv", "atv",
                  "motor", "jeep", "4wd", "4x4", "road", "railway", "rail line", "motoneige", "quad", "vtt")
FOR_HIKERS = ("hik", "foot", "pedestrian", "walk", "multi", "nature", "interpret", "pied", "randonn")
USE_FIELDS = ("type", "use", "class", "activit", "designat", "mode", "category", "categor", "surface", "desc_entit")

def yes(v):
    return str(v).strip().lower() in ("y", "yes", "true", "1", "open", "allowed")

def trail_use(a):
    """'hike', 'not' (water, snow, motorized…) or '?' from an official feature's own fields."""
    if "hikerpedestrian" in a and a["hikerpedestrian"] not in (None, ""):          # USGS National Digital Trails
        tt = str(a.get("trailtype") or "").lower()
        if "water" in tt or "snow" in tt:
            return "not"
        return "hike" if yes(a["hikerpedestrian"]) else "not"
    if "trail_type" in a and "hiker_pedestrian_managed" in a:                       # Forest Service
        if str(a.get("trail_type") or "").upper() in ("SNOW", "WATER"):
            return "not"
        if any(a.get(k) for k in ("hiker_pedestrian_managed", "hiker_pedestrian_accpt", "hiker_pedestrian_accpt_disc",
                                  "hiker_pedestrian_disc")):
            return "hike"
        return "not" if a.get("hiker_pedestrian_restricted") else "?"
    if "trltype" in a:                                                             # National Park Service
        tt = str(a.get("trltype") or "").lower()
        if "water" in tt or "snow" in tt:
            return "not"
        use = str(a.get("trluse") or "").lower()
        return "hike" if (not use or any(w in use for w in FOR_HIKERS)) else "not"
    for k in ("actwalking", "hiking", "hike", "use_hike", "pedestrian", "walking"):        # yes/no activity columns
        if k in a and a[k] not in (None, ""):
            return "hike" if yes(a[k]) else "?"
    text = " ".join(str(v).lower() for k, v in a.items() if v and any(f in k for f in USE_FIELDS))
    if any(w in text for w in FOR_HIKERS):
        return "hike"
    if any(w in text for w in NOT_FOR_HIKERS):
        return "not"
    return "?"

def join_pieces(feats, gap=30):
    """Official trails cut into pieces, joined back: pieces with the same name whose ends meet (or unnamed pieces
    that meet end to end) are one trail. Returns lists of features."""
    parent = list(range(len(feats)))
    def root(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    ends = defaultdict(list)
    for i, f in enumerate(feats):
        for l in f["lines"]:
            for p in (l[0], l[-1]):
                ends[(round(p[0] * 2000), round(p[1] * 2000))].append((i, p))
    for (ky, kx), items in ends.items():
        near = [x for dy in (-1, 0, 1) for dx in (-1, 0, 1) for x in ends.get((ky + dy, kx + dx), ())]
        for i, p in items:
            for j, q in near:
                if i != j and feats[i]["name"].lower() == feats[j]["name"].lower() and dist(p, q) <= gap:
                    parent[root(i)] = root(j)
    groups = defaultdict(list)
    for i, f in enumerate(feats):
        groups[root(i)].append(f)
    return list(groups.values())

def group_use(group):
    uses = {f["use"] for f in group}
    return "hike" if "hike" in uses else "?" if "?" in uses else "not"

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
    pack, region_file = sys.argv[1], sys.argv[2]
    report = sys.argv[3] if len(sys.argv) > 3 else "report.md"
    summary_file = sys.argv[4] if len(sys.argv) > 4 else "summary.json"
    region = json.load(open(region_file))
    state = region["name"]
    header, trails = read_pack(pack)
    area, outline = region_area(region)
    country = region.get("country", "US")
    sources = list(NATIONAL.get(country, [])) + STATE_SOURCES.get(state, [])
    known = {src[1].rsplit("/", 1)[0] for src in sources} | {src[1] for src in sources}
    sources += discover(region, area, known)
    md = [f"# {state}: trail pack vs official trail lists", ""]
    def say(line=""):
        print(line)
        md.append(line)
    summary = {"region": region["region"], "name": state, "country": country, "lists": {}}

    official, grids = {}, {}
    say(f"Pack: {len(trails)} trails. Inside {state} ({outline}), official lists:")
    say()
    for src in sources:
        try:
            feats = fetch(src, area)
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
        summary["lists"][src[0]] = {"pieces": len(feats), "miles": round(miles)}
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
        summary[kind] = {"total": len(group), "confirmed": len(conf), "partly": len(part), "none": len(none)}
        say(f"## {kind}: {len(group)}")
        say(f"- confirmed by at least one official list (≥{CONFIRM:.0%} of the line): **{len(conf)}**")
        say(f"- partly on official trails (30–70%): {len(part)}")
        say(f"- on no official list: **{len(none)}**")
        by = Counter(k for r in conf for k in confirmed(r[2]))
        say("- confirmed by: " + ", ".join(f"{k} {v}" for k, v in by.most_common()))
        # trails the official lists say aren't for hikers (every list that confirms them says 'not')
        not_hike = [r for r in conf if all(v[1]["use"] == "not" for v in confirmed(r[2]).values())]
        summary[kind]["not_for_hikers"] = len(not_hike)
        say(f"- official lists say **not for hikers** (water, snow, ORV, motorized…): {len(not_hike)}")
        for t, _, hits in sorted(not_hike, key=lambda r: -r[0]["length"])[:8]:
            k, v = next(iter(confirmed(hits).items()))
            say(f"  - {t['name']} ({t['length'] / 1609.34:.1f} mi) = {label(v[1])} ({k}{', ' + v[1]['detail'] if v[1]['detail'] else ''})")
        def place(t):
            short = t["length"] < 805
            park = bool(t.get("tags", {}).get("switchback:area"))
            return ("in a park" if park else "outside parks") + (", under ½ mi" if short else "")
        kinds = Counter(place(r[0]) for r in none)
        summary[kind]["none_by_place"] = dict(kinds)
        say("- on no list, by place: " + ", ".join(f"{k} {v}" for k, v in kinds.most_common()))
        if want:
            nameable = [r for r in conf if any(v[1]["name"] and v[1]["use"] != "not" for v in confirmed(r[2]).values())]
            say(f"- **can take an official name: {len(nameable)}**")
            summary[kind]["nameable"] = len(nameable)
            say()
            for t, _, hits in sorted(nameable, key=lambda r: -r[0]["length"])[:40]:
                best = max(confirmed(hits).items(), key=lambda kv: (bool(kv[1][1]["name"]) and kv[1][1]["use"] != "not", kv[1][0]))
                say(f"  - {t['name']} ({t['length'] / 1609.34:.1f} mi) → **{label(best[1][1])}** "
                    f"({best[0]}, {best[1][0]:.0%}) {link(t['_lines'][0][0])}")
        else:
            differ = [(t, k, v) for t, _, hits in conf for k, v in confirmed(hits).items()
                      if v[1]["name"] and not same_name(t["name"], v[1]["name"])]
            say(f"- official name differs (per list): {len(differ)}")
            summary[kind]["name_differs"] = len(differ)
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
    say("## Official trails missing from the pack (joined into whole trails, hiking only)")
    for name, feats in official.items():
        missing, skipped = [], Counter()
        for group in join_pieces(feats):
            use = group_use(group)
            lines = [l for f in group for l in f["lines"]]
            total = sum(length(l) for l in lines)
            if total < 400:
                continue
            if use == "not":
                skipped["not for hikers"] += 1
                continue
            share, _ = match(lines, pg)
            if share < 0.3:
                missing.append((group, total, use))
        hike = [m for m in missing if m[2] == "hike"]
        unknown = [m for m in missing if m[2] == "?"]
        mi = lambda ms: round(sum(m[1] for m in ms) / 1609.34)
        say(f"- **{name}**: {len(hike)} hiking trails ({mi(hike)} mi) + {len(unknown)} of unknown use ({mi(unknown)} mi); "
            f"left out {skipped['not for hikers']} not for hikers")
        summary["lists"].setdefault(name, {}).update({"missing": len(hike), "missing_miles": mi(hike),
                                                      "missing_unknown_use": len(unknown), "missing_unknown_miles": mi(unknown),
                                                      "not_for_hikers": skipped["not for hikers"]})
        for group, total, use in sorted(missing, key=lambda m: -m[1])[:10]:
            f = max(group, key=lambda f: sum(length(l) for l in f["lines"]))
            say(f"  - {label(f)} ({total / 1609.34:.1f} mi{', ' + f['detail'] if f['detail'] else ''}"
                f"{', use unknown' if use == '?' else ''}) {link(f['lines'][0][0])}")
    open(report, "w").write("\n".join(md) + "\n")
    json.dump(summary, open(summary_file, "w"), indent=1)

if __name__ == "__main__":
    main()
