#!/usr/bin/env python3
"""Sorts the trails of a country that has no official trail lists wired in, by what its own map says of each one
(run by the trail-packs workflow after enrich_trail_pack.py; does nothing for a country without rules here).

    local_rules.py <out-dir> <region-id> [report.csv]

The United States and Canada are sorted against official lists (check_official_trails.py). Elsewhere the builder's
English word lists miss: a Swiss pack lists "Fübergwaldstrasse" and thousands of "Unnamed route" as hikes. Where the
country's signposted hiking network is mapped as routes (Switzerland: about 12,000 of them), a route is the evidence
an official list is in the US. So, for each trail:

  a route with a name                    a hike, as before
  a route with no name                   named for its ends when the map gives them ("Furi – Furgg"); otherwise an
                                         unnamed line (drawn, not listed)
  a named path that is on no route       a hike only when something says people hike it: a hiking grade (sac_scale),
                                         trail_visibility, a name that is a trail's ("Höhenweg", "Sentier …",
                                         "Sentiero …"), or a park or reserve around it
    …named like a street, with none      informal (hidden unless "Informal trails" is on): "…strasse", "Rue …",
     of those                            "Quai …", "Via …" on pavement
    …anything else                       not a hike: stays on the map, out of the list

Rewrites <region-id>.trails in place (same version, same cells), corrects the counts in <region-id>.json, and with a
third argument writes one line per trail saying what it was taken for and why.
"""
import csv, json, os, re, sys
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import enrich_trail_pack as packs      # noqa: E402

PAVED = {"asphalt", "concrete", "paving_stones", "paved", "sett", "concrete:plates", "bricks"}
HIKING_TAGS = ("sac_scale", "trail_visibility")

# German, French, Italian and Romansh, the languages of Swiss maps (and English, for the bike parks)
CH = {
    # a path whose name says trail: "Höhenweg", "Panoramaweg", "Lehrpfad", "Sentier des Chamois", "Sentiero …"
    "trail": re.compile(
        r"(wander|höhen|hoehen|panorama|rund|berg|ufer|see|themen|lehr|natur|erlebnis|planeten|alp|hütten|huetten|grat|"
        r"schlucht|moor|tobel|gletscher|felsen|wasserfall|aussichts|kultur|sagen|märchen|pilger|jakobs|suonen|kneipp|"
        r"barfuss|wald)(weg|pfad|wäg)\b|\b(pfad|steig|klettersteig|lehrpfad|rundgang|rundwanderung|wanderung|"
        r"sentier|sente|sentiero|sentee|senté|senda|veia|veja|bisse|suone|tour|circuit|boucle|balade|giro|anello|"
        r"passeggiata|percorso|trail|trails|path|loop|parcours|vita)\b", re.I),
    # …or says street: "Bahnhofstrasse", "Rue du Lac", "Quai Ernest Ansermet", "Piazza Grande"
    "street": re.compile(
        r"(strasse|straße|str\.|gasse|gässli|gaessli|platz|allee|steg|brücke|bruecke|passerelle)$|"
        r"^(rue|ruelle|avenue|av\.|boulevard|bd|place|impasse|quai|route|rte|passage|pont|"
        r"viale|piazza|piazzale|vicolo|strada|corso|salita|ponte)\b|\b(trottoir|parkplatz|parking|sidewalk)\b", re.I),
    # …or could be either, and is a street when it is paved: "Kapellenweg", "Chemin des Vignes", "Via Cantonale"
    "lane": re.compile(r"(weg|wäg|wegli)$|^(chemin|ch\.|via|vea)\b", re.I),
    "informal": "On no signposted hiking route, and named like a street.",
}
RULES = {"CH": CH}

def ends(tags):
    a, b = (tags.get(k, "").strip() for k in ("from", "to"))
    # a mapper's note to self isn't a place: "Stocksiten? / Amden?", "fixme", "aaa"
    if any(len(x) < 3 or "?" in x or "fixme" in x.lower() or len(set(x.lower())) == 1 for x in (a, b)):
        return None
    return f"{a} – {b}" if a.casefold() != b.casefold() else f"{a} (loop)"

