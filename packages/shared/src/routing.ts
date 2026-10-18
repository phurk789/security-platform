// Route planning and geofences on the site grid: an A* planner over a 2 m grid that keeps
// vehicles off buildings, inside the fence (through the gate) and out of keep-out zones, plus
// the geometry every client and the server share to judge a route or a live position.
import { BUILDINGS, FENCE_Y, GATE, SITE, insideDemoArea } from './site';
import { INDOOR_UGV_SPEED, UGV_SPEED } from './policy';
import { floorPlan, routeCrossesWalls } from './indoor';
import { atBuilding } from './site';
import type { Point } from './types';

// ---------------------------------------------------------------------------
// Geofences
// ---------------------------------------------------------------------------

export type GeofenceKind = 'keep_out' | 'caution' | 'no_fly';
export type FencedKind = 'ugv' | 'uav';

export interface Geofence {
  id: string;
  name: string;
  /** keep_out: vehicles must not enter (routes refused, live breach raised). caution: routes allowed, live entry noted. no_fly: aircraft only. */
  kind: GeofenceKind;
  poly: Point[];
  active: boolean;
  appliesTo: FencedKind[];
  reason?: string;
  createdBy?: string;
  createdAt?: number;
}

export const GEOFENCE_KIND_LABEL: Record<GeofenceKind, string> = { keep_out: 'Keep-out', caution: 'Caution', no_fly: 'No-fly' };

/** Starting fences for the demo site. Administrators and supervisors change them in the console. */
export const DEFAULT_GEOFENCES: Geofence[] = [
  {
    id: 'GF-FUEL',
    name: 'Fuel store (diesel), west of Building 5',
    kind: 'keep_out',
    poly: [
      { x: 34, y: 140 },
      { x: 54, y: 140 },
      { x: 54, y: 176 },
      { x: 34, y: 176 },
    ],
    active: true,
    appliesTo: ['ugv', 'uav'],
    reason: 'Diesel store: no vehicles or rotors within 8 m.',
  },
  {
    id: 'GF-B2-ROOF',
    name: 'Building 2 roof, no overflight',
    kind: 'no_fly',
    poly: [
      { x: 142, y: 92 },
      { x: 214, y: 92 },
      { x: 214, y: 200 },
      { x: 142, y: 200 },
    ],
    active: true,
    appliesTo: ['uav'],
    reason: 'Engineering offices and solvent store below: no overflight during working hours.',
  },
  {
    id: 'GF-PLAZA',
    name: 'Staff yard when occupied',
    kind: 'caution',
    poly: [
      { x: 70, y: 184 },
      { x: 140, y: 184 },
      { x: 140, y: 228 },
      { x: 70, y: 228 },
    ],
    active: true,
    appliesTo: ['ugv'],
    reason: 'Pedestrian area (staff parking and sports pitch): walking pace, announce before entering.',
  },
];

/** Geofence shapes per demo site (applied by applySiteVariant). */
export const GEOFENCE_VARIANTS: Record<'amata' | 'civic', Record<string, { poly: Point[]; name: string; reason: string }>> = {
  amata: Object.fromEntries(DEFAULT_GEOFENCES.map((g) => [g.id, { poly: g.poly.map((p) => ({ ...p })), name: g.name, reason: g.reason ?? '' }])),
  civic: {
    'GF-FUEL': {
      name: 'Fuel store (diesel), Building 5 west',
      reason: 'Diesel store: no vehicles or rotors within 8 m.',
      poly: [
        { x: 62, y: 150 },
        { x: 84, y: 150 },
        { x: 84, y: 192 },
        { x: 62, y: 192 },
      ],
    },
    'GF-B2-ROOF': {
      name: 'Building 2 roof, no overflight',
      reason: 'Public counters below: no overflight during opening hours.',
      poly: [
        { x: 170, y: 18 },
        { x: 268, y: 18 },
        { x: 268, y: 96 },
        { x: 170, y: 96 },
      ],
    },
    'GF-PLAZA': {
      name: 'Plaza when occupied',
      reason: 'Pedestrian area: walking pace, announce before entering.',
      poly: [
        { x: 186, y: 98 },
        { x: 242, y: 98 },
        { x: 242, y: 154 },
        { x: 186, y: 154 },
      ],
    },
  },
};

