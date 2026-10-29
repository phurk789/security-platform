// Fixed drawing order of every map, bottom to top. Each group after the basemap has an empty
// anchor ("slot") layer; a layer of group G goes in just below the slot of the group after G, so
// it lands on top of its own group whenever it is added. Basemaps therefore always stay under the
// operational overlays, and live markers always stay on top.
import type { LayerSpecification, Map as MlMap } from 'maplibre-gl';

export const LAYER_GROUPS = ['basemap', 'terrain', 'raster', 'vector', 'boundaries', 'routes', 'models', 'live'] as const;
export type LayerGroup = (typeof LAYER_GROUPS)[number];

/** The parts of a MapLibre map the layer helpers use (a fake implements it in tests). */
export type LayerHost = Pick<MlMap, 'getLayer' | 'addLayer' | 'getSource' | 'addSource' | 'setLayoutProperty' | 'getLayoutProperty'>;

export const slotId = (g: LayerGroup) => `slot-${g}`;

/** Adds the empty anchor layers once, in order (call before anything else is added). */
export function ensureSlots(map: LayerHost) {
  for (const g of LAYER_GROUPS.slice(1)) {
    if (!map.getLayer(slotId(g))) map.addLayer({ id: slotId(g), type: 'background', layout: { visibility: 'none' }, paint: { 'background-opacity': 0 } });
  }
}

/** The layer id a layer of this group is inserted before (undefined = on top of everything). */
export function beforeIdFor(group: LayerGroup): string | undefined {
  const i = LAYER_GROUPS.indexOf(group);
  return i < LAYER_GROUPS.length - 1 ? slotId(LAYER_GROUPS[i + 1]) : undefined;
}

/** Adds a layer to its group unless a layer with that id is already there. */
export function addLayerTo(map: LayerHost, group: LayerGroup, layer: LayerSpecification) {
  if (map.getLayer(layer.id)) return false;
  map.addLayer(layer, beforeIdFor(group));
  return true;
}
