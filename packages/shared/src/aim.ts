// Pointing gimbal cameras at a place on the site grid: angles, zoom, line of sight, best camera.
// Used by the server (auto-aim on alerts, "point at incident") and the offline demo.
import { GIMBAL_LIMITS } from './camera';
import type { Building } from './site';
import type { Device, Point } from './types';

/** How a gimbal camera is mounted. Site grid: x east, y south; bearings 0 = north, clockwise. */
export interface CameraMount {
  /** Bearing of the gimbal's yaw zero (where "centre" points), degrees. On a vehicle: its heading. */
  bearingDeg: number;
  /** Lens height above the ground, metres. */
  heightM: number;
  /** Vertical field of view at 1× zoom, degrees. */
  fovDeg?: number;
  /** Furthest distance worth pointing at, metres. */
  rangeM?: number;
}

export interface Aim {
  /** Gimbal yaw relative to the mount, degrees (positive = right). */
  yaw: number;
  /** Gimbal pitch, degrees (negative = down). */
  pitch: number;
  /** Zoom that frames about `frameM` metres of scene height at the target. */
  zoom: number;
  distanceM: number;
  /** False if the gimbal cannot turn that far. */
  reachable: boolean;
}

const deg = (r: number) => (r * 180) / Math.PI;
const rad = (d: number) => (d * Math.PI) / 180;
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Bearing from a to b in degrees (0 = north / −y, clockwise). */
export function bearingDeg(a: Point, b: Point) {
  return (deg(Math.atan2(b.x - a.x, -(b.y - a.y))) + 360) % 360;
}

export function aimAt(pos: Point, mount: CameraMount, target: Point, opts: { targetHeightM?: number; frameM?: number; zoomMax?: number } = {}): Aim {
  const th = opts.targetHeightM ?? 1.2;
  const frame = opts.frameM ?? 8;
  const dist = Math.max(0.5, Math.hypot(target.x - pos.x, target.y - pos.y));
  const yaw = wrap180(bearingDeg(pos, target) - mount.bearingDeg);
  const pitch = Math.max(GIMBAL_LIMITS.pitchMin, Math.min(GIMBAL_LIMITS.pitchMax, -deg(Math.atan2(mount.heightM - th, dist))));
  const fov = mount.fovDeg ?? 45;
  const zoom = Math.max(1, Math.min(opts.zoomMax ?? GIMBAL_LIMITS.zoomMax, (2 * dist * Math.tan(rad(fov) / 2)) / frame));
  return { yaw: round1(yaw), pitch: round1(pitch), zoom: round1(zoom), distanceM: Math.round(dist), reachable: Math.abs(yaw) <= GIMBAL_LIMITS.yaw };
}

/**
 * True if no building blocks the sight line from a camera at `from` (height hFrom) to a point at
 * `to` (height hTo). Buildings are boxes; the line is blocked where it passes below a roof.
 */
export function lineOfSight(from: Point, to: Point, buildings: Building[], hFrom: number, hTo = 1.2) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  for (const b of buildings) {
    // Liang–Barsky clip of the segment against the footprint.
    let t0 = 0;
    let t1 = 1;
    const edges: [number, number][] = [
      [-dx, from.x - b.x],
      [dx, b.x + b.w - from.x],
      [-dy, from.y - b.y],
      [dy, b.y + b.d - from.y],
    ];
    let hit = true;
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) hit = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
      if (t0 > t1) hit = false;
    }
    if (!hit) continue;
    const h = (t: number) => hFrom + (hTo - hFrom) * t;
    if (Math.min(h(t0), h(t1)) < b.h) return false;
  }
  return true;
}

export interface CameraChoice {
  device: Device;
  aim: Aim;
}

/**
 * The best fixed gimbal camera for a point: online, mounted, in range, able to turn there and
 * with a clear line of sight. Nearest wins. `busy` lists cameras an operator is using right now.
 */
export function pickCamera(devices: Device[], target: Point, buildings: Building[], isOnline: (d: Device) => boolean, busy: (id: string) => boolean = () => false): CameraChoice | null {
  const out: CameraChoice[] = [];
  for (const d of devices) {
    if (d.kind !== 'cctv' || !d.capabilities.includes('gimbal') || !d.mount || !isOnline(d) || busy(d.id)) continue;
    const aim = aimAt(d.pos, d.mount, target);
    if (!aim.reachable || aim.distanceM > (d.mount.rangeM ?? 250)) continue;
    if (!lineOfSight(d.pos, target, buildings, d.mount.heightM)) continue;
    out.push({ device: d, aim });
  }
  out.sort((a, b) => a.aim.distanceM - b.aim.distanceM);
  return out[0] ?? null;
}

/** Mount of a vehicle camera right now: yaw zero is the vehicle's heading. */
export function vehicleMount(d: Device): CameraMount {
  return { bearingDeg: d.heading ?? 0, heightM: d.mount?.heightM ?? 1.4, fovDeg: d.mount?.fovDeg ?? 50, rangeM: d.mount?.rangeM ?? 150 };
}

/** Mount to use for aiming: fixed cameras use their configured mount, vehicles their heading. */
export function mountOf(d: Device): CameraMount | null {
  if (d.kind === 'cctv') return d.mount ?? null;
  return vehicleMount(d);
}

function round1(v: number) {
  return Math.round(v * 10) / 10;
}
