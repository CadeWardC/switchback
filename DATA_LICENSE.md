# Trail data licence

The trail files this repository builds and publishes (the `trails-us` release: `<area>.trails`, `<area>.json`,
`regions.json`) are a database derived from OpenStreetMap. They are made available under the
**Open Database License (ODbL) 1.0**, https://opendatacommons.org/licenses/odbl/1-0/.

**Trail lines, names and tags:** © OpenStreetMap contributors, https://www.openstreetmap.org/copyright.

Where a trail carries an `official:source` tag, its official name, number or status comes from that source:

| Source | Used for | Terms |
| --- | --- | --- |
| USGS National Digital Trails | confirming trails, official names and numbers | U.S. Geological Survey, public domain |
| USDA Forest Service, National Forest System Trails | confirming trails, official names and numbers, use | USDA Forest Service (listed as CC BY 4.0 on data.gov) |
| National Park Service, Public Trails | confirming trails, official names | National Park Service |
| State, provincial and city lists named in `scripts/check_official_trails.py` | confirming trails; names only from the hand-picked lists | each publisher's open-data terms |
| Lists from vetted government publishers found in the ArcGIS Online catalogue | confirming trails only (never names) | each publisher's terms |
| Park trail lists in `data/parks/` | confirming that a named trail is in a park's own published list (a fact, with its source link) | facts only; no text or maps are copied |

**Elevation:** Terrain Tiles (Mapzen/AWS Open Data), built from USGS 3DEP, SRTM, CDEM and others; see
https://github.com/tilezen/joerd/blob/master/docs/attribution.md.

The app's code is separate from this data and is not covered by the ODbL.
