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
import difflib, glob, json, math, os, re, sys, zlib
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

ADD_FROM = {"Forest Service": "usfs", "National Park Service": "osmWay"}   # list -> the "source" the app reads
ADD_MIN_M = 400

def stitch(lines, gap=30):
    """Pieces of one trail joined end to end where their ends meet: the longest run first."""
    left = [list(l) for l in lines if len(l) >= 2]
    out = []
    while left:
        run = left.pop(max(range(len(left)), key=lambda i: official.length(left[i])))
        grew = True
        while grew:
            grew = False
            for i, l in enumerate(left):
                for mine, theirs, flip, front in ((run[-1], l[0], False, False), (run[-1], l[-1], True, False),
                                                  (run[0], l[-1], False, True), (run[0], l[0], True, True)):
                    if official.dist(mine, theirs) <= gap:
                        piece = l[::-1] if flip else l
                        run = piece + run if front else run + piece
                        left.pop(i)
                        grew = True
                        break
                if grew:
                    break
        out.append(run)
    return sorted(out, key=official.length, reverse=True)

def same_trail(entries, near=400, share=0.15):
    """A list's pieces of one trail (same name and number) whose ends nearly meet, as one entry: the list often cuts
    a trail at a road or a stream crossing. The gap must be small beside the pieces it joins."""
    out, groups = [], defaultdict(list)
    for m in entries:
        key = (official.norm_name(m.get("name") or ""), str(m.get("no") or ""))
        if key[0] and m.get("lines"):
            groups[key].append(m)
        else:
            out.append(m)
    for key, group in groups.items():
        group = [dict(m) for m in group]
        merged = True
        while merged and len(group) > 1:
            merged = False
            for i in range(len(group)):
                for j in range(i + 1, len(group)):
                    a, b = group[i], group[j]
                    gap = min(official.dist(p, q) for la in a["lines"] for p in (la[0], la[-1])
                              for lb in b["lines"] for q in (lb[0], lb[-1]))
                    size = sum(official.length(l) for l in a["lines"] + b["lines"])
                    if gap <= near and gap <= max(30, share * size):
                        a.update(lines=a["lines"] + b["lines"], miles=a.get("miles", 0) + b.get("miles", 0),
                                 gap=near, sure=bool(a.get("sure") and b.get("sure")),
                                 accepted=bool(a.get("accepted") and b.get("accepted")),
                                 motor=bool(a.get("motor") or b.get("motor")), shut=bool(a.get("shut") or b.get("shut")),
                                 use="hike" if a["use"] == b["use"] == "hike" else "?")
                        group.pop(j)
                        merged = True
                        break
                if merged:
                    break
        out += group
    return out

