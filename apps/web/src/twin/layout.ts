// Site furniture shared by the 2D plan and the 3D twin: trees, lamps, parked cars, camera views.
import { BUILDINGS, FENCE_Y, PARKING, PLAZA, ROAD, SITE, type Point } from '@13store/shared';

export function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

export function inBlocked(x: number, y: number) {
  const pad = 6;
  if (BUILDINGS.some((b) => x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.d + pad)) return true;
  if (x > PARKING.x - 4 && x < PARKING.x + PARKING.w + 4 && y > PARKING.y - 4 && y < PARKING.y + PARKING.d + 4) return true;
  if (Math.hypot(x - PLAZA.cx, y - PLAZA.cy) < PLAZA.r + 8) return true;
  if (y > FENCE_Y - 8 && y < ROAD.y + ROAD.h + 4) return true;
  if (Math.abs(x - 244) < 8 && y < FENCE_Y) return true; // central walkway
  if (y > 112 && y < 128) return true; // east–west walkway
  return false;
}

/** Deterministic tree positions (same on every client). */
export const TREES: (Point & { s: number })[] = (() => {
  const r = rng(7);
  const out: (Point & { s: number })[] = [];
  while (out.length < 90) {
    const x = 10 + r() * 400;
    const y = 8 + r() * 280;
    if (!inBlocked(x, y)) out.push({ x, y, s: 0.75 + r() * 0.6 });
  }
  return out.sort((a, b) => a.y - b.y);
})();

/** Street lamps: along the road, the car park, the plaza and the service gate. */
export const LAMPS: Point[] = [
  ...Array.from({ length: 8 }, (_, i) => ({ x: 30 + i * 52, y: ROAD.y - 3 })),
  { x: PARKING.x - 4, y: PARKING.y + PARKING.d / 2 },
  { x: PARKING.x + PARKING.w + 4, y: PARKING.y + PARKING.d / 2 },
  { x: PLAZA.cx - PLAZA.r - 6, y: PLAZA.cy },
  { x: PLAZA.cx + PLAZA.r + 6, y: PLAZA.cy },
  { x: 318, y: FENCE_Y - 6 },
  { x: 352, y: FENCE_Y - 6 },
];

/** Lamps that also cast real light (others are emissive only, to keep the GPU cost low). */
export const LIT_LAMPS = [12, 13, 8, 9, 3, 10];

/** Parked cars in the lot (x, y, colour index). */
export const PARKED: (Point & { c: number; r: number })[] = (() => {
  const r = rng(91);
  const out: (Point & { c: number; r: number })[] = [];
  for (let i = 0; i < 13; i++) {
    for (const row of [0, 1]) {
      if (r() < 0.45) continue;
      // keep the bottom row clear east of x=200: the UGV's patrol lane runs along it
      if (row && PARKING.x + 8 + i * 8 > 200) continue;
      out.push({ x: PARKING.x + 8 + i * 8, y: row ? PARKING.y + PARKING.d - 6 : PARKING.y + 6, c: Math.floor(r() * 6), r: row ? Math.PI : 0 });
    }
  }
  return out;
})();

/** Where each fixed camera looks. Height in metres above ground. */
export const CAMERA_VIEWS: Record<string, { height: number; target: Point; targetHeight?: number; fov: number }> = {
  'CCTV-01': { height: 7, target: { x: 214, y: 128 }, fov: 58 },
  'CCTV-02': { height: 6.5, target: { x: 335, y: 236 }, targetHeight: 0.5, fov: 52 },
  'CCTV-03': { height: 6, target: { x: 120, y: 120 }, fov: 55 },
  'CCTV-04': { height: 6, target: { x: 360, y: 210 }, fov: 60 },
};

/** Site metres (x east, y south) → three.js world (X east, Z south, Y up), centred on the site. */
export const toWorld = (x: number, y: number) => ({ x: x - SITE.width / 2, z: y - SITE.height / 2 });
export const fromWorld = (x: number, z: number) => ({ x: x + SITE.width / 2, y: z + SITE.height / 2 });
