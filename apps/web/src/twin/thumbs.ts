// Vehicle thumbnails for the fleet cards: the same 3D models as the twin, rendered once per
// model into a small PNG by one shared offscreen renderer and cached. Falls back to nothing
// (the card shows an icon) when WebGL is not available.
import * as THREE from 'three';
import { makeUav, makeUgv } from './models';
import { webglAvailable } from './world';

const W = 240;
const H = 150;
const cache = new Map<string, string>();
const waiting = new Map<string, Promise<string | null>>();
let studio: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; cam: THREE.PerspectiveCamera; canvas: HTMLCanvasElement } | null | undefined;

function getStudio() {
  if (studio !== undefined) return studio;
  if (!webglAvailable()) return (studio = null);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.5;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    const scene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight('#f2f6ff', '#3a4250', 2.2);
    const sun = new THREE.DirectionalLight('#fff6e6', 3.2);
    sun.position.set(2.5, 5, 3);
    const fill = new THREE.DirectionalLight('#9fd8ff', 1.2);
    fill.position.set(-4, 2, -2);
    scene.add(hemi, sun, fill);
    const cam = new THREE.PerspectiveCamera(30, W / H, 0.05, 100);
    studio = { renderer, scene, cam, canvas };
  } catch {
    studio = null;
  }
  return studio;
}

function render(key: string): string | null {
  const st = getStudio();
  if (!st) return null;
  const [kind, model, payload] = key.split('|');
  const root = kind === 'uav' ? makeUav().root : makeUgv({ model: model || undefined, payload: payload === '1' }).root;
  // Lights inside the model (headlight, strobes) are for the night scene, not the studio.
  root.traverse((o) => {
    if ((o as THREE.Light).isLight) o.visible = false;
  });
  st.scene.add(root);
  root.updateMatrixWorld(true);
  // Frame the body (sprites are excluded: their bounds are huge).
  const box = new THREE.Box3();
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.visible && m.geometry) box.expandByObject(m);
  });
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.x, size.z) * 0.58 + size.y * 0.2;
  const dist = radius / Math.tan((st.cam.fov * Math.PI) / 360);
  // Three-quarter view from the front-left, slightly above.
  st.cam.position.set(centre.x - dist * 0.7, centre.y + dist * 0.45, centre.z + dist * 0.62);
  st.cam.lookAt(centre);
  st.cam.updateProjectionMatrix();
  st.renderer.render(st.scene, st.cam);
  const url = st.canvas.toDataURL('image/png');
  st.scene.remove(root);
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mt of mats) (mt as THREE.Material).dispose();
  });
  return url;
}

/** Data URL of a rendered thumbnail for a vehicle kind / catalogue model, or null when unavailable. */
export function vehicleThumb(kind: 'ugv' | 'uav', model?: string, payload = false): Promise<string | null> {
  const key = `${kind}|${model ?? ''}|${payload ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);
  let p = waiting.get(key);
  if (!p) {
    p = new Promise<string | null>((resolve) => {
      // Render off the critical path (a short timer: idle time is rare while the twin animates).
      const run = () => {
        try {
          const url = render(key);
          if (url) cache.set(key, url);
          resolve(url);
        } catch {
          resolve(null);
        }
      };
      setTimeout(run, 80 + waiting.size * 40);
    });
    waiting.set(key, p);
  }
  return p;
}
