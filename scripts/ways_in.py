#!/usr/bin/env python3
"""Says which trails each way in follows (run by the trail-packs workflow once a pack has its final names).

    ways_in.py <out-dir> <region-id>

A hike's trailheads (the tag "switchback:access") each carry the walk from the trailhead to the trail. Where that
walk runs along other named trails, the trailhead gets them as "v", in the order walked, so the app can say
"via Ridge Trail" when you pick where to start:

  - at most two trails, the ones the walk spends longest on
  - each for at least 100 m and a fifth of the walk
  - only trails with a name of their own: not unnamed paths, names we made up ("Connector: A – B", "A spur"),
    road walks or informal paths
  - never the hike itself, nor a stretch named for it and another trail ("A and B")
  - nothing for a walk shorter than 150 m

Trails are found by shape (the walk within 6 m of a trail's line), in the walk's own cell and the cells around it.
Rewrites <region-id>.trails in place (same version, same cells) and adds the count to <region-id>.json.
"""
import json, math, os, sys
from collections import defaultdict

import numpy as np
import shapely
from shapely.geometry import LineString
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich_trail_pack as packs      # noqa: E402
from build_trail_pack import decode   # noqa: E402

TAG = "switchback:access"
STEP = 5.0          # metres between the points a walk is checked at
NEAR = 6.0          # a walk this close to a trail's line is on it
PIECE = 30          # points in each piece a trail's line is measured in
MIN_WALK = 150.0    # a shorter walk in isn't "via" anything
MIN_ON = 100.0      # a trail has to carry the walk at least this far…
MIN_SHARE = 0.2     # …and this share of it
NOT_A_NAME = ("switchback:unnamed", "switchback:derived_name", "switchback:roadwalk", "switchback:informal")

def nameable(t):
    tags = t.get("tags", {})
    name = t.get("name") or ""
    # (a mapper's note to self isn't a name: "Kollersweid - fixme")
    return bool(name) and "fixme" not in name.lower() and "?" not in name and not any(tags.get(k) == "yes" for k in NOT_A_NAME)

def same(a, b):
    """The same trail by name, or a stretch named for both ("A and B" beside "A")."""
    a, b = a.casefold().strip(), b.casefold().strip()
    return a in b or b in a

class Lines:
    """The lines of the named trails in a cell and the cells around it, on a flat local grid in metres."""
    def __init__(self, groups):
        self.names, self.geoms = [], []
        first = next((decode(s)[0] for rows in groups for t in rows for s in t["segments"][:1] if s), None)
        self.kx = 111320 * math.cos(math.radians(first[0])) if first else 1.0
        for rows in groups:
            for t in rows:
                if not nameable(t):
                    continue
                for s in t["segments"] + ([t["path"]] if "path" in t else []):
                    pts = self.flat(decode(s))
                    # in short pieces, so a walk is only measured against the part of a long trail beside it
                    for i in range(0, len(pts) - 1, PIECE):
                        g = LineString(pts[i:i + PIECE + 1])
                        if g.length > 0:
                            self.names.append(t["name"])
                            self.geoms.append(g)
        self.tree = STRtree(self.geoms) if self.geoms else None

    def flat(self, pts):
        return [(lo * self.kx, la * 110540) for la, lo in pts]

    def via(self, walk, own):
        """The trails a walk follows, in the order walked (see the rules above)."""
        if self.tree is None or len(walk) < 2:
            return []
        geom = LineString(self.flat(walk))
        total = geom.length
        if total < MIN_WALK:
            return []
        n = int(total // STEP) + 2
        samples = shapely.line_interpolate_point(geom, np.linspace(0, total, n))
        on = {}                                  # name -> which samples are on a trail of that name
        for j in self.tree.query(geom, predicate="dwithin", distance=NEAR):
            name = self.names[j]
            if same(name, own):
                continue
            hit = shapely.distance(self.geoms[j], samples) <= NEAR
            if hit.any():
                on[name] = on[name] | hit if name in on else hit
        picked, free = [], np.ones(n, dtype=bool)
        need = max(MIN_ON, MIN_SHARE * total)
        while on and len(picked) < 2:
            # the trail carrying the most of what no trail picked so far carries (two names for one stretch of
            # ground, a route and the path it runs on, give one "via")
            name = max(on, key=lambda k: (int((on[k] & free).sum()), k))
            hit = on.pop(name) & free
            if hit.sum() * total / n < need:
                break
            if any(same(name, other) for _, other in picked):
                continue
            picked.append((int(np.argmax(hit)), name))
            free &= ~hit
        return [name for _, name in sorted(picked)]

def main():
    out_dir, region = sys.argv[1], sys.argv[2]
    pack_path = os.path.join(out_dir, f"{region}.trails")
    info_path = os.path.join(out_dir, f"{region}.json")
    header, cells = packs.read(pack_path)
    rows = {k: json.loads(v) for k, v in cells.items() if not k.startswith("p:")}
    walks = named = 0
    for key in sorted(rows):
        if not any(TAG in t.get("tags", {}) for t in rows[key]):
            continue
        r, c = (int(x) for x in key.split("_"))
        around = [rows[f"{r + dr}_{c + dc}"] for dr in (-1, 0, 1) for dc in (-1, 0, 1) if f"{r + dr}_{c + dc}" in rows]
        lines = Lines(around)
        for t in rows[key]:
            raw = t.get("tags", {}).get(TAG)
            if not raw:
                continue
            entries = json.loads(raw)
            for e in entries:
                e.pop("v", None)
                if "l" not in e:
                    continue
                walks += 1
                via = lines.via(decode(e["l"]), t["name"])
                if via:
                    e["v"] = via
                    named += 1
            t["tags"][TAG] = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
        cells[key] = json.dumps(rows[key], ensure_ascii=False, separators=(",", ":")).encode()
    size = packs.write(pack_path, header, cells)
    info = json.load(open(info_path))
    info["bytes"] = size
    info["ways in"] = {"walks": walks, "via a named trail": named}
    json.dump(info, open(info_path, "w"), separators=(",", ":"))
    print(f"  ways in: {named} of {walks} walks follow a named trail; file now {size / 1024:.0f} KB")

if __name__ == "__main__":
    main()
