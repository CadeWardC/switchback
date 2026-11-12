# Switchback for the web

The Switchback website: a map of hiking trails with a list, trail pages (length, climb, elevation chart, GPX),
route planning, walk recording, saved trails and settings. It is built to become the app on every platform: it
is phone-first, and everything it asks of the device goes through one small interface (`src/platform/`) so it can
be wrapped as an iPhone and Android app later without touching the screens.

Plain TypeScript with [Preact](https://preactjs.com) (a few kilobytes) and [MapLibre](https://maplibre.org) for the
map, built by [Vite](https://vite.dev). Everything is bundled: no scripts, fonts or icons are loaded from a CDN.

## Run it

```sh
cd web
npm install

# trail files for development (not kept in git): the list of regions and at least one region
mkdir -p public/data
gh release download trails-us -R CadeWardC/switchback -p regions.json -p missouri.trails -D public/data

npm run dev        # http://localhost:5173/#/@38.87,-92.32,12 is Rock Bridge, Missouri
npm test           # unit tests: the trail-file parser, polylines, the shared rules, GPX
npm run build      # type-checks, then writes the site to dist/
npm run preview    # serves dist/
```

Regions whose file is not in `public/data` show a "couldn't be loaded" note on the map; that is expected when
developing with one state.

## Deploy

`.github/workflows/pages.yml` builds the site, copies every trail file from the `trails-us` release into
`dist/data/`, and publishes it with GitHub Pages. It runs when `web/` changes on the default branch, once a week
(the trail files are rebuilt regularly), and by hand (Actions › Website (GitHub Pages) › Run workflow).

**One-time setting:** in the repository, Settings › Pages › Build and deployment › Source = **GitHub Actions**.
The site is then at `https://cadewardc.github.io/switchback/`.

All paths are relative (`base: './'`), so the site also works from any other folder or domain.

## Where the trails come from

Release downloads send no CORS headers, so a browser cannot fetch them from another address. The deploy job
copies them beside the site, and the site loads `./data/regions.json` and `./data/<region>.trails` from its own
address. A region's file is downloaded the first time the map shows it, kept in the browser's Cache Storage
(so later visits need no download, and it works offline), and only the 0.25° cells on screen are unpacked.

The file format and the rules shared with the apps (what counts as a hike, difficulty, estimated time) are in
`src/lib/pack.ts` and `src/lib/trail.ts`, mirroring `Switchback/Services/TrailPacks.swift` and
`Switchback/Model/Trail.swift`.

## The map

The base map is the app's own outdoor style on OpenFreeMap vector tiles. `scripts/make-styles.mjs` (run by
`npm run dev` and `npm run build`) writes `public/styles/light.json` and `dark.json` from
`../Switchback/Resources/switchback-style*.json`, leaving out the icons the iPhone app draws itself. If the
tile server can't be reached, trails draw on a plain background and the site says so; it tries again when the
connection or the tab comes back. Trailhead pins, numbered groups and region labels are painted on a canvas
(`src/map/images.ts`), so they need no map fonts.

## How it is laid out

| | |
| --- | --- |
| `src/tokens.ts` | Every design value: colours (light and dark), difficulty colours, radii, spacing, type sizes. The CSS custom properties are generated from it at startup; the map reads it too. |
| `src/platform/` | The device interface (`types.ts`) and the browser's version of it (`browser.ts`): location and recording, keep-awake, file export, small values, large files, links and directions, haptics, where trail files come from. A Capacitor version goes beside it and is picked in `index.ts`. |
| `src/lib/` | No browser needed: polylines, the trail-file parser, trail rules, geometry, units, GPX, submissions, storage. |
| `src/data.ts` | Loading and caching trail files, trails for a map view, one trail by id, search, "reset and download again". |
| `src/state.ts` | Shared state (signals): settings, the address bar, the map view, trails in view, filters, saved things. |
| `src/controller.ts` | Loads trails when the map moves; opens the trail named in the address. |
| `src/recorder.ts` | Recording a walk. |
| `src/map/` | The map, its layers and its canvas-painted pictures. |
| `src/ui/` | The screens: Explore, Trail, Record, Saved, Plan, Activity, Settings, and the submit dialog. |

Addresses: `#/` (map), `#/@lat,lon,zoom` (a place), `#/trail/<region>/<id>`, `#/record`, `#/saved`, `#/plan`,
`#/activity`, `#/activity/<id>`, `#/settings`.

## Submitting a trail

There is no server yet. "Submit this trail" on a recorded walk or a drawn route writes the submission file
described in `../docs/SUBMISSIONS.md` (the same GPX the phone apps write) and opens a prefilled issue on GitHub,
to which the sender attaches the file. All of it is in `src/lib/submit.ts`; replace `submitTrail` there to use
a real backend. Accounts, photos and reviews are not built.

## Things kept in the browser

Saved trails, planned routes, recorded walks and settings are in `localStorage` (keys starting `switchback:`);
trail files are in Cache Storage (`switchback-trail-files-v1`). Nothing is sent anywhere.
