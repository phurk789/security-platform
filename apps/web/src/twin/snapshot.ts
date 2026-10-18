// Pictures from the twin's cameras (live feeds and incident thumbnails). All of them share ONE
// offscreen WebGL renderer that draws a camera view and copies it into the caller's 2D canvas.
// One context means the scene's shaders and environment map are built once, not once per feed —
// that was most of the start-up time on a first visit.
import * as THREE from 'three';
import { getWorld, webglAvailable } from './world';

export const FEED_W = 400;
export const FEED_H = 225;
let shared: { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement; ready: boolean } | null | undefined;

function studio() {
  if (shared !== undefined) return shared;
  if (!webglAvailable()) return (shared = null);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = FEED_W;
    canvas.height = FEED_H;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(FEED_W, FEED_H, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const st = { renderer, canvas, ready: false };
    shared = st;
    // Build the shaders without blocking the page; feeds show their placeholder until then.
    const world = getWorld();
    const cam = new THREE.PerspectiveCamera(50, FEED_W / FEED_H, 0.5, 2000);
    const done = () => (st.ready = true);
    whenIdle(() => {
      try {
        renderer.compileAsync(world.scene, cam).then(done, done);
      } catch {
        done();
      }
    });
  } catch {
    shared = null;
  }
  return shared;
}

function whenIdle(fn: () => void) {
  const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
  if (ric) ric(fn, { timeout: 1500 });
  else setTimeout(fn, 300);
}

/** True once the shared renderer can draw without stalling the page. */
export function feedsReady() {
  const st = studio();
  return !!st?.ready;
}

/** Draw `deviceId`'s camera view into `target` at w×h. Returns false when it cannot (yet). */
export function drawCamera(
  target: HTMLCanvasElement,
  deviceId: string,
  opts: { ir?: boolean; facing?: 'front' | 'rear' | 'left' | 'right' | 'down'; w?: number; h?: number } = {},
) {
  const st = studio();
  if (!st || !st.ready) return false;
  // Always render at the feed size and let drawImage scale: resizing the shared canvas between
  // callers reallocates its buffers and stalls the GPU on every switch.
  const w = opts.w ?? FEED_W;
  const h = opts.h ?? FEED_H;
  const world = getWorld();
  const cam = world.feedCamera(deviceId, FEED_W / FEED_H, opts.facing);
  if (!cam) return false;
  st.renderer.toneMappingExposure = (opts.ir ? 2.4 : 1.6) * (world.daylight ? 0.6 : 1);
  const iv = world.state?.devices[deviceId]?.indoor;
  if (iv) world.withCutaway(iv, () => st.renderer.render(world.scene, cam));
  else st.renderer.render(world.scene, cam);
  const ctx = target.getContext('2d');
  if (!ctx) return false;
  if (target.width !== w || target.height !== h) {
    target.width = w;
    target.height = h;
  }
  ctx.drawImage(st.canvas, 0, 0, w, h);
  return true;
}

/** Still frame for incident thumbnails. */
export function snapshotInto(target: HTMLCanvasElement, deviceId: string, opts: { ir?: boolean; day?: boolean } = {}) {
  return drawCamera(target, deviceId, { ir: opts.ir, w: 320, h: 180 });
}
