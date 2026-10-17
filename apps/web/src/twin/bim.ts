// Imported site models (BIM → glTF) and orthophoto ground, described by media/twin.json.
// Nothing here is required: without the file the twin draws buildings from their footprints.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export interface TwinModel {
  /** glTF / GLB file, relative to the app root (e.g. "media/site.glb"). Metres, Y up, north = −Z. */
  src: string;
  /** Site-grid position (metres) of the model's origin. */
  origin?: { x: number; y: number };
  /** Rotation about the vertical axis, degrees clockwise seen from above. */
  rotationDeg?: number;
  scale?: number;
  /** Height of the model origin above site ground (metres). */
  elevation?: number;
  /** Procedural buildings this model replaces (their ids), or "*" for all of them. */
  replaces?: string[] | '*';
}

export interface TwinManifest {
  ground?: {
    /** Orthophoto covering the whole site rectangle, north up. */
    ortho?: string;
  };
  models?: TwinModel[];
}

export async function loadTwinManifest(): Promise<TwinManifest | null> {
  if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
  try {
    const r = await fetch('media/twin.json', { cache: 'no-cache' });
    if (!r.ok) return null;
    const j = (await r.json()) as TwinManifest;
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

/** Loads one glTF model and prepares it for the twin (shadows, world placement). */
export async function loadTwinModel(m: TwinModel, toWorld: (x: number, y: number) => { x: number; z: number }): Promise<THREE.Group> {
  const gltf = await new GLTFLoader().loadAsync(m.src);
  const root = gltf.scene;
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const p = toWorld(m.origin?.x ?? 0, m.origin?.y ?? 0);
  root.position.set(p.x, m.elevation ?? 0, p.z);
  root.rotation.y = -THREE.MathUtils.degToRad(m.rotationDeg ?? 0);
  root.scale.setScalar(m.scale ?? 1);
  root.name = `bim:${m.src}`;
  return root;
}

export function loadOrtho(src: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    new THREE.TextureLoader().load(
      src,
      (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 4;
        resolve(t);
      },
      undefined,
      reject,
    );
  });
}

/** Small equirectangular environment for reflections, drawn in a canvas (works in every renderer). */
export function makeEnvironment(day: boolean): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 128;
  const g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 64);
  if (day) {
    sky.addColorStop(0, '#5f8ad6');
    sky.addColorStop(1, '#cfe0f2');
  } else {
    sky.addColorStop(0, '#0a1326');
    sky.addColorStop(1, '#2a3a5c');
  }
  g.fillStyle = sky;
  g.fillRect(0, 0, 256, 64);
  const ground = g.createLinearGradient(0, 64, 0, 128);
  ground.addColorStop(0, day ? '#8a9680' : '#2a3140');
  ground.addColorStop(1, day ? '#3f4a38' : '#0b0f14');
  g.fillStyle = ground;
  g.fillRect(0, 64, 256, 64);
  // a few bright spots on the horizon: street and building lights by night, sun glare by day
  for (let i = 0; i < (day ? 1 : 14); i++) {
    const x = day ? 190 : (i * 97) % 256;
    const r = g.createRadialGradient(x, 62, 0, x, 62, day ? 40 : 10);
    r.addColorStop(0, day ? 'rgba(255,250,235,0.9)' : 'rgba(255,214,150,0.55)');
    r.addColorStop(1, 'rgba(255,220,160,0)');
    g.fillStyle = r;
    g.fillRect(0, 40, 256, 50);
  }
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
