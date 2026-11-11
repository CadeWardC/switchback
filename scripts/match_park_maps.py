#!/usr/bin/env python3
"""Probe: fetch a park's map files so the matcher can be developed against real ones."""
import json, os, sys, urllib.request
region, pack, out, only = sys.argv[1], sys.argv[2], sys.argv[3], (sys.argv[4] if len(sys.argv) > 4 else "")
os.makedirs(out, exist_ok=True)
parks = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "park-maps", region + ".json")))["parks"]
for slug, v in parks.items():
    if only and only not in slug:
        continue
    for i, m in enumerate(v["maps"], 1):
        if m["kind"] == "pdf":
            req = urllib.request.Request(m["url"], headers={"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) trail-map-index/1.0"})
            open(os.path.join(out, f"raw-{slug}-{i}.pdf"), "wb").write(urllib.request.urlopen(req, timeout=60).read())
            print(slug, i, m["url"])
