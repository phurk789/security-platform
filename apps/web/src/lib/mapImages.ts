// Images the overlays use, drawn on a canvas in the browser: the heading arrow, and one label image
// per text (made the first time a layer asks for it). Drawing text ourselves means no glyph server
// is needed and Thai renders with the system font.
import type { Map as MlMap, MapStyleImageMissingEvent } from 'maplibre-gl';
import { ARROW_IMAGE } from './overlays';

const dpr = () => Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = Math.ceil(w);
  c.height = Math.ceil(h);
  return c;
}

/** Arrow pointing up (north before rotation), drawn ahead of the device dot. */
export function drawArrow(r = dpr()): ImageData {
  const size = 34 * r;
  const c = canvas(size, size);
  const g = c.getContext('2d')!;
  g.scale(r, r);
  g.beginPath();
  g.moveTo(17, 0.5);
  g.lineTo(24, 10.5);
  g.lineTo(17, 8);
  g.lineTo(10, 10.5);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#0b1220';
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.stroke();
  g.fill();
  return g.getImageData(0, 0, c.width, c.height);
}

/** A rounded tag with white text on `bg`. */
export function drawLabel(text: string, bg: string, r = dpr()): ImageData {
  const font = `600 ${12 * r}px system-ui, -apple-system, "Segoe UI", "Noto Sans Thai", Tahoma, sans-serif`;
  const probe = canvas(1, 1).getContext('2d')!;
  probe.font = font;
  const w = Math.ceil(probe.measureText(text).width + 12 * r);
  const h = Math.ceil(18 * r);
  const c = canvas(w, h);
  const g = c.getContext('2d')!;
  g.font = font;
  g.fillStyle = bg;
  g.globalAlpha = 0.9;
  const rad = 4 * r;
  g.beginPath();
  g.roundRect(0.5, 0.5, w - 1, h - 1, rad);
  g.fill();
  g.globalAlpha = 1;
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  g.fillText(text, 6 * r, h / 2 + 0.5 * r);
  return g.getImageData(0, 0, c.width, c.height);
}

/** Adds the fixed images and draws label images on demand. Returns a function that stops listening. */
export function addMapImages(map: MlMap) {
  const r = dpr();
  if (!map.hasImage(ARROW_IMAGE)) map.addImage(ARROW_IMAGE, drawArrow(r), { pixelRatio: r });
  const onMissing = (e: MapStyleImageMissingEvent) => {
    if (!e.id.startsWith('lbl|') || map.hasImage(e.id)) return;
    const [, text, bg] = e.id.split('|');
    map.addImage(e.id, drawLabel(text, bg || '#0f172a', r), { pixelRatio: r });
  };
  map.on('styleimagemissing', onMissing);
  return () => map.off('styleimagemissing', onMissing);
}
