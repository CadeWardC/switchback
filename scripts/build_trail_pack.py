#!/usr/bin/env python3
"""Builds Switchback's lightweight trail packs from an OpenStreetMap extract.

    build_trail_pack.py <region.osm.pbf> <region-id> <out-dir> [country] [display name]

Writes, into <out-dir>:
  c_<row>_<col>.z   one file per 0.25° cell that has trails: a raw-DEFLATE-compressed JSON list of trails in exactly
                    the format the app saves them (encoded polylines), each trail in the cell where it starts
  index.json        {version, region, cell, bbox, cells: {"row_col": bytes}}

The trail rules mirror the app's live search (Overpass.swift), so ids match and the two can be mixed:
hiking/foot/walking route relations, named paths/footways/bridleways and named tracks, and unnamed paths (joined,
800 m or more). Lines are simplified to 4 m and stored at 1e-5° (about a metre).
Pieces of one named trail that meet along other trails (or across a gap of a few metres) are joined into one trail:
a loop mapped as two halves joined by another trail becomes one closed loop.

Each trail also gets its area: the smallest named park, nature reserve or protected area (conservation areas,
national forests, wildernesses…) its middle lies in, as the tag "switchback:area". Unnamed paths are named from the
map where it says something true ("Connector: A – B" between two named trails, "A spur" off one), and dropped when
they're neither in an area nor joined to a trail nor tagged for hiking (city shortcuts, yard paths).
"""
import heapq, json, math, os, re, sys, zlib
from collections import defaultdict

import osmium
from shapely.geometry import LineString, Point, Polygon, MultiPolygon
from shapely.strtree import STRtree

CELL = 0.25
SIMPLIFY_M = 4.0
KEEP_TAGS = {"switchback:multiuse", "switchback:roadwalk", "informal", "access", "foot", "sac_scale", "surface", "trail_visibility", "operator", "network", "ref", "from", "to", "website",
             "wikidata", "wikimedia_commons", "dog", "symbol", "description", "description:en", "note", "name:en"}
SKIP_ROLES = {"alternative", "excursion", "approach", "connection", "link"}
PAVED = {"paved", "asphalt", "concrete", "paving_stones", "sett", "compacted"}
NO_ACCESS = {"private", "no"}
NO_PARKING = {"private", "no", "customers", "permit", "delivery", "employees"}
TRAILHEAD_M = 100    # a trailhead or car park this close to a trail is a place to start from
ACCESS_M = 3000      # …and trails within this walk of it (along trails) can be started from there
FAR_LINK_M = 3000    # …or this close when both pieces are in the same park (see link_pieces)
FRAGMENT_M = 805     # a named piece shorter than this (half a mile) isn't a hike on its own
LINK_M = 1000   # pieces of one named trail this close along other trails are one trail (a loop mapped in halves)
GAP_M = 30      # a straight jump allowed between pieces where the map has a small gap

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
    x, y = ax + t * dx, ay + t * dy
    return math.hypot(x, y)

def simplify(pts, tol=SIMPLIFY_M):
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b <= a + 1:
            continue
        best, idx = 0, a
        for i in range(a + 1, b):
            d = seg_dist(pts[i], pts[a], pts[b])
            if d > best:
                best, idx = d, i
        if best > tol:
            keep[idx] = True
            stack += [(a, idx), (idx, b)]
    return [p for p, k in zip(pts, keep) if k]

def encode(pts):
    out, plat, plon = [], 0, 0
    def put(v):
        v = ~(v << 1) if v < 0 else (v << 1)
        while v >= 0x20:
            out.append(chr((0x20 | (v & 0x1f)) + 63))
            v >>= 5
        out.append(chr(v + 63))
    for la, lo in pts:
        a, b = int(round(la * 1e5)), int(round(lo * 1e5))
        put(a - plat)
        put(b - plon)
        plat, plon = a, b
    return "".join(out)

def encode_ints(values):
    """Plain integers in the polyline alphabet (zig-zag, 5 bits a character)."""
    out = []
    for v in values:
        v = ~(v << 1) if v < 0 else (v << 1)
        while v >= 0x20:
            out.append(chr((0x20 | (v & 0x1f)) + 63))
            v >>= 5
        out.append(chr(v + 63))
    return "".join(out)

def add_elevation(trails, cache_dir):
    """Detailed, compact elevation for every trail's main line (see elevation.py)."""
    import elevation
    terrain = elevation.Terrain(cache_dir)
    paths = []
    for t, _ in trails:
        lines = [decode(x) for x in t["segments"]]
        paths.append(lines[t["pathIndex"]] if "pathIndex" in t else decode(t["path"]))
    # the walks in from trailheads and the side loops get their elevation too, so a whole hike can be charted
    extras = []      # (trail, tag, parsed entries)
    for t, _ in trails:
        for tag in ("switchback:access", "switchback:ext"):
            if tag in t.get("tags", {}):
                extras.append((t, tag, json.loads(t["tags"][tag])))
    extra_paths = [decode(e["l"]) for _, _, entries in extras for e in entries if "l" in e]
    tiles = elevation.needed_tiles(paths + extra_paths, dist)
    ok, todo = terrain.fetch_all(tiles)
    print(f"  terrain: {len(tiles)} tiles ({todo} downloaded now, {ok} ok)")
    done = 0
    for (t, _), pts in zip(trails, paths):
        e = elevation.profile(pts, terrain, dist, encode_ints)
        if e:
            t["elev"] = e
            done += 1
    print(f"  elevation for {done} of {len(trails)} trails")
    cache, walks = {}, 0
    for t, tag, entries in extras:
        for e in entries:
            if "l" not in e:
                continue
            if e["l"] not in cache:
                cache[e["l"]] = elevation.profile(decode(e["l"]), terrain, dist, encode_ints)
            if cache[e["l"]]:
                e["e"] = cache[e["l"]]
                walks += 1
        t["tags"][tag] = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    print(f"  elevation for {walks} walks in and side loops")

def decode(s):
    out, i, lat, lon = [], 0, 0, 0
    def nxt():
        nonlocal i
        r = sh = 0
        while True:
            b = ord(s[i]) - 63
            i += 1
            r |= (b & 0x1f) << sh
            sh += 5
            if b < 0x20:
                return ~(r >> 1) if r & 1 else r >> 1
    while i < len(s):
        lat += nxt()
        lon += nxt()
        out.append((lat / 1e5, lon / 1e5))
    return out

