# GIS: WGS 84 anchor, latitude/longitude, GeoJSON

The platform plans, draws and reasons in a **local site grid**: metres, origin at the north-west
corner of the site drawing, +x east, +y south. That is what makes the twin, the route planner
and the geofences fast and exact. Everything that leaves the platform, or comes from a real
device, is in **WGS 84** (EPSG:4326, the GNSS datum). One anchor ties the two together.

## The anchor

| Field                    | Meaning                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `originLat`, `originLon` | WGS 84 position of the grid origin (x = 0, y = 0)                                      |
| `rotationDeg`            | How far the drawing's +x axis turns clockwise from true east (0 = drawing is north-up) |

The projection is a local equirectangular one: error well under 1 cm across a few kilometres, far
below GNSS accuracy. The demo site is anchored to a placeholder in central Bangkok
(`DEMO_GEO` in `packages/shared/src/site.ts`); a real site gets its anchor from the survey or by
matching two known points in the GIS and the drawing.

- Set it under **Administration → Site & GIS** (admin, step-up) or `PATCH /sites/{id}/geo`.
  The change is audited (`site.geo`) and pushed to every open console.
- The **gateway** uses the same anchor to convert GNSS fixes from vehicles (`geo` in the site
  config, `apps/gateway/config/*.json`). It sends its anchor when it connects; if it is more than
  2 m or 0.5° off the site's, the server writes an audit entry `gateway.geo_mismatch` and shows a
  warning in the console, so a copy-paste error cannot quietly shift every vehicle.

## In the console

- **Incident details**, **device details** and the **map callout** show each position as grid
  metres and as latitude/longitude; the lat/lon is a link that opens the point in a maps app for a
  responder on a phone.
- The map footer names the anchor in use.
- Offline (booth file) the demo anchor is used and labelled as such.

## GeoJSON out

`GET /sites/{id}/geojson?layers=…&download=1` → one RFC 7946 FeatureCollection, coordinates in
`[longitude, latitude]`, CRS84. Layers: `site`, `buildings`, `zones`, `entrances`, `hydrants`,
`geofences`, `devices`, `incidents` (open ones; administrators get none, like the API).
Every feature carries its id, the local grid `x`/`y` and the data label (SIMULATION / LIVE …).
A download is audited (`site.export`). Administration → **Export GeoJSON** does the same.

Open it in QGIS (_Layer → Add Layer → Add Vector Layer_), ArcGIS, or push it to a city platform;
`fc.site.anchor` lets a reader rebuild the grid if it needs to.

## GeoJSON in

`POST /geofences/import` (supervisor or admin; Administration → **Import geofences (GeoJSON)**)
takes a FeatureCollection of polygons drawn in the GIS and turns them into geofences:

| Property           | Used as                                                                                         |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `name` (or `id`)   | Zone name; a zone with the same name is **updated**, so re-importing a layer does not duplicate |
| `kind`             | `keep_out` (default), `caution`, `no_fly` (`keep-out` and `Keep Out` are accepted)              |
| `appliesTo`        | `["ugv","uav"]` or `"ugv,uav"`; default both, `uav` only for no-fly                             |
| `reason`, `active` | Shown to operators; `active: false` imports a disabled zone                                     |

Holes are ignored, a MultiPolygon becomes one zone per part, 30 vertices per zone, 100 zones per
import, 300 per site. Features that are not polygons, have an unknown kind or do not touch the
site (anchor wrong, or `[lat, lon]` instead of `[lon, lat]`) are skipped and listed in the answer.

## API

| Call                      | Who               | Notes                                                     |
| ------------------------- | ----------------- | --------------------------------------------------------- |
| `GET /sites/{id}`         | any member        | `geometry.geo` is the anchor; `default` = the user's site |
| `PATCH /sites/{id}/geo`   | admin (step-up)   | `{ originLat, originLon, rotationDeg }`                   |
| `GET /sites/{id}/geojson` | any member        | `?layers=a,b&download=1`                                  |
| `POST /geofences/import`  | supervisor, admin | FeatureCollection → `{ imported, geofences, errors }`     |

Shared code: `packages/shared/src/geo.ts` (transform), `packages/shared/src/geojson.ts`
(export/import). Tests: `apps/server/test/gis.test.ts`.
