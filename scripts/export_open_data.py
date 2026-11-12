#!/usr/bin/env python3
"""Writes a trail pack out as an open file anyone can use: <out-dir>/<region-id>.geojson.gz

    export_open_data.py <pack-dir> <region-id> <out-dir>

GeoJSON (gzipped). One feature per trail (kind "trail"): the whole trail, every piece of it, as a MultiLineString
(longitude, latitude) and what we know of it: name, length, where the line came from, whether an official list
confirms it, climb. Then the ways in: for each trailhead or car park a hike can be started from, a feature of kind
"way_in" (the walk from the trailhead to the trail, a LineString) or, where the trailhead is on the trail itself,
of kind "trailhead" (a Point). Opens in QGIS, geojson.io, GDAL/ogr2ogr and most mapping tools.
"""
import gzip, json, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich_trail_pack as packs                 # noqa: E402
from build_trail_pack import decode               # noqa: E402

def licence(origin):
    return ("CC BY 4.0, USDA Forest Service" if origin == "Forest Service" else
            "public domain (U.S. federal data)" if origin else "ODbL, © OpenStreetMap contributors")

def ways_in(t):
    """The trailheads a hike can be started from, each with the walk to the trail."""
    tags = t.get("tags", {})
    out = []
    for e in json.loads(tags.get("switchback:access", "[]")):
        lat, lon = e["p"]
        props = {"kind": "way_in" if "l" in e else "trailhead", "trailhead": e["n"], "trail_id": t["id"],
                 "trail": t["name"], "walk_m": e["d"], "trailhead_lat": lat, "trailhead_lon": lon,
                 # the walk follows paths on the map, whatever the trail's own line came from
                 "licence": licence(None)}
        chart = e.get("e") or {}
        for key, k in (("climb_m", "g"), ("descent_m", "l"), ("lowest_m", "mn"), ("highest_m", "mx")):
            if isinstance(chart.get(k), (int, float)):
                props[key] = round(chart[k])
        if "l" in e:
            geometry = {"type": "LineString", "coordinates": [[round(lo, 6), round(la, 6)] for la, lo in decode(e["l"])]}
        else:
            geometry = {"type": "Point", "coordinates": [lon, lat]}
        out.append({"type": "Feature", "properties": props, "geometry": geometry})
    return out

def feature(t):
    tags = t.get("tags", {})
    origin = tags.get("switchback:origin")
    props = {
        "kind": "trail", "id": t["id"], "name": t["name"], "length_m": round(t["length"]),
        "line_from": origin or "OpenStreetMap",
        "licence": licence(origin),
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
    if tags.get("switchback:closed") == "yes":
        props["loop_closed_along_trails"] = True
    heads = json.loads(tags.get("switchback:access", "[]"))
    if heads:
        props["trailheads"] = len(heads)
    e = t.get("elev") or {}
    for key, k in (("climb_m", "g"), ("descent_m", "l"), ("lowest_m", "mn"), ("highest_m", "mx")):
        if isinstance(e.get(k), (int, float)):
            props[key] = round(e[k])
    lines = [[[round(lo, 6), round(la, 6)] for la, lo in decode(s)] for s in t["segments"]]
    return {"type": "Feature", "properties": props, "geometry": {"type": "MultiLineString", "coordinates": lines}}

def main():
    pack_dir, region, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    header, cells = packs.read(os.path.join(pack_dir, f"{region}.trails"))
    info = json.load(open(os.path.join(pack_dir, f"{region}.json")))
    seen, feats, walks = set(), [], []
    for k in sorted(cells):
        if k.startswith("p:"):
            continue
        for t in json.loads(cells[k]):
            if t["id"] not in seen:
                seen.add(t["id"])
                feats.append(feature(t))
                walks += ways_in(t)
    trails = len(feats)
    feats += walks
    doc = {"type": "FeatureCollection", "name": info.get("name", region), "version": header.get("version"),
           "attribution": "Trails and ways in © OpenStreetMap contributors (ODbL); some lines from the USDA Forest Service "
                          "(CC BY 4.0) and the National Park Service (public domain). See each feature's line_from and licence.",
           "features": feats}
    path = os.path.join(out, f"{region}.geojson.gz")
    with gzip.open(path, "wt", encoding="utf-8", compresslevel=9) as f:
        json.dump(doc, f, ensure_ascii=False, separators=(",", ":"))
    print(f"{region}: {trails} trails, {len(walks)} ways in, {os.path.getsize(path) / 1024:.0f} KB")

if __name__ == "__main__":
    main()
