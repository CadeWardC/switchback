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
        <sb:kind>walked</sb:kind>          <!-- walked: recorded on foot. placed: points put on a map (lidar, aerial photos), not walked -->
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

A walked trail keeps the time (and height, when the phone has it) of every point: the checks need them. A trail
placed on a map has neither, and has its own, stricter checks (below). `drawn` (a route someone planned) is read
as `placed`.

By sending a trail, the sender agrees it may be published in Switchback's open trail files under the
[Open Database License](https://opendatacommons.org/licenses/odbl/) and says they walked it themselves on land
open to the public. The apps say so before the file is made.

## Sending it

There is no server yet. The apps write the file and hand it to the share sheet, and offer to open a new issue on
GitHub. GitHub issues do not take `.gpx` attachments: zip the file, or rename it `.gpx.txt` (the checker reads
`.gpx`, `.gpx.txt`, `.gz` and `.zip`). A maintainer puts the file in `data/submissions/inbox/` and runs the
workflow "Check submitted trails".

## The checks

`python3 scripts/verify_submission.py <file.gpx> [--pack <region>.trails] [--wanted <region>.wanted.json]
[--out data/submissions]` prints a report and exits 0 when every check passes, 2 for needs verification, 1 otherwise.

| Check | Fails when |
| --- | --- |
| Readable | not GPX, or no track |
| Walked | no times on the points |
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

## Three outcomes

| Outcome | When | Where it goes |
| --- | --- | --- |
| Verified | every check passes | `data/submissions/verified/<region>/`, waiting for a maintainer's approval |
| Needs verification | likely a trail, but something is unsure: a walk whose recording is messy; or a trail placed on a map that has one of its two proofs (the park names it, or the lidar shows it) but not both | `data/submissions/needs-verification/<region>/`, with what is unsure |
| Not passed | anything else (too short, not on foot, no name, already in the file, a line with no proof at all) | nowhere |

A trail on the needs-verification list is not in the trail files. Each build publishes the list beside the trail
file as `<region>.needs-verification.geojson`, and the apps show those trails apart from the hikes, dashed, with
"I walked this". It gets into the trail files one of two ways: a maintainer accepts it (fills in `"approved_by"`
in its file), or someone walks it and sends that in, and the walk is verified and approved. Once the pack has a
line there, the entry drops off the list by itself.

## What a person still decides

The checks cannot know whether the land is open to the public, or whether the name is the one on the sign. The
maintainer looks at the line over aerial photos, the park's own map and the land's ownership before approving.

## Trails wanted

Each region's build also writes `<region>.wanted.json` (in the `trails-us` release beside the trail file): trails
that a park's own list or map names but the file has no line for, with the park, roughly where it is, and the
manager's page or map. These are the trails most worth walking and sending in.

## Placing a trail on a map without walking it

A trail can also be placed from public-domain USGS data: 1 m lidar (3DEP) and aerial photos (NAIP). The file is
the same GPX with `<sb:kind>placed</sb:kind>` and no times. The points can be few (one at each bend is enough)
and a few metres off, as long as they stay within about 15 m of the trail. What matters is that the trail is a
trail, so a placed trail must pass two more checks than a walked one:

| Check | Fails when |
| --- | --- |
| Named by the park | no trail of that name is on the region's wanted list near there (`--wanted <region>.wanted.json`) |
| The ground shows it | `scripts/lidar_trail.py` does not find a trail along the line in the lidar |

`lidar_trail.py` subtracts the shape of the hill from the lidar heights, which leaves a footpath as a groove or
bench a metre or two wide; finds the cheapest way along the line's corridor, where walking along a groove is cheap
(that is the line snapped to the ground, bends and all); and compares it with the same line pushed 50 m aside in
eight directions, where there should be no trail. Measured on Missouri trails that official lists confirm
(November 2026): it agreed with about four in ten real trails, whether given the mapped line or only a point
every 60 m, and with almost no ground where we have no trail (1 of 47 pieces, none of 11 whole lines). So when it
agrees that is strong evidence, and when it does not the trail simply has to be walked. An old road bed, a ditch
or an ATV track leaves a groove too, which is why the park's own list must name the trail, and why a maintainer
still approves each one.

In the packs a placed trail carries `switchback:origin` = `USGS lidar` and `switchback:unwalked` = `yes`, and its
description says nobody has sent in a walk of it yet.

Lines are never traced from Google Maps, Apple Maps or a park's drawn map: their terms do not allow it, and
neither does OpenStreetMap. Esri World Imagery and Bing imagery may be traced only into OpenStreetMap itself
(the trail then reaches the packs at the next build): the apps link to OpenStreetMap's editor at the spot.
GPS traces already published on OpenStreetMap confirm paths that are mapped (`scripts/gps_traces.py`).
