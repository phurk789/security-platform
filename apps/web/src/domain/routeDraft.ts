// A route (or a zone outline) being drawn on the real map: points in site metres, checked as they
// are drawn against the same rules the server and the approval checks use (inside the site's
// operating area — or the demo boundary when it has none — clear of keep-out zones, at most 50
// checkpoints). The draft lives outside React state so a form on another page (patrols, zones)
// can start a drawing on the overview map and pick the result up when it comes back.
import { useSyncExternalStore } from 'react';
import { routeLength, routeOutsideSite, routeViolations, type Geofence, type Point, type View } from '@13store/shared';

/** The server accepts 1–50 checkpoints per route. */
export const MAX_CHECKPOINTS = 50;
/** The server accepts 3–30 corners per zone. */
export const MIN_ZONE_POINTS = 3;
export const MAX_ZONE_POINTS = 30;

export type DraftPurpose = 'mission-new' | 'mission-edit' | 'patrol' | 'zone';

export interface RouteDraft {
  purpose: DraftPurpose;
  /** The vehicle the route is for ('' for a zone). */
  deviceId: string;
  /** The mission whose route is being changed (mission-edit). */
  missionId?: string;
  points: Point[];
  /** The points when the drawing started; Cancel puts these back. */
  initial: Point[];
  /** drawing: the map takes clicks. done: finished, the caller collects the points. */
  state: 'drawing' | 'done';
  /** Page to go back to when the drawing ends (the patrol and zone forms are not on the map page). */
  returnTo?: View;
  /** Caller's form values, restored when it comes back. */
  meta?: unknown;
}

const round = (p: Point): Point => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });

export const maxPoints = (purpose: DraftPurpose) => (purpose === 'zone' ? MAX_ZONE_POINTS : MAX_CHECKPOINTS);

export function addPoint(points: Point[], p: Point, max = MAX_CHECKPOINTS): Point[] {
  return points.length >= max ? points : [...points, round(p)];
}

export function movePoint(points: Point[], i: number, p: Point): Point[] {
  return i < 0 || i >= points.length ? points : points.map((q, n) => (n === i ? round(p) : q));
}

export function removePoint(points: Point[], i: number): Point[] {
  return i < 0 || i >= points.length ? points : points.filter((_, n) => n !== i);
}

export interface DraftCheck {
  /** Metres from the vehicle (when its position is known) through every checkpoint; a zone's perimeter. */
  lengthM: number;
  /** 1-based numbers of checkpoints outside the site, or reached by leaving the operating area. */
  outside: number[];
  /** Keep-out zones the route crosses. */
  fences: Geofence[];
  full: boolean;
  /** Fit to save: a route with at least one checkpoint, all inside the site, no keep-out zone crossed; a zone with 3+ corners. */
  ok: boolean;
}

export function checkDraft(points: Point[], from: Point | undefined, fences: Geofence[], kind: 'ugv' | 'uav', purpose: DraftPurpose = 'mission-new'): DraftCheck {
  if (purpose === 'zone') {
    const ring = points.length > 2 ? [...points, points[0]] : points;
    return { lengthM: Math.round(routeLength(ring)), outside: [], fences: [], full: points.length >= MAX_ZONE_POINTS, ok: points.length >= MIN_ZONE_POINTS };
  }
  const outside = routeOutsideSite(points, fences, kind);
  const hits = points.length ? routeViolations(points, from, fences, kind) : [];
  return {
    lengthM: Math.round(routeLength(points, from)),
    outside,
    fences: hits,
    full: points.length >= MAX_CHECKPOINTS,
    ok: points.length > 0 && outside.length === 0 && hits.length === 0,
  };
}

// ---- the one draft of this page -------------------------------------------------------

let current: RouteDraft | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export const routeDraft = {
  get: (): RouteDraft | null => current,
  start(d: Omit<RouteDraft, 'state' | 'initial'>) {
    const points = d.points.map(round);
    current = { ...d, points, initial: points, state: 'drawing' };
    emit();
  },
  setPoints(points: Point[]) {
    if (!current) return;
    current = { ...current, points };
    emit();
  },
  finish() {
    if (!current) return;
    current = { ...current, state: 'done' };
    emit();
  },
  /** Stop drawing and keep what was there before (the caller's form still gets its values back). */
  cancel() {
    if (!current) return;
    current = { ...current, points: current.initial, state: 'done' };
    emit();
  },
  clear() {
    if (!current) return;
    current = null;
    emit();
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function useRouteDraft() {
  return useSyncExternalStore(routeDraft.subscribe, routeDraft.get, routeDraft.get);
}

/** A finished drawing with points for this purpose and vehicle, if there is one. */
export function finishedDraft(d: RouteDraft | null, purpose: DraftPurpose, deviceId: string) {
  return d && d.state === 'done' && d.points.length > 0 && d.purpose === purpose && d.deviceId === deviceId ? d : null;
}
