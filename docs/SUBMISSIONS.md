# Submitting a trail

Anyone can send in a trail they walked. Nothing a person sends goes into the trail files by itself: every submission
is checked by `scripts/verify_submission.py`, and then a person looks at it, before a pack takes it.

## The submission file

A GPX 1.1 file, written by the apps ("Submit this trail") or by hand. The same file from the iPhone app, the Android
app and the website:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Switchback iOS 1.0" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:sb="https://github.com/CadeWardC/switchback/submission/1">
  <metadata>
    <name>Bluff Loop</name>
    <desc>Signed at the car park. Rocky near the top.</desc>
    <time>2026-11-12T15:04:05Z</time>
    <extensions>
      <sb:submission>
        <sb:kind>walked</sb:kind>          <!-- walked: recorded on foot. drawn: points placed on a map, not walked -->
        <sb:app>ios 1.0</sb:app>           <!-- ios, android or web, and the version -->
        <sb:loop>yes</sb:loop>             <!-- optional: yes when it ends where it starts -->
        <sb:access>public</sb:access>      <!-- the sender says it is open to the public on foot -->
      </sb:submission>
    </extensions>
  </metadata>
  <trk>
    <name>Bluff Loop</name>
    <trkseg>
      <trkpt lat="38.8712345" lon="-92.3212345"><ele>231.4</ele><time>2026-11-12T14:01:02Z</time></trkpt>
      …
    </trkseg>
  </trk>
</gpx>
```

A walked trail keeps the time (and height, when the phone has it) of every point: the checks need them. A drawn
trail has neither, and is never added on its own: it waits until someone walks it.

By sending a trail, the sender agrees it may be published in Switchback's open trail files under the
[Open Database License](https://opendatacommons.org/licenses/odbl/) and says they walked it themselves on land
open to the public. The apps say so before the file is made.

## Sending it

There is no server yet. The apps write the file and hand it to the share sheet, and offer to open a new issue on
GitHub. GitHub issues do not take `.gpx` attachments: zip the file, or rename it `.gpx.txt` (the checker reads
`.gpx`, `.gpx.txt`, `.gz` and `.zip`). A maintainer puts the file in `data/submissions/inbox/` and runs the
workflow "Check submitted trails".

## The checks

`python3 scripts/verify_submission.py <file.gpx> [--pack <region>.trails]` prints a report and exits 0 only when
every check passes.

| Check | Fails when |
| --- | --- |
| Readable | not GPX, or no track |
| Walked | no times on the points, or marked `drawn` |
| Long enough | under 400 m or under 30 points |
| On foot | the middle speed is over 9 km/h, or it is faster than 20 km/h for more than a twentieth of the way |
| Clean recording | jumps of more than 150 m between points, or more than a tenth of it is standing still noise |
| A real place | points outside the region's file, or all in one spot |
| Named | no name, or a placeholder ("trail", "my hike", "untitled") |
| New | 80% or more of it lies within 15 m of trails the pack already has (it is then offered as a confirmation of those trails instead) |

A file that passes is cleaned (stops and GPS scatter removed, simplified to 4 m, out-and-back walked twice folded
into one line) and written to `data/submissions/verified/<region>/<name>.geojson` with what was checked. Only the date of the walk
is kept, never its times. The pack builder (`scripts/enrich_trail_pack.py`) only reads that folder, only files
whose `"approved_by"` a maintainer has filled in, and skips a trail the pack has gained a line for since
(from OpenStreetMap or an official list). In the pack and the open files such a trail says where its line came
from: `switchback:origin` = `Community`.

## What a person still decides

The checks cannot know whether the land is open to the public, or whether the name is the one on the sign. The
maintainer looks at the line over aerial photos, the park's own map and the land's ownership before approving.
