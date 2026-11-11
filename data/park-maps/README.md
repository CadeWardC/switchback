# Park maps

Park managers publish their own trail maps. This folder holds what we learn from them, never the maps themselves.

- `sites.json`: managers' own lists of parks to collect maps from.
- `<region>.json`: links to each park's maps, with facts about the files (pages, whether they carry real coordinates). Made by `scripts/collect_park_maps.py` (workflow "Collect park maps").
- `<region>-matches.json`: for each map drawn for one trail and carrying coordinates, which of our lines lie on the highlighted trail and how much of it they cover. Made by `scripts/match_park_maps.py` (workflow "Match park maps to our trails"). `scripts/enrich_trail_pack.py` uses it to mark trails as confirmed, and to hide lines that sit on a park's off-road vehicle map.
- `<region>-missing.json`: trails a map shows that our data mostly lacks. A to-do list for mapping in OpenStreetMap.

Only names and measurements are taken from the maps. Their drawn lines are not copied into the trail data; each map belongs to its publisher.
