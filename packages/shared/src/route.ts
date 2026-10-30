// Route checkpoints with what the vehicle does at each one (route planner): a name, the speed of
// the leg towards it, a wait, and whether to keep the camera view there as evidence. Plain
// {x, y} points are valid route points, so older routes keep working.
import type { Point } from './types';

export interface RoutePoint extends Point {
  /** Shown on the map, in the list and in the timeline, e.g. "Gate 3". */
  name?: string;
  /** Speed on the leg towards this point (m/s). Unset: the vehicle's route speed. */
  speed?: number;
  /** Seconds to wait at this point before going on. */
  holdS?: number;
  /** Keep the camera view here as evidence: a clip of the wait (or of CAPTURE_DEFAULT_S without one). */
  capture?: boolean;
}

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
} as const;
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
    out.push(q);
  }
  return out;
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

/** "Checkpoint 3 · Gate" (1-based), for messages and the timeline. */
export function checkpointLabel(points: RoutePoint[], i: number) {
  const name = points[i]?.name;
  return name ? `${i + 1} (${name})` : String(i + 1);
}
