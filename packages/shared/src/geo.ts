// Site grid ↔ WGS 84. The platform works in a local site grid (metres, x east, y south,
// origin at the site's north-west corner). Real devices report latitude/longitude.
// Each site is anchored by the WGS 84 position of its origin and the grid's rotation.

export interface GeoAnchor {
  /** Latitude of the site grid origin (x=0, y=0), degrees. */
  originLat: number;
  /** Longitude of the site grid origin, degrees. */
  originLon: number;
  /** Clockwise rotation of the grid's +x axis from true east, degrees. 0 = grid aligned to north. */
  rotationDeg?: number;
}

const R = 6_378_137; // WGS 84 equatorial radius, metres

/**
 * Local equirectangular projection. Error is well under 1 cm over a few kilometres,
 * which is far below GNSS accuracy for this use.
 */
export function siteToGeo(a: GeoAnchor, p: { x: number; y: number }) {
  const th = ((a.rotationDeg ?? 0) * Math.PI) / 180;
  // site +x = east, +y = south → east/north metres, then rotate by the grid rotation
  const e0 = p.x;
  const n0 = -p.y;
  const east = e0 * Math.cos(th) + n0 * Math.sin(th);
  const north = -e0 * Math.sin(th) + n0 * Math.cos(th);
  const lat = a.originLat + (north / R) * (180 / Math.PI);
  const lon = a.originLon + (east / (R * Math.cos((a.originLat * Math.PI) / 180))) * (180 / Math.PI);
  return { lat, lon };
}

export function geoToSite(a: GeoAnchor, g: { lat: number; lon: number }) {
  const th = ((a.rotationDeg ?? 0) * Math.PI) / 180;
  const north = ((g.lat - a.originLat) * Math.PI * R) / 180;
  const east = ((g.lon - a.originLon) * Math.PI * R * Math.cos((a.originLat * Math.PI) / 180)) / 180;
  // inverse rotation
  const e0 = east * Math.cos(th) - north * Math.sin(th);
  const n0 = east * Math.sin(th) + north * Math.cos(th);
  return { x: e0, y: -n0 };
}

/** Convert a compass heading (deg from true north) to the site grid's heading. */
export function headingToSite(a: GeoAnchor, headingTrueDeg: number) {
  return (((headingTrueDeg - (a.rotationDeg ?? 0)) % 360) + 360) % 360;
}
