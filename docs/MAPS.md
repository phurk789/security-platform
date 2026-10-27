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

No environment variables are needed in phase 1: every basemap is keyless.

## Basemap licensing

| Basemap | Terms |
|---|---|
| Esri World Imagery, Imagery + labels, World Topo | Free with the attribution shown. Commercial production use needs Esri's terms (ArcGIS Location Platform account). |
| Sentinel-2 cloudless 2016 (EOX) | CC BY 4.0 with attribution. Later years (2018+) are CC BY-NC-SA: do not switch the layer without checking. |
| OpenStreetMap (tile.openstreetmap.org) | Light use only, attribution required ([tile usage policy](https://operations.osmfoundation.org/policies/tiles/)). Production: own tile server or a provider. |
| Google imagery | Not included. Needs a licence and a key, and the key must stay on the server (a server-proxied provider). The drawn twin's photorealistic option (`VITE_GOOGLE_MAPS_API_KEY`) remains for the offline demo build only. |

## Limits (phase 1)

- Terrain 3D, 3D Tiles, the operations and cockpit maps: phases 2 and 3.
- Floor plans of buildings (indoor view) are still in the drawn twin only.
- Basemap tiles come straight from the providers: a console without internet shows no imagery
  (overlays still draw).
- Labels for many objects can overlap; there is no label collision handling yet.