def chains(pieces, with_nodes=False):
    """Joins pieces (lists of (node_id, (lat, lon))) that share end nodes into the longest continuous lines."""
    remaining = [p for p in pieces if len(p) >= 2]
    ends = defaultdict(set)
    for i, p in enumerate(remaining):
        ends[p[0][0]].add(i)
        ends[p[-1][0]].add(i)
    used, out = set(), []
    for i in range(len(remaining)):
        if i in used:
            continue
        used.add(i)
        chain = list(remaining[i])
        grown = True
        while grown:
            grown = False
            for at_end in (True, False):
                node = chain[-1][0] if at_end else chain[0][0]
                for j in list(ends[node]):
                    if j in used:
                        continue
                    p = remaining[j]
                    if not at_end:
                        p = list(reversed(p)) if p[0][0] == node else p
                        chain = p[:-1] + chain
                    else:
                        p = p if p[0][0] == node else list(reversed(p))
                        chain = chain + p[1:]
                    used.add(j)
                    grown = True
                    break
        out.append(chain if with_nodes else [c for _, c in chain])
    return out

# ---------------------------------------------------------------- joining the pieces of one named trail

def network(lines):
    """Every trail line as a graph: node id -> [(neighbour, metres)], plus each node's position."""
    adj, where = defaultdict(list), {}
    for nodes in lines:
        for (a, pa), (b, pb) in zip(nodes, nodes[1:]):
            where[a], where[b] = pa, pb
            if a != b:
                d = dist(pa, pb)
                adj[a].append((b, d))
                adj[b].append((a, d))
    return adj, where

def reach(adj, src, targets, limit):
    """Shortest walks (metres, node ids) from src to the targets within limit metres along the network."""
    best, prev, heap, found = {src: 0.0}, {}, [(0.0, src)], {}
    want = targets - {src}
    while heap and len(found) < len(want):
        d, n = heapq.heappop(heap)
        if d > best.get(n, math.inf):
            continue
        if n in want:
            found[n] = d
        for m, w in adj.get(n, ()):
            nd = d + w
            if nd <= limit and nd < best.get(m, math.inf):
                best[m], prev[m] = nd, n
                heapq.heappush(heap, (nd, m))
    walks = {}
    for t, d in found.items():
        path = [t]
        while path[-1] != src:
            path.append(prev[path[-1]])
        walks[t] = (d, path[::-1])
    return walks

def link_pieces(pieces, adj, where, parks=None):
    """Joins the pieces of one named trail (lines of (node id, (lat, lon))) that meet along other trails, or across a
    small gap, into walks: a loop mapped as two halves joined by another trail becomes one closed loop, and a trail
    broken where it shares a stretch with another becomes one line. Returns [(walk, segments)]: the line to follow,
    and the lines to draw (the pieces and the stretches that join them)."""
    keep = [k for k, p in enumerate(pieces) if len(p) >= 2]
    parks = [parks[k] for k in keep] if parks else None
    pieces = [pieces[k] for k in keep]
    far = parks is not None and any(p for p in parks)
    sizes = [length([c for _, c in p]) for p in pieces]
    if len(pieces) < 2:
        return [([c for _, c in p], [[c for _, c in p]]) for p in pieces]
    end_node = lambda i, e: pieces[i][-1 if e else 0][0]
    ends = defaultdict(list)                  # node -> [(piece, which end)]
    for i in range(len(pieces)):
        for e in (0, 1):
            ends[end_node(i, e)].append((i, e))
    links = []                                # (metres, (i, e), (j, f), coords between them)
    for i in range(len(pieces)):
        for e in (0, 1):
            a = end_node(i, e)
            others = {n for n, owners in ends.items() if any(j != i for j, _ in owners)}
            walks = reach(adj, a, others, FAR_LINK_M if far else LINK_M)
            for n in others:
                if n == a:
                    walk = (0.0, [a])
                elif n in walks:
                    walk = walks[n]
                elif dist(where[a], where[n]) <= GAP_M:
                    walk = (dist(where[a], where[n]), [a, n])
                else:
                    continue
                for j, f in ends[n]:
                    if (j, f) > (i, e):       # each pair once
                        links.append((walk[0], (i, e), (j, f), [where[x] for x in walk[1]]))
    links.sort(key=lambda l: l[0])
    group = list(range(len(pieces)))
    def root(x):
        while group[x] != x:
            group[x] = group[group[x]]
            x = group[x]
        return x
    linked = {}                               # (i, e) -> ((j, f), coords from (i, e) to (j, f))
    for d, a, b, coords in links:
        if a[0] == b[0] or a in linked or b in linked:
            continue
        if d > LINK_M:
            # a longer gap is joined only inside one park, and only when the trail's own pieces are most of the
            # result (the stretch between them is at most 40% of the two pieces it joins)
            same_park = parks and parks[a[0]] and parks[a[0]] == parks[b[0]]
            if not same_park or d > 0.4 * (sizes[a[0]] + sizes[b[0]]):
                continue
        if root(a[0]) == root(b[0]):
            # closes a loop: only where the pieces really go round (not two ends of one line far apart)
            if d > LINK_M / 2:
                continue
        group[root(a[0])] = root(b[0])
        linked[a] = (b, coords)
        linked[b] = (a, coords[::-1])
    out, done = [], set()
    for start in range(len(pieces)):
        if start in done:
            continue
        # begin at a free end of this group if it has one (a line), else anywhere (a loop)
        members = [i for i in range(len(pieces)) if root(i) == root(start)]
        free = next(((i, e) for i in members for e in (0, 1) if (i, e) not in linked), None)
        i, e_in = free if free else (members[0], 0)
        walk, segs = [], []
        while i not in done:
            done.add(i)
            line = [c for _, c in pieces[i]]
            if e_in == 1:
                line = line[::-1]
            segs.append(line)
            walk += line if not walk or walk[-1] != line[0] else line[1:]
            nxt = linked.get((i, 1 - e_in))
            if not nxt:
                break
            (j, f), coords = nxt
            if len(coords) >= 2:
                segs.append(coords)
                walk += coords[1:]
            i, e_in = j, f
        out.append((walk, segs))
    return out

# ---------------------------------------------------------------- reading OSM

