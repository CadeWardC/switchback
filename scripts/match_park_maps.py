#!/usr/bin/env python3
"""Lays park maps that carry real coordinates over our trails (run by the match-park-maps workflow).

    match_park_maps.py <region-id> <pack-dir> <out-dir> [park-slug-filter]

For each PDF in data/park-maps/<region-id>.json that is georeferenced (Missouri State Parks publishes one such map
per trail, with that trail highlighted): reads where the map sits on the ground, draws the page, picks out the
highlighted line, and measures against every trail of ours in the map's area
  - share: how much of our line lies on the highlighted line
  - covered: how much of the highlighted line our lines account for
Writes <out-dir>/matches-<region-id>.json: per map the park, the trail's name as printed, and our trails on it.
Only names and measurements leave this script; the map's drawing is never copied into our data.
"""
import json, math, os, re, sys, urllib.request
import numpy as np
import pymupdf

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_official_trails as official  # noqa: E402
import enrich_trail_pack as packs          # noqa: E402

AGENT = "Mozilla/5.0 (X11; Linux x86_64) trail-map-index/1.0"
CELL = 8.0          # metres: the grid the highlighted line is reduced to
STEP = 5.0          # metres between sample points along our lines
ON, MIN_M = 0.8, 80  # a line of ours is "on" the map's trail from this share, if this much of it is on the map

def merc(lat):
    return math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))

def unmerc(y):
    return math.degrees(2 * math.atan(math.exp(y)) - math.pi / 2)

def georef(doc, page):
    """The page's map frame and its corners on the ground: (bbox in page points, gpts, lpts), or None."""
    src = doc.xref_object(page.xref)
    m = re.search(r"/BBox\s*\[([^\]]+)\]", src)
    ref = re.search(r"/Measure\s+(\d+)\s+0\s+R", src)
    meas = doc.xref_object(int(ref.group(1))) if ref else src
    g = re.search(r"/GPTS\s*\[([^\]]+)\]", meas)
    l = re.search(r"/LPTS\s*\[([^\]]+)\]", meas)
    if not (m and g):
        return None
    bbox = [float(x) for x in m.group(1).split()]
    gpts = [float(x) for x in g.group(1).split()]
    lpts = [float(x) for x in l.group(1).split()] if l else [0, 1, 0, 0, 1, 0, 1, 1]
    if len(bbox) != 4 or len(gpts) != 8 or len(lpts) != 8:
        return None
    return bbox, gpts, lpts

def fit(bbox, gpts, lpts, height, scale):
    """Least-squares straight fit from picture pixels to (longitude, Mercator latitude)."""
    x1, y1, x2, y2 = bbox
    a, bx, by = [], [], []
    for i in range(4):
        u, v = lpts[2 * i], lpts[2 * i + 1]
        px = (x1 + u * (x2 - x1)) * scale
        py = (height - (y1 + v * (y2 - y1))) * scale   # PDF y runs up, pictures run down
        a.append([px, py, 1.0])
        bx.append(gpts[2 * i + 1])
        by.append(merc(gpts[2 * i]))
    a = np.array(a)
    cx = np.linalg.lstsq(a, np.array(bx), rcond=None)[0]
    cy = np.linalg.lstsq(a, np.array(by), rcond=None)[0]
    return cx, cy

