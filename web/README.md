# Switchback: the app, for the web, iPhone and Android

One app for all three: a website (GitHub Pages), and the same website wrapped with
[Capacitor](https://capacitorjs.com) as an iPhone app (`ios/`) and an Android app (`android/`). It shows hiking
trails on a map with a list, trail pages (length, climb, elevation chart, GPX), follows a trail while recording a
hike, plans routes, and keeps trails, hikes and the map on the device so it works with no signal.

Everything the app asks of the device goes through one small interface (`src/platform/`): the browser's version
and the phone apps' version sit side by side, and no screen knows which one it has.

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
npm test           # unit tests: trail files, polylines, shared rules, GPX, recording, following, filters, map saving
npm run build      # type-checks, then writes the site to dist/
npm run preview    # serves dist/
```

Regions whose file is not in `public/data` show a "couldn't be loaded" note on the map; that is expected when
developing with one state.

## The phone apps

```sh
npm run build:app          # builds the site, leaves out the development trail files, copies it into android/ and ios/
cd android && ./gradlew assembleDebug      # app/build/outputs/apk/debug/app-debug.apk (needs the Android SDK and Java 21)
npx cap open ios           # on a Mac: opens ios/App/App.xcodeproj in Xcode
```

`android/` and `ios/` are ordinary Android Studio and Xcode projects (iOS uses Swift packages, no CocoaPods), so
an extension target (a widget, a Live Activity) can be added to the Xcode project later. The copied web files
(`android/app/src/main/assets/public`, `ios/App/App/public`) are not in git: `npx cap sync` puts them there.

Two workflows build them on every push that touches `web/`:
`.github/workflows/build-android-apk.yml` (a debug APK, release `switchback-android-build-N`) and
`.github/workflows/build-web-ios-ipa.yml` (an unsigned IPA on a Mac runner, release `switchback-app-build-N`).

What differs in the apps (all in `src/platform/capacitor.ts`):

| | Website | Phone apps |
| --- | --- | --- |
| Trail files | copied beside the site by the deploy job; kept in Cache Storage | downloaded straight from the GitHub release; kept as files |
| Recording | only while the page is open (screen kept awake) | a background location service: carries on with the screen off (Android shows a notification) |
| Your hikes, routes, saved trails | IndexedDB | files in the app's own folder |
| Settings | localStorage | Preferences |
| GPX and submission files | a download | the share sheet |
| Links, directions | a new tab | the system browser, the maps app |
| Android back | (the browser's) | closes a dialog, lowers the sheet, goes back a page, then leaves |

App icon and splash screen come from `assets/` (made from the iPhone app's icon); regenerate with
`npx capacitor-assets generate --ios --android`.

**Before a store release** the owner still has to: set up signing (an Apple developer team in Xcode; a release
keystore for Android), raise `versionCode`/`MARKETING_VERSION`, and fill in the stores' location-permission
declarations (the app uses location in the background only while a hike is being recorded).

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

## Offline

Nothing to manage. The app itself opens with no connection (a service worker on the web, `scripts/make-sw.mjs`;
the apps carry their files). A region's trail file stays on the device once the map has shown it. Every map tile,
font range and terrain tile ever loaded is kept (`platform.tiles`, bounded, the longest-unused go first) and used
before the network, so anywhere you have looked works offline; past zoom 14 the map enlarges what it has. The map
around where you are, and around any trail you open, save or start, is fetched quietly in the background
(`src/offline.ts`, `src/map/tilesource.ts`): three connections at a time, at most 12,000 tiles a job, backing off
on errors, and larger jobs wait for Wi-Fi unless "Download maps over cellular" is on. "Save this area" on the map
does the same for what is in view. Recording and following a trail use GPS only.

`src/map/tilesource.ts` is also where a second source will go: one base-map file per state (PMTiles), looked in
before the tile store. It is a marked stub today.

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
| `src/filters.ts` | The filters and sort order as one small store, with a plain-words summary ("Loops under 5 mi, closest first"). Any layout can read and write it. |
| `src/data.ts` | Loading and caching trail files, trails for a map view, one trail by id, search, the "wanted" and "needs verification" lists, "reset and download again". |
| `src/offline.ts`, `src/map/tilesource.ts` | Keeping the map on the device, and saving areas ahead. |
| `src/lib/track.ts`, `src/lib/follow.ts` | The rules for recording (fixes carry their own time, so a late batch is handled) and for following a trail (distance and climb left, arrival, sunset). |
| `src/state.ts` | Shared state (signals): settings, the address bar, the map view, trails in view, filters, saved things. |
| `src/controller.ts` | Loads trails when the map moves; opens the trail named in the address. |
| `src/recorder.ts` | Recording a walk. |
| `src/map/` | The map, its layers and its canvas-painted pictures. |
| `src/ui/` | The screens: Explore, Trail, Record, Saved, Plan, Activity, Settings, Help map trails, and the submit dialog. `ResultsList` and `TrailView` take data and callbacks only, so another layout can replace them. |

Addresses: `#/` (map), `#/@lat,lon,zoom` (a place), `#/trail/<region>/<id>`, `#/record`, `#/saved`, `#/plan`,
`#/activity`, `#/activity/<id>`, `#/settings`, `#/help`.

## Submitting a trail

There is no server yet. "Submit this trail" on a recorded walk or a drawn route writes the submission file
described in `../docs/SUBMISSIONS.md` (the same GPX the phone apps write) and opens a prefilled issue on GitHub,
to which the sender attaches the file. All of it is in `src/lib/submit.ts`; replace `submitTrail` there to use
a real backend. Accounts, photos and reviews are not built.

## Things kept on the device

Settings are small values (`localStorage` keys starting `switchback:` on the web; Preferences in the apps). Saved
trails, planned routes and recorded hikes are documents (IndexedDB database `switchback` on the web; files in the
apps); a recording in progress is a log that grows a line at a time, so a closed app loses nothing. Trail files
are in Cache Storage (`switchback-trail-files-v1`) on the web and files in the apps; map tiles are in the
IndexedDB database `switchback-tiles`. Nothing is sent anywhere.
