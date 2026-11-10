#!/usr/bin/env python3
"""How much of each trail in a box have people recorded GPS tracks along? (read-only pilot)

    gps_traces.py <region.trails> south,west,north,east [max pages per tile]

Uses OpenStreetMap's public GPS traces (api/0.6/trackpoints; uploaded by mappers, open to use). A trail counts as
walked where a trace point lies within 15 m. Traces only CONFIRM paths that are already mapped: nothing is drawn from
them. They're uneven (popular places have many, most places none), so "no traces" proves nothing.
"""
import json, math, sys, time, urllib.request, zlib, re
from collections import defaultdict, Counter

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build_trail_pack import decode, densify, dist  # noqa: E402

API = "https://api.openstreetmap.org/api/0.6/trackpoints"
NEAR = 15

def points(s, w, n, e, max_pages):
    out, page = [], 0
    while page < max_pages:
        url = f"{API}?bbox={w},{s},{e},{n}&page={page}"
        req = urllib.request.Request(url, headers={"User-Agent": "Switchback trail checks (github.com/CadeWardC/switchback)"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                text = r.read().decode("utf-8", "replace")
        except Exception as ex:
            print(f"  stopped at page {page}: {ex}")
            break
        got = [(float(a), float(b)) for a, b in re.findall(r'<trkpt lat="([-0-9.]+)" lon="([-0-9.]+)"', text)]
        out += got
        if len(got) < 5000:
            break
        page += 1
        time.sleep(1)
    return out

def main():
    pack, box = sys.argv[1], [float(x) for x in sys.argv[2].split(",")]
    max_pages = int(sys.argv[3]) if len(sys.argv) > 3 else 40
    s, w, n, e = box
    grid, total = defaultdict(list), 0
    lat = s
    while lat < n:
        lon = w
        while lon < e:
            got = points(lat, lon, min(lat + 0.25, n), min(lon + 0.25, e), max_pages)
            total += len(got)
            for p in got:
                grid[(round(p[0] * 5000), round(p[1] * 5000))].append(p)
            lon += 0.25
        lat += 0.25
    print(f"{total} GPS trace points in the box")
    b = open(pack, "rb").read()
    k = int.from_bytes(b[5:9], "big")
    h = json.loads(b[9:9 + k])
    body = b[9 + k:]
    def walked(p):
        c = (round(p[0] * 5000), round(p[1] * 5000))
        return any(dist(p, q) <= NEAR for dy in (-1, 0, 1) for dx in (-1, 0, 1) for q in grid.get((c[0] + dy, c[1] + dx), ()))
    rows = []
    for key, (o, l) in h["cells"].items():
        if key.startswith("p:"):
            continue
        for t in json.loads(zlib.decompress(body[o:o + l], -15)):
            line = decode(t["path"]) if "path" in t else decode(t["segments"][t["pathIndex"]])
            pts = densify(line, 20)
            inside = [p for p in pts if s <= p[0] <= n and w <= p[1] <= e]
            if len(inside) < max(5, len(pts) // 2):
                continue
            tags = t.get("tags", {})
            kind = ("informal" if tags.get("switchback:informal") else "unnamed" if tags.get("switchback:unnamed")
                    else "road walk" if tags.get("switchback:roadwalk") else "side or fragment" if tags.get("switchback:side") or tags.get("switchback:fragment")
                    else "official hike" if tags.get("official:source") else "hike, unconfirmed" if tags.get("switchback:hike") != "no" else "other")
            rows.append((sum(walked(p) for p in inside) / len(inside), kind, t["name"], t["length"]))
    by = defaultdict(list)
    for share, kind, name, m in rows:
        by[kind].append(share)
    print(f"{len(rows)} trails in the box. Share of each trail with a GPS trace along it:")
    for kind, shares in sorted(by.items(), key=lambda kv: -len(kv[1])):
        well = sum(x >= 0.5 for x in shares)
        none = sum(x < 0.05 for x in shares)
        print(f"  {kind:<20} {len(shares):4d} trails: {well} mostly traced (50%+), {none} with no traces, median {sorted(shares)[len(shares) // 2]:.0%}")
    print("Unconfirmed or unnamed trails that people clearly walk (70%+ traced):")
    for share, kind, name, m in sorted((r for r in rows if r[1] in ("hike, unconfirmed", "unnamed", "informal", "other") and r[0] >= 0.7), key=lambda r: -r[3])[:25]:
        print(f"  {name[:45]:<45} {m / 1609.34:4.1f} mi  {share:.0%}  ({kind})")

if __name__ == "__main__":
    main()
