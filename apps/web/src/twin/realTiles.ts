// Photorealistic 3D tiles of the real site (Google Map Tiles API) in place of the drawn scenery.
// On only when the build has a Google Maps key (VITE_GOOGLE_MAPS_API_KEY) and the site's WGS 84
// anchor points at a real place. Devices, routes, zones and floor plans keep drawing on top.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer/three';
import { GoogleCloudAuthPlugin, ReorientationPlugin, TilesFadePlugin } from '3d-tiles-renderer/plugins';
import { SITE } from '@13store/shared';
import { toWorld } from './layout';
import type { TwinWorld } from './world';
import { GOOGLE_KEY } from './realKey';

export interface RealTiles {
  /** Call once per frame with the camera the map is drawn from. */
  update(): void;
  setVisible(on: boolean): void;
  /** Data providers to credit on screen (required by the Map Tiles API terms). */
  attributions(): string;
  dispose(): void;
}

const DEG = Math.PI / 180;

export function attachRealTiles(world: TwinWorld, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera): RealTiles | null {
  if (!GOOGLE_KEY) return null;
  const geo = SITE.geo;
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: GOOGLE_KEY, autoRefreshToken: true }));
  tiles.registerPlugin(new ReorientationPlugin({ lat: geo.originLat * DEG, lon: geo.originLon * DEG, height: 0, recenter: true }));
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.errorTarget = 14;

  // The reoriented tileset has north on +Z; the twin has south on +Z and the grid may be turned
  // (rotationDeg, clockwise from east). The site grid origin (the anchor) sits at toWorld(0, 0).
  const holder = new THREE.Group();
  holder.name = 'real-tiles';
  holder.rotation.y = Math.PI + (geo.rotationDeg ?? 0) * DEG;
  const o = toWorld(0, 0);
  holder.position.set(o.x, 0, o.z);
  holder.add(tiles.group);
  world.scene.add(holder);

  // Photogrammetry already carries its light and shadow: draw it unlit, dimmed at night.
  const night = new THREE.Color('#5d6b86');
  const day = new THREE.Color('#ffffff');
  const mats = new Set<THREE.MeshBasicMaterial>();
  tiles.addEventListener('load-model', (e: { scene: THREE.Object3D }) => {
    e.scene.traverse((c) => {
      const m = c as THREE.Mesh;
      if (!m.isMesh) return;
      const old = m.material as THREE.MeshStandardMaterial;
      const mat = new THREE.MeshBasicMaterial({ map: old.map ?? null, color: world.daylight ? day : night });
      mats.add(mat);
      old.dispose();
      m.material = mat;
      m.receiveShadow = true;
    });
  });
  tiles.addEventListener('dispose-model', (e: { scene: THREE.Object3D }) => {
    e.scene.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) mats.delete(m.material as THREE.MeshBasicMaterial);
    });
  });

  // Ellipsoid height of the ground is not known up front (geoid and terrain): once tiles under
  // the site arrive, drop the tileset so the real ground sits at the twin's y = 0.
  const ray = new THREE.Raycaster();
  let grounded = false;
  let lastGroundTry = 0;
  const ground = () => {
    const c = toWorld(SITE.width / 2, SITE.height / 2);
    ray.set(new THREE.Vector3(c.x, 2000, c.z), new THREE.Vector3(0, -1, 0));
    const hit = ray.intersectObject(tiles.group, true)[0];
    if (hit) {
      holder.position.y -= hit.point.y;
      grounded = true;
    }
  };

  let visible = true;
  let wasDay = world.daylight;
  world.setRealTiles(true);
  return {
    update() {
      if (!visible) return;
      tiles.setCamera(camera);
      tiles.setResolutionFromRenderer(camera, renderer);
      camera.updateMatrixWorld();
      tiles.update();
      if (world.daylight !== wasDay) {
        wasDay = world.daylight;
        for (const m of mats) m.color.copy(wasDay ? day : night);
      }
      const now = performance.now();
      if (!grounded && now - lastGroundTry > 1000) {
        lastGroundTry = now;
        ground();
      }
    },
    setVisible(on) {
      visible = on;
      holder.visible = on;
      world.setRealTiles(on);
    },
    attributions() {
      const out: string[] = [];
      for (const a of tiles.getAttributions()) if (a.type === 'string' && a.value) out.push(String(a.value));
      return out.join(' · ');
    },
    dispose() {
      world.setRealTiles(false);
      world.scene.remove(holder);
      tiles.dispose();
    },
  };
}
