// Basemaps: the imagery under everything else. One raster source + layer per basemap, all added
// once and only one visible (hidden raster layers fetch no tiles). The choice is kept in
// localStorage, so every page and every reload shows the same one.
//
// Licensing (see docs/MAPS.md): every provider here is used with its attribution, without keys.
// OpenStreetMap's own tile servers are for light use only; Esri's are free with attribution but
// commercial production use needs Esri's terms (ArcGIS Location Platform). Google imagery is NOT
// here on purpose: it needs a licence and a key, which must stay on the server (add it as a
// server-proxied provider when there is one).
import type { RasterSourceSpecification } from 'maplibre-gl';
import { addLayerTo, type LayerHost } from './layerOrder';

export interface Basemap {
  id: string;
  label: string;
  tiles: string[];
  attribution: string;
  maxzoom: number;
  /** Reference labels drawn over the imagery (satellite + labels). */
  labels?: { tiles: string[]; attribution: string; maxzoom: number };
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const ESRI_IMAGERY_ATTR = 'Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> · Esri, Maxar, Earthstar Geographics, and the GIS User Community';

export const BASEMAPS: readonly Basemap[] = [
  {
    id: 'esri-imagery',
    label: 'Satellite (Esri World Imagery)',
    tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
    attribution: ESRI_IMAGERY_ATTR,
    maxzoom: 19,
  },
  {
    id: 'esri-imagery-labels',
    label: 'Satellite + labels',
    tiles: [`${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`],
    attribution: ESRI_IMAGERY_ATTR,
    maxzoom: 19,
    labels: {
      tiles: [`${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`],
      attribution: 'Esri, HERE, Garmin, © OpenStreetMap contributors',
      maxzoom: 19,
    },
  },
  {
    id: 's2cloudless',
    label: 'Satellite (Sentinel-2 cloudless, 10 m)',
    tiles: ['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg'],
    attribution:
      '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2016 &amp; 2017)',
    maxzoom: 15,
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    maxzoom: 19,
  },
  {
    id: 'esri-topo',
    label: 'Terrain (Esri World Topo)',
    tiles: [`${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`],
    attribution: 'Powered by <a href="https://www.esri.com" target="_blank" rel="noopener">Esri</a> · Esri, HERE, Garmin, Intermap, USGS, FAO, NPS, © OpenStreetMap contributors, and the GIS User Community',
    maxzoom: 19,
  },
];

export const DEFAULT_BASEMAP = 'esri-imagery';
export const BASEMAP_STORAGE_KEY = 'ps-basemap';

export const basemapLayerId = (id: string) => `basemap-${id}`;
export const basemapLabelsLayerId = (id: string) => `basemap-${id}-labels`;

const find = (id: string) => BASEMAPS.find((b) => b.id === id);

/** The basemap to show: the viewer's last choice when it still exists, else the default. */
export function getInitialBasemap(): string {
  try {
    const v = globalThis.localStorage?.getItem(BASEMAP_STORAGE_KEY);
    if (v && find(v)) return v;
  } catch {
    /* storage blocked: use the default */
  }
  return DEFAULT_BASEMAP;
}

function saveBasemap(id: string) {
  try {
    globalThis.localStorage?.setItem(BASEMAP_STORAGE_KEY, id);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

const raster = (tiles: string[], attribution: string, maxzoom: number): RasterSourceSpecification => ({ type: 'raster', tiles, tileSize: 256, attribution, maxzoom });

/**
 * Adds every basemap as a raster source + layer (at the bottom of the layer order), with only
 * `initialId` visible. Safe to call again: nothing is added twice.
 */
export function addBasemapLayers(map: LayerHost, initialId: string) {
  const show = find(initialId) ? initialId : DEFAULT_BASEMAP;
  for (const b of BASEMAPS) {
    const visibility = b.id === show ? 'visible' : 'none';
    if (!map.getSource(basemapLayerId(b.id))) map.addSource(basemapLayerId(b.id), raster(b.tiles, b.attribution, b.maxzoom));
    addLayerTo(map, 'basemap', { id: basemapLayerId(b.id), type: 'raster', source: basemapLayerId(b.id), layout: { visibility } });
    if (b.labels) {
      if (!map.getSource(basemapLabelsLayerId(b.id))) map.addSource(basemapLabelsLayerId(b.id), raster(b.labels.tiles, b.labels.attribution, b.labels.maxzoom));
      addLayerTo(map, 'basemap', { id: basemapLabelsLayerId(b.id), type: 'raster', source: basemapLabelsLayerId(b.id), layout: { visibility } });
    }
  }
  return show;
}

/** Shows one basemap, hides the rest, and remembers the choice for every page. */
export function switchBasemap(map: LayerHost, id: string) {
  if (!find(id)) return false;
  for (const b of BASEMAPS) {
    const v = b.id === id ? 'visible' : 'none';
    if (map.getLayer(basemapLayerId(b.id))) map.setLayoutProperty(basemapLayerId(b.id), 'visibility', v);
    if (b.labels && map.getLayer(basemapLabelsLayerId(b.id))) map.setLayoutProperty(basemapLabelsLayerId(b.id), 'visibility', v);
  }
  saveBasemap(id);
  return true;
}

/** The basemap visible on this map now (undefined before the layers are added). */
export function currentBasemap(map: LayerHost): string | undefined {
  return BASEMAPS.find((b) => map.getLayer(basemapLayerId(b.id)) && map.getLayoutProperty(basemapLayerId(b.id), 'visibility') !== 'none')?.id;
}
