#!/usr/bin/env python3
"""Prepares park map pictures (no coordinates) for a model to read: a gridded preview and numbered colour chips.

    prep_park_map_pictures.py <pics dir> <out dir> <index-<region>.json>

Writes <out>/<id>-grid.jpg, <out>/<id>-chips.png and <out>/todo.json (each map's chip colours)."""
import json, os, re, sys, cv2, numpy as np
pics, out = sys.argv[1], sys.argv[2]
idx = json.load(open(sys.argv[3]))
os.makedirs(out, exist_ok=True)
todo = []
for slug, p in idx.items():
    for i, m in enumerate(p["maps"], 1):
        if m["georeferenced"]:
            continue
        f = [x for x in os.listdir(pics) if re.match(rf"{re.escape(slug)}-{i}-p-?1\.png$", x)]
        if not f:
            continue
        img = cv2.imread(os.path.join(pics, f[0]))
        H, W = img.shape[:2]
        # gridded preview, 1600 px wide, labels every 0.1
        sc = 1600 / W
        v = cv2.resize(img, (1600, int(H * sc)), interpolation=cv2.INTER_AREA)
        h, w = v.shape[:2]
        for k in range(1, 10):
            x, y = int(w * k / 10), int(h * k / 10)
            cv2.line(v, (x, 0), (x, h), (255, 0, 255), 1)
            cv2.line(v, (0, y), (w, y), (255, 0, 255), 1)
            cv2.putText(v, f".{k}", (x + 2, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 2)
            cv2.putText(v, f".{k}", (2, y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 0, 255), 2)
        cv2.imwrite(f"{out}/{slug}-{i}-grid.jpg", v, [cv2.IMWRITE_JPEG_QUALITY, 85])
        # colour chips: k-means of saturated pixels, plus near-black
        hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
        sat = (hsv[:, :, 1] > 80) & (hsv[:, :, 2] > 50)
        px = img[sat].astype(np.float32)
        if len(px) < 200:
            px = (np.zeros((14, 3)) + np.arange(14)[:, None] * 18).astype(np.float32)
        px = np.ascontiguousarray(px[np.random.default_rng(0).choice(len(px), min(len(px), 80000), replace=False)], np.float32)
        _, lab, cen = cv2.kmeans(px, 14, None, (3, 40, 1.0), 3, cv2.KMEANS_PP_CENTERS)
        cnt = np.bincount(lab.ravel(), minlength=14)
        cols = [c for c, n in sorted(zip(cen.tolist(), cnt), key=lambda z: -z[1]) if n > 80] + [[30, 30, 30]]
        sw = np.full((90 * ((len(cols) + 4) // 5), 900, 3), 255, np.uint8)
        hexes = []
        for j, c in enumerate(cols):
            x, y = 180 * (j % 5), 90 * (j // 5)
            cv2.rectangle(sw, (x + 10, y + 10), (x + 80, y + 70), [int(t) for t in c], -1)
            cv2.putText(sw, str(j + 1), (x + 95, y + 55), cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0, 0, 0), 2)
            hexes.append("#%02x%02x%02x" % tuple(int(t) for t in c[::-1]))
        cv2.imwrite(f"{out}/{slug}-{i}-chips.png", sw)
        todo.append({"slug": slug, "map": i, "park": p["park"], "grid": f"{out}/{slug}-{i}-grid.jpg",
                     "chips": f"{out}/{slug}-{i}-chips.png", "chip_hex": hexes})
json.dump(todo, open(f"{out}/todo.json", "w"), indent=1)
print(len(todo))
