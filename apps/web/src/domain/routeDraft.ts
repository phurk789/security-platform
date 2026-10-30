// A route (or a zone outline) being drawn on the real map: points in site metres, checked as they
// are drawn against the same rules the server and the approval checks use (inside the site's
// operating area — or the demo boundary when it has none — clear of keep-out zones, at most 50
// checkpoints). The draft lives outside React state so a form on another page (patrols, zones)
// can start a drawing on the overview map and pick the result up when it comes back.
import { useSyncExternalStore } from 'react';
import { geoToSite, polygonArea, polygonPerimeter, polygonSelfIntersects, routeLength, siteToGeo, type GeoAnchor, routeOutsideSite, routeViolations, type FencedKind, type Geofence, type GeofenceKind, type Point, type RoutePoint, type View } from '@13store/shared';

/** The server accepts 1–50 checkpoints per route. */
export const MAX_CHECKPOINTS = 50;
/** The server accepts 3–30 corners per zone. */
export const MIN_ZONE_POINTS = 3;
export const MAX_ZONE_POINTS = 30;

/** zone: an outline for the Admin form; geofence: a zone drawn or reshaped and saved on the map. */
export type DraftPurpose = 'mission-new' | 'mission-edit' | 'patrol' | 'zone' | 'geofence';

/** The zone editor on the map: what the zone is, and whether clicks still add corners. */
export interface ZoneMeta {
  /** Set when an existing zone is being changed. */
  id?: string;
  name: string;
  kind: GeofenceKind;
  appliesTo: FencedKind[];
  reason: string;
  active: boolean;
  /** draw: each map click adds a corner. edit: drag corners, drag or click the midpoints to add one. */
  mode: 'draw' | 'edit';
  /** rect: two clicks give the opposite corners of a north-up rectangle. */
  shape: 'polygon' | 'rect';
}

export const isZonePurpose = (p: DraftPurpose) => p === 'zone' || p === 'geofence';

export interface RouteDraft {
  purpose: DraftPurpose;
  /** The vehicle the route is for ('' for a zone). */
  deviceId: string;
  /** The mission whose route is being changed (mission-edit). */
  missionId?: string;
  /** Route checkpoints keep their settings (name, speed, wait, capture); zone corners are plain points. */
  points: RoutePoint[];
  /** The points when the drawing started; Cancel puts these back. */
  initial: RoutePoint[];
  /** Earlier point lists, newest last, for Undo. */
  past: RoutePoint[][];
  /** The checkpoint whose settings are open in the panel (routes). */
  selected?: number;
  /** drawing: the map takes clicks. done: finished, the caller collects the points. */
  state: 'drawing' | 'done';
  /** Page to go back to when the drawing ends (the patrol and zone forms are not on the map page). */
  returnTo?: View;
  /** Caller's form values, restored when it comes back. */
  meta?: unknown;
}

// `|| 0` turns -0 into 0.
const round = (p: Point): Point => ({ x: Math.round(p.x * 10) / 10 || 0, y: Math.round(p.y * 10) / 10 || 0 });
/** The same point at a rounded position, settings kept. */
const roundKeep = <P extends Point>(p: P): P => ({ ...p, ...round(p) });

export const maxPoints = (purpose: DraftPurpose) => (isZonePurpose(purpose) ? MAX_ZONE_POINTS : MAX_CHECKPOINTS);

/** Undo goes back this many steps. */
const HISTORY = 100;

export function addPoint(points: Point[], p: Point, max = MAX_CHECKPOINTS): Point[] {
  return points.length >= max ? points : [...points, round(p)];
}

/** Move a point; a checkpoint keeps its name, speed, wait and capture. */
export function movePoint<P extends Point>(points: P[], i: number, p: Point): P[] {
  return i < 0 || i >= points.length ? points : points.map((q, n) => (n === i ? { ...q, ...round(p) } : q));
}

