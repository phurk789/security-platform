// Still frames from the twin's cameras (incident thumbnails): one shared offscreen renderer
// draws the scene from a device's camera into the caller's 2D canvas on demand.
import * as THREE from 'three';
import { getWorld, webglAvailable } from './world';

const W = 320;
const H = 180;
let shared: { renderer: THREE.WebGLRenderer; canvas: HTMLCanvasElement } | null | undefined;

function studio() {
  if (shared !== undefined) return shared;
  if (!webglAvailable()) return (shared = null);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'low-power', preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    shared = { renderer, canvas };
  } catch {
    shared = null;
  }
  return shared;
}

/** Draw the current view from `deviceId`'s camera into `target`. Returns false when it cannot. */
export function snapshotInto(target: HTMLCanvasElement, deviceId: string, opts: { ir?: boolean; day?: boolean } = {}) {
  const st = studio();
  if (!st) return false;
  const world = getWorld();
  const cam = world.feedCamera(deviceId, W / H);
  if (!cam) return false;
  st.renderer.toneMappingExposure = (opts.ir ? 2.4 : 1.6) * (world.daylight ? 0.6 : 1);
  st.renderer.render(world.scene, cam);
  const ctx = target.getContext('2d');
  if (!ctx) return false;
  if (target.width !== W || target.height !== H) {
    target.width = W;
    target.height = H;
  }
  ctx.drawImage(st.canvas, 0, 0, W, H);
  return true;
}