def sort_trail(t, rules):
    """(what the trail is taken for, why), changing its tags (and name) to match."""
    tags = t.setdefault("tags", {})
    if tags.get("switchback:origin") or "official:source" in tags:
        return "hike" if tags.get("switchback:hike") != "no" else "not a hike", "an official list has it"
    if tags.get("switchback:unnamed") == "yes":
        return "unnamed", "an unnamed path"
    if tags.get("switchback:informal") == "yes":
        return "informal", tags.get("switchback:informal_reason", "the map says so")
    before = "hike" if tags.get("switchback:hike") != "no" else "not a hike"
    if t["source"] == "osmRelation":
        if t["name"] != "Unnamed route":
            return before, "a signposted route with a name"
        name = ends(tags)
        if name:
            t["name"] = name
            tags["switchback:named_for"] = "ends"
            return before, "a signposted route, named for its ends"
        tags["switchback:unnamed"] = "yes"
        tags["switchback:hike"] = "no"
        return "unnamed", "a signposted route with no name and no ends given"
    if any(tags.get(k) == "yes" for k in ("switchback:side", "switchback:roadwalk", "switchback:fragment")) \
            or tags.get("switchback:network") == "yes":
        return before, "as the builder left it (a side trail, road walk, fragment or trail system)"
    name = t["name"]
    grade = [k for k in HIKING_TAGS if k in tags]
    if grade:
        return before, "a named path with " + " and ".join(grade)
    if rules["trail"].search(name):
        return before, "a named path whose name is a trail's"
    if tags.get("switchback:area"):
        return before, f"a named path in {tags['switchback:area']}"
    paved = tags.get("surface") in PAVED
    if rules["street"].search(name) or (paved and rules["lane"].search(name)):
        tags["switchback:informal"] = "yes"
        tags["switchback:informal_reason"] = rules["informal"]
        tags["switchback:hike"] = "no"
        return "informal", "on no route, named like a street" + (", paved" if paved else "")
    tags["switchback:hike"] = "no"
    return "not a hike", "a named path on no route, with nothing that says people hike it"

def main():
    out_dir, region = sys.argv[1], sys.argv[2]
    report = sys.argv[3] if len(sys.argv) > 3 else None
    info_path = os.path.join(out_dir, f"{region}.json")
    info = json.load(open(info_path))
    rules = RULES.get(info.get("country", "US"))
    if not rules:
        print(f"  local rules: none for {info.get('country', 'US')}, nothing changed")
        return
    pack_path = os.path.join(out_dir, f"{region}.trails")
    header, cells = packs.read(pack_path)
    counts, lines = Counter(), []
    for key in sorted(cells):
        if key.startswith("p:"):
            continue
        rows = json.loads(cells[key])
        for t in rows:
            was = t["name"]
            what, why = sort_trail(t, rules)
            counts[what] += 1
            counts[f"{what}: {'a named path in a park or reserve' if why.startswith('a named path in ') else why}"] += 1
            if t["name"] != was:
                counts["named for their ends"] += 1
            lines.append((t["id"], t["name"], round(t["length"] / 1000, 2), what, why,
                          ("relation/" if t["source"] == "osmRelation" else "way/") + str(t.get("osmId", ""))))
        cells[key] = json.dumps(rows, ensure_ascii=False, separators=(",", ":")).encode()
    size = packs.write(pack_path, header, cells)
    info["bytes"] = size
    official = info.setdefault("official", {})
    official["hikes"] = counts["hike"]
    official["informal"] = counts["informal"]
    official["not listed as hikes"] = counts["not a hike"] + counts["unnamed"] + counts["informal"]
    info["local rules"] = {k: v for k, v in sorted(counts.items())}
    json.dump(info, open(info_path, "w"), separators=(",", ":"))
    print(f"  local rules ({info['country']}): {counts['hike']} hikes, {counts['not a hike']} not hikes, "
          f"{counts['informal']} informal, {counts['unnamed']} unnamed; {counts['named for their ends']} routes named "
          f"for their ends")
    for k, v in sorted(counts.items(), key=lambda kv: -kv[1]):
        if ": " in k:
            print(f"    {v:6d}  {k}")
    if report:
        os.makedirs(os.path.dirname(os.path.abspath(report)), exist_ok=True)
        with open(report, "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "name", "km", "taken for", "why", "openstreetmap"])
            w.writerows(sorted(lines, key=lambda r: (r[3], r[1])))
        print(f"  one line per trail: {report}")

if __name__ == "__main__":
    main()
