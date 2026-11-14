# Download the trails

Every trail in Switchback's dataset, as open files anyone can use. One file per US state and Canadian province, rebuilt whenever the dataset is (at least monthly).

All files are in the [`trails-open` release](https://github.com/CadeWardC/switchback/releases/tag/trails-open).

## Format

GeoJSON, gzipped. Unzip with `gunzip`, 7-Zip or similar; open in QGIS, [geojson.io](https://geojson.io), or convert with GDAL (`ogr2ogr trails.gpkg missouri.geojson`).

Each feature is one trail: a `MultiLineString` (longitude, latitude) with these properties.

| Property | Meaning |
|---|---|
| `id`, `name`, `length_m` | The trail, and the length of its main line in metres |
| `line_from` | Where the line came from: `OpenStreetMap`, `Forest Service`, `National Park Service` or `Community` (walked and sent in by a Switchback user, checked and approved) |
| `licence` | The licence of that line |
| `osm` | The OpenStreetMap relation or way, for OpenStreetMap lines |
| `area`, `system` | The park or forest, and the trail system it belongs to |
| `official_source`, `official_name`, `official_number`, `official_match`, `official_page`, `official_miles` | What an official list or park map says about it, when one confirms it |
| `hike` | `true` when the app lists it as a hike (not a fragment, side trail, road walk or informal path) |
| `informal`, `informal_reason`, `unnamed`, `side_trail`, `road_walk`, `shared_with_bikes` | Present when true |
| `climb_m`, `descent_m`, `lowest_m`, `highest_m` | Elevation along the main line |
| `difficulty`, `minutes` | `easy`, `moderate`, `hard` or `veryHard`, and the walking time at an easy pace |

## Licence

Most lines come from OpenStreetMap: © OpenStreetMap contributors, [Open Database License](https://opendatacommons.org/licenses/odbl/). If you publish something made from them, credit OpenStreetMap and keep the data open under the same licence.

Lines marked `National Park Service` are U.S. federal data in the public domain. Lines marked `Forest Service` are from the USDA Forest Service's National Forest System Trails (listed as CC BY 4.0 on data.gov): credit the USDA Forest Service. See [DATA_LICENSE.md](../DATA_LICENSE.md).

## United States

| State | File |
|---|---|
| Alabama | [alabama.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/alabama.geojson.gz) |
| Alaska | [alaska.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/alaska.geojson.gz) |
| Arizona | [arizona.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/arizona.geojson.gz) |
| Arkansas | [arkansas.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/arkansas.geojson.gz) |
| California | [california.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/california.geojson.gz) |
| Colorado | [colorado.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/colorado.geojson.gz) |
| Connecticut | [connecticut.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/connecticut.geojson.gz) |
| Delaware | [delaware.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/delaware.geojson.gz) |
| District of Columbia | [district-of-columbia.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/district-of-columbia.geojson.gz) |
| Florida | [florida.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/florida.geojson.gz) |
| Georgia | [georgia.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/georgia.geojson.gz) |
| Hawaii | [hawaii.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/hawaii.geojson.gz) |
| Idaho | [idaho.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/idaho.geojson.gz) |
| Illinois | [illinois.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/illinois.geojson.gz) |
| Indiana | [indiana.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/indiana.geojson.gz) |
| Iowa | [iowa.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/iowa.geojson.gz) |
| Kansas | [kansas.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/kansas.geojson.gz) |
| Kentucky | [kentucky.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/kentucky.geojson.gz) |
| Louisiana | [louisiana.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/louisiana.geojson.gz) |
| Maine | [maine.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/maine.geojson.gz) |
| Maryland | [maryland.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/maryland.geojson.gz) |
| Massachusetts | [massachusetts.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/massachusetts.geojson.gz) |
| Michigan | [michigan.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/michigan.geojson.gz) |
| Minnesota | [minnesota.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/minnesota.geojson.gz) |
| Mississippi | [mississippi.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/mississippi.geojson.gz) |
| Missouri | [missouri.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/missouri.geojson.gz) |
| Montana | [montana.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/montana.geojson.gz) |
| Nebraska | [nebraska.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/nebraska.geojson.gz) |
| Nevada | [nevada.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/nevada.geojson.gz) |
| New Hampshire | [new-hampshire.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/new-hampshire.geojson.gz) |
| New Jersey | [new-jersey.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/new-jersey.geojson.gz) |
| New Mexico | [new-mexico.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/new-mexico.geojson.gz) |
| New York | [new-york.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/new-york.geojson.gz) |
| North Carolina | [north-carolina.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/north-carolina.geojson.gz) |
| North Dakota | [north-dakota.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/north-dakota.geojson.gz) |
| Ohio | [ohio.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ohio.geojson.gz) |
| Oklahoma | [oklahoma.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/oklahoma.geojson.gz) |
| Oregon | [oregon.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/oregon.geojson.gz) |
| Pennsylvania | [pennsylvania.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/pennsylvania.geojson.gz) |
| Puerto Rico | [puerto-rico.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/puerto-rico.geojson.gz) |
| Rhode Island | [rhode-island.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/rhode-island.geojson.gz) |
| South Carolina | [south-carolina.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/south-carolina.geojson.gz) |
| South Dakota | [south-dakota.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/south-dakota.geojson.gz) |
| Tennessee | [tennessee.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/tennessee.geojson.gz) |
| Texas | [texas.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/texas.geojson.gz) |
| Utah | [utah.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/utah.geojson.gz) |
| Vermont | [vermont.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/vermont.geojson.gz) |
| Virginia | [virginia.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/virginia.geojson.gz) |
| Washington | [washington.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/washington.geojson.gz) |
| West Virginia | [west-virginia.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/west-virginia.geojson.gz) |
| Wisconsin | [wisconsin.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/wisconsin.geojson.gz) |
| Wyoming | [wyoming.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/wyoming.geojson.gz) |

## Canada

| Province or territory | File |
|---|---|
| Alberta | [ca-alberta.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-alberta.geojson.gz) |
| British Columbia | [ca-british-columbia.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-british-columbia.geojson.gz) |
| Manitoba | [ca-manitoba.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-manitoba.geojson.gz) |
| New Brunswick | [ca-new-brunswick.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-new-brunswick.geojson.gz) |
| Newfoundland and Labrador | [ca-newfoundland-and-labrador.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-newfoundland-and-labrador.geojson.gz) |
| Northwest Territories | [ca-northwest-territories.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-northwest-territories.geojson.gz) |
| Nova Scotia | [ca-nova-scotia.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-nova-scotia.geojson.gz) |
| Nunavut | [ca-nunavut.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-nunavut.geojson.gz) |
| Ontario | [ca-ontario.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-ontario.geojson.gz) |
| Prince Edward Island | [ca-prince-edward-island.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-prince-edward-island.geojson.gz) |
| Quebec | [ca-quebec.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-quebec.geojson.gz) |
| Saskatchewan | [ca-saskatchewan.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-saskatchewan.geojson.gz) |
| Yukon | [ca-yukon.geojson.gz](https://github.com/CadeWardC/switchback/releases/download/trails-open/ca-yukon.geojson.gz) |

## The app's own files

The app reads a compact format instead (`<area>.trails`, in the [`trails-us` release](https://github.com/CadeWardC/switchback/releases/tag/trails-us)); `scripts/build_trail_pack.py` describes it.
