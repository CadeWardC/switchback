#!/usr/bin/env python3
"""Looks through a finished trail pack for hikes that probably aren't cohesive, so they are found by the build and
not by someone scrolling the map.

    trail_quality.py <pack-dir> <region-id> [--list N]

Counts, and with --list names the worst of:
  split     a name carried by two or more hikes whose ends are within a mile of each other: likely one trail in pieces
  tangled   a hike whose lines add up to much more than its main line: a web or a trail with big side branches
  near_loop a one-way hike that ends within a quarter mile of where it starts: likely a loop left open
Also counts what the build already repaired: routes turned into system overviews, trails with a bridged stretch (joined pieces, closed loops).
Adds the counts to <region-id>.json under "cohesion" and prints one line.
"""
import json, os, sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich_trail_pack as packs                                   # noqa: E402
from build_trail_pack import SIDE_WORDS, NOT_SYSTEMS, decode, dist, length  # noqa: E402

SPLIT_M, NEAR_LOOP_M = 1609, 400

def main_of(t):
    return decode(t["segments"][t["pathIndex"]]) if "pathIndex" in t else decode(t["path"])

def check(trails):
    out = defaultdict(list)
    counts = defaultdict(int)
    by_name = defaultdict(list)
    for t in trails:
        tags = t.get("tags", {})
        if tags.get("switchback:network") == "yes":
            counts["overviews" if tags.get("switchback:hike") == "no" else "networks"] += 1
        if "switchback:bridged" in tags:
            counts["bridged"] += 1
        if tags.get("switchback:hike") == "no" or any(tags.get(k) == "yes" for k in
                ("switchback:informal", "switchback:side", "switchback:unnamed", "switchback:roadwalk", "switchback:network")):
            continue
        counts["hikes"] += 1
        m = main_of(t)
        if len(m) < 2:
            continue
        t["_ends"] = (m[0], m[-1])
        gap = dist(m[0], m[-1])
        total = sum(length(decode(s)) for s in t["segments"])
        if total > t["length"] * 1.3 and total - t["length"] > 800:
            out["tangled"].append((total - t["length"], f"{t['name']} ({t['length'] / 1609.344:.1f} mi main line, {total / 1609.344:.1f} mi of lines)"))
        if max(150, t["length"] * 0.03) <= gap <= NEAR_LOOP_M and t["length"] > 4 * gap:
            out["near_loop"].append((t["length"], f"{t['name']} ({t['length'] / 1609.344:.1f} mi, ends {gap:.0f} m apart)"))
        if not SIDE_WORDS.search(t["name"]) and t["name"].lower() not in NOT_SYSTEMS and gap > 1:
            by_name[t["name"]].append(t)
    for name, group in by_name.items():
        if len(group) < 2:
            continue
        best = None
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                g = min(dist(a, b) for a in group[i]["_ends"] for b in group[j]["_ends"])
                if g <= SPLIT_M and (best is None or g < best):
                    best = g
        if best is not None:
            miles = sum(t["length"] for t in group) / 1609.344
            out["split"].append((miles, f"{name} ({len(group)} pieces, {miles:.1f} mi in all, nearest ends {best:.0f} m apart)"))
    for k in ("split", "tangled", "near_loop"):
        counts[k] = len(out[k])
    return dict(counts), {k: [text for _, text in sorted(v, reverse=True)] for k, v in out.items()}

def main():
    pack_dir, region = sys.argv[1], sys.argv[2]
    show = int(sys.argv[sys.argv.index("--list") + 1]) if "--list" in sys.argv else 0
    header, cells = packs.read(os.path.join(pack_dir, f"{region}.trails"))
    seen, trails = set(), []
    for k, v in cells.items():
        if not k.startswith("p:"):
            for t in json.loads(v):
                if t["id"] not in seen:
                    seen.add(t["id"])
                    trails.append(t)
    counts, lists = check(trails)
    info_path = os.path.join(pack_dir, f"{region}.json")
    if os.path.exists(info_path):
        info = json.load(open(info_path))
        info["cohesion"] = counts
        json.dump(info, open(info_path, "w"), separators=(",", ":"))
    print(f"{region}: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))
    for k, items in lists.items():
        for text in items[:show]:
            print(f"  {k}: {text}")
    return counts

if __name__ == "__main__":
    main()
