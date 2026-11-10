#!/usr/bin/env python3
"""Adds what official trail lists know to a freshly built trail pack (run by the trail-packs workflow after
build_trail_pack.py).

    enrich_trail_pack.py <out-dir> <region-id>

Uses only the vetted lists in check_official_trails.py (the national ones and the hand-picked state and provincial
ones, never the catalogue's finds), matched by shape:
  - an unnamed line takes an official name only when check_official_trails.official_name() is sure (most of the line on
    one named official trail open to hikers, that name dominant and not generic, no list naming it differently); the
    trail keeps its id, and official:name / official:ref / official:source say where the name came from
  - a named trail an official list confirms gets official:source (and official:ref, and official:name when the
    wording differs)
  - lines official lists say aren't for hikers, unnamed lines on no list outside parks with nothing marking them as
    hiking trails, and street-like named paths on no list outside parks get switchback:informal=yes and
    switchback:informal_reason (the app hides them unless "Informal trails" is on)
Rewrites <region-id>.trails in place (same version, same cells) and adds the counts to <region-id>.json. If the
official lists can't be reached the pack is left as it is.
"""
import difflib, glob, json, os, sys, zlib
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import check_official_trails as official  # noqa: E402

MAGIC = b"SBTP1"

def read(path):
    b = open(path, "rb").read()
    n = int.from_bytes(b[5:9], "big")
    header = json.loads(b[9:9 + n])
    body = b[9 + n:]
    cells = {}
    for k, (o, l) in header["cells"].items():
        cells[k] = zlib.decompress(body[o:o + l], -15)
    return header, cells

def write(path, header, cells):
    blobs, table, offset = [], {}, 0
    for key in sorted(cells):
        c = zlib.compressobj(9, zlib.DEFLATED, -15)
        z = c.compress(cells[key]) + c.flush()
        table[key] = [offset, len(z)]
        blobs.append(z)
        offset += len(z)
    header = dict(header, cells=table)
    raw = json.dumps(header, separators=(",", ":")).encode()
    with open(path, "wb") as f:
        f.write(MAGIC + len(raw).to_bytes(4, "big") + raw + b"".join(blobs))
    return len(MAGIC) + 4 + len(raw) + offset

def park_records(region_id):
    """Trail lists researched park by park from each manager's own pages (data/parks/<region>/*.json):
    {park, manager, source (URL), checked (date), trails: [{name, miles?, uses?, note?}]}, keyed by park name."""
    out = {}
    folder = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "parks", region_id)
    for f in sorted(glob.glob(os.path.join(folder, "*.json"))):
        try:
            rec = json.load(open(f))
            for name in [rec["park"]] + rec.get("also_known_as", []):
                out[official.norm_name(name)] = rec
        except Exception as ex:
            print(f"  park record {os.path.basename(f)} couldn't be read ({ex})")
    return out

