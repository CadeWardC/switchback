#!/usr/bin/env python3
"""Roughly lays a park map picture that has no coordinates over our trails, to find trails the map has and we lack.

    overlay_park_maps.py <pack.trails> <index-<region>.json> <pics dir> <out dir> <park slug> <map n> [hints.json]

hints.json (written by a model reading the map, see docs in data/park-maps/README.md): the main map panel and boxes to
skip (insets, legend), the chip numbers of the trail colours (chip_hex from prep_park_map_pictures.py), the trail names
printed, and the scale bar (zero_x, end_x in page pixels, end_value, units).

1. Our trails in the park (the pack's area tag) plus every pack line near them, in local metres. A map of one or two
   named trails is fitted on our trails of those names only.
2. The map's trail-coloured pixels (each pixel goes to its nearest chip; the trail chips are kept).
3. North up: search scale (within 25% of the scale bar when there is one) and shift for where our lines best sit on
   the map's trail lines (FFT correlation; score = share of our line on theirs x share of theirs, in our box, near
   ours), then nudge with a similarity fit that may not change the scale by more than about 20%.
4. Trail-coloured pixels more than 40 m from any line of ours, skeletonised into line-shaped pieces of 150 m or more:
   candidates, each with a close-up (map | map with our lines in black and the piece boxed) for a model to judge.
The rough traces stay in the work folder: only names, rough positions and lengths may leave it (the maps belong to
their publishers, and tracing them into the trail data is not allowed).
"""
import json, math, os, re, sys
import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_official_trails as official  # noqa: E402

R = 6371000.0

def area_of(t):
    return (t.get("tags") or {}).get("switchback:area", "")

def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", s.lower()).strip()

def park_trails(trails, park):
    key = norm(park)
    mine = [t for t in trails if norm(area_of(t)) and (norm(area_of(t)) == key or key in norm(area_of(t))
                                                      or norm(area_of(t)) in key)]
    if not mine:
        return [], []
    pts = np.array([p for t in mine for l in t["_lines"] for p in l])
    s, w = pts.min(0)
    n, e = pts.max(0)
    ds, dw = (n - s) * 0.4 + 0.01, (e - w) * 0.4 + 0.01
    near = [t for t in trails if t not in mine and any(s - ds <= p[0] <= n + ds and w - dw <= p[1] <= e + dw
                                                       for l in t["_lines"] for p in l[::5])]
    return mine, near

class Local:
    def __init__(self, lat0, lon0):
        self.lat0, self.lon0, self.k = lat0, lon0, math.cos(math.radians(lat0))
    def xy(self, lat, lon):  # metres east, metres north
        return (np.radians(lon - self.lon0) * R * self.k, np.radians(lat - self.lat0) * R)
    def ll(self, x, y):
        return (self.lat0 + math.degrees(y / R), self.lon0 + math.degrees(x / (R * self.k)))

def densify(line, step=10.0):
    out = []
    for (x0, y0), (x1, y1) in zip(line[:-1], line[1:]):
        d = math.hypot(x1 - x0, y1 - y0)
        n = max(1, int(d / step))
        for i in range(n):
            out.append((x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n))
    out.append(line[-1])
    return out

