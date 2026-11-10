# Park trail lists

One JSON file per park, in a folder per trail-pack area (`data/parks/missouri/rock-bridge-memorial-state-park.json`),
researched from the land manager's own pages and maps. `scripts/enrich_trail_pack.py` reads them when an area's
trail pack is built: a trail in that park whose name is in the list is marked official, with the source link.

```json
{
  "park": "Rock Bridge Memorial State Park",
  "also_known_as": [],
  "manager": "Missouri State Parks",
  "source": "https://…the manager's trails page…",
  "checked": "2026-11-10",
  "trails": [{"name": "Devil's Icebox Trail", "miles": 0.5, "uses": "hiking", "note": ""}],
  "notes": "anything a hiker should know that the manager states (closures, permits)"
}
```

Only facts are recorded (which trails exist, their names, lengths, uses), each with the page it came from. No
descriptions, maps or photos are copied. `park` must match the park's name in OpenStreetMap (the trail's area in the
app); put other spellings in `also_known_as`.
