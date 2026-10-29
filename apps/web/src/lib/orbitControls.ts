// Shared orbit controls: middle-button drag, or Ctrl/Cmd + left drag, turns the camera around the
// centre of the screen. Left–right changes the bearing, up–down the pitch (0–89°). MapLibre's own
// right-drag rotation is switched off (createStandardMap) so the right button stays free for
// context menus; touch rotate/pitch and Shift + arrow keys keep working as MapLibre does them.
import type { Map as MlMap } from 'maplibre-gl';
import { MAX_PITCH } from './terrain3d';

/** Degrees of bearing / pitch per pixel dragged. */
const BEARING_PER_PX = 0.4;
const PITCH_PER_PX = 0.3;

export type OrbitMap = Pick<MlMap, 'getBearing' | 'getPitch' | 'jumpTo' | 'getCanvasContainer'> & { dragPan: { isEnabled(): boolean; enable(): void; disable(): void } };

interface PointerLike {
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  clientX: number;
  clientY: number;
  preventDefault(): void;
  stopPropagation(): void;
}

export const clampPitch = (p: number) => Math.max(0, Math.min(MAX_PITCH, p));

/**
 * Attaches the orbit gesture. `win` receives move/up events while dragging (defaults to window);
 * `pivot` is shown in the middle of the screen while turning. Returns a function that removes
 * every listener (call it when the map is destroyed).
 */
export function attachOrbitControls(map: OrbitMap, opts: { win?: EventTarget; pivot?: HTMLElement } = {}) {
  const target = map.getCanvasContainer() as unknown as EventTarget;
  const win: EventTarget = opts.win ?? (globalThis as unknown as { window: EventTarget }).window;
  let drag: { x: number; y: number; bearing: number; pitch: number; panWasOn: boolean } | null = null;

  const onMove = (ev: Event) => {
    const e = ev as unknown as PointerLike;
    if (!drag) return;
    e.preventDefault();
    map.jumpTo({ bearing: drag.bearing + (e.clientX - drag.x) * BEARING_PER_PX, pitch: clampPitch(drag.pitch - (e.clientY - drag.y) * PITCH_PER_PX) });
  };
  const end = () => {
    if (!drag) return;
    if (drag.panWasOn) map.dragPan.enable();
    drag = null;
    opts.pivot?.classList.remove('on');
    win.removeEventListener('mousemove', onMove);
    win.removeEventListener('mouseup', end);
  };
  const onDown = (ev: Event) => {
    const e = ev as unknown as PointerLike;
    const orbit = e.button === 1 || (e.button === 0 && (e.ctrlKey || e.metaKey));
    if (!orbit || drag) return;
    // Middle click would start the browser's auto-scroll; a plain drag would also pan the map.
    e.preventDefault();
    e.stopPropagation();
    drag = { x: e.clientX, y: e.clientY, bearing: map.getBearing(), pitch: map.getPitch(), panWasOn: map.dragPan.isEnabled() };
    map.dragPan.disable();
    opts.pivot?.classList.add('on');
    win.addEventListener('mousemove', onMove);
    win.addEventListener('mouseup', end);
  };
  // Middle-button "auxclick" opens links in new tabs and the like: not on the map.
  const onAux = (ev: Event) => (ev as unknown as PointerLike).button === 1 && ev.preventDefault();

  // Capture phase: decide before MapLibre's own handlers start a pan.
  target.addEventListener('mousedown', onDown, { capture: true });
  target.addEventListener('auxclick', onAux);
  return () => {
    end();
    target.removeEventListener('mousedown', onDown, { capture: true } as EventListenerOptions);
    target.removeEventListener('auxclick', onAux);
  };
}
