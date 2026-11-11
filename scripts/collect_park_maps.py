#!/usr/bin/env python3
"""Finds each park's own trail maps (run by the collect-park-maps workflow; this needs the open internet).

    collect_park_maps.py <region-id> <out-dir> [park-name-filter]

For every park record in data/parks/<region-id>/ it opens the manager's page (the record's "source", plus any "maps"
listed by hand), follows links on that site that look like map or trail pages (one step), and gathers the PDFs and
pictures that look like maps. Each one is downloaded, checked (is it a PDF or picture, how many pages, does it carry
real coordinates like the maps made for Avenza), and its first pages are turned into pictures.

Writes <out-dir>/index.json (park -> its maps: where each came from, size, pages, georeferenced or not) and the
pictures <out-dir>/<park-slug>-<n>-p<page>.png. The index is only links and facts; the maps stay their publishers'.
"""
import hashlib, json, glob, os, re, subprocess, sys, time, urllib.parse, urllib.request
from html.parser import HTMLParser

AGENT = "Mozilla/5.0 (X11; Linux x86_64) trail-map-index/1.0"
MAP_WORDS = re.compile(r"map|trail|brochure|guide", re.I)
PAGE_WORDS = re.compile(r"map|trail|hik", re.I)
FILE = re.compile(r"\.(pdf|jpe?g|png)(\?|$)", re.I)
SKIP = re.compile(r"logo|icon|sprite|facebook|twitter|instagram|banner|thumb|styles/|favicon|regulation|rules|"
                  r"permit|application|form|newsletter|minutes|agenda|hunting|fishing", re.I)
MAX_FILES, MAX_PAGES, MAX_BYTES, PAGES_DRAWN = 40, 8, 40 << 20, 2
last = {}

class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.out, self.href, self.text = [], None, []
    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "a" and a.get("href"):
            self.href, self.text = a["href"], []
        elif tag == "img" and self.href is not None:
            self.text.append(a.get("alt") or "")
    def handle_data(self, d):
        if self.href is not None:
            self.text.append(d)
    def handle_endtag(self, tag):
        if tag == "a" and self.href is not None:
            self.out.append((self.href, " ".join(" ".join(self.text).split())))
            self.href = None

