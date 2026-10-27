# Maps (MapLibre)

The console's maps are built from one shared core in `apps/web/src/lib/`. Phase 1 (27 Oct 2026):
the main map on the overview page. Phase 2 adds terrain (Terrain-RGB from the server), phase 3
OGC 3D Tiles (deck.gl) and the operations / cockpit maps.

```
gateway: GNSS lat/lon ──geoToSite(anchor)──► site metres ──WebSocket──► server ──► console state
console: site metres ──siteToGeo(anchor)──► lat/lon ──GeoJSON setData──► MapLibre layers
browser ◄── basemap tiles (Esri / EOX / OSM, direct, no keys)

Basemap imagery = colour of the ground      (lib/basemaps.ts)
Terrain-RGB     = height of the ground      (phase 2: GET /api/v1/terrain/tiles/:z/:x/:y)
MapLibre        = camera, globe, renderer   (lib/standardMap.ts, lib/terrain3d.ts)
```

The site anchor (`AppState.geo`, from the server's site record) is the same one gateways use, and
the conversion is an exact inverse, so a device is drawn at the WGS 84 point its GNSS reported.

## Files

| File | What |
|---|---|
| `lib/terrain3d.ts` | `baseMapStyle()`: the only style (globe projection, sky/fog), `MAX_PITCH` 89° |
| `lib/basemaps.ts` | Basemap registry, `getInitialBasemap()`, `addBasemapLayers()`, `switchBasemap()` (choice kept in `localStorage` `ps-basemap`) |
| `lib/basemapControl.ts` | Basemap picker control |
| `lib/layerOrder.ts` | Fixed layer order with anchor ("slot") layers: basemap → terrain → raster → vector → boundaries → routes → models → live |
| `lib/orbitControls.ts` | Middle-drag or Ctrl/Cmd + drag: bearing (sideways) and pitch (up/down, 0–89°); right button left free |
| `lib/standardMap.ts` | `createStandardMap()`: the only place a map is created (controls, limits, orbit, cleanup) |
| `lib/overlays.ts` | GeoJSON sources and layers: site boundary, geofences, sample plan, trails, routes, incidents, devices |
| `lib/mapImages.ts` | Heading arrow and text labels drawn on a canvas (no glyph server; Thai uses the system font) |
| `components/RealMap.tsx` | The overview map (lifecycle, clicks, layer menu, redraw at most every 250 ms) |
| `components/MainMap.tsx` | Real map when connected to a server; drawn twin in the offline demo build |

Devices without a position fix (`Device.noFix`: GNSS without a 3D fix, or never reported) are not
drawn; the map shows a chip naming them instead. The gateway sends samples without `pos` then.

## Run locally

```powershell
npm run dev -w @13store/server   # demo mode on :8080, simulated vehicles
npm run dev -w @13store/web      # console on :5173 (proxies /api to :8080)
```

Sign in with a demo account; the overview shows the real map. In the browser console
`__psMaps.size` (dev builds only) is the number of live maps: 0 after leaving the page, 1 on it.

The built-in basemaps need no environment variables. Google basemaps need `GOOGLE_MAPS_API_KEY`
on the server (see below).

## Basemap licensing

| Basemap | Terms |
|---|---|
| Esri World Imagery, Imagery + labels, World Topo | Free with the attribution shown. Commercial production use needs Esri's terms (ArcGIS Location Platform account). |
| Sentinel-2 cloudless 2016 (EOX) | CC BY 4.0 with attribution. Later years (2018+) are CC BY-NC-SA: do not switch the layer without checking. |
| OpenStreetMap (tile.openstreetmap.org) | Light use only, attribution required ([tile usage policy](https://operations.osmfoundation.org/policies/tiles/)). Production: own tile server or a provider. |
| Google "· Google" entries (satellite, satellite + labels, terrain) | Google's XYZ tiles straight from `mt0–mt3.google.com/vt/lyrs=s\|y\|p`, the way LCOT does it: no key, `© Google` attribution. **Not an API Google licenses for this use**: Google can throttle or block it at any time, and a customer audit may flag it. Kept by the owner's decision (27 Oct 2026); never the default basemap. For a delivered system switch to the official entries below. |
| Google "(official API)" entries | **Map Tiles API** through the server (below). Billed by Google per tile request beyond a free monthly allowance; needs the attribution the console shows. The drawn twin's photorealistic option (`VITE_GOOGLE_MAPS_API_KEY`) remains for the offline demo build only. |

## Google basemaps (server-proxied)

Off until the server has a key. With `GOOGLE_MAPS_API_KEY` set, the basemap picker also offers
**Google satellite**, **satellite + labels** and **roads**, marked "(official API)" (Thai labels).

```
browser ──/api/v1/basemaps/google-api-hybrid/tiles/{z}/{x}/{y} + session token──► platform server
platform server ──createSession (cached ~2 weeks) / 2dtiles + API key──► tile.googleapis.com
browser ◄── /api/v1/basemaps/:id/attribution (viewport copyright) ── shown as "Google Maps · ©…"
```

- The key stays on the server; browsers send only their session token (to our own origin).
- Every tile request needs a signed-in user (the API's normal sign-in check).
- One Google session per map style is shared by all viewers and renewed before it expires (or
  when Google rejects it). Google's `Cache-Control` is passed on unchanged; the server stores no tiles.
- Required attribution: the "Google Maps" mark and the copyright for the area on screen, in their
  own box at the bottom right, apart from other providers.

To switch it on (Google Cloud console, then the server):

1. A Google Cloud project with **billing** and the **Map Tiles API** enabled; accept the Google Maps
   Platform terms.
2. An API key restricted to **Map Tiles API** and, if possible, to the server's public IP address
   (the key is only used from the server).
3. `GOOGLE_MAPS_API_KEY=<key>` in the server's environment (on .13: `.env.server`), then restart the server.

| Variable | Default | What |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | (unset: no Google basemaps) | Map Tiles API key, server only |
| `GOOGLE_TILES_URL` | `https://tile.googleapis.com` | Only for tests (a fake Google) |

## Limits (phase 1)

- Terrain 3D, 3D Tiles, the operations and cockpit maps: phases 2 and 3.
- Floor plans of buildings (indoor view) are still in the drawn twin only.
- Basemap tiles come straight from the providers: a console without internet shows no imagery
  (overlays still draw).
- Labels for many objects can overlap; there is no label collision handling yet.
