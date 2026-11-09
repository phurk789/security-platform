// Route checkpoints with what the vehicle does at each one (route planner): a name, the speed of
// the leg towards it, a wait, where the camera looks and whether it sweeps, a photo, and whether to
// keep the camera view there as evidence. Plain {x, y} points are valid route points, so older
// routes keep working.
import type { Point } from './types';

/**
 * Where the camera turns at a checkpoint, in degrees: pitch up (+) or down (−) from level, yaw right
 * (+) or left (−) of the vehicle's front; zoom as a magnification (1× = wide). Unset parts stay at
 * level, straight ahead and wide. The platform turns it back to the front when the wait is over.
 */
export interface RouteLook {
  pitch?: number;
  yaw?: number;
  zoom?: number;
}

export interface RoutePoint extends Point {
  /** Shown on the map, in the list and in the timeline, e.g. "Gate 3". */
  name?: string;
  /** Speed on the leg towards this point (m/s). Unset: the vehicle's route speed. */
  speed?: number;
  /** Seconds to wait at this point before going on. */
  holdS?: number;
  /** Keep the camera view here as evidence: a clip of the wait (or of CAPTURE_DEFAULT_S without one). */
  capture?: boolean;
  /** Turn the camera here (see RouteLook). */
  look?: RouteLook;
  /** During the wait, pan the camera left and right across ± this many degrees around the look's yaw. */
  sweep?: number;
  /** Take a photo here once the camera has turned. */
  photo?: boolean;
}

/** Something happens at this checkpoint besides driving through it (a wait, the camera, evidence). */
export const pointActs = (p: RoutePoint) => !!(p.holdS || p.capture || p.look || p.sweep || p.photo);
/** The camera has a job at this checkpoint. */
export const pointUsesCamera = (p: RoutePoint) => !!(p.look || p.sweep || p.photo || p.capture);

/** A route kept for reuse on a site (missions and patrols start from it). */
export interface SavedRoute {
  id: string;
  siteId: string;
  name: string;
  points: RoutePoint[];
  createdBy: string;
  updatedAt: number;
}

export const ROUTE_LIMITS = {
  maxPoints: 50,
  nameLen: 40,
  minSpeed: 0.2,
  maxSpeed: 5,
  maxHoldS: 300,
  /** Camera tilt: down to straight down, up to 30° above level. */
  minPitch: -90,
  maxPitch: 30,
  /** Camera pan either side of the vehicle's front (the gimbals in use turn ±135°). */
  maxYaw: 135,
  maxZoom: 30,
  /** Sweep half-width (degrees either side). */
  minSweep: 10,
  maxSweep: 135,
} as const;
/** Wait the planner suggests when a camera job is added to a checkpoint the vehicle would drive through (s). */
export const CAMERA_WAIT_S = 10;
/** Length of the evidence clip at a capture point without a wait (s). */
export const CAPTURE_DEFAULT_S = 10;

/**
 * Route points from untrusted input: x/y numbers plus the known settings, checked and rounded.
 * Returns the reason when something is wrong (the server answers 400 with it).
 */