/** Change a checkpoint's settings (undefined clears one). */
export function setPointSettings(points: RoutePoint[], i: number, patch: Partial<Omit<RoutePoint, 'x' | 'y'>>): RoutePoint[] {
  if (i < 0 || i >= points.length) return points;
  return points.map((q, n) => {
    if (n !== i) return q;
    const next: RoutePoint = { ...q, ...patch };
    for (const k of Object.keys(next) as (keyof RoutePoint)[]) if (next[k] === undefined || next[k] === '' || next[k] === false) delete next[k];
    return next;
  });
}

/** The same route driven the other way round. */
export const reverseRoute = (points: RoutePoint[]) => [...points].reverse();

/** Add the first checkpoint again at the end, so the route comes back to where it began. */
export function closeLoop(points: RoutePoint[], max = MAX_CHECKPOINTS): RoutePoint[] {
  if (points.length < 2 || points.length >= max) return points;
  const [a, z] = [points[0], points[points.length - 1]];
  if (a.x === z.x && a.y === z.y) return points;
  return [...points, { x: a.x, y: a.y, ...(a.name ? { name: a.name } : {}) }];
}

/** Whether the route already ends where it began. */
export const isLoop = (points: Point[]) => points.length > 2 && points[0].x === points[points.length - 1].x && points[0].y === points[points.length - 1].y;

export function insertPoint(points: Point[], i: number, p: Point, max = MAX_ZONE_POINTS): Point[] {
  if (points.length >= max || i < 0 || i > points.length) return points;
  return [...points.slice(0, i), round(p), ...points.slice(i)];
}

/** Corners of the north-up rectangle with opposite corners a and b (site metres; the site grid may be rotated). */
export function northUpRect(a: Point, b: Point, anchor: GeoAnchor): Point[] {
  const ga = siteToGeo(anchor, a);
  const gb = siteToGeo(anchor, b);
  return [
    { lat: ga.lat, lon: ga.lon },
    { lat: ga.lat, lon: gb.lon },
    { lat: gb.lat, lon: gb.lon },
    { lat: gb.lat, lon: ga.lon },
  ].map((g) => round(geoToSite(anchor, g)));
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
  /** Zones: area (m²) and whether two edges cross. */
  areaM2?: number;
  crosses?: boolean;
  /** Fit to save: a route with at least one checkpoint, all inside the site, no keep-out zone crossed; a zone with 3+ corners whose edges do not cross. */
  ok: boolean;
}

export function checkDraft(points: Point[], from: Point | undefined, fences: Geofence[], kind: 'ugv' | 'uav', purpose: DraftPurpose = 'mission-new'): DraftCheck {
  if (isZonePurpose(purpose)) {
    const crosses = polygonSelfIntersects(points);
    return {
      lengthM: Math.round(points.length > 2 ? polygonPerimeter(points) : routeLength(points)),
      areaM2: points.length > 2 ? Math.round(polygonArea(points)) : 0,
      crosses,
      outside: [],
      fences: [],
      full: points.length >= MAX_ZONE_POINTS,
      ok: points.length >= MIN_ZONE_POINTS && !crosses,
    };
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
  start(d: Omit<RouteDraft, 'state' | 'initial' | 'past'>) {
    const points = d.points.map(roundKeep);
    current = { ...d, points, initial: points, past: [], state: 'drawing', selected: undefined };
    emit();
  },
  setPoints(points: RoutePoint[]) {
    if (!current || points === current.points) return;
    const selected = current.selected !== undefined && current.selected < points.length ? current.selected : undefined;
    current = { ...current, points, selected, past: [...current.past, current.points].slice(-HISTORY) };
    emit();
  },
  /** Open a checkpoint's settings in the panel (undefined closes them). */
  select(i: number | undefined) {
    if (!current || current.selected === i) return;
    current = { ...current, selected: i };
    emit();
  },
  /** Back one change (an added, moved or removed point). */
  undo() {
    if (!current || !current.past.length) return;
    const past = current.past.slice(0, -1);
    current = { ...current, points: current.past[current.past.length - 1], past, selected: undefined };
    emit();
  },
  setMeta(meta: unknown) {
    if (!current) return;
    current = { ...current, meta };
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
