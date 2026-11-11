#!/usr/bin/env python3
"""Read-only: for each state, the trail layers public agencies publish in ArcGIS Online's catalogue, with who
publishes each (the account and its organisation), so government publishers can be picked for the vetted list.

    survey_trail_sources.py <regions.json from the trails-us release> <region ids, space separated | "us">

One line per layer with at least 40 trails in the state:
    region | trails in the state | account | organisation | item title | layer name | url | name-like fields
"""
import json, sys, urllib.parse, urllib.request

def get(url, params=None, timeout=45):
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "trail-source-survey/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)

TRAILISH = ("trail", "path", "greenway", "hik")
SKIP = ("snowmobile", "proposed", "planned", "atv", "orv", "ohv", "water trail", "paddl", "bike route", "bikeway",
        "bicycle", "sidewalk", "blueway", "historic", "census", "parcel")
orgs, owners = {}, {}

def org_of(owner):
    if owner not in owners:
        try:
            u = get(f"https://www.arcgis.com/sharing/rest/community/users/{urllib.parse.quote(owner)}", {"f": "json"})
            oid = u.get("orgId")
            if oid and oid not in orgs:
                try:
                    orgs[oid] = get(f"https://www.arcgis.com/sharing/rest/portals/{oid}", {"f": "json"}).get("name", "")
                except Exception:
                    orgs[oid] = ""
            owners[owner] = orgs.get(oid, "") or u.get("fullName", "")
        except Exception:
            owners[owner] = ""
    return owners[owner]

def count_in(url, box):
    s, w, n, e = box
    try:
        return get(url + "/query", {"where": "1=1", "geometry": f"{w},{s},{e},{n}", "geometryType": "esriGeometryEnvelope",
                                   "inSR": 4326, "spatialRel": "esriSpatialRelIntersects", "returnCountOnly": "true",
                                   "f": "json"}).get("count") or 0
    except Exception:
        return 0

def layers(url):
    try:
        info = get(url, {"f": "json"})
    except Exception:
        return []
    if info.get("layers") is not None:
        out = []
        for l in info["layers"][:25]:
            if l.get("geometryType") == "esriGeometryPolyline" and any(w in l["name"].lower() for w in TRAILISH):
                try:
                    out.append((f"{url.rstrip('/')}/{l['id']}", get(f"{url.rstrip('/')}/{l['id']}", {"f": "json"})))
                except Exception:
                    pass
        return out
    return [(url, info)] if info.get("geometryType") == "esriGeometryPolyline" else []

def main():
    regions = json.load(open(sys.argv[1]))["regions"]
    want = sys.argv[2].split()
    seen = set()
    for rid, r in sorted(regions.items()):
        if r.get("country") != "US" or (want != ["us"] and rid not in want):
            continue
        name, box = r["name"], r["bbox"]
        for q in (f"{name} state park trails", f"{name} trails", f"{name} hiking trails", f"{name} DNR trails",
                  f"{name} recreation trails statewide"):
            try:
                res = get("https://www.arcgis.com/sharing/rest/search", {
                    "q": f'{q} (type:"Feature Service" OR type:"Map Service")', "num": 30, "f": "json"})
            except Exception as ex:
                print(f"{rid} | search failed: {ex}")
                continue
            for item in res.get("results", []):
                url = (item.get("url") or "").rstrip("/")
                title = item.get("title") or ""
                if not url or (rid, url) in seen or any(w in title.lower() for w in SKIP):
                    continue
                seen.add((rid, url))
                for lurl, info in layers(url):
                    lname = info.get("name") or ""
                    if any(w in lname.lower() for w in SKIP):
                        continue
                    n = count_in(lurl, box)
                    if n < 40:
                        continue
                    fields = [f["name"] for f in info.get("fields", [])]
                    namey = [f for f in fields if any(w in f.lower() for w in ("name", "label", "use", "type", "status", "hik"))][:8]
                    print(f"{rid} | {n} | {item.get('owner')} | {org_of(item.get('owner') or '')} | {title[:60]} | {lname[:40]} | {lurl} | {','.join(namey)}", flush=True)

if __name__ == "__main__":
    main()
