#!/usr/bin/env python3
"""Read-only: what are the Forest Service trails we did NOT add? (run by the skipped-federal workflow)

    skipped_federal.py <region-id> <pack-dir>

Takes the Forest Service trails our data has no line for and that the list doesn't plainly mark for hikers, and
sorts them by the list's own fields (hiker columns, other managed uses, trail class, allowed uses), with miles and
examples, so a rule for which of them to add can be chosen from evidence.
"""
import json, os, sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_official_trails as official  # noqa: E402
import enrich_trail_pack as packs          # noqa: E402

HIKER = ("hiker_pedestrian_managed", "hiker_pedestrian_accpt", "hiker_pedestrian_accpt_disc", "hiker_pedestrian_disc",
         "hiker_pedestrian_restricted")

def main():
    region_id, pack_dir = sys.argv[1], sys.argv[2]
    info = json.load(open(os.path.join(pack_dir, f"{region_id}.json")))
    header, cells = packs.read(os.path.join(pack_dir, f"{region_id}.trails"))
    grid, n = official.Grid(), 0
    for k, v in cells.items():
        if k.startswith("p:"):
            continue
        for t in json.loads(v):
            if t.get("tags", {}).get("switchback:origin"):
                continue    # judge against OpenStreetMap's lines only, not what we added from the lists
            for s in t["segments"]:
                grid.add(official.decode(s), n)
            n += 1
    region = {"region": region_id, "name": info.get("name", region_id), "country": "US", "coverage": info.get("coverage", [])}
    area, _ = official.region_area(region)
    official.KEEP_ATTRS = True
    src = next(s for s in official.NATIONAL_US if s[0] == "Forest Service")
    feats = official.fetch(src, area)
    print(f"# {info.get('name')}: {len(feats)} Forest Service pieces")
    if feats:
        print("fields:", ", ".join(sorted(feats[0]["a"])))
    by = defaultdict(lambda: [0, 0.0, []])       # label -> [trails, miles, examples]
    def note(kind, value, miles, name):
        row = by[(kind, value)]
        row[0] += 1
        row[1] += miles
        if len(row[2]) < 6 and name:
            row[2].append(name)
    total = [0, 0.0]
    for group in official.join_pieces(feats):
        lines = [l for f in group for l in f["lines"]]
        miles = sum(official.length(l) for l in lines) / 1609.344
        if miles < 0.25 or official.group_use(group) == "not" or all(f.get("sure") for f in group):
            continue
        if official.match(lines, grid)[0] >= 0.3:
            continue
        f = max(group, key=lambda f: sum(official.length(l) for l in f["lines"]))
        a, name = f["a"], f["name"]
        total[0] += 1
        total[1] += miles
        filled = lambda k: a.get(k) not in (None, "", "N/A")
        note("hiker columns filled", " + ".join(k.replace("hiker_pedestrian_", "") for k in HIKER if filled(k)) or "(none)", miles, name)
        managed = sorted(k[:-8] for k in a if k.endswith("_managed") and filled(k))
        note("managed for", ", ".join(managed) or "(nothing)", miles, name)
        accepted = sorted(k[:-6] for k in a if k.endswith("_accpt") and filled(k))
        note("accepted", ", ".join(accepted) or "(nothing)", miles, name)
        for k in ("trail_type", "trail_class", "allowed_terra_use", "national_trail_designation", "trail_surface",
                  "terra_motorized", "attributesubset", "special_mgmt_area", "mvum_symbol", "terra_base_symbology"):
            if k in a:
                note(k, str(a.get(k))[:40], miles, name)
        note("named", "yes" if name and official.norm_name(name) not in official.GENERIC else "no", miles, name)
        note("motor", "managed for motor vehicles" if f.get("motor") else "no", miles, name)
        note("length", "under 1 mi" if miles < 1 else "1 to 5 mi" if miles < 5 else "over 5 mi", miles, name)
    print(f"not in OpenStreetMap and not plainly for hikers: {total[0]} trails, {total[1]:.0f} mi")
    kind = None
    for (k, v), (c, mi, ex) in sorted(by.items(), key=lambda kv: (kv[0][0], -kv[1][0])):
        if k != kind:
            kind, shown = k, 0
            print(f"\n## {k}")
        shown += 1
        if shown <= 12:
            print(f"  {c:5d} trails {mi:7.0f} mi  {v}   e.g. {'; '.join(ex[:4])}")

if __name__ == "__main__":
    main()
