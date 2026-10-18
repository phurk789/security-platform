# Photorealistic real-site view (Google Map Tiles API)

The 3D twin can show Google's photorealistic 3D tiles of the real site instead of the drawn
scenery. Devices, routes, zones, geofences and indoor floor plans keep drawing on top.

- **Turn on:** set `VITE_GOOGLE_MAPS_API_KEY` at build time (Vercel project env var). The key needs
  the **Map Tiles API** enabled; restrict it to the site's web origin. Without a key the twin is
  unchanged and the tiles library is never loaded.
- **Where:** the site's WGS 84 anchor, `DEMO_GEO` in `packages/shared/src/site.ts`. The demo site
  centre is 13.4350, 101.0300 (Amata City Chonburi, approximate). Fine-tune in the browser with
  `?site=<lat>,<lon>[,<rotationDeg>]` (remembered per browser; `?site=reset` undoes it).
- **Code:** `apps/web/src/twin/realTiles.ts` (tiles, orientation, grounding, unlit/night tint),
  `apps/web/src/twin/realKey.ts` (key check), wired in `apps/web/src/components/Twin3D.tsx`.
  `TwinWorld.setRealTiles()` hides the drawn scenery and building models.
- **Attribution:** Google and data-provider credits show bottom-right while tiles are on (required).

## Next step

Align the demo layout to the real place: open the twin with a key, compare against the tiles, then
move building footprints (`BUILDINGS` in `site.ts`), camera views, routes, fences and the UGV-04
warehouse (Building 5 floor plan in `packages/shared/src/indoor.ts`) onto the real buildings.
Testing from a cloud session needs a key without a website restriction and `tile.googleapis.com`
in the environment's allowed domains.
