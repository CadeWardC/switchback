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

def describe(url, box):
    try:
        info = get(url, {"f": "json"})
    except Exception as ex:
        return f"  unreachable: {ex}"
    if "error" in info:
        return f"  error: {info['error'].get('message')}"
    if info.get("layers") is not None:      # a service: list its line layers
        lines = []
        for l in info["layers"]:
            lines.append(f"  layer {l['id']}: {l['name']} ({l.get('geometryType', '?')})")
        return "\n".join(lines)
    fields = [f["name"] for f in info.get("fields", [])]
    count = "?"
    if box:
        s, w, n, e = box
        try:
            count = get(url + "/query", {"where": "1=1", "geometry": f"{w},{s},{e},{n}",
                                        "geometryType": "esriGeometryEnvelope", "inSR": 4326,
                                        "spatialRel": "esriSpatialRelIntersects", "returnCountOnly": "true",
                                        "f": "json"}).get("count", "?")
        except Exception as ex:
            count = f"? ({ex})"
    return f"  {info.get('name')} · {info.get('geometryType')} · {count} in box\n  fields: {', '.join(fields[:40])}"

def main():
    words = sys.argv[1]
    box = [float(x) for x in sys.argv[2].split(",")] if len(sys.argv) > 2 else None
    print("== known national services")
    for url in [
        "https://carto.nationalmap.gov/arcgis/rest/services/transportation/MapServer",
        "https://partnerships.nationalmap.gov/arcgis/rest/services/USGSTrails/MapServer",
        "https://services1.arcgis.com/fBc8EJBxQRMcHlei/arcgis/rest/services/NPS_Public_Trails/FeatureServer/0",
        "https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0",
    ]:
        print(url)
        print(describe(url, box))
    print(f"\n== ArcGIS Online catalogue: {words}")
    res = get("https://www.arcgis.com/sharing/rest/search", {
        "q": f'{words} (type:"Feature Service" OR type:"Map Service")', "num": 60, "f": "json",
        "sortField": "numViews", "sortOrder": "desc"})
    for item in res.get("results", []):
        url = item.get("url") or ""
        print(f"\n* {item.get('title')}  [{item.get('owner')}]  views {item.get('numViews')}  {item.get('type')}")
        if item.get("snippet"):
            print(f"  {item['snippet'][:160]}")
        if url:
            print(f"  {url}")
            print(describe(url, box))

if __name__ == "__main__":
    main()