export function sanitizeRoute(raw: unknown): RoutePoint[] | string {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > ROUTE_LIMITS.maxPoints) return `Route needs 1–${ROUTE_LIMITS.maxPoints} checkpoints.`;
  const out: RoutePoint[] = [];
  for (const [i, p] of raw.entries()) {
    const n = i + 1;
    if (typeof p?.x !== 'number' || typeof p?.y !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return 'Checkpoints must be {x, y} numbers.';
    const q: RoutePoint = { x: p.x, y: p.y };
    if (p.name !== undefined && p.name !== null && p.name !== '') {
      if (typeof p.name !== 'string') return `Checkpoint ${n}: the name must be text.`;
      const name = p.name.trim().slice(0, ROUTE_LIMITS.nameLen);
      if (name) q.name = name;
    }
    if (p.speed !== undefined && p.speed !== null) {
      const v = Number(p.speed);
      if (!Number.isFinite(v) || v < ROUTE_LIMITS.minSpeed || v > ROUTE_LIMITS.maxSpeed)
        return `Checkpoint ${n}: speed must be ${ROUTE_LIMITS.minSpeed}–${ROUTE_LIMITS.maxSpeed} m/s.`;
      q.speed = Math.round(v * 10) / 10;
    }
    if (p.holdS !== undefined && p.holdS !== null && p.holdS !== 0) {
      const h = Number(p.holdS);
      if (!Number.isFinite(h) || h < 0 || h > ROUTE_LIMITS.maxHoldS) return `Checkpoint ${n}: the wait must be 0–${ROUTE_LIMITS.maxHoldS} s.`;
      if (Math.round(h) > 0) q.holdS = Math.round(h);
    }
    if (p.capture === true) q.capture = true;
    if (p.look !== undefined && p.look !== null) {
      if (typeof p.look !== 'object' || Array.isArray(p.look)) return `Checkpoint ${n}: the camera direction must be {pitch, yaw, zoom}.`;
      const look: RouteLook = {};
      const part = (v: unknown, lo: number, hi: number, what: string): number | string | undefined => {
        if (v === undefined || v === null || v === '') return undefined;
        const x = Number(v);
        return Number.isFinite(x) && x >= lo && x <= hi ? x : `Checkpoint ${n}: the camera ${what} must be ${lo}–${hi}.`;
      };
      const pitch = part(p.look.pitch, ROUTE_LIMITS.minPitch, ROUTE_LIMITS.maxPitch, 'tilt (°)');
      const yaw = part(p.look.yaw, -ROUTE_LIMITS.maxYaw, ROUTE_LIMITS.maxYaw, 'pan (°)');
      const zoom = part(p.look.zoom, 1, ROUTE_LIMITS.maxZoom, 'zoom (×)');
      for (const v of [pitch, yaw, zoom]) if (typeof v === 'string') return v;
      // Level, straight ahead and wide are where the camera already is: only the rest is kept.
      if (typeof pitch === 'number' && Math.round(pitch)) look.pitch = Math.round(pitch);
      if (typeof yaw === 'number' && Math.round(yaw)) look.yaw = Math.round(yaw);
      if (typeof zoom === 'number' && Math.round(zoom * 10) / 10 > 1) look.zoom = Math.round(zoom * 10) / 10;
      if (Object.keys(look).length) q.look = look;
    }
    if (p.sweep !== undefined && p.sweep !== null && p.sweep !== 0) {
      const w = Number(p.sweep);
      if (!Number.isFinite(w) || w < ROUTE_LIMITS.minSweep || w > ROUTE_LIMITS.maxSweep)
        return `Checkpoint ${n}: the sweep must be ${ROUTE_LIMITS.minSweep}–${ROUTE_LIMITS.maxSweep}° either side.`;
      q.sweep = Math.round(w);
    }
    if (p.photo === true) q.photo = true;
    out.push(q);
  }
  return out;
}

/**
 * Where the camera points at each step of a sweep at a checkpoint: from the look's yaw out to one
 * side, across to the other and back, in steps of at most 30°, kept within the gimbal's reach.
 * One full pass; the platform repeats it while the wait lasts.
 */
export function sweepYaws(centre: number, halfWidth: number): number[] {
  const lo = Math.max(-ROUTE_LIMITS.maxYaw, centre - halfWidth);
  const hi = Math.min(ROUTE_LIMITS.maxYaw, centre + halfWidth);
  // The points after `a` on the way to `b`, at most 30° apart (`b` included).
  const leg = (a: number, b: number) => {
    const n = Math.max(1, Math.ceil(Math.abs(b - a) / 30));
    return Array.from({ length: n }, (_, k) => Math.round(a + ((b - a) * (k + 1)) / n));
  };
  // Centre → left end → right end → centre.
  return [...leg(centre, lo), ...leg(lo, hi), ...leg(hi, centre)];
}

/** Seconds to drive the route: each leg at its own speed (else `speed`), plus the waits. */
export function routeTimeS(points: RoutePoint[], from: Point | undefined, speed: number) {
  let t = 0;
  let prev = from;
  for (const p of points) {
    if (prev) t += Math.hypot(p.x - prev.x, p.y - prev.y) / Math.max(p.speed ?? speed, 0.1);
    t += p.holdS ?? 0;
    prev = p;
  }
  return t;
}

/** "down 30°, right 45°, 3×, sweeping ±60°": what the camera does at a checkpoint, for the timeline. */
export function describeLook(p: RoutePoint) {
  const { pitch = 0, yaw = 0, zoom = 1 } = p.look ?? {};
  const parts: string[] = [];
  if (pitch) parts.push(`${pitch < 0 ? 'down' : 'up'} ${Math.abs(pitch)}°`);
  if (yaw) parts.push(`${yaw < 0 ? 'left' : 'right'} ${Math.abs(yaw)}°`);
  if (zoom > 1) parts.push(`${zoom}×`);
  if (p.sweep) parts.push(`sweeping ±${p.sweep}°`);
  return parts.join(', ') || 'level, straight ahead';
}

/** "Checkpoint 3 · Gate" (1-based), for messages and the timeline. */
export function checkpointLabel(points: RoutePoint[], i: number) {
  const name = points[i]?.name;
  return name ? `${i + 1} (${name})` : String(i + 1);
}
