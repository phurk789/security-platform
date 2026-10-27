// MapLibre control that lists the basemaps (radio buttons). Plain DOM, so it works the same in
// every map without React; it reads and writes the shared choice through basemaps.ts.
import type { IControl, Map as MlMap } from 'maplibre-gl';
import { BASEMAPS, currentBasemap, switchBasemap } from './basemaps';

const LAYERS_ICON =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 2 10 5-10 5L2 7l10-5Z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>';

export class BasemapControl implements IControl {
  private el?: HTMLDivElement;
  private cleanup: (() => void)[] = [];

  constructor(private t: (s: string) => string = (s) => s) {}

  onAdd(map: MlMap) {
    const el = document.createElement('div');
    el.className = 'maplibregl-ctrl maplibregl-ctrl-group ps-basemap-ctrl';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ps-basemap-btn';
    btn.title = this.t('Basemap');
    btn.setAttribute('aria-label', this.t('Basemap'));
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = LAYERS_ICON;
    const panel = document.createElement('div');
    panel.className = 'ps-basemap-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'radiogroup');
    panel.setAttribute('aria-label', this.t('Basemap'));
    const name = `ps-basemap-${Math.random().toString(36).slice(2, 8)}`;
    for (const b of BASEMAPS) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = name;
      input.value = b.id;
      input.addEventListener('change', () => input.checked && switchBasemap(map, b.id));
      const span = document.createElement('span');
      span.textContent = this.t(b.label);
      label.append(input, span);
      panel.append(label);
    }
    const sync = () => {
      const cur = currentBasemap(map);
      for (const i of panel.querySelectorAll('input')) (i as HTMLInputElement).checked = i.value === cur;
    };
    const setOpen = (open: boolean) => {
      panel.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) sync();
    };
    const onBtn = () => setOpen(panel.hidden !== false);
    const onDoc = (e: MouseEvent) => !el.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    btn.addEventListener('click', onBtn);
    document.addEventListener('mousedown', onDoc);
    el.addEventListener('keydown', onKey);
    this.cleanup.push(
      () => btn.removeEventListener('click', onBtn),
      () => document.removeEventListener('mousedown', onDoc),
      () => el.removeEventListener('keydown', onKey),
    );
    el.append(btn, panel);
    this.el = el;
    return el;
  }

  onRemove() {
    for (const f of this.cleanup.splice(0)) f();
    this.el?.remove();
    this.el = undefined;
  }
}
