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
import difflib, glob, json, os, re, sys, zlib
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

def map_matches(region_id):
    """What laying the parks' own georeferenced trail maps over our lines found (data/park-maps/<region>-matches.json,
    written by match_park_maps.py): trail id -> {trail (the name printed on the map), park, url, share}."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "park-maps", f"{region_id}-matches.json")
    out = {}
    if not os.path.exists(path):
        return out
    for m in json.load(open(path)).get("maps", []):
        # only maps drawn for one trail ("TrailMap-…"), and not paddling routes
        if not m.get("trail") or not ONE_TRAIL.search(m["url"]) or WATER.search(m["trail"]):
            continue
        for o in m.get("ours", []):
            if o["share"] >= 0.8 and o["on_map"] >= 0.7 and o["share"] > out.get(o["id"], {}).get("share", 0):
                out[o["id"]] = {"trail": m["trail"], "park": m["park"], "url": m["url"], "share": o["share"]}
    return out

ONE_TRAIL = re.compile(r"trail(-|_|%20| )?map", re.I)
WATER = re.compile(r"\b(water|aquatic|paddl\w*|canoe|kayak|float)\b", re.I)
MOTOR = re.compile(r"\b(orv|ohv|atv|off[- ]road|motor\w*)\b", re.I)

def like(ours, theirs):
    """Our name is the map's name: the same, the map's name plus a part ("X - North Loop"), or a spelling apart."""
    a, b = official.norm_name(ours), official.norm_name(theirs)
    return a == b or a.startswith(b + " ") or difflib.SequenceMatcher(None, a, b).ratio() >= 0.85

def apply_map(t, hit, counts):
    """A trail one of the park's own maps shows: confirm it, and name it when it has no name of its own.
    Returns True when the map vouches for it."""
    tags = t.setdefault("tags", {})
    nameless = tags.get("switchback:unnamed") == "yes" or tags.get("switchback:derived_name") == "yes"
    same = not nameless and like(t["name"], hit["trail"])
    if MOTOR.search(hit["trail"]):
        # the park's map of its off-road vehicle trails: not a hike
        if not same:
            tags["switchback:informal"] = "yes"
            tags["switchback:informal_reason"] = f"on the park's map of its off-road vehicle trails ({hit['trail']})"
            counts["off-road vehicle trails (park map)"] += 1
        return False
    if nameless:
        # only a name that reads like a whole trail name ("Deer Run Trail"), never a system's or a garbled one
        if hit["share"] < 0.85 or re.search(r"\bsystem\b", hit["trail"], re.I) or \
                not re.fullmatch(r"(?:[A-Z][\w.'’-]+ )+(?:Trail|Loop|Path|Walk|Boardwalk|Trace)", hit["trail"]):
            return False
        t["name"] = hit["trail"]
        tags.pop("switchback:unnamed", None)
        tags.pop("switchback:derived_name", None)
        tags["official:name"] = hit["trail"]
        counts["named from a park's map"] += 1
    elif not same and hit["share"] < 0.9:
        return False   # a differently named line only partly on the map's trail: say nothing
    # (a differently named line that runs along the map's trail is confirmed but keeps its name: the name read off
    # a map is not sure enough to show beside ours)
    tags.setdefault("official:source", f"{hit['park']} trail map")
    tags.setdefault("official:match", f"{round(hit['share'] * 100)}% on the park's own map of this trail")
    tags["official:url"] = hit["url"]
    counts["confirmed by a park's map"] += 1
    return True

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
    on_maps = map_matches(region_id)
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
        if rec and tags.get("switchback:unnamed") != "yes" and "official:url" not in tags:
            # the same name (or the part after "System - "), spelled all but identically; never just a name
            # inside a longer one ("Moon Loop" is not "South Moon Loop" or "Moon Loop Access")
            mine = {official.norm_name(t["name"]), official.norm_name(t["name"].split(" - ")[-1])}
            def same(x):
                theirs = official.norm_name(x["name"])
                return (t["name"] in x.get("our_names", []) or theirs in mine
                        or any(difflib.SequenceMatcher(None, theirs, m).ratio() >= 0.88 for m in mine))
            hit = next((x for x in rec.get("trails", []) if same(x)), None)
            if hit:
                if "official:source" not in tags:
                    tags["official:source"] = rec.get("manager") or rec["park"]
                    tags["official:match"] = "named in the park's trail list"
                if rec.get("source"):
                    tags["official:url"] = rec["source"]
                if not official.same_name(hit["name"], t["name"]):
                    tags["official:name"] = hit["name"]
                # the manager's length, when this is the whole trail and not one piece of it
                if hit.get("miles") and 0.6 <= t["length"] / 1609.344 / hit["miles"] <= 1.6:
                    tags["official:miles"] = str(hit["miles"])
                rec.setdefault("_found", set()).add(hit["name"])
                counts["confirmed by a park's trail list"] += 1
        mapped = t["id"] in on_maps and apply_map(t, on_maps[t["id"]], counts)
        why = None if mapped else (tags.get("switchback:informal_reason") if t["id"] in on_maps and
                                   tags.get("switchback:informal") == "yes" else None) or official.informal_reason(t, res)
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