def get(url, limit=MAX_BYTES):
    host = urllib.parse.urlparse(url).netloc
    wait = last.get(host, 0) + 1.0 - time.time()   # at most one request a second to any one site
    if wait > 0:
        time.sleep(wait)
    last[host] = time.time()
    req = urllib.request.Request(url, headers={"User-Agent": AGENT, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.geturl(), r.headers.get("Content-Type", ""), r.read(limit + 1)

def links(url):
    final, kind, body = get(url, 4 << 20)
    if "html" not in kind:
        return final, []
    p = Links()
    p.feed(body.decode("utf-8", "replace"))
    out = []
    for href, text in p.out:
        full = urllib.parse.urljoin(final, href).split("#")[0]
        if full.startswith("http"):
            out.append((full, text))
    return final, out

def find(start, extra):
    """Map files linked from the park's page, and from the map/trail pages it links to on the same site."""
    files, seen, notes = {}, set(), []
    for u in extra:
        files[u] = "listed by hand"
    def scan(url, depth):
        if url in seen or len(seen) > MAX_PAGES:
            return
        seen.add(url)
        try:
            final, found = links(url)
        except Exception as ex:
            notes.append(f"{url}: {ex}")
            return
        host = urllib.parse.urlparse(final).netloc.removeprefix("www.")
        if os.environ.get("SHOW_LINKS"):
            print(f"  {final}: {len(found)} links")
            for full, text in found:
                print(f"    {full} | {text[:60]}")
        for full, text in found:
            if SKIP.search(full) or SKIP.search(text):
                continue
            if FILE.search(full) or "/media/" in urllib.parse.urlparse(full).path:   # "/media/…": a file behind a page
                if MAP_WORDS.search(full) or MAP_WORDS.search(text):
                    files.setdefault(full, text[:80])
            elif depth and urllib.parse.urlparse(full).netloc.removeprefix("www.") == host \
                    and (full.rstrip("/").endswith("/trails")   # a park's trails page, wherever the site keeps it
                         or (full.startswith(final.rstrip("/")) and PAGE_WORDS.search(full[len(final):] + " " + text))):
                scan(full, depth - 1)
    if start and (FILE.search(start) or "/media/" in start):
        files.setdefault(start, "the record's own source")   # the record points straight at a file
    elif start:
        scan(start, 1)
        if not files and start.rstrip("/").count("/") > 3:
            scan(start.rstrip("/").rsplit("/", 1)[0], 0)   # nothing on a sub-page (…/trails): try the park's own page
    return files, notes

def describe(data):
    if data[:4] == b"%PDF":
        geo = any(k in data for k in (b"/GPTS", b"/LGIDict", b"GEOGCS", b"/Measure"))
        pages = len(re.findall(rb"/Type\s*/Page[^s]", data))
        return "pdf", pages, geo
    if data[:3] == b"\xff\xd8\xff":
        return "jpg", 1, False
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png", 1, False
    return None, 0, False

def draw(kind, path, stem):
    """First pages as pictures about 2000 px on the long side."""
    made = []
    if kind == "pdf":
        subprocess.run(["pdftoppm", "-png", "-r", "110", "-scale-to", "2000", "-f", "1", "-l", str(PAGES_DRAWN),
                        path, stem + "-p"], check=False, timeout=180)
        made = sorted(glob.glob(stem + "-p*.png"))
    else:
        out = f"{stem}-p1.png"
        subprocess.run(["convert", path, "-resize", "2000x2000>", out], check=False, timeout=120)
        made = [out] if os.path.exists(out) else []
    return [os.path.basename(m) for m in made]

def whole_sites(region, have):
    """Every park on a manager's own list of parks (data/park-maps/sites.json), beyond the ones with records:
    [(slug, {park, manager, source})]."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "park-maps", "sites.json")
    out, seen = [], set()
    for site in (json.load(open(path)).get(region, []) if os.path.exists(path) else []):
        try:
            _, found = links(site["list"])
        except Exception as ex:
            print(f"{site['list']}: {ex}")
            continue
        for url, text in found:
            url = url.rstrip("/")
            page = url + site.get("append", "")
            if not re.search(site["park_link"], url) or url in seen or page in have or not text:
                continue
            seen.add(url)
            out.append((re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-"),
                        {"park": text, "manager": site.get("manager"), "source": page}))
    return out

def main():
    region, out = sys.argv[1], sys.argv[2]
    only = sys.argv[3].lower() if len(sys.argv) > 3 and sys.argv[3] else ""
    os.makedirs(out, exist_ok=True)
    folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "parks", region)
    index, hashes = {}, set()
    recs = []
    for f in sorted(glob.glob(os.path.join(folder, "*.json"))):
        rec = json.load(open(f))
        if isinstance(rec, dict) and "park" in rec:
            recs.append((os.path.basename(f)[:-5], rec))
    recs += whole_sites(region, {r.get("source") for _, r in recs})
    for slug, rec in recs:
        if only and only not in rec["park"].lower():
            continue
        files, notes = find(rec.get("source"), rec.get("maps", []))
        maps = []
        for url, text in list(files.items())[:MAX_FILES]:
            try:
                final, _, data = get(url)
                if len(data) > MAX_BYTES:
                    notes.append(f"{url}: too big")
                    continue
                kind, pages, geo = describe(data)
                if not kind and b"<html" in data[:2000].lower():
                    # a page that wraps the file (the Conservation Department's map pages): take the file inside
                    # any file the page links, embeds or frames (href, src, data…)
                    raw = data.decode("utf-8", "replace").replace("\\/", "/")
                    inner = [urllib.parse.urljoin(final, u) for u in
                             re.findall(r"""["'(]([^"'()<>\s]+\.(?:pdf|PDF)(?:\?[^"'()<>\s]*)?)""", raw)]
                    # a PDF viewer's link carries the real file in "file="
                    inner = [urllib.parse.unquote(u.split("file=", 1)[1].split("&")[0]) if "file=" in u else u
                             for u in inner]
                    inner += [u for u, _ in links(final)[1] if FILE.search(u)]
                    inner = [u for u in dict.fromkeys(inner) if not SKIP.search(u)]
                    inner.sort(key=lambda u: (".pdf" not in u.lower(), not MAP_WORDS.search(u)))
                    if os.environ.get("SHOW_LINKS"):
                        print(f"  viewer page {final}: files inside {inner[:5]}")
                        for m in list(re.finditer(r"(?i)pdf|iframe|<embed|<object|file-url|download", raw))[:25]:
                            print("    …" + " ".join(raw[max(0, m.start() - 110):m.start() + 130].split()))
                    if inner:
                        final, _, data = get(inner[0])
                        kind, pages, geo = describe(data)
                digest = hashlib.sha256(data).hexdigest()[:16]
                if not kind or len(data) < 20000 or digest in hashes:
                    if os.environ.get("SHOW_LINKS"):
                        print(f"  skipped {url} -> {final}: {kind}, {len(data)} bytes, starts {data[:60]!r}")
                    continue
                hashes.add(digest)
                stem = os.path.join(out, f"{slug}-{len(index.get(slug, {}).get('maps', [])) + len(maps) + 1}")
                raw = f"{stem}.{kind}"
                open(raw, "wb").write(data)
                pictures = [] if os.environ.get("NO_PICTURES") else draw(kind, raw, stem)
                os.remove(raw)
                maps.append({"url": final, "link_text": text, "kind": kind, "bytes": len(data), "pages": pages,
                             "georeferenced": geo, "sha256_16": digest, "pictures": pictures})
            except Exception as ex:
                notes.append(f"{url}: {ex}")
        if slug in index:   # the same park from its record and from the manager's list of parks
            index[slug]["maps"] += maps
        else:
            index[slug] = {"park": rec["park"], "manager": rec.get("manager"), "page": rec.get("source"),
                           "maps": maps, "notes": notes[:6]}
        print(f"{rec['park']}: {len(maps)} map(s)" + (f", {sum(m['georeferenced'] for m in maps)} georeferenced" if maps else "")
              + (f"; {notes[0]}" if notes and not maps else ""), flush=True)
    json.dump(index, open(os.path.join(out, "index.json"), "w"), indent=1)
    got = sum(1 for v in index.values() if v["maps"])
    print(f"\n{got} of {len(index)} parks have at least one map; {sum(len(v['maps']) for v in index.values())} maps, "
          f"{sum(m['georeferenced'] for v in index.values() for m in v['maps'])} georeferenced")

if __name__ == "__main__":
    main()