def add_federal(missing, trails, counts):
    """Trails the Forest Service and the National Park Service publish (public domain) that our data has no line
    for, added as trails of their own: only ones the list itself says are for people on foot, existing and open,
    not managed for motor vehicles, with a real name or number, at least a quarter mile, and not already added from
    the other list. Each says where its line came from (switchback:origin, official:source).
    Returns [(trail, start)]."""
    import build_trail_pack as builder
    grid = official.Grid()          # what has been added so far, so the two lists don't add the same trail twice
    near = defaultdict(list)        # our trails by 0.05° square, to borrow the park or forest's name from a neighbour
    for t in trails:
        a = t.get("tags", {}).get("switchback:area")
        if a:
            p = t["_lines"][0][0]
            near[(round(p[0] * 20), round(p[1] * 20))].append((p, a))
    added = []
    for label, source in ADD_FROM.items():
        for m in same_trail(missing.get(label, [])):
            # for hikers: the list manages it for them, or accepts them on a trail with no motor use at all
            # (the horse and pack trails of the backcountry, which walkers use)
            why = ("for motor vehicles" if m.get("motor") else
                   "not said to be for hikers" if m["use"] != "hike" or not (m.get("sure") or m.get("accepted")) else
                   "not an open, existing trail" if m.get("shut") else None)
            name = official.tidy_name(m["name"] or "")
            if not why and (not name or official.norm_name(name) in official.GENERIC):
                name = f"Forest Trail {m['no']}" if label == "Forest Service" and m.get("no") else ""
                why = None if name else "no name"
            lines = stitch(m.get("lines", []), m.get("gap", 30)) if not why else []
            if not why and (not lines or official.length(lines[0]) < ADD_MIN_M):
                why = "too short"
            if not why and added and official.match(lines, grid)[0] >= 0.3:
                why = "already added from the other list"
            if why:
                counts[f"{label}: not added, {why}"] += 1
                continue
            start = lines[0][0]
            tid = f"f{'s' if source == 'usfs' else 'n'}{m.get('no') or name}-{start[0]:.3f},{start[1]:.3f}"
            made = builder.make_trail(tid, None, source, name, lines, {}, ADD_MIN_M, main=lines[0])
            if not made:
                continue
            t, at = made
            tags = t.setdefault("tags", {})
            tags.update({"switchback:origin": label, "official:source": label,
                         "official:match": "the line itself comes from this list"})
            if not m.get("sure"):
                tags["description"] = "The Forest Service keeps this trail for horses, pack stock or bicycles; hikers are welcome."
                counts[f"added from the {label}: horse, pack and bicycle trails open to hikers"] += 1
            if m.get("no"):
                tags["official:ref"] = tags["ref"] = str(m["no"])
            k = (round(start[0] * 20), round(start[1] * 20))
            around = [(official.dist(start, p), a) for dy in (-1, 0, 1) for dx in (-1, 0, 1)
                      for p, a in near.get((k[0] + dy, k[1] + dx), ())]
            area = m.get("unit") or (min(around)[1] if around and min(around)[0] < 3000 else "")
            if area:
                tags["switchback:area"] = official.tidy_name(area) if m.get("unit") else area
            for i, l in enumerate(lines):
                grid.add(l, len(added))
            t["_lines"] = lines
            added.append((t, at))
            counts[f"added from the {label}"] += 1
            counts["miles added"] += official.length(lines[0]) / 1609.344
    return added

def wanted_trails(region_id, parks, trails):
    """Trails a park's own list or map names that the pack has no line for: the ones worth walking and sending
    in (docs/SUBMISSIONS.md) or mapping in OpenStreetMap. Each says which park, where the park is (the middle of
    the trails we do have there), and the manager's page or map to find it by. Facts only: no line is taken
    from anyone's map. [{park, trail, miles?, source?, map?, lat?, lon?, have?}]"""
    middles = defaultdict(list)
    for t in trails:
        a = official.norm_name(t.get("tags", {}).get("switchback:area", ""))
        if a and t.get("_lines"):
            middles[a].append(t["_lines"][0][0])
    def where(names):
        pts = [p for n in names for p in middles.get(official.norm_name(n), ())]
        if not pts:
            return {}
        return {"lat": round(sum(p[0] for p in pts) / len(pts), 4), "lon": round(sum(p[1] for p in pts) / len(pts), 4)}
    out, done = {}, set()
    for rec in parks.values():
        if id(rec) in done:
            continue
        done.add(id(rec))
        at = where([rec["park"]] + rec.get("also_known_as", []))
        for x in rec.get("trails", []):
            if x["name"] in rec.get("_found", ()) or WATER.search(x["name"]) or MOTOR.search(x["name"]):
                continue
            if re.search(r"\b(paddl|canoe|kayak|orv|atv|motor)", str(x.get("uses", "")), re.I):
                continue
            row = {"park": rec["park"], "trail": x["name"], **at}
            if x.get("miles"):
                row["miles"] = x["miles"]
            if rec.get("source"):
                row["source"] = rec["source"]
            out[(official.norm_name(rec["park"]), official.norm_name(x["name"]))] = row
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "park-maps", f"{region_id}-missing.json")
    if os.path.exists(path):
        for m in json.load(open(path)).get("trails", []):
            if WATER.search(m["trail"]) or MOTOR.search(m["trail"]) or m.get("share_in_our_data", 0) >= 0.5:
                continue
            key = (official.norm_name(m["park"]), official.norm_name(m["trail"]))
            row = out.setdefault(key, {"park": m["park"], "trail": m["trail"], **where([m["park"]])})
            row["map"] = m["map"]
            row["have"] = m.get("share_in_our_data", 0)
    return sorted(out.values(), key=lambda r: (r["park"], r["trail"]))

COMMUNITY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "submissions", "verified")

