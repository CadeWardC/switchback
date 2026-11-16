#!/usr/bin/env python3
"""park_map_scalecrop.py <map id> x0 y0 x1 y1   (page fractions) -> prep/<id>-scale.png
Crops that box of the full map page, enlarges it, and adds a ruler above it labelled in PAGE PIXELS (x)."""
import sys, os, re, cv2, numpy as np
d = os.environ.get("PARK_MAP_WORK", ".")  # the folder holding pics/ and prep/
mid = sys.argv[1]; x0, y0, x1, y1 = map(float, sys.argv[2:6])
slug, n = mid.rsplit("-", 1)
f = [x for x in os.listdir(f"{d}/pics") if re.match(rf"{re.escape(slug)}-{n}-p-?1\.png$", x)][0]
img = cv2.imread(f"{d}/pics/{f}"); H, W = img.shape[:2]
a, b, c, e = int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)
crop = img[b:e, a:c]
k = 1400 / crop.shape[1]
big = cv2.resize(crop, (1400, max(1, int(crop.shape[0] * k))), interpolation=cv2.INTER_CUBIC)
rul = np.full((70, 1400, 3), 255, np.uint8)
step = 5 if (c - a) < 300 else 10 if (c - a) < 700 else 25
for px in range((a // step) * step, c + 1, step):
    x = int((px - a) * k)
    if 0 <= x < 1400:
        big_tick = px % (step * 4) == 0
        cv2.line(rul, (x, 70), (x, 40 if big_tick else 55), (0, 0, 255), 1)
        if big_tick:
            cv2.putText(rul, str(px), (x - 15, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 255), 1)
        cv2.line(big, (x, 0), (x, big.shape[0]), (0, 0, 255) if big_tick else (200, 200, 255), 1)
out = np.vstack([rul, big])
cv2.imwrite(f"{d}/prep/{mid}-scale.png", out)
print(f"wrote prep/{mid}-scale.png; page is {W} px wide; crop covers page x {a}..{c}")
