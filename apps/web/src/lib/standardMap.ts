// The only place a map is created. Every map surface (main map, operations, cockpit) gets the same
// globe style, controls, camera limits and orbit gesture; pages differ only in camera values
// (centre, zoom, pitch) and, from phase 2, whether terrain starts on.
import maplibregl, { type Map as MlMap } from 'maplibre-gl';
import { addBasemapLayers, getInitialBasemap } from './basemaps';
import { BasemapControl } from './basemapControl';
import { ensureSlots } from './layerOrder';
import { attachOrbitControls } from './orbitControls';
import { MAX_PITCH, baseMapStyle } from './terrain3d';

export interface StandardMapOptions {
  /** [longitude, latitude] */
  center: [number, number];
  zoom?: number;
  pitch?: number;
  bearing?: number;
  /** Basemap id; default: the viewer's last choice (shared by every page). */
  basemap?: string;
  /** Translates control labels. */
  t?: (s: string) => string;
  /** Called once the style is ready and the basemap is in: add sources and layers here. */
  onReady?: (map: MlMap) => void;
}

export interface StandardMap {
  map: MlMap;
  /** Removes the map, its controls and every listener. Safe to call twice. */
  destroy(): void;
}

/** Site-level working zoom (a few hundred metres across). */
export const SITE_ZOOM = 16.5;

/** Maps alive right now: lets tests and the dev console check that pages clean up after themselves. */
export const liveMaps = new Set<MlMap>();
if (import.meta.env?.DEV) (globalThis as unknown as { __psMaps: Set<MlMap> }).__psMaps = liveMaps;

export function createStandardMap(container: HTMLElement, opts: StandardMapOptions): StandardMap {
  const map = new maplibregl.Map({
    container,
    style: baseMapStyle(),
    center: opts.center,
    zoom: opts.zoom ?? SITE_ZOOM,
    pitch: opts.pitch ?? 0,
    bearing: opts.bearing ?? 0,
    maxPitch: MAX_PITCH,
    maxZoom: 21,
    attributionControl: false,
    // Right-drag rotation is replaced by the orbit gesture (middle / Ctrl+drag), so the right button stays free.
    dragRotate: false,
  });
  liveMaps.add(map);
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true, showZoom: true }), 'top-right');
  map.addControl(new BasemapControl(opts.t), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');
  map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

  const pivot = document.createElement('div');
  pivot.className = 'ps-map-pivot';
  pivot.setAttribute('aria-hidden', 'true');
  map.getContainer().appendChild(pivot);
  const disposeOrbit = attachOrbitControls(map, { pivot });

  map.once('load', () => {
    ensureSlots(map);
    addBasemapLayers(map, opts.basemap ?? getInitialBasemap());
    opts.onReady?.(map);
  });

  let destroyed = false;
  return {
    map,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      disposeOrbit();
      pivot.remove();
      liveMaps.delete(map);
      map.remove(); // also removes the controls (their onRemove runs)
    },
  };
}