def add_community(region_id, trails, counts, folder=COMMUNITY):
    """Trails people walked and sent in (docs/SUBMISSIONS.md): only files that passed scripts/verify_submission.py
    and that a maintainer approved (a name in "approved_by"), and only where the pack still has no line there
    (OpenStreetMap or an official list may have gained the trail since). Returns [(trail, start)]."""
    import build_trail_pack as builder
    files = sorted(glob.glob(os.path.join(folder, region_id, "*.geojson")))
    if not files:
        return []
    grid = official.Grid()
    for i, t in enumerate(trails):
        for l in t["_lines"]:
            grid.add(l, i)
    added = []
    for f in files:
        try:
            feature = json.load(open(f))
            p = feature["properties"]
            line = [(c[1], c[0]) for c in feature["geometry"]["coordinates"]]
        except Exception as ex:
            print(f"  {os.path.basename(f)}: couldn't be read ({ex})")
            continue
        if not str(p.get("approved_by") or "").strip():
            counts["sent in by walkers: waiting for approval"] += 1
            continue
        placed = p.get("kind") == "placed"
        # walked, or placed on a map where a park's own list names the trail and the lidar shows it
        sound = p.get("kind") == "walked" or (placed and p.get("park") and (p.get("lidar_z") or 0) >= 2)
        if not sound or len(line) < 2 or official.length(line) < ADD_MIN_M:
            counts["sent in by walkers: not added, not a sound trail of a quarter mile"] += 1
            continue
        if official.match([line], grid)[0] >= 0.8:
            counts["sent in by walkers: not added, the pack has the trail now"] += 1
            continue
        if p.get("loop") and line[0] != line[-1]:
            line.append(line[0])
        name = official.tidy_name(p.get("name") or "")
        tid = f"c{name}-{line[0][0]:.3f},{line[0][1]:.3f}"
        made = builder.make_trail(tid, None, "osmWay", name, [line], {}, ADD_MIN_M, main=line)
        if not made:
            continue
        t, at = made
        tags = t.setdefault("tags", {})
        if placed:
            tags["switchback:origin"] = "USGS lidar"
            tags["switchback:unwalked"] = "yes"
            tags["description"] = ("Placed from USGS lidar where the park's own list names this trail. "
                                   "Nobody has sent in a walk of it yet, so the line may be a little off.")
            if p.get("park_source"):
                tags["official:url"] = p["park_source"]
        else:
            tags["switchback:origin"] = "Community"
            tags["switchback:walked"] = str(p.get("walked_on") or "")
            if p.get("notes"):
                tags["description"] = str(p["notes"])[:400]
        if p.get("area") or p.get("park"):
            tags["switchback:area"] = p.get("area") or p["park"]
        t["_lines"] = [line]
        grid.add(line, len(trails) + len(added))
        added.append((t, at))
        counts["sent in by walkers: added"] += 1
    return added

LEVELS = ["easy", "moderate", "hard", "veryHard"]

def rate(t):
    """Writes the trail's difficulty and walking time into the file, so every app shows the same without working
    them out itself (and a change to the rule is a rebuild of the files, not a new version of each app).
    Difficulty: kilometres plus a point for every 100 m of climb, raised by the SAC scale and a Forest Service
    class 1 trail. Time: Naismith's rule at an easy pace, 4.5 km/h plus an hour for every 600 m of climb."""
    tags = t.setdefault("tags", {})
    gain = (t.get("elev") or {}).get("g") or 0
    effort = t["length"] / 1000 + gain / 100
    level = 0 if effort < 8 else 1 if effort < 16 else 2 if effort < 26 else 3
    if re.sub(r"\D", "", tags.get("usfs:trail_class", "")) == "1":
        level = max(level, 1)
    sac = tags.get("sac_scale")
    if sac == "mountain_hiking":
        level = max(level, 1)
    elif sac == "demanding_mountain_hiking":
        level = max(level, 2)
    elif sac in ("alpine_hiking", "demanding_alpine_hiking", "difficult_alpine_hiking"):
        level = 3
    tags["switchback:difficulty"] = LEVELS[level]
    tags["switchback:minutes"] = str(round((t["length"] / 1000 / 4.5 + gain / 600) * 60))