def colour_masks(img, hints=None):
    """[(label, mask)] of candidate trail colours."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    if hints:
        allc, want = hints
        rgb = np.array([[int(h[i:i + 2], 16) for i in (1, 3, 5)] for h in allc + ["#ffffff", "#808080", "#000000"]], float)
        px = img[:, :, ::-1].reshape(-1, 3).astype(float)
        d = np.stack([np.linalg.norm(px - c, axis=1) for c in rgb], 1)
        best = d.argmin(1).reshape(img.shape[:2]); dmin = d.min(1).reshape(img.shape[:2])
        out = []
        for n in want:
            m = ((best == n - 1) & (dmin < 55)).astype(np.uint8)
            out.append((allc[n - 1], m))
        return out
    sat = (hsv[:, :, 1] > 90) & (hsv[:, :, 2] > 60)
    px = img[sat].astype(np.float32)
    if len(px) < 500:
        return []
    sample = px[np.random.default_rng(0).choice(len(px), min(len(px), 60000), replace=False)]
    k = 10
    _, lab, cen = cv2.kmeans(sample, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 1.0), 3,
                             cv2.KMEANS_PP_CENTERS)
    out = []
    flat = img.reshape(-1, 3).astype(np.float32)
    d = np.stack([np.linalg.norm(flat - c, axis=1) for c in cen], 1)
    best = d.argmin(1).reshape(img.shape[:2])
    near = d.min(1).reshape(img.shape[:2]) < 45
    for i, c in enumerate(cen):
        m = ((best == i) & near & sat).astype(np.uint8)
        # lines, not fills: keep what an opening with a 7 px square removes
        thin = m & (1 - cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8)))
        if thin.sum() > 300:
            hexc = "#%02x%02x%02x" % tuple(int(v) for v in c[::-1])
            out.append((hexc, thin))
    return out

def raster(lines, s, shape, pad):
    """Our lines at scale s (px/m), north up, into an image with our min corner at (pad, pad)."""
    h, w = shape
    img = np.zeros((h, w), np.float32)
    for l in lines:
        p = np.array([[pad + x * s, h - pad - y * s] for x, y in l], np.int32)
        cv2.polylines(img, [p], False, 1.0, 2)
    return img

def fit(lines, mask, mins, ext, down=2, mpp=None):
    """Best (score, s, tx, ty) so that pixel = (tx + x*s, ty - y*s), x,y metres from our min corner.
    Score = share of our line on the map's lines x share of the map's lines (inside our box, on the page) near ours.
    Our box may hang off the page (a map of one trail shows only part of a park)."""
    small = cv2.resize(mask, (mask.shape[1] // down, mask.shape[0] // down), interpolation=cv2.INTER_AREA)
    small = (small > 0).astype(np.float32)
    H, W = small.shape
    scales = (np.geomspace(0.75 / mpp / down, 1.33 / mpp / down, 25) if mpp else
              np.geomspace(0.12 * W / max(ext), 1.3 * W / max(ext), 45))
    best = (-1, 0, 0, 0, 0, 0)
    for s in scales:
        bw, bh = int(ext[0] * s) + 1, int(ext[1] * s) + 1
        if bw > 6 * W or bh > 6 * H or bw * bh < 100:
            continue
        PH, PW = H + bh + 2, W + bw + 2
        pad = np.zeros((PH, PW), np.float32); pad[:H, :W] = small
        dil = cv2.dilate(pad, np.ones((5, 5), np.uint8))
        ours = np.zeros((PH, PW), np.float32)
        for l in lines:
            p = np.array([[x * s, bh - y * s] for x, y in l], np.int32)
            cv2.polylines(ours, [p], False, 1.0, 1)
        odil = cv2.dilate(ours, np.ones((5, 5), np.uint8))
        boxr = np.zeros((PH, PW), np.float32); boxr[:bh + 1, :bw + 1] = 1
        Fo, Fod, Fb = np.fft.rfft2(ours), np.fft.rfft2(odil), np.fft.rfft2(boxr)
        Fd, Fm = np.fft.rfft2(dil), np.fft.rfft2(pad)
        onpage = np.fft.irfft2(np.fft.rfft2((np.arange(PH)[:, None] < H) & (np.arange(PW)[None] < W)).astype(complex) * np.conj(Fo), s=(PH, PW))
        hit = np.fft.irfft2(Fd * np.conj(Fo), s=(PH, PW)) / np.maximum(onpage, 1)
        got = np.fft.irfft2(Fm * np.conj(Fod), s=(PH, PW))
        inbox = np.fft.irfft2(Fm * np.conj(Fb), s=(PH, PW))
        tot = ours.sum()
        rec = got / np.maximum(inbox, 30)
        sc = hit * rec * np.minimum(1, onpage / (0.3 * tot))   # at least 30% of our line on the page
        i = np.unravel_index(np.argmax(sc), sc.shape)
        if sc[i] > best[0]:
            dy, dx = i
            dy = dy - PH if dy > H else dy
            dx = dx - PW if dx > W else dx
            best = (float(sc[i]), s * down, dx * down, (dy + bh) * down, float(hit[i]), float(rec[i]))
    return best[:4], best[4:]

def refine(pts, mask, A, rounds=(30, 15, 8)):
    """Affine A (2x3, metres -> px) nudged so our points sit on the mask."""
    ys, xs = np.nonzero(mask)
    if len(xs) == 0:
        return A, 0
    tree = cv2.flann_Index(np.stack([xs, ys], 1).astype(np.float32), dict(algorithm=1, trees=4))
    P = np.c_[pts, np.ones(len(pts))]
    for r in rounds:
        q = (A @ P.T).T.astype(np.float32)
        idx, dist = tree.knnSearch(q, 1, params={})
        ok = np.sqrt(dist[:, 0]) < r
        if ok.sum() < 30:
            break
        tgt = np.stack([xs[idx[ok, 0]], ys[idx[ok, 0]]], 1).astype(np.float32)
        src = (A @ P[ok].T).T.astype(np.float32)
        M, _ = cv2.estimateAffinePartial2D(src, tgt, method=cv2.RANSAC, ransacReprojThreshold=r / 2)
        if M is None:
            break
        k = math.hypot(M[0, 0], M[1, 0])
        if not 0.85 < k < 1.18 or abs(math.atan2(M[1, 0], M[0, 0])) > 0.09:
            break
        A = M @ np.vstack([A, [0, 0, 1]])
    q = (A @ P.T).T
    idx, dist = tree.knnSearch(q.astype(np.float32), 1, params={})
    return A, float((np.sqrt(dist[:, 0]) < 6).mean())

def skeleton(m):
    sk = np.zeros_like(m)
    el = cv2.getStructuringElement(cv2.MORPH_CROSS, (3, 3))
    m = m.copy()
    while m.any():
        er = cv2.erode(m, el)
        sk |= m & (1 - cv2.dilate(er, el))
        m = er
    return sk

def main():
    pack, index, pics, out, slug, n = sys.argv[1:7]
    hints = json.load(open(sys.argv[7])) if len(sys.argv) > 7 else {}
    n = int(n)
    os.makedirs(out, exist_ok=True)
    rec = json.load(open(index))[slug]
    park = rec["park"]
    _, trails = official.read_pack(pack)
    mine, near = park_trails(trails, park)
    res = {"slug": slug, "map": n, "park": park, "url": rec["maps"][n - 1]["url"], "ours": len(mine)}
    if len(mine) == 0:
        res["status"] = "no trails of ours in this park"
        print(json.dumps(res))
        return
    names = [x["name"] for x in hints.get("trail_names", [])]
    if 0 < len(names) <= 2:
        import difflib
        key = lambda n: re.sub(r"\b(trail|loop|section)\b|[^a-z0-9]+", "", n.lower())
        sel = [t for t in mine + near if t.get("name") and any(key(t["name"]) and (key(t["name"]) in key(n) or key(n) in key(t["name"])
               or difflib.SequenceMatcher(None, key(t["name"]), key(n)).ratio() > 0.8) for n in names)]
        if sel:
            res["fitted_on"] = sorted({t["name"] for t in sel})
            near = [t for t in mine + near if t not in sel]
            mine = sel
    allp = [p for t in mine for l in t["_lines"] for p in l]
    lat0, lon0 = np.mean([p[0] for p in allp]), np.mean([p[1] for p in allp])
    L = Local(lat0, lon0)
    def proj(ts):
        return [np.array([L.xy(a, b) for a, b in l]) for t in ts for l in t["_lines"] if len(l) > 1]
    lm, ln = proj(mine), proj(near)
    allxy = np.vstack(lm)
    mn = allxy.min(0)
    ext = allxy.max(0) - mn
    rel = [l - mn for l in lm]
    pic = [f for f in os.listdir(pics) if re.match(rf"{re.escape(slug)}-{n}-p-?1\.png$", f)][0]
    img = cv2.imread(os.path.join(pics, pic))
    H, W = img.shape[:2]
    panel = hints.get("panel")  # [x0, y0, x1, y1] fractions of the page: the main map
    keep = np.ones((H, W), np.uint8)
    if panel:
        keep[:] = 0
        keep[int(panel[1] * H):int(panel[3] * H), int(panel[0] * W):int(panel[2] * W)] = 1
    for b in hints.get("exclude", []):
        keep[int(b[1] * H):int(b[3] * H), int(b[0] * W):int(b[2] * W)] = 0
    MPP = None
    sb = hints.get("scale") or {}
    if sb.get("found") and sb.get("end_x") and sb.get("end_value") and abs(sb["end_x"] - sb["zero_x"]) > 10:
        unit = {"mi": 1609.344, "km": 1000, "ft": 0.3048, "m": 1}[sb["units"]]
        MPP = sb["end_value"] * unit / abs(sb["end_x"] - sb["zero_x"]) * (2000 / W if False else 1)
        res["scale_bar_m_per_px"] = round(MPP, 2)
    ch = (hints["chip_hex"], hints["trail_chips"]) if hints.get("trail_chips") else None
    if hints and not ch:
        res["status"] = "no trail colours on this map"
        json.dump(res, open(os.path.join(out, f"{slug}-{n}.json"), "w"), indent=1)
        print(json.dumps(res))
        return
    masks = [(c, m & keep) for c, m in colour_masks(img, ch)]
    tried = []
    for c, m in masks:
        (sc, s, tx, ty), p = fit(rel, m, mn, ext, mpp=MPP)
        print(c, round(sc, 3), p, file=sys.stderr)
        tried.append((sc, c, s, tx, ty))
    if len(masks) > 1:
        un = np.zeros((H, W), np.uint8)
        for _, m in masks:
            un |= m
        (sc, s, tx, ty), p = fit(rel, un, mn, ext, mpp=MPP)
        print("union", round(sc, 3), p, file=sys.stderr)
        tried.append((sc, "union", s, tx, ty))
    tried.sort(reverse=True)
    if not tried:
        res["status"] = "no coloured lines found"
        print(json.dumps(res))
        return
    sc, c, s, tx, ty = tried[0]
    # union of the colours that also carry our trails well at this placement: the map's trail colours
    A = np.array([[s, 0, tx - mn[0] * s], [0, -s, ty + mn[1] * s]])
    pts = np.vstack([densify(l) for l in lm])
    trailmask = np.zeros((H, W), np.uint8)
    used = []
    P = np.c_[pts, np.ones(len(pts))]
    for c2, m in masks:
        q = np.round((A @ P.T).T).astype(int)
        ok = (q[:, 0] >= 0) & (q[:, 0] < W) & (q[:, 1] >= 0) & (q[:, 1] < H)
        dil = cv2.dilate(m, np.ones((9, 9), np.uint8))
        hit = dil[q[ok, 1], q[ok, 0]].mean() if ok.any() else 0
        if hit > 0.12 or c2 == c or c == "union" or ch:
            trailmask |= m
            used.append((c2, round(float(hit), 2)))
    A, onshare = refine(pts, trailmask, A)
    res.update(score=round(float(sc), 3), colours=used, fit_share=round(onshare, 2),
               metres_per_px=round(1 / math.sqrt(abs(np.linalg.det(A[:, :2]))), 2))
    # where our lines (all of them, park + near) fall on the page
    ours_img = np.zeros((H, W), np.uint8)
    P2 = lambda l: np.round((A @ np.c_[l, np.ones(len(l))].T).T).astype(np.int32)
    for l in lm + ln:
        cv2.polylines(ours_img, [P2(l)], False, 1, 3)
    mpp = res["metres_per_px"]
    far = cv2.dilate(ours_img, np.ones((2 * int(40 / mpp) + 1,) * 2, np.uint8))
    # extent our lines can say anything about: the park's lines' hull, grown by 1.5 km (map panel bounds it too)
    left = trailmask & (1 - far)
    left = cv2.morphologyEx(left, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    sk = skeleton(left)
    k, lab, st, _ = cv2.connectedComponentsWithStats(cv2.dilate(sk, np.ones((7, 7), np.uint8)), 8)
    Ai = np.linalg.inv(np.vstack([A, [0, 0, 1]]))[:2]
    cands = []
    for i in range(1, k):
        ys, xs = np.nonzero((lab == i) & (sk > 0))
        metres = len(xs) * mpp
        bw, bh = st[i, cv2.CC_STAT_WIDTH], st[i, cv2.CC_STAT_HEIGHT]
        span = math.hypot(bw, bh)
        if metres < 150 or span < 25 or len(xs) > 2.2 * span + 40:   # short, or a blob of letters
            continue
        # order points roughly along the piece for a trace
        o = np.argsort(xs * 0.001 + ys) if st[i, cv2.CC_STAT_HEIGHT] > st[i, cv2.CC_STAT_WIDTH] else np.argsort(xs + ys * 0.001)
        sel = o[:: max(1, len(o) // 40)]
        g = (Ai @ np.c_[xs[sel], ys[sel], np.ones(len(sel))].T).T
        trace = [tuple(round(v, 5) for v in L.ll(x, y)) for x, y in g]
        cx, cy = xs.mean(), ys.mean()
        cands.append({"id": len(cands) + 1, "metres": int(metres), "px_box": [int(xs.min()), int(ys.min()),
                      int(xs.max()), int(ys.max())], "centre": L.ll(*(Ai @ [cx, cy, 1])), "trace": trace})
    res["candidates"] = cands
    res["status"] = "aligned" if onshare >= 0.5 else "weak fit"
    # overlay picture: map faded, our lines in black, candidates boxed and numbered
    vis = (img * 0.55 + 255 * 0.45).astype(np.uint8)
    for l in lm:
        cv2.polylines(vis, [P2(l)], False, (0, 0, 0), 3)
    for l in ln:
        cv2.polylines(vis, [P2(l)], False, (90, 90, 90), 2)
    vis[left > 0] = (255, 0, 255)
    for cd in cands:
        x0, y0, x1, y1 = cd["px_box"]
        cv2.rectangle(vis, (x0 - 6, y0 - 6), (x1 + 6, y1 + 6), (255, 0, 255), 2)
        cv2.putText(vis, str(cd["id"]), (x0, max(20, y0 - 10)), cv2.FONT_HERSHEY_SIMPLEX, 1.0, (180, 0, 180), 3)
    for cd in cands:
        x0, y0, x1, y1 = cd["px_box"]
        m = max(120, int(0.4 * max(x1 - x0, y1 - y0)))
        a0, b0, a1, b1 = max(0, x0 - m), max(0, y0 - m), min(W, x1 + m), min(H, y1 + m)
        crop = img[b0:b1, a0:a1].copy()
        ov = crop.copy()
        cv2.rectangle(ov, (x0 - a0 - 6, y0 - b0 - 6), (x1 - a0 + 6, y1 - b0 + 6), (255, 0, 255), 3)
        lay = np.zeros(crop.shape[:2], np.uint8)
        for l in lm + ln:
            q = P2(l) - [a0, b0]
            cv2.polylines(lay, [q.astype(np.int32)], False, 1, 2)
        side = np.hstack([crop, ov])
        side2 = ov.copy(); side2[lay > 0] = (0, 0, 0)
        cv2.imwrite(os.path.join(out, f"{slug}-{n}-c{cd['id']}.jpg"), np.hstack([crop, np.full((crop.shape[0], 12, 3), 255, np.uint8), side2]),
                    [cv2.IMWRITE_JPEG_QUALITY, 85])
    cv2.imwrite(os.path.join(out, f"{slug}-{n}-overlay.jpg"), vis, [cv2.IMWRITE_JPEG_QUALITY, 80])
    json.dump(res, open(os.path.join(out, f"{slug}-{n}.json"), "w"), indent=1)
    print(json.dumps({k: v for k, v in res.items() if k != "candidates"}), len(cands), "candidates")

if __name__ == "__main__":
    main()