def highlighted(pix):
    """Pixels of the highlighted trail. It is drawn in the trail's blaze colour (yellow, orange, blue, green, red…),
    the one strong colour on an otherwise pale map, so: the most common strong hue, plus the red dashes some maps
    use for the leg from the trailhead."""
    rgb = pix.astype(int)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    mx, mn = rgb.max(-1), rgb.min(-1)
    strong = (mx - mn > 120) & (mx > 150)
    d = np.maximum(mx - mn, 1)
    hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    if strong.sum() < 20:
        return strong
    counts = np.bincount((hue[strong] // 15).astype(int) % 24, minlength=24)
    top = (int(counts.argmax()) + 0.5) * 15
    off = np.abs((hue - top + 180) % 360 - 180)
    red = (r > 190) & (g < 70) & (b < 70)
    return (strong & (off < 25)) | red

def cells_of(xs, ys):
    return set(zip((xs // CELL).astype(int).tolist(), (ys // CELL).astype(int).tolist()))

def near(cells, reach):
    """The cells within `reach` cells of any of them."""
    out = set()
    for cx, cy in cells:
        for dx in range(-reach, reach + 1):
            for dy in range(-reach, reach + 1):
                out.add((cx + dx, cy + dy))
    return out

def sample(line, lat0):
    """Points every STEP metres along a line of (lat, lon), in local metres."""
    kx, ky = 111320.0 * math.cos(math.radians(lat0)), 110540.0
    pts = np.array([(p[1] * kx, p[0] * ky) for p in line])
    if len(pts) < 2:
        return pts
    out = [pts[:1]]
    for a, b in zip(pts[:-1], pts[1:]):
        n = max(1, int(np.hypot(*(b - a)) // STEP))
        t = np.linspace(0, 1, n + 1)[1:, None]
        out.append(a + (b - a) * t)
    return np.vstack(out)

def read_map(data):
    """(printed lines of text, bounds (s, w, n, e), highlighted cells, metres per pixel, lat0) or a reason string."""
    doc = pymupdf.open(stream=data, filetype="pdf")
    page = doc[0]
    geo = georef(doc, page)
    if not geo:
        return "no coordinates found in the file"
    bbox, gpts, lpts = geo
    lats, lons = gpts[0::2], gpts[1::2]
    s, n, w, e = min(lats), max(lats), min(lons), max(lons)
    if not (-90 < s < n < 90 and -180 <= w < e <= 180) or n - s > 1.5 or e - w > 1.5:
        return "coordinates don't look like a park map"
    lat0 = (s + n) / 2
    kx, ky = 111320.0 * math.cos(math.radians(lat0)), 110540.0
    width_m = (e - w) * kx
    frame_pt = abs(bbox[2] - bbox[0])
    scale = min(6.0, max(1.5, width_m / 2.5 / frame_pt))   # about 2.5 m a pixel, within sane picture sizes
    pm = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    pix = np.frombuffer(pm.samples, dtype=np.uint8).reshape(pm.height, pm.width, pm.n)[..., :3]
    cx, cy = fit(bbox, gpts, lpts, page.rect.height, scale)
    mask = highlighted(pix)
    # only inside the map frame
    fx = sorted([bbox[0] * scale, bbox[2] * scale])
    fy = sorted([(page.rect.height - bbox[1]) * scale, (page.rect.height - bbox[3]) * scale])
    yy, xx = np.nonzero(mask)
    keep = (xx > fx[0] + 2) & (xx < fx[1] - 2) & (yy > fy[0] + 2) & (yy < fy[1] - 2)
    xx, yy = xx[keep], yy[keep]
    lon = cx[0] * xx + cx[1] * yy + cx[2]
    lat = np.array([unmerc(v) for v in (cy[0] * xx + cy[1] * yy + cy[2])]) if len(xx) else np.array([])
    cells = cells_of(lon * kx, lat * ky) if len(xx) else set()
    text = [t.strip() for t in page.get_text().splitlines() if t.strip()]
    return text, (s, w, n, e), cells, width_m / (frame_pt * scale), lat0

PLACE = re.compile(r"state park|historic site|conservation area|national forest|wild area|natural area|"
                   r"trails of|missouri|\d{4}", re.I)

def trail_name(text, park):
    """The trail the map is of: the first printed line that isn't the park's name, a banner or a date."""
    for t in text[:5]:
        if official.norm_name(t) != official.norm_name(park) and not PLACE.search(t) and 3 < len(t) < 60:
            return re.sub(r"(?<=[a-z])(?=Trail$)", " ", t)   # "Hike OnlyTrail"
    return None

def main():
    region, pack_dir, out = sys.argv[1], sys.argv[2], sys.argv[3]
    only = sys.argv[4] if len(sys.argv) > 4 else ""
    os.makedirs(out, exist_ok=True)
    here = os.path.dirname(os.path.abspath(__file__))
    fresh = os.path.join(pack_dir, f"index-{region}.json")   # the collector's newest index, when the workflow fetched it
    parks = json.load(open(fresh)) if os.path.exists(fresh) else \
        json.load(open(os.path.join(here, "..", "data", "park-maps", region + ".json")))["parks"]
    header, cells = packs.read(os.path.join(pack_dir, region + ".trails"))
    trails = {}
    for k, v in cells.items():
        if not k.startswith("p:"):
            for t in json.loads(v):
                trails.setdefault(t["id"], t)
    for t in trails.values():
        t["_lines"] = [official.decode(s) for s in t["segments"]]
        pts = [p for l in t["_lines"] for p in l]
        t["_box"] = (min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts))
    results = []
    for slug, park in parks.items():
        if only and only not in slug:
            continue
        for i, m in enumerate(park["maps"], 1):
            if m["kind"] != "pdf" or not m.get("georeferenced"):
                continue
            row = {"park": park["park"], "slug": slug, "url": m["url"]}
            results.append(row)
            try:
                local = os.path.join(os.environ.get("MAP_FILES", ""), f"raw-{slug}-{i}.pdf")
                if os.environ.get("MAP_FILES") and os.path.exists(local):
                    data = open(local, "rb").read()
                else:
                    req = urllib.request.Request(m["url"], headers={"User-Agent": AGENT})
                    data = urllib.request.urlopen(req, timeout=60).read()
                got = read_map(data)
            except Exception as ex:
                got = f"couldn't be read ({ex})"
            if isinstance(got, str):
                row["skipped"] = got
                print(f"{park['park']} map {i}: {got}", flush=True)
                continue
            text, (s, w, n, e), hl, mpp, lat0 = got
            row.update(trail=trail_name(text, park["park"]), bounds=[s, w, n, e], metres_per_pixel=round(mpp, 2), cells=len(hl))
            if len(hl) < 8:
                row["skipped"] = "no highlighted trail on the map"
                print(f"{park['park']} map {i} ({row['trail']}): no highlighted trail", flush=True)
                continue
            reach = max(2, int(math.ceil((12 + 2 * mpp) / CELL)))   # 12 m plus two pixels of slack
            close = near(hl, reach)
            kx, ky = 111320.0 * math.cos(math.radians(lat0)), 110540.0
            ours, all_cells, on_cells = [], set(), set()
            for t in trails.values():
                b = t["_box"]
                if b[2] < s or b[0] > n or b[3] < w or b[1] > e:
                    continue
                pts = np.vstack([p for p in (sample(l, lat0) for l in t["_lines"]) if len(p)])
                inside = (pts[:, 0] > w * kx) & (pts[:, 0] < e * kx) & (pts[:, 1] > s * ky) & (pts[:, 1] < n * ky)
                if inside.sum() * STEP < MIN_M:
                    continue
                pin = pts[inside]
                keys = list(zip((pin[:, 0] // CELL).astype(int).tolist(), (pin[:, 1] // CELL).astype(int).tolist()))
                hit = sum(1 for c in keys if c in close)
                share = hit / len(keys)
                cs = set(keys)
                all_cells |= cs
                tags = t.get("tags", {})
                if share >= 0.3:
                    ours.append({"id": t["id"], "name": t["name"], "m": round(t["length"]),
                                 "share": round(share, 2), "on_map": round(float(inside.mean()), 2),
                                 "unnamed": tags.get("switchback:unnamed") == "yes" or tags.get("switchback:derived_name") == "yes",
                                 "informal": tags.get("switchback:informal") == "yes"})
                    if share >= ON:
                        on_cells |= cs
            ours.sort(key=lambda o: -o["share"] * o["m"])
            row["ours"] = ours
            row["covered"] = round(len(hl & near(on_cells, reach)) / len(hl), 2)      # by our lines that follow it
            row["covered_any"] = round(len(hl & near(all_cells, reach)) / len(hl), 2)  # by any line of ours
            print(f"{park['park']} map {i} ({row['trail']}): "
                  f"{row['covered']:.0%} covered by lines following it, {row['covered_any']:.0%} by any; "
                  + "; ".join(f"{o['name']} {o['share']:.0%}" for o in ours[:5]), flush=True)
    json.dump({"region": region, "pack_version": header.get("version"), "maps": results},
              open(os.path.join(out, f"matches-{region}.json"), "w"), indent=1)
    done = [r for r in results if "ours" in r]
    print(f"\n{len(done)} of {len(results)} maps read; "
          f"{sum(1 for r in done if r['covered'] >= 0.8)} well covered by our lines, "
          f"{sum(1 for r in done if r['covered_any'] < 0.5)} mostly missing from our data")

if __name__ == "__main__":
    main()