def place(added, trails_by_cell, header, info):
    """Puts added trails in their cells and widens the area's summary to hold them."""
    for t, at in added:
        trails_by_cell.setdefault(f"{math.floor(at[0] / header['cell'])}_{math.floor(at[1] / header['cell'])}", []).append(t)
        t.pop("_main", None)
        info.setdefault("coverage", [])
        sq = f"{math.floor(at[0])}_{math.floor(at[1])}"
        if sq not in info["coverage"]:
            info["coverage"] = sorted(info["coverage"] + [sq])
        b = info.get("bbox")
        if b:
            info["bbox"] = [min(b[0], at[0]), min(b[1], at[1]), max(b[2], at[0]), max(b[3], at[1])]
    if added:
        header["bbox"] = info.get("bbox", header.get("bbox"))
        info["trails"] = info.get("trails", 0) + len(added)

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
        inside, results, sizes, missing = official.evaluate(trails, area, sources, keep_lines=set(ADD_FROM))
    except Exception as ex:
        print(f"  official lists couldn't be checked ({ex})")
        inside, results, sizes, missing = trails, {id(t): {} for t in trails}, {}, {}
    # with no list at all nothing can be confirmed, named or called informal for being on no list; the hikes are
    # still sorted from the fragments, side trails and unnamed lines, and park records and maps still apply
    listless = not sizes
    if listless:
        print("  no official list could be fetched: only sorting hikes and applying park records")

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
                                   tags.get("switchback:informal") == "yes" else None) or \
            (None if listless else official.informal_reason(t, res))
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
        elif tags.get("switchback:network") == "yes":
            hike = tags.get("switchback:hike") != "no"   # the builder decided: an overview of named trails isn't a hike
        elif tags.get("switchback:fragment") == "yes":
            hike = listed
        else:
            hike = (loop or listed or "switchback:access" in tags or "switchback:system" in tags
                    or tags.get("switchback:derived_name") == "yes")
        if not hike:
            tags["switchback:hike"] = "no"
        counts["hikes" if hike else "not listed as hikes"] += 1

    seen_parks = set()
    for rec in parks.values():
        if id(rec) in seen_parks:      # a park is in the table once for each of its names
            continue
        seen_parks.add(id(rec))
        absent = [x["name"] for x in rec.get("trails", []) if x["name"] not in rec.get("_found", ())]
        if absent:
            print(f"  {rec['park']}: in its trail list but not found in the pack: {', '.join(absent)}")
    try:
        wanted = wanted_trails(region_id, parks, inside)
        json.dump({"region": region_id, "wanted": wanted}, open(os.path.join(out, f"{region_id}.wanted.json"), "w"),
                  ensure_ascii=False, separators=(",", ":"))
        counts["trails wanted (on a park's list or map, no line yet)"] = len(wanted)
    except Exception as ex:
        print(f"  the list of trails wanted couldn't be written ({ex})")
    # federal trails our data has no line for
    try:
        added = add_federal(missing, trails, counts) if region["country"] == "US" else []
        if added and os.environ.get("ELEVATION", "1") != "0":
            import build_trail_pack as builder
            builder.add_elevation(added, os.environ.get("TERRAIN_CACHE", "terrain"))
        place(added, trails_by_cell, header, info)
        if added:
            counts["hikes"] += len(added)
            counts["miles added"] = round(counts["miles added"])
    except Exception as ex:
        print(f"  federal trails couldn't be added ({ex})")
    # trails people walked and sent in, once checked and approved
    try:
        walked = add_community(region_id, [t for ts in trails_by_cell.values() for t in ts], counts)
        if walked and os.environ.get("ELEVATION", "1") != "0":
            import build_trail_pack as builder
            builder.add_elevation(walked, os.environ.get("TERRAIN_CACHE", "terrain"))
        place(walked, trails_by_cell, header, info)
        counts["hikes"] += len(walked)
    except Exception as ex:
        print(f"  trails sent in by walkers couldn't be added ({ex})")
    for k, ts in trails_by_cell.items():
        for t in ts:
            t.pop("_lines", None)
            rate(t)
        cells[k] = json.dumps(ts, ensure_ascii=False, separators=(",", ":")).encode()
    size = write(pack_path, header, cells)
    info["bytes"] = size
    info["cells"] = len(trails_by_cell)
    info["official"] = {"lists": sizes, **dict(counts)}
    json.dump(info, open(info_path, "w"), separators=(",", ":"))
    print("  " + ", ".join(f"{k} {v}" for k, v in counts.items()) + f"; file now {size / 1024:.0f} KB")

if __name__ == "__main__":
    main()