export function setGeofenceData(v: 'amata' | 'civic') {
  for (const g of DEFAULT_GEOFENCES) {
    const d = GEOFENCE_VARIANTS[v][g.id];
    if (d) Object.assign(g, { poly: d.poly.map((p) => ({ ...p })), name: d.name, reason: d.reason });
  }
}

export function insidePoly(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function orient(a: Point, b: Point, c: Point) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/** True if the segment a→b touches the polygon (enters it or crosses an edge). */
export function segmentHitsPoly(a: Point, b: Point, poly: Point[]) {
  if (insidePoly(a, poly) || insidePoly(b, poly)) return true;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) if (segmentsCross(a, b, poly[i], poly[j])) return true;
  return false;
}

/** Active fences of the blocking kind that a route (optionally starting from `from`) would enter. */
export function routeViolations(route: Point[], from: Point | undefined, fences: Geofence[], kind: FencedKind): Geofence[] {
  const pts = from ? [from, ...route] : route;
  const blocking = fences.filter((f) => f.active && f.appliesTo.includes(kind) && (kind === 'uav' ? f.kind === 'no_fly' || f.kind === 'keep_out' : f.kind === 'keep_out'));
  return blocking.filter((f) => {
    for (let i = 0; i < pts.length; i++) {
      if (i === 0 && from && insidePoly(pts[0], f.poly)) continue; // already inside at the start: leaving is allowed
      if (i > 0 && segmentHitsPoly(pts[i - 1], pts[i], f.poly)) return true;
      if (i === 0 && !from && insidePoly(pts[0], f.poly)) return true;
    }
    return false;
  });
}

/** Fences a vehicle at `p` is inside of (any kind that applies to it). */
export function fencesAt(p: Point, fences: Geofence[], kind: FencedKind) {
  return fences.filter((f) => f.active && f.appliesTo.includes(kind) && insidePoly(p, f.poly));
}

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

export interface PlanOptions {
  fences?: Geofence[];
  kind?: FencedKind;
  /** Clearance from buildings and fences (m). Default 3 for ground vehicles, 6 for aircraft. */
  marginM?: number;
  /** Grid cell (m). Default 2. */
  cellM?: number;
  /** Extra points the route must pass through, in order. */
  via?: Point[];
}

export type Plan = { ok: true; checkpoints: Point[]; lengthM: number; etaS: number } | { ok: false; reason: string };

const DIRS: [number, number, number][] = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

function blockedTest(opts: PlanOptions) {
  const kind = opts.kind ?? 'ugv';
  const margin = opts.marginM ?? (kind === 'uav' ? 6 : 3);
  const fences = (opts.fences ?? []).filter((f) => f.active && f.appliesTo.includes(kind) && (kind === 'uav' ? f.kind !== 'caution' : f.kind === 'keep_out'));
  const inflated = fences.map((f) => inflate(f.poly, margin * 0.5));
  return (p: Point) => {
    if (!insideDemoArea(p)) return true;
    if (kind === 'ugv') {
      for (const b of BUILDINGS) if (p.x > b.x - margin && p.x < b.x + b.w + margin && p.y > b.y - margin && p.y < b.y + b.d + margin) return true;
      // The fence line, except through the gate.
      if (Math.abs(p.y - FENCE_Y) < margin && (p.x < GATE.x + 1 || p.x > GATE.x + GATE.w - 1)) return true;
    }
    for (const poly of inflated) if (insidePoly(p, poly)) return true;
    return false;
  };
}

/** Grows a convex-ish polygon away from its centroid by `d` metres. */
function inflate(poly: Point[], d: number): Point[] {
  const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length;
  const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length;
  return poly.map((p) => {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const n = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / n) * d, y: p.y + (dy / n) * d };
  });
}

function segmentClear(a: Point, b: Point, blocked: (p: Point) => boolean) {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)));
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    if (blocked({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })) return false;
  }
  return true;
}

