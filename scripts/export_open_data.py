#!/usr/bin/env python3
"""Writes a trail pack out as an open file anyone can use: <out-dir>/<region-id>.geojson.gz

    export_open_data.py <pack-dir> <region-id> <out-dir>

GeoJSON (gzipped), one feature per trail: its lines as a MultiLineString (longitude, latitude) and what we know of
it: name, length, where the line came from, whether an official list confirms it, climb. Opens in QGIS, geojson.io,
GDAL/ogr2ogr and most mapping tools.
"""
import gzip, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich_trail_pack as packs                 # noqa: E402
from build_trail_pack import decode               # noqa: E402

def feature(t):
    tags = t.get("tags", {})
    origin = tags.get("switchback:origin")
    props = {
        "id": t["id"], "name": t["name"], "length_m": round(t["length"]),
        "line_from": origin or "OpenStreetMap",
        "licence": ("CC BY 4.0, USDA Forest Service" if origin == "Forest Service" else
                    "ODbL, walked and sent in by a Switchback user" if origin == "Community" else
                    "ODbL, placed from USGS 3DEP lidar (public domain) by a Switchback user" if origin == "USGS lidar" else
                    "public domain (U.S. federal data)" if origin else "ODbL, © OpenStreetMap contributors"),
    }
    if not origin and t.get("osmId"):
        props["osm"] = f"{'relation' if t['source'] == 'osmRelation' else 'way'}/{t['osmId']}"
    for key, tag in (("area", "switchback:area"), ("system", "switchback:system"), ("official_source", "official:source"),
                     ("official_name", "official:name"), ("official_number", "official:ref"),
                     ("official_match", "official:match"), ("official_page", "official:url"),
                     ("official_miles", "official:miles"), ("surface", "surface"), ("ref", "ref")):
        if tags.get(tag):
            props[key] = tags[tag]
    props["hike"] = tags.get("switchback:hike") != "no"
    for key, tag in (("informal", "switchback:informal"), ("unnamed", "switchback:unnamed"), ("side_trail", "switchback:side"),
                     ("road_walk", "switchback:roadwalk"), ("network", "switchback:network"), ("shared_with_bikes", "switchback:multiuse")):
        if tags.get(tag) == "yes":
            props[key] = True
    if tags.get("switchback:informal_reason"):
        props["informal_reason"] = tags["switchback:informal_reason"]
    if tags.get("switchback:bridged"):
        props["joined_along_route_m"] = int(tags["switchback:bridged"])
    e = t.get("elev") or {}
    for key, k in (("climb_m", "g"), ("descent_m", "l"), ("lowest_m", "mn"), ("highest_m", "mx")):
        if isinstance(e.get(k), (int, float)):
            props[key] = round(e[k])
    if tags.get("switchback:unwalked") == "yes":
        props["not_yet_walked"] = True
    if tags.get("switchback:difficulty"):
        props["difficulty"] = tags["switchback:difficulty"]
    if tags.get("switchback:minutes", "").isdigit():
        props["minutes"] = int(tags["switchback:minutes"])
    lines = [[[round(lo, 6), round(la, 6)] for la, lo in decode(s)] for s in t["segments"]]
    return {"type": "Feature", "properties": props, "geometry": {"type": "MultiLineString", "coordinates": lines}}

def main():
    pack_dir, region, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    header, cells = packs.read(os.path.join(pack_dir, f"{region}.trails"))
    info = json.load(open(os.path.join(pack_dir, f"{region}.json")))
    seen, feats = set(), []
    for k in sorted(cells):
        if k.startswith("p:"):
            continue
        for t in json.loads(cells[k]):
            if t["id"] not in seen:
                seen.add(t["id"])
                feats.append(feature(t))
    doc = {"type": "FeatureCollection", "name": info.get("name", region), "version": header.get("version"),
           "attribution": "Trails © OpenStreetMap contributors (ODbL); some lines from the USDA Forest Service "
                          "(CC BY 4.0) and the National Park Service (public domain), and some walked and sent in by "
                          "Switchback users (ODbL). See each feature's line_from and licence.",
           "features": feats}
    path = os.path.join(out, f"{region}.geojson.gz")
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{region}: {len(feats)} trails, {os.path.getsize(path) / 1024:.0f} KB")

if __name__ == "__main__":
    main()