POI_KINDS = [  # (tag, values, kind as the app names it)
    ("tourism", {"viewpoint"}, "viewpoint"), ("natural", {"peak", "volcano"}, "peak"),
    ("waterway", {"waterfall"}, "waterfall"), ("natural", {"spring"}, "water"),
    ("amenity", {"drinking_water", "water_point"}, "water"), ("natural", {"cave_entrance"}, "cave"),
    ("tourism", {"alpine_hut", "wilderness_hut"}, "shelter"), ("amenity", {"shelter"}, "shelter"),
    ("tourism", {"camp_site"}, "campsite"), ("tourism", {"picnic_site"}, "picnic"),
    ("amenity", {"toilets"}, "toilets"), ("amenity", {"parking"}, "parking"),
]

def poi_kind(tags):
    for key, values, kind in POI_KINDS:
        if tags.get(key) in values:
            return kind
    return None

class Relations(osmium.SimpleHandler):
    """First pass: hiking routes, and the points of interest trails pass by."""
    def __init__(self):
        super().__init__()
        self.routes = {}          # id -> (tags, [(way_id, role)])
        self.member_ways = set()
        self.pois = []            # (lat, lon, kind, name, ele, id)
        self.trailheads = []      # (rank, name, (lat, lon)): 0 = mapped trailhead, 1 = parking

    def node(self, n):
        if not n.tags or not n.location.valid():
            return
        if n.tags.get("highway") == "trailhead" or n.tags.get("information") == "trailhead":
            self.trailheads.append((0, n.tags.get("name", ""), (n.location.lat, n.location.lon)))
        elif n.tags.get("amenity") == "parking" and n.tags.get("access") not in NO_PARKING:
            self.trailheads.append((1, n.tags.get("name", ""), (n.location.lat, n.location.lon)))
        kind = poi_kind(n.tags)
        if kind:
            ele = n.tags.get("ele")
            try:
                ele = round(float(ele.split()[0]), 1) if ele else None
            except ValueError:
                ele = None
            self.pois.append((n.location.lat, n.location.lon, kind, n.tags.get("name", ""), ele, n.id))

    def relation(self, r):
        t = r.tags
        if t.get("type") == "route" and t.get("route") in ("hiking", "foot", "walking"):
            members = [(m.ref, m.role) for m in r.members if m.type == "w"]
            self.routes[r.id] = ({k: v for k, v in t}, members)
            self.member_ways.update(w for w, _ in members)

AREA_TAGS = {("boundary", "protected_area"), ("boundary", "national_park"), ("leisure", "park"),
             ("leisure", "nature_reserve")}

class Areas(osmium.SimpleHandler):
    """Named parks, reserves and protected areas, as polygons (assembled from ways and multipolygon relations)."""
    def __init__(self):
        super().__init__()
        self.names, self.polys = [], []
        self.lake_names, self.lake_polys = [], []     # named lakes, ponds and reservoirs

    def area(self, a):
        t = a.tags
        name = t.get("name")
        lake = t.get("natural") == "water" and t.get("water") not in NOT_LAKES
        if not name or not (lake or any(t.get(k) == v for k, v in AREA_TAGS)):
            return
        try:
            parts = []
            for outer in a.outer_rings():
                shell = [(n.lon, n.lat) for n in outer]
                holes = [[(n.lon, n.lat) for n in inner] for inner in a.inner_rings(outer)]
                if len(shell) >= 4:
                    parts.append(Polygon(shell, [h for h in holes if len(h) >= 4]))
            if not parts:
                return
            geom = parts[0] if len(parts) == 1 else MultiPolygon(parts)
            if not geom.is_valid:
                geom = geom.buffer(0)
            if geom.is_empty:
                return
        except Exception:
            return
        if lake:
            self.lake_names.append(name)
            self.lake_polys.append(geom)
            return
        self.names.append(name)
        self.polys.append(geom)

NOT_LAKES = {"river", "stream", "canal", "ditch", "drain", "wastewater", "basin", "moat", "fishpass", "lock", "rapids"}
PARK_MAX = 0.02        # square degrees (about 190 km²): bigger areas (national forests) don't name their paths
LAKE_NEAR = 0.0009     # degrees: about 80–100 m from the shore

class LakeFinder:
    """Names a path after the lake it runs along."""
    def __init__(self, areas):
        self.names, self.polys = areas.lake_names, areas.lake_polys
        self.tree = STRtree(self.polys) if self.polys else None

    def beside(self, line):
        """The named lake that at least 60% of the line follows the shore of, or None."""
        if self.tree is None or len(line) < 2:
            return None
        pts = [Point(lon, lat) for lat, lon in densify(line, 40)]
        shape = LineString([(lon, lat) for lat, lon in line])
        best = None
        for i in self.tree.query(shape.buffer(LAKE_NEAR)):
            shore = self.polys[int(i)].boundary
            share = sum(1 for p in pts if shore.distance(p) <= LAKE_NEAR) / len(pts)
            if share >= 0.6 and (best is None or share > best[0]):
                best = (share, self.names[int(i)])
        return best[1] if best else None

class AreaFinder:
    def __init__(self, areas):
        self.names = areas.names
        self.polys = areas.polys
        self.tree = STRtree(self.polys) if self.polys else None

    def find(self, lat, lon):
        """The smallest named area containing the point."""
        found = self.find_sized(lat, lon)
        return found[0] if found else None

    def find_sized(self, lat, lon):
        """(name, size in square degrees) of the smallest named area containing the point."""
        if self.tree is None:
            return None
        p = Point(lon, lat)
        best = None
        for i in self.tree.query(p):
            poly = self.polys[int(i)]
            if poly.contains(p) and (best is None or poly.area < self.polys[best].area):
                best = int(i)
        return (self.names[best], self.polys[best].area) if best is not None else None