/** A* on the grid between two points. Returns grid points (cell centres) or null. */
function astar(from: Point, to: Point, blocked: (p: Point) => boolean, cell: number): Point[] | null {
  const cols = Math.ceil(SITE.width / cell) + 1;
  const rows = Math.ceil(SITE.height / cell) + 1;
  const toCell = (p: Point) => ({ c: Math.max(0, Math.min(cols - 1, Math.round(p.x / cell))), r: Math.max(0, Math.min(rows - 1, Math.round(p.y / cell))) });
  const toPt = (c: number, r: number): Point => ({ x: c * cell, y: r * cell });
  const key = (c: number, r: number) => r * cols + c;
  const start = toCell(from);
  const goal = toCell(to);
  // A goal inside an obstacle margin (e.g. an alert at a building door) is allowed: we plan to the nearest free cell.
  const goalFree = !blocked(toPt(goal.c, goal.r));
  const g = new Float64Array(cols * rows).fill(Infinity);
  const came = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const open: { k: number; f: number }[] = [];
  const push = (k: number, f: number) => {
    open.push({ k, f });
    let i = open.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (open[p].f <= open[i].f) break;
      [open[p], open[i]] = [open[i], open[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = open[0];
    const last = open.pop()!;
    if (open.length) {
      open[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < open.length && open[l].f < open[m].f) m = l;
        if (r < open.length && open[r].f < open[m].f) m = r;
        if (m === i) break;
        [open[m], open[i]] = [open[i], open[m]];
        i = m;
      }
    }
    return top;
  };
  const h = (c: number, r: number) => {
    const dx = Math.abs(c - goal.c);
    const dy = Math.abs(r - goal.r);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  const sk = key(start.c, start.r);
  g[sk] = 0;
  push(sk, h(start.c, start.r));
  let best = -1;
  let bestD = Infinity;
  let expanded = 0;
  while (open.length && expanded < 60_000) {
    const { k } = pop();
    if (closed[k]) continue;
    closed[k] = 1;
    expanded++;
    const c = k % cols;
    const r = (k - c) / cols;
    const dGoal = Math.hypot(c - goal.c, r - goal.r);
    if (dGoal < bestD) {
      bestD = dGoal;
      best = k;
    }
    if (c === goal.c && r === goal.r) break;
    if (!goalFree && dGoal <= 1.5) break;
    for (const [dc, dr, cost] of DIRS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const nk = key(nc, nr);
      if (closed[nk]) continue;
      const np = toPt(nc, nr);
      if (blocked(np) && !(nc === goal.c && nr === goal.r)) continue;
      // No corner cutting between two blocked cells.
      if (dc && dr && blocked(toPt(c + dc, r)) && blocked(toPt(c, r + dr))) continue;
      const ng = g[k] + cost;
      if (ng < g[nk]) {
        g[nk] = ng;
        came[nk] = k;
        push(nk, ng + h(nc, nr));
      }
    }
  }
  const endK = closed[key(goal.c, goal.r)] ? key(goal.c, goal.r) : !goalFree && bestD <= 1.5 ? best : -1;
  if (endK < 0) return null;
  const path: Point[] = [];
  for (let k = endK; k >= 0; k = came[k]) {
    const c = k % cols;
    path.push(toPt(c, (k - c) / cols));
  }
  return path.reverse();
}

/** String-pulling: keep only the corners a straight drive needs. */
function simplify(pts: Point[], blocked: (p: Point) => boolean): Point[] {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !segmentClear(pts[i], pts[j], blocked)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export function routeLength(pts: Point[], from?: Point) {
  const all = from ? [from, ...pts] : pts;
  let len = 0;
  for (let i = 1; i < all.length; i++) len += Math.hypot(all[i].x - all[i - 1].x, all[i].y - all[i - 1].y);
  return len;
}

export function etaSeconds(lengthM: number, speedMps = UGV_SPEED) {
  // Acceleration, corners and the approach add roughly 15 s per leg on a patrol vehicle.
  return Math.round(lengthM / Math.max(0.5, speedMps) + 15);
}

/**
 * Plans checkpoints from `from` to `to` (through `via`, in order) that stay off buildings, inside
 * the fence (through the gate) and out of keep-out zones. The result is a short list of corners
 * the mission planner can submit for approval.
 */
export function planRoute(from: Point, to: Point, opts: PlanOptions = {}): Plan {
  const kind = opts.kind ?? 'ugv';
  const cell = opts.cellM ?? 2;
  const blocked = blockedTest(opts);
  if (!insideDemoArea(to)) return { ok: false, reason: 'Destination is outside the site boundary.' };
  const fences = (opts.fences ?? []).filter((f) => f.active && f.appliesTo.includes(kind) && (kind === 'uav' ? f.kind !== 'caution' : f.kind === 'keep_out'));
  const inside = fences.find((f) => insidePoly(to, f.poly));
  if (inside) return { ok: false, reason: `Destination is inside the ${GEOFENCE_KIND_LABEL[inside.kind].toLowerCase()} zone "${inside.name}".` };
  const legs = [from, ...(opts.via ?? []), to];
  const out: Point[] = [];
  for (let i = 1; i < legs.length; i++) {
    const a = i === 1 ? from : out[out.length - 1];
    const b = legs[i];
    let leg: Point[];
    if (kind === 'uav' && segmentClear(a, b, blocked)) leg = [a, b];
    else if (segmentClear(a, b, blocked)) leg = [a, b];
    else {
      const grid = astar(a, b, blocked, cell);
      if (!grid) return { ok: false, reason: `No clear path to ${i === legs.length - 1 ? 'the destination' : `waypoint ${i}`} around buildings and keep-out zones.` };
      // Snap the ends to the real points, then pull the string tight.
      grid[0] = a;
      grid[grid.length - 1] = b;
      leg = simplify(grid, blocked);
    }
    for (const p of leg.slice(1)) out.push({ x: round1(p.x), y: round1(p.y) });
  }
  // Drop near-duplicates and cap the checkpoint count.
  const cps = out.filter((p, i) => i === 0 || Math.hypot(p.x - out[i - 1].x, p.y - out[i - 1].y) > 0.5);
  while (cps.length > 50) cps.splice(1, 1);
  const lengthM = Math.round(routeLength(cps, from));
  return { ok: true, checkpoints: cps, lengthM, etaS: etaSeconds(lengthM, kind === 'uav' ? 9 : UGV_SPEED) };
}

export interface IndoorUnit {
  pos: Point;
  indoor?: { buildingId: string; level: number };
}

/**
 * Route for an indoor vehicle: it stays on its building floor (LiDAR SLAM, no GNSS), so it can only
 * reach places inside that building, along a leg that does not cross a wall.
 */
export function planIndoor(u: IndoorUnit & { indoor: { buildingId: string; level: number } }, to: Point): Plan {
  const b = BUILDINGS.find((x) => x.id === u.indoor.buildingId);
  const name = b?.name ?? u.indoor.buildingId;
  if (!b || !atBuilding(b, to, 0)) return { ok: false, reason: `Indoor only: stays on ${name}, level ${u.indoor.level}. The alert is outside the building.` };
  const plan = floorPlan(u.indoor.buildingId, u.indoor.level);
  if (!plan) return { ok: false, reason: `No floor plan for ${name}, level ${u.indoor.level}.` };
  if (routeCrossesWalls([u.pos, to], plan) >= 0) return { ok: false, reason: `Inside ${name}: no wall-free direct leg. Use the floor patrol.` };
  const lengthM = Math.round(Math.hypot(to.x - u.pos.x, to.y - u.pos.y));
  return { ok: true, checkpoints: [{ x: round1(to.x), y: round1(to.y) }], lengthM, etaS: etaSeconds(lengthM, INDOOR_UGV_SPEED) };
}

/** planRoute for any vehicle: indoor vehicles use their floor, others the site planner. */
export function planFor(u: IndoorUnit & { kind: string }, to: Point, opts: PlanOptions = {}): Plan {
  if (u.indoor) return planIndoor(u as IndoorUnit & { indoor: { buildingId: string; level: number } }, to);
  return planRoute(u.pos, to, { ...opts, kind: u.kind as FencedKind });
}

/** Candidate vehicles for a place, ranked by estimated arrival. */
export function rankUnits<T extends { id: string; kind: string; pos: Point; battery?: number; indoor?: { buildingId: string; level: number } }>(
  units: T[],
  to: Point,
  fences: Geofence[],
): { unit: T; plan: Plan; etaS: number; lengthM: number }[] {
  return units
    .filter((u) => u.kind === 'ugv' || u.kind === 'uav')
    .map((u) => {
      const plan = planFor(u, to, { fences });
      return { unit: u, plan, etaS: plan.ok ? plan.etaS : Infinity, lengthM: plan.ok ? plan.lengthM : Infinity };
    })
    .sort((a, b) => a.etaS - b.etaS);
}
