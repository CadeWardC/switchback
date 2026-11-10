#!/usr/bin/env python3
"""What OpenStreetMap has around some points (read-only diagnostic): every walkable way within 400 m, with the tags
that decide whether the pack builder keeps it.

    whats_at.py <region.osm.pbf> "lat,lon;lat,lon;…"
"""
import math, sys
from collections import Counter, defaultdict

import osmium

WALKABLE = {"path", "footway", "cycleway", "track", "bridleway", "pedestrian", "steps"}
NEAR = 400

def dist(a, b):
    k = math.cos(math.radians((a[0] + b[0]) / 2))
    return math.hypot((a[0] - b[0]) * 111320, (a[1] - b[1]) * 111320 * k)

class Scan(osmium.SimpleHandler):
    def __init__(self, points):
        super().__init__()
        self.points = points
        self.grid = defaultdict(list)
        for i, p in enumerate(points):
            self.grid[(round(p[0] * 100), round(p[1] * 100))].append(i)
        self.found = defaultdict(list)

    def way(self, w):
        hw = w.tags.get("highway")
        if hw not in WALKABLE:
            return
        try:
            nodes = [(n.location.lat, n.location.lon) for n in w.nodes if n.location.valid()]
        except osmium.InvalidLocationError:
            return
        if len(nodes) < 2:
            return
        hit = set()
        for c in nodes:
            k = (round(c[0] * 100), round(c[1] * 100))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    for i in self.grid.get((k[0] + dy, k[1] + dx), ()):
                        if i not in hit and dist(c, self.points[i]) <= NEAR:
                            hit.add(i)
        if not hit:
            return
        t = w.tags
        row = {"hw": hw, "name": t.get("name", ""), "surface": t.get("surface", ""), "footway": t.get("footway", ""),
               "access": t.get("access", ""), "foot": t.get("foot", ""), "informal": t.get("informal", ""),
               "m": sum(dist(a, b) for a, b in zip(nodes, nodes[1:]))}
        for i in hit:
            self.found[i].append(row)

def why(r):
    """Why the builder would drop this way (or 'kept')."""
    if r["access"] in ("private", "no") or r["foot"] in ("private", "no"):
        return "closed or private"
    if r["footway"] in ("sidewalk", "crossing"):
        return "sidewalk"
    if r["name"]:
        return "kept (named)" if r["hw"] != "pedestrian" and r["hw"] != "steps" else f"named {r['hw']} (not taken)"
    if r["hw"] == "path":
        return "unnamed path, paved (dropped)" if r["surface"] in ("paved", "asphalt", "concrete", "paving_stones", "sett", "compacted") else "unnamed path (kept if 0.5 mi+ when joined)"
    return f"unnamed {r['hw']} (not taken)"

def main():
    points = [tuple(float(x) for x in p.split(",")) for p in sys.argv[2].split(";") if p]
    scan = Scan(points)
    scan.apply_file(sys.argv[1], locations=True, idx="flex_mem")
    overall = Counter()
    for i, p in enumerate(points):
        rows = scan.found.get(i, [])
        if not rows:
            print(f"{i}: nothing walkable mapped within {NEAR} m")
            overall["nothing mapped"] += 1
            continue
        kinds = defaultdict(lambda: [0, 0.0, set()])
        for r in rows:
            k = kinds[why(r)]
            k[0] += 1
            k[1] += r["m"]
            if r["name"]:
                k[2].add(r["name"])
        main_kind = max(kinds.items(), key=lambda kv: kv[1][1])[0]
        overall[main_kind] += 1
        parts = [f"{k}: {v[0]} ways, {v[1] / 1609.34:.1f} mi" + (f" {sorted(v[2])[:4]}" if v[2] else "")
                 for k, v in sorted(kinds.items(), key=lambda kv: -kv[1][1])]
        surf = Counter(r["surface"] or "?" for r in rows)
        print(f"{i}: " + " | ".join(parts) + f" | surfaces {dict(surf.most_common(4))}")
    print("\nMostly, by point:", dict(overall.most_common()))

if __name__ == "__main__":
    main()
