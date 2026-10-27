// Attribution Google requires for Map Tiles API basemaps: the "Google Maps" mark and the copyright
// text for what is on screen (asked from the server, which asks Google's viewport endpoint). Shown
// only while a Google basemap is visible, apart from other providers' attribution.
import type { IControl, Map as MlMap } from 'maplibre-gl';
import { basemaps, currentBasemap } from './basemaps';

/** Fetches JSON from this platform's API with the viewer's session. */
export type ApiGet = <T>(path: string) => Promise<T>;

export class GoogleAttributionControl implements IControl {
  private el?: HTMLDivElement;
  private off: (() => void)[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastKey = '';

  constructor(private get: ApiGet) {}

  onAdd(map: MlMap) {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl ps-google-attrib';
    el.hidden = true;
    const mark = document.createElement('span');
    mark.className = 'ps-google-mark';
    mark.textContent = 'Google Maps';
    const text = document.createElement('span');
    text.className = 'ps-google-copy';
    el.append(mark, text);
    this.el = el;

    const refresh = () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.update(map, text), 400);
    };
    map.on('moveend', refresh);
    map.on('styledata', refresh); // a basemap switch changes layer visibility
    this.off.push(
      () => map.off('moveend', refresh),
      () => map.off('styledata', refresh),
    );
    refresh();
    return el;
  }

  private async update(map: MlMap, text: HTMLSpanElement) {
    const id = currentBasemap(map);
    const google = id && basemaps().find((b) => b.id === id)?.provider === 'google';
    if (!this.el) return;
    this.el.hidden = !google;
    if (!google) return;
    const b = map.getBounds();
    const q = new URLSearchParams({
      zoom: String(Math.round(map.getZoom())),
      north: Math.min(89.9, b.getNorth()).toFixed(5),
      south: Math.max(-89.9, b.getSouth()).toFixed(5),
      east: Math.min(180, b.getEast()).toFixed(5),
      west: Math.max(-180, b.getWest()).toFixed(5),
    });
    const key = `${id}?${q}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    try {
      const r = await this.get<{ copyright: string }>(`/basemaps/${id}/attribution?${q}`);
      text.textContent = r.copyright ? ` · ${r.copyright}` : '';
    } catch {
      text.textContent = '';
    }
  }

  onRemove() {
    clearTimeout(this.timer);
    for (const f of this.off.splice(0)) f();
    this.el?.remove();
    this.el = undefined;
  }
}
