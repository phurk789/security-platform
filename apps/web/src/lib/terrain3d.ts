// The one globe style every map in the console starts from (main map, operations, cockpit).
// Basemap imagery = colour of the ground (basemaps.ts) · Terrain-RGB = height of the ground
// (phase 2) · MapLibre = camera, globe and renderer. Pages never declare their own style.
import type { StyleSpecification } from 'maplibre-gl';

/** Steepest camera tilt, degrees: almost level with the horizon. */
export const MAX_PITCH = 89;

/** Sky and fog seen at the horizon when the camera is tilted, and around the globe when zoomed out. */
export const SKY = {
  'sky-color': '#9fbdda',
  'sky-horizon-blend': 0.5,
  'horizon-color': '#e7eef5',
  'horizon-fog-blend': 0.9,
  'fog-color': '#dbe3ec',
  'fog-ground-blend': 0.75,
} as const;

/**
 * Empty globe style: zoomed out the world is a sphere, zoomed in MapLibre blends to a flat
 * (Mercator) view for work at site level. Sources and layers are added by basemaps.ts and
 * overlays.ts, in their fixed order.
 */
export function baseMapStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [],
    projection: { type: 'globe' },
    sky: { ...SKY },
  } as StyleSpecification;
}
