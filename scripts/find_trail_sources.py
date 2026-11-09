#!/usr/bin/env python3
"""Lists public official trail datasets for a place (read-only), to choose what to check trail packs against.

    find_trail_sources.py "<search words>" [south,west,north,east]

Searches ArcGIS Online's public catalogue (where federal, state and local agencies publish map data) and probes a
few known national trail services, printing each layer's name, owner, fields and how many trails fall in the box.
"""
import json, sys, urllib.parse, urllib.request

def get(url, params=None, timeout=60):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)

TRAILISH = ("trail", "path", "greenway", "hik")

def count_in(url, box):
    s, w, n, e = box
    try:
        return get(url + "/query", {"where": "1=1", "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
                                   "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "returnCountOnly": "true",
                                   "f": "json"}).get("count")
    except Exception:
        return None

def trail_layers(url, box, force=False):
    """[(layer url, name, count in box, fields)] for the line layers that look like trails."""
    try:
        info = get(url, {"f": "json"})
    except Exception as ex:
        return [(url, f"unreachable: {ex}", None, [])]
    if "error" in info:
        return [(url, f"error: {info['error'].get('message')}", None, [])]
    if info.get("layers") is not None:
        out = []
        for l in info["layers"]:
            if l.get("geometryType") == "esriGeometryPolyline" and (force or any(w in l["name"].lower() for w in TRAILISH)):
                out += trail_layers(f"{url.rstrip('/')}/{l['id']}", box, True)
        return out
    if info.get("geometryType") != "esriGeometryPolyline":
        return []
    fields = [f["name"] for f in info.get("fields", [])]
    return [(url, info.get("name"), count_in(url, box), fields)]

def show(rows, label=""):
    for url, name, count, fields in rows:
        if count == 0:
            continue
        print(f"  {count if count is not None else '?':>6} in MO  {name}  {label}")
        print(f"         {url}")
        if fields:
            print(f"         fields: {', '.join(fields[:30])}")

def main():
    box = [float(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else None
    print("== known national services")
    for url in [
        "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer",
        "https://partnerships.nationalmap.gov/arcgis/rest/services/USGSTrails/MapServer",
        "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Public_Trails/FeatureServer",
        "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer",
    ]:
        print(url)
        show(trail_layers(url, box))
    seen = set()
    for words in sys.argv[1].split(";"):
        print(f"\n== catalogue: {words.strip()}")
        res = get("https://www.arcgis.com/sharing/rest/search", {
            "q": f'{words.strip()} (type:"Feature Service" OR type:"Map Service")', "num": 40, "f": "json"})
        for item in res.get("results", []):
            url = item.get("url") or ""
            if not url or url in seen:
                continue
            seen.add(url)
            rows = [r for r in trail_layers(url, box) if r[2]]
            if rows:
                print(f"* {item.get('title')}  [{item.get('owner')}]")
                show(rows)

if __name__ == "__main__":
    main()