class Ways(osmium.SimpleHandler):
    def __init__(self, member_ways, finder=None):
        super().__init__()
        self.member_ways = member_ways
        self.finder = finder      # for unnamed park paths: kept only inside a named park
        self.geom = {}            # way id -> [(node_id, (lat, lon))] for route members
        self.named = []           # (way id, name, tags, nodes)
        self.tracks = []          # named dirt tracks: kept only where they're part of the trail network
        self.unnamed = []         # (way id, tags, nodes)
        self.parking = []         # (name, (lat, lon)): car parks drawn as areas
        self.park_ways = 0

    def way(self, w):
        try:
            nodes = [(n.ref, (n.location.lat, n.location.lon)) for n in w.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(nodes) < 2:
            return
        if w.id in self.member_ways:
            self.geom[w.id] = nodes
        t = w.tags
        hw = t.get("highway")
        if t.get("amenity") == "parking":
            if t.get("access") not in NO_PARKING:
                self.parking.append((t.get("name", ""), (sum(c[0] for _, c in nodes) / len(nodes),
                                                         sum(c[1] for _, c in nodes) / len(nodes))))
            return
        if t.get("access") in NO_ACCESS or t.get("foot") in NO_ACCESS:
            return   # private, or closed to people on foot (bike-only and similar)
        name = t.get("name")
        if name and hw in ("path", "footway", "bridleway") and t.get("footway") not in ("sidewalk", "crossing"):
            self.named.append((w.id, name, {k: v for k, v in t}, nodes))
        elif name and hw == "cycleway":
            # a named greenway or rail trail: open to walkers unless it says otherwise
            self.named.append((w.id, name, dict({k: v for k, v in t}, **{"switchback:multiuse": "yes"}), nodes))
        elif name and hw == "track" and t.get("tracktype") != "grade1":
            self.tracks.append((w.id, name, {k: v for k, v in t}, nodes))
        elif not name and hw == "path" and t.get("surface") not in PAVED and "segregated" not in t:
            self.unnamed.append((w.id, {k: v for k, v in t}, nodes))
        elif (not name and hw in ("footway", "path", "bridleway", "cycleway") and self.finder is not None
              and t.get("footway") not in ("sidewalk", "crossing", "access_aisle", "link") and "indoor" not in t):
            # an unnamed walkway (often paved) is a trail only inside a named park: the park's loop, not a pavement
            mid = nodes[len(nodes) // 2][1]
            if self.finder.find(*mid):
                self.unnamed.append((w.id, {k: v for k, v in t}, nodes))
                self.park_ways += 1

# ---------------------------------------------------------------- trails

def make_trail(tid, osm_id, source, name, lines, tags, min_len, main=None):
    measured = [(l, length(l)) for l in lines if len(l) >= 2]
    if not measured:
        return None
    main, main_len = (main, length(main)) if main else max(measured, key=lambda m: m[1])
    if main_len < min_len:
        return None
    segs = [simplify(l) for l, ln in measured if ln >= 30]
    path = simplify(main)
    kept = {k: v[:400] for k, v in tags.items() if k in KEEP_TAGS}
    t = {"id": tid, "name": name, "source": source, "osmId": osm_id,
         "segments": [encode(s) for s in segs], "length": round(main_len, 1)}
    if path in segs:
        t["pathIndex"] = segs.index(path)
    else:
        t["path"] = encode(path)
    # OpenStreetMap's own word that this isn't an official trail: informal=yes, or walking is discouraged
    # (an operator means someone manages it, so it isn't informal whatever the tag says)
    if "operator" not in kept and (kept.get("informal") == "yes" or "discouraged" in (kept.get("access"), kept.get("foot"))):
        kept["switchback:informal"] = "yes"
        kept["switchback:informal_reason"] = ("Mapped in OpenStreetMap as an informal path." if kept.get("informal") == "yes"
                                              else "Mapped in OpenStreetMap as a path walkers are asked not to use.")
    kept.pop("access", None)
    kept.pop("foot", None)
    if kept:
        t["tags"] = kept
    t["_main"] = list(main)
    return t, path[0]

# ---------------------------------------------------------------- hikes: duplicates, loops, trailheads, systems

SIDE_WORDS = re.compile(r"\b(access|spur|connector|cutoff|cut-off|link|connection)\b", re.I)
SYSTEM_SPLIT = re.compile(r"^(.{4,}?)\s+[-–—:]\s+(.+)$")
NOT_SYSTEMS = {"connector", "trail", "trails", "loop", "path", "unnamed trail"}

def is_unnamed(t):
    return t.get("tags", {}).get("switchback:unnamed") == "yes"

def lines_of(t):
    return [decode(s) for s in t["segments"]]

def densify(line, step):
    out = [line[0]]
    for a, b in zip(line, line[1:]):
        k = max(1, int(dist(a, b) // step))
        out += [(a[0] + (b[0] - a[0]) * i / k, a[1] + (b[1] - a[1]) * i / k) for i in range(1, k + 1)]
    return out

def coverage(a_lines, b_lines, near=15):
    """The share of a's lines that lie within `near` metres of b's."""
    cells = defaultdict(list)
    for l in b_lines:
        for p in densify(l, 8):
            cells[(round(p[0] * 5000), round(p[1] * 5000))].append(p)
    pts = [p for l in a_lines for p in densify(l, 15)]
    hit = 0
    for p in pts:
        k = (round(p[0] * 5000), round(p[1] * 5000))
        if any(dist(p, q) <= near for dy in (-1, 0, 1) for dx in (-1, 0, 1) for q in cells.get((k[0] + dy, k[1] + dx), ())):
            hit += 1
    return hit / len(pts) if pts else 0

def drop_duplicates(trails):
    """Two named trails that are the same line (each covers 95% of the other) are one hike: a route and the path it
    runs on, mapped under two names. The route stays (it takes the other's details and name as alt_name); a trail that
    is only PART of another is never dropped."""
    named = [i for i, (t, _) in enumerate(trails) if not is_unnamed(t)]
    geo, buckets = {}, defaultdict(list)
    for i in named:
        ls = lines_of(trails[i][0])
        pts = [p for l in ls for p in l]
        c = ((min(p[0] for p in pts) + max(p[0] for p in pts)) / 2, (min(p[1] for p in pts) + max(p[1] for p in pts)) / 2)
        geo[i] = (ls, sum(length(l) for l in ls))
        buckets[(round(c[0] * 100), round(c[1] * 100))].append(i)
    dropped = set()
    for (ky, kx), items in buckets.items():
        for i in items:
            for j in [x for dy in (-1, 0, 1) for dx in (-1, 0, 1) for x in buckets.get((ky + dy, kx + dx), ())]:
                if j <= i or i in dropped or j in dropped:
                    continue
                (la, na), (lb, nb) = geo[i], geo[j]
                if not 0.85 <= na / max(nb, 1) <= 1.18:
                    continue
                if coverage(la, lb) < 0.95 or coverage(lb, la) < 0.95:
                    continue
                a, b = trails[i][0], trails[j][0]
                keep, drop, gone = (a, b, j) if (a["source"] == "osmRelation" or b["source"] != "osmRelation") else (b, a, i)
                tags = keep.setdefault("tags", {})
                for k, v in drop.get("tags", {}).items():
                    tags.setdefault(k, v)
                if drop["name"].lower() != keep["name"].lower():
                    tags.setdefault("alt_name", drop["name"])
                    keep.setdefault("_names", []).append(drop["name"])
                dropped.add(gone)
    print(f"  duplicates: {len(dropped)} trails that were the same line as another")
    return [tr for i, tr in enumerate(trails) if i not in dropped]

def set_main(t, main, extra):
    """Gives a trail a new line to follow (and more lines to draw)."""
    segs = lines_of(t) + [simplify(l) for l in extra if len(l) >= 2]
    path = simplify(main)
    t["segments"] = [encode(x) for x in segs]
    t.pop("pathIndex", None)
    t["path"] = encode(path)
    t["length"] = round(length(main), 1)
    t["_main"] = list(main)
    return path[0]

def closed(main):
    return len(main) > 2 and length(main) > 500 and dist(main[0], main[-1]) < max(150, length(main) * 0.03)

def shortest(adj, src, dst, limit, banned=()):
    """(metres, node ids) of the shortest walk from src to dst within limit, not using the banned edges."""
    best, prev, heap = {src: 0.0}, {}, [(0.0, src)]
    while heap:
        d, n = heapq.heappop(heap)
        if n == dst:
            path = [n]
            while path[-1] != src:
                path.append(prev[path[-1]])
            return d, path[::-1]
        if d > best.get(n, math.inf):
            continue
        for m, w in adj.get(n, ()):
            if (n, m) in banned:
                continue
            nd = d + w
            if nd <= limit and nd < best.get(m, math.inf):
                best[m], prev[m] = nd, n
                heapq.heappush(heap, (nd, m))
    return None

def hikes(trails, adj, where, node_names, heads):
    """Turns trails into hikes: closes named loops along the trails that complete them, finds the trailheads each
    trail can be started from (with the walk in), offers loops that hang off a loop as extensions, marks access trails
    and connectors as side trails, and groups trail systems."""
    node_of = {c: n for n, c in where.items()}
    ids = lambda main: [node_of.get(c) for c in main]

    # 1. named loops that don't come back to their start: close them along other trails
    closed_now = 0
    for k, (t, _) in enumerate(trails):
        main = t["_main"]
        names = [t["name"]] + t.get("_names", [])
        if is_unnamed(t) or closed(main) or not any(re.search(r"\bloop\b", n, re.I) for n in names):
            continue
        nodes = ids(main)
        a, z = nodes[0], nodes[-1]
        if a is None or z is None or a == z:
            continue
        own = {(x, y) for x, y in zip(nodes, nodes[1:])} | {(y, x) for x, y in zip(nodes, nodes[1:])}
        found = shortest(adj, z, a, min(2 * length(main), 15000), own)
        if not found:
            continue
        back = [where[n] for n in found[1]]
        start = set_main(t, main + back[1:], [back])
        t.setdefault("tags", {})["switchback:closed"] = "yes"
        trails[k] = (t, start)
        closed_now += 1
    print(f"  loops: closed {closed_now} named loops along the trails that complete them")

    # 2. side trails: access trails, spurs, connectors and cutoffs aren't hikes of their own
    sides = 0
    for t, _ in trails:
        name = t["name"]
        generated = is_unnamed(t) and (name.startswith("Connector") or name.endswith(" spur"))
        if generated or (not is_unnamed(t) and SIDE_WORDS.search(name) and t["length"] < 3220 and not closed(t["_main"])):
            t.setdefault("tags", {})["switchback:side"] = "yes"
            sides += 1
    print(f"  side trails: {sides} access trails, spurs and connectors")

    hikeable = [i for i, (t, _) in enumerate(trails) if not is_unnamed(t) and t.get("tags", {}).get("switchback:side") != "yes"]
    loops = {i for i in hikeable if closed(trails[i][0]["_main"])}
    targets = defaultdict(list)       # node -> hikes that can be joined there (a loop anywhere, a line at its ends)
    loop_nodes = defaultdict(list)    # node -> loops through it
    for i in hikeable:
        nodes = ids(trails[i][0]["_main"])
        if i in loops:
            for n in set(nodes) - {None}:
                targets[n].append(i)
                loop_nodes[n].append(i)
        else:
            for n in {nodes[0], nodes[-1]} - {None}:
                targets[n].append(i)

    # 3. trailheads: mapped trailheads and car parks next to a trail, and the walk from each to the trails near it
    grid = defaultdict(list)
    for n, c in where.items():
        grid[(round(c[0] * 500), round(c[1] * 500))].append(n)       # ~220 m cells
    placed = []
    for rank, name, c in sorted(heads, key=lambda h: (h[0], not h[1])):
        k = (round(c[0] * 500), round(c[1] * 500))
        near = [(dist(c, where[n]), n) for dy in (-1, 0, 1) for dx in (-1, 0, 1) for n in grid.get((k[0] + dy, k[1] + dx), ())]
        if not near:
            continue
        gap, node = min(near)
        if gap > TRAILHEAD_M or any(dist(c, q[2]) < 150 for q in placed if abs(q[2][0] - c[0]) < 0.01):
            continue
        if not name:
            on = sorted(node_names.get(node, ()))
            name = f"Parking on {on[0]}" if on else "Parking"
        placed.append((name, node, c, gap))
    access = defaultdict(list)
    for name, node, c, gap in placed:
        best, prev, heap, seen = {node: 0.0}, {}, [(0.0, node)], set()
        while heap:
            d, n = heapq.heappop(heap)
            if d > best.get(n, math.inf):
                continue
            for i in targets.get(n, ()):
                if i not in seen:
                    seen.add(i)
                    path = [n]
                    while path[-1] != node:
                        path.append(prev[path[-1]])
                    access[i].append((gap + d, name, c, [c] + [where[x] for x in reversed(path)]))
            for m, w in adj.get(n, ()):
                nd = d + w
                if nd <= ACCESS_M and nd < best.get(m, math.inf):
                    best[m], prev[m] = nd, n
                    heapq.heappush(heap, (nd, m))
    with_access = 0
    for i, found in access.items():
        found.sort(key=lambda f: f[0])
        out = []
        for d, name, c, line in found[:6]:
            e = {"n": name, "d": round(d), "p": [round(c[0], 5), round(c[1], 5)]}
            if d >= 30:
                e["l"] = encode(simplify(line))
            out.append(e)
        trails[i][0].setdefault("tags", {})["switchback:access"] = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
        with_access += 1
    print(f"  trailheads: {len(placed)} next to trails; {with_access} of {len(hikeable)} hikes can be started from one")

    # 3b. fragments: a short named piece with no trailhead isn't a hike of its own. If it joins other trails at both
    # ends it's a connector (a side trail); otherwise it's a fragment. Both stay on the map.
    through = defaultdict(set)        # node -> trails through it
    for i, (t, _) in enumerate(trails):
        for n in ids(t["_main"]):
            if n is not None:
                through[n].add(i)
    fragments = connectors = 0
    for i in hikeable:
        t = trails[i][0]
        tags = t.setdefault("tags", {})
        if t["length"] >= FRAGMENT_M or i in loops or "switchback:access" in tags:
            continue
        nodes = ids(t["_main"])
        ends = [n for n in (nodes[0], nodes[-1]) if n is not None]
        if len(ends) == 2 and all(through[n] - {i} for n in ends):
            tags["switchback:side"] = "yes"
            connectors += 1
        else:
            tags["switchback:fragment"] = "yes"
            fragments += 1
    print(f"  short pieces: {connectors} that join two trails (connectors), {fragments} fragments")

    # 4. extensions: a loop that hangs off another loop (shares a junction and at most a third of its line) can be added to it
    extended = 0
    side_now = lambda j: trails[j][0].get("tags", {}).get("switchback:side") == "yes"
    for i in loops:
        nodes = [n for n in ids(trails[i][0]["_main"]) if n is not None]
        mine = set(nodes)
        others = {j for n in mine for j in loop_nodes.get(n, ()) if j != i}
        ext = []
        for j in others:
            s = trails[j][0]
            s_nodes = ids(s["_main"])
            shared = [n for n in s_nodes if n in mine]
            if not shared or len(shared) > 0.35 * len(s_nodes) or s["length"] > trails[i][0]["length"]:
                continue
            at = s_nodes.index(shared[0])
            line = s["_main"][at:] + s["_main"][1:at + 1]          # the side loop, starting at the junction
            ext.append({"id": s["id"], "n": s["name"], "m": round(s["length"]), "l": encode(simplify(line))})
        if ext:
            ext.sort(key=lambda e: e["m"])
            trails[i][0].setdefault("tags", {})["switchback:ext"] = json.dumps(ext[:3], ensure_ascii=False, separators=(",", ":"))
            extended += 1
    print(f"  extensions: {extended} loops have a side loop that can be added")

    # 5. trail systems: "Cedar Creek Trail - Moon Loop", "- Pine Ridge", … and the trail they're named after
    groups = defaultdict(set)
    for i, (t, _) in enumerate(trails):
        if is_unnamed(t):
            continue
        for name in [t["name"]] + t.get("_names", []):
            m = SYSTEM_SPLIT.match(name)
            if m and m.group(1).strip().lower() not in NOT_SYSTEMS:
                groups[m.group(1).strip()].add(i)
    systems = {name: members for name, members in groups.items() if len(members) >= 3}
    by_lower = {name.lower(): name for name in systems}
    tagged = 0
    for i, (t, _) in enumerate(trails):
        name = next((n for n, members in systems.items() if i in members), None)
        if not name and not is_unnamed(t):
            name = by_lower.get(t["name"].lower())
        if name:
            t.setdefault("tags", {})["switchback:system"] = name
            tagged += 1
    print(f"  systems: {len(systems)} trail systems with {tagged} trails")
    return trails


ROAD_NAME = re.compile(r"\b(road|rd|street|avenue|ave|highway|hwy|lane|drive|route|fsr)\b|\b(fr|cr|fs|nf)[ -]?\d", re.I)
HIKING_HINTS = {"sac_scale", "trail_visibility", "mtb:scale"}
TRAIL_WORDS = re.compile(r"\b(trail|trl|path|loop|trace|greenway)\b", re.I)
NATURAL_SURFACE = {"ground", "dirt", "earth", "grass", "gravel", "fine_gravel", "rock", "pebblestone", "mud", "sand",
                   "unpaved", "wood", "woodchips"}

def middle(pts):
    """The point halfway along a line."""
    total, half = length(pts), length(pts) / 2
    run = 0
    for i in range(1, len(pts)):
        d = dist(pts[i - 1], pts[i])
        if run + d >= half and d > 0:
            t = (half - run) / d
            return (pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t)
        run += d
    return pts[len(pts) // 2]

def build(pbf):
    areas = Areas()
    areas.apply_file(pbf, locations=True, idx="flex_mem")
    finder = AreaFinder(areas)
    lakes = LakeFinder(areas)
    print(f"  {len(areas.names)} named parks and protected areas")
    rel = Relations()
    rel.apply_file(pbf)
    ways = Ways(rel.member_ways, finder)
    ways.apply_file(pbf, locations=True, idx="flex_mem")
    print(f"  {ways.park_ways} unnamed walkways inside parks")

    trails, relation_names, route_ends = [], set(), set()
    node_names = defaultdict(set)      # node id -> names of the trails through it
    for rid, (tags, members) in rel.routes.items():
        pieces = []
        rname = tags.get("name")
        for wid, role in members:
            nodes = ways.geom.get(wid)
            if not nodes:
                continue
            route_ends.update((nodes[0][0], nodes[-1][0]))
            if rname:
                for n, _ in nodes:
                    node_names[n].add(rname)
            if role not in SKIP_ROLES:
                pieces.append(nodes)
        name = tags.get("name") or tags.get("name:en") or (f"Route {tags['ref']}" if "ref" in tags else "Unnamed route")
        made = make_trail(f"r{rid}", rid, "osmRelation", name, chains(pieces), tags, 300)
        if made:
            trails.append(made)
            relation_names.add(name.lower())

    for wid, name, tags, nodes in ways.named:
        for n, _ in nodes:
            node_names[n].add(name)
    # Named dirt tracks: in farm country most are section-line roads ("66th Street Southeast"). Keep one only where
    # it's in a park or forest, joins a trail, is tagged for hiking, or is called a trail.
    track_groups = defaultdict(list)
    for wid, name, tags, nodes in ways.tracks:
        track_groups[name].append((wid, tags, nodes))
    kept_tracks = dropped_tracks = 0
    for name, group in track_groups.items():
        trailish = bool(TRAIL_WORDS.search(name))
        for line in chains([nodes for _, _, nodes in group], with_nodes=True):
            pts = [c for _, c in line]
            touches = line[0][0] in node_names or line[-1][0] in node_names
            tags = group[0][1]
            hiking = any(k in tags for k in HIKING_HINTS) or tags.get("foot") == "designated"
            if trailish or touches or hiking or finder.find(*middle(pts)):
                # a dirt road you can walk is a road walk, not a trail ("Road walk: County Road 356")
                road = bool(ROAD_NAME.search(name)) and not trailish
                shown = f"Road walk: {name}" if road else name
                ways.named.append((group[0][0], shown, dict(tags, **{"switchback:roadwalk": "yes"}) if road else tags, line))
                kept_tracks += 1
            else:
                dropped_tracks += 1
    print(f"  named tracks: kept {kept_tracks}, dropped {dropped_tracks} (roads outside parks)")

    by_name = defaultdict(list)
    for wid, name, tags, nodes in ways.named:
        if name.lower() not in relation_names:
            by_name[name].append((wid, tags, nodes))
    # every trail line, so pieces of one named trail can be joined along the trails between them
    adj, where = network([n for n in ways.geom.values()] + [n for _, _, _, n in ways.named] +
                         [n for _, _, n in ways.unnamed])
    joined = 0
    for name, group in by_name.items():
        lines = chains([nodes for _, _, nodes in group], with_nodes=True)
        # generic names ("Connector", "White Connector 1") are many different trails: never joined across gaps
        generic = bool(SIDE_WORDS.search(name)) or name.lower() in NOT_SYSTEMS
        parks = None if generic or len(lines) < 2 else [finder.find(*middle([c for _, c in l])) for l in lines]
        walks = link_pieces(lines, adj, where, parks)
        joined += len(lines) - len(walks)
        for walk, segs in walks:
            first = walk[0]
            owner = next(((wid, tags) for wid, tags, nodes in group if any(c == first for _, c in nodes)), (group[0][0], group[0][1]))
            made = make_trail("w%s-%.3f,%.3f" % (name, first[0], first[1]), owner[0], "osmWay", name, segs, owner[1], 400,
                              main=walk)
            if made:
                trails.append(made)
    print(f"  named trails: joined {joined} pieces mapped apart into the trail they belong to")

    pieces, tags_by_end = [], {}
    for wid, tags, nodes in ways.unnamed:
        if nodes[0][0] in route_ends and nodes[-1][0] in route_ends:
            continue
        pieces.append(nodes)
        tags_by_end[nodes[0][0]] = tags_by_end[nodes[-1][0]] = tags
    dropped = lake_walks = 0
    for chain in chains(pieces, with_nodes=True):
        line = [c for _, c in chain]
        # what the ends (and the line) touch
        touch_a = node_names.get(chain[0][0], set())
        touch_z = node_names.get(chain[-1][0], set())
        touched = set().union(*(node_names.get(n, set()) for n, _ in chain)) if chain else set()
        tags = tags_by_end.get(chain[0][0]) or tags_by_end.get(chain[-1][0]) or {}
        mid = middle(line)
        area = finder.find(*mid)
        hiking = any(k in tags for k in HIKING_HINTS) or tags.get("surface") in NATURAL_SURFACE
        if not area and not touched and not hiking and length(line) < 2000:
            dropped += 1
            continue
        if touch_a and touch_z and touch_a != touch_z:
            a, z = sorted(touch_a)[0], sorted(touch_z - touch_a or touch_z)[0]
            name = f"Connector: {a} – {z}"
        elif touch_a or touch_z or touched:
            name = f"{sorted(touch_a or touch_z or touched)[0]} spur"
        else:
            name = "Unnamed trail"
        # a path along a named lake's shore is that lake's walk ("Little Dixie Lake Walk")
        lake = lakes.beside(line) if name == "Unnamed trail" else None
        if lake:
            name = lake if re.search(r"\b(walk|trail|path|loop)$", lake, re.I) else f"{lake} Walk"
            lake_walks += 1
        ka, kz = "%.5f,%.5f" % line[0], "%.5f,%.5f" % line[-1]
        made = make_trail("u" + min(ka, kz) + "|" + max(ka, kz), 0, "osmWay", name, [line], tags, 800)
        if made:
            made[0].setdefault("tags", {})["switchback:derived_name" if lake else "switchback:unnamed"] = "yes"
            trails.append(made)
    print(f"  dropped {dropped} unnamed paths outside parks that join no trail; named {lake_walks} after the lake they follow")

    # every trail's area
    in_area = defaultdict(list)
    for t, _ in trails:
        lines = [decode(s) for s in t["segments"]]
        main = lines[t.get("pathIndex", 0)] if "pathIndex" in t else decode(t["path"])
        found = finder.find_sized(*middle(main))
        if found:
            t.setdefault("tags", {})["switchback:area"] = found[0]
            in_area[found].append(t)
    # an unnamed path in a park (not a vast forest) takes the park's name; where the park has no named trail at all,
    # its longest path is the park's trail ("Clifty Creek Conservation Area Trail") and listed like any other
    park_named = 0
    for (area, size), members in in_area.items():
        plain = sorted((t for t in members if is_unnamed(t) and t["name"] == "Unnamed trail"), key=lambda t: -t["length"])
        if not plain or size > PARK_MAX:
            continue
        base = area if re.search(r"\b(trail|trails|path|greenway)$", area, re.I) else None
        if all(is_unnamed(t) for t in members):
            first, plain = plain[0], plain[1:]
            first["name"] = base or f"{area} Trail"
            del first["tags"]["switchback:unnamed"]
            first["tags"]["switchback:derived_name"] = "yes"
            park_named += 1
        for t in plain:
            t["name"] = f"{area} path"
            park_named += 1
    print(f"  named {park_named} unnamed paths after the park they're in")
    trails = drop_duplicates(trails)
    trails = hikes(trails, adj, where, node_names, rel.trailheads + [(1, n, c) for n, c in ways.parking])
    for t, _ in trails:
        for k in [k for k in t if k.startswith("_")]:
            del t[k]
    pois = pois_near(trails, rel.pois)
    return trails, pois

def pois_near(trails, pois):
    """Keeps the points of interest within about 200 m of a trail (not every café and toilet in town)."""
    lines = []
    for t, _ in trails:
        for seg in t["segments"]:
            pts = decode(seg)
            if len(pts) >= 2:
                lines.append(LineString([(lo, la) for la, lo in pts]))
    if not lines or not pois:
        return []
    tree = STRtree(lines)
    kept = []
    for lat, lon, kind, name, ele, pid in pois:
        k = math.cos(math.radians(lat))
        reach = 0.0018 if kind != "parking" else 0.0025          # degrees of latitude ≈ 200 m (250 m for parking)
        p = Point(lon, lat)
        near = tree.query(p.buffer(reach / max(k, 0.2)))
        if any(lines[int(i)].distance(p) * 111320 * min(1, k * 1.2) < reach * 111320 for i in near):
            kept.append([round(lat * 1e5), round(lon * 1e5), kind, name, ele, pid])
    return kept

def quality(trails, pois):
    """A few numbers to spot bad data in the build log (and in the region list)."""
    q = defaultdict(int)
    long_ones, seen = [], defaultdict(int)
    for t, start in trails:
        tags = t.get("tags", {})
        if t["id"].startswith("r"):
            q["routes"] += 1
        elif tags.get("switchback:unnamed"):
            name = t["name"]
            q["connectors" if name.startswith("Connector") else "spurs" if name.endswith("spur") else "unnamed"] += 1
        else:
            q["named paths"] += 1
        if tags.get("switchback:area"):
            q["in an area"] += 1
        if t["length"] > 150_000:
            long_ones.append(f"{t['name']} ({t['length'] / 1000:.0f} km)")
        seen[(t["name"], math.floor(start[0] / CELL), math.floor(start[1] / CELL))] += 1
    q["same name twice in a cell"] = sum(1 for (n, *_), c in seen.items() if c > 1 and n != "Unnamed trail")
    q["highlights"] = len(pois)
    return dict(q), long_ones[:10]

MAGIC = b"SBTP1"

def main():
    """Writes one file per region: <region>.trails, plus a small summary <region>.json.

    <region>.trails = "SBTP1" + 4-byte big-endian header length + header JSON
                      {version, region, cell, bbox, cells: {"row_col": [offset, length]}}
                      + one raw-DEFLATE JSON list of trails per cell (offsets count from the end of the header),
    so the app downloads the state once and unpacks only the cells it needs.
    """
    pbf, region, out = sys.argv[1], sys.argv[2], sys.argv[3]
    country = sys.argv[4] if len(sys.argv) > 4 else "US"
    display = sys.argv[5] if len(sys.argv) > 5 else region.replace("-", " ").title()
    os.makedirs(out, exist_ok=True)
    trails, pois = build(pbf)
    if os.environ.get("ELEVATION", "1") != "0":
        add_elevation(trails, os.environ.get("TERRAIN_CACHE", "terrain"))
    cells = defaultdict(list)
    coverage = set()   # 1° squares with trails: lets the app tell exactly which regions cover a place
    lats, lons = [], []
    for t, start in trails:
        coverage.add(f"{math.floor(start[0])}_{math.floor(start[1])}")
        row, col = math.floor(start[0] / CELL), math.floor(start[1] / CELL)
        cells[f"{row}_{col}"].append(t)
        lats.append(start[0])
        lons.append(start[1])
    version = os.environ.get("PACK_VERSION", "dev")
    bbox = [min(lats), min(lons), max(lats), max(lons)] if lats else None
    blobs, table, offset = [], {}, 0
    for key, ts in sorted(cells.items()):
        raw = json.dumps(ts, ensure_ascii=False, separators=(",", ":")).encode()
        c = zlib.compressobj(9, zlib.DEFLATED, -15)   # raw DEFLATE, which the app reads with NSData's .zlib
        z = c.compress(raw) + c.flush()
        table[key] = [offset, len(z)]
        blobs.append(z)
        offset += len(z)
    # highlights (viewpoints, water, shelters…) near trails, per cell, as "p:<cell>":
    # [lat·1e5, lon·1e5, kind, name, elevation, OSM node id]
    poi_cells = defaultdict(list)
    for p in pois:
        poi_cells[f"p:{math.floor(p[0] / 1e5 / CELL)}_{math.floor(p[1] / 1e5 / CELL)}"].append(p)
    for key, ps in sorted(poi_cells.items()):
        raw = json.dumps(ps, ensure_ascii=False, separators=(",", ":")).encode()
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        z = c.compress(raw) + c.flush()
        table[key] = [offset, len(z)]
        blobs.append(z)
        offset += len(z)
    header = json.dumps({"version": version, "region": region, "cell": CELL, "bbox": bbox, "cells": table},
                        separators=(",", ":")).encode()
    with open(os.path.join(out, f"{region}.trails"), "wb") as f:
        f.write(MAGIC + len(header).to_bytes(4, "big") + header + b"".join(blobs))
    size = len(MAGIC) + 4 + len(header) + offset
    with open(os.path.join(out, f"{region}.json"), "w") as f:
        q, long_ones = quality(trails, pois)
        json.dump({"region": region, "name": display, "country": country, "version": version, "bbox": bbox,
                   "coverage": sorted(coverage), "cells": len(cells), "bytes": size, "trails": len(trails),
                   "highlights": len(pois), "quality": q},
                  f, separators=(",", ":"))
    named = sum(1 for t, _ in trails if not t.get("tags", {}).get("switchback:unnamed"))
    areas = len({t.get("tags", {}).get("switchback:area") for t, _ in trails} - {None})
    print(f"{region}: {len(trails)} trails ({named} named) in {areas} areas and {len(cells)} cells, "
          f"{len(pois)} highlights, one file of {size / 1024:.0f} KB")
    print("  quality:", ", ".join(f"{k} {v}" for k, v in sorted(q.items())))
    if long_ones:
        print("  longest (check these are real):", "; ".join(long_ones))

if __name__ == "__main__":
    main()