def main():
    out, region_id = sys.argv[1], sys.argv[2]
    pack_path, info_path = os.path.join(out, f"{region_id}.trails"), os.path.join(out, f"{region_id}.json")
    info = json.load(open(info_path))
    header, cells = read(pack_path)
    trails_by_cell = {k: json.loads(v) for k, v in cells.items() if not k.startswith("p:")}
    trails = []
    for k, ts in trails_by_cell.items():
        for t in ts:
            t["_lines"] = [official.decode(s) for s in t["segments"]]
            trails.append(t)
    region = {"region": region_id, "name": info.get("name", region_id), "country": info.get("country", "US"),
              "coverage": info.get("coverage", [])}
    area, outline = official.region_area(region)
    sources = list(official.NATIONAL.get(region["country"], [])) + official.STATE_SOURCES.get(region["name"], [])
    known = {src[1].rsplit("/", 1)[0] for src in sources} | {src[1] for src in sources}
    try:
        # the state's or province's own lists, from vetted government publishers only
        sources += official.discover(region, area, known, vetted_only=True)
    except Exception as ex:
        print(f"  the state's own lists couldn't be looked up ({ex})")
    print(f"{region['name']}: {len(trails)} trails; official lists inside ({outline}):")
    try:
        inside, results, sizes, _ = official.evaluate(trails, area, sources)
    except Exception as ex:
        print(f"  official lists couldn't be checked ({ex}); pack left as it is")
        return
    if not sizes:
        print("  no official list could be fetched; pack left as it is")
        return

    counts = Counter()
    parks = park_records(region_id)
    for t in inside:
        res = results[id(t)]
        tags = t.setdefault("tags", {})
        if tags.get("switchback:unnamed") == "yes" or tags.get("switchback:derived_name") == "yes":
            got, _ = official.official_name(res)
            if got:
                name, ref, src = got
                t["name"] = name
                tags.pop("switchback:unnamed", None)
                tags.pop("switchback:derived_name", None)
                tags.update({"official:name": name, "official:source": src})
                if ref:
                    tags["official:ref"] = ref
                counts["named from an official list"] += 1
        else:
            conf = official.confirmed(res)
            hiking = {k: v for k, v in conf.items()
                      if v["hike_share"] >= official.CONFIRM or (v.get("ref") and v["hike_share"] >= 0.5)}
            if hiking:
                src, v = max(hiking.items(), key=lambda kv: kv[1]["share"])
                tags["official:source"] = src
                # how sure the match is: share of the line on the official trail, same number, name likeness
                tags["official:match"] = f"{round(v['share'] * 100)}%" + (", same number" if v.get("ref") else "") + \
                                         (f", name {round(v['alike'] * 100)}% alike" if v.get("alike") else "")
                n = v["named"]
                if n:
                    if n.get("no"):
                        tags["official:ref"] = n["no"]
                    if not official.same_name(t["name"], n["name"]):
                        tags["official:name"] = official.tidy_name(n["name"])
                counts["confirmed by an official list"] += 1
        # a park's own published trail list (data/parks): a trail of that name in that park is official
        rec = parks.get(official.norm_name(tags.get("switchback:area", "")))
        if rec and "official:source" not in tags and tags.get("switchback:unnamed") != "yes":
            hit = next((x for x in rec.get("trails", []) if official.same_name(x["name"], t["name"])
                        or difflib.SequenceMatcher(None, official.norm_name(x["name"]), official.norm_name(t["name"])).ratio() >= 0.88), None)
            if hit:
                tags["official:source"] = rec.get("manager") or rec["park"]
                tags["official:match"] = "named in the park's trail list"
                if rec.get("source"):
                    tags["official:url"] = rec["source"]
                rec.setdefault("_found", set()).add(hit["name"])
                counts["confirmed by a park's trail list"] += 1
        why = official.informal_reason(t, res)
        if why:
            tags["switchback:informal"] = "yes"
            tags["switchback:informal_reason"] = why
        elif tags.get("switchback:informal") == "yes" and "official:source" in tags:
            # OpenStreetMap calls it informal, but an official hiking list has it: the list wins
            del tags["switchback:informal"]
            tags.pop("switchback:informal_reason", None)
        if tags.get("switchback:informal") == "yes":
            counts["informal"] += 1
        # is it a hike to list? A loop, a trail with a trailhead, a trail an official list has, or part of a trail
        # system; never a side trail, road walk, unnamed line or informal path, and a short fragment only if official
        line = official.decode(t["path"]) if "path" in t else t["_lines"][t.get("pathIndex", 0)]
        loop = t["length"] > 500 and official.dist(line[0], line[-1]) < max(150, t["length"] * 0.03)
        listed = "official:source" in tags
        if any(tags.get(k) == "yes" for k in ("switchback:informal", "switchback:side", "switchback:roadwalk", "switchback:unnamed")):
            hike = False
        elif tags.get("switchback:fragment") == "yes":
            hike = listed
        else:
            hike = (loop or listed or "switchback:access" in tags or "switchback:system" in tags
                    or tags.get("switchback:derived_name") == "yes")
        if not hike:
            tags["switchback:hike"] = "no"
        counts["hikes" if hike else "not listed as hikes"] += 1

    for rec in parks.values():
        missing = [x["name"] for x in rec.get("trails", []) if x["name"] not in rec.get("_found", ())]
        if missing:
            print(f"  {rec['park']}: in its trail list but not found in the pack: {', '.join(missing)}")
    for k, ts in trails_by_cell.items():
        for t in ts:
            t.pop("_lines", None)
        cells[k] = json.dumps(ts, ensure_ascii=False, separators=(",", ":")).encode()
    size = write(pack_path, header, cells)
    info["bytes"] = size
    info["official"] = {"lists": sizes, **dict(counts)}
    json.dump(info, open(info_path, "w"), separators=(",", ":"))
    print("  " + ", ".join(f"{k} {v}" for k, v in counts.items()) + f"; file now {size / 1024:.0f} KB")

if __name__ == "__main__":
    main()
