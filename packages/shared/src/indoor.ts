// Indoor operations: floor plans (from BIM or a facility drawing) and the geometry checks that keep
// an indoor vehicle's route inside the building, off the stairs and clear of walls.
// Coordinates stay in the site grid (metres), with the floor level kept separately, so one map
// serves outdoor and indoor devices.
import { BUILDINGS, type Building } from './site';
import type { Point } from './types';

export interface Wall {
  a: Point;
  b: Point;
  kind?: 'exterior' | 'interior' | 'glass' | 'rack';
}

export interface Room {
  id: string;
  name: string;
  poly: Point[];
}

export interface Door {
  id: string;
  at: Point;
  kind: 'door' | 'fire' | 'lift' | 'stairs';
}

export interface FloorPlan {
  buildingId: string;
  level: number;
  name: string;
  walls: Wall[];
  rooms: Room[];
  doors: Door[];
  /** Areas a ground vehicle must never enter (stair cores, lift shafts, plant rooms). */
  noGo: Room[];
  /** A sensible patrol route on this floor (used as the default when planning a mission). */
  patrolRoute: Point[];
  /** Pallet racking (warehouses): drawn as tall shelving; their outlines are also walls, so routes
   *  stay in the aisles. */
  racks?: Room[];
  /** Height of the racking in metres (3D view). */
  rackHeightM?: number;
}

// ---------------------------------------------------------------------------
// geometry
// ---------------------------------------------------------------------------

const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

export function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point) {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (p: Point, q: Point, r: Point) =>
    Math.min(p.x, r.x) - 1e-9 <= q.x && q.x <= Math.max(p.x, r.x) + 1e-9 && Math.min(p.y, r.y) - 1e-9 <= q.y && q.y <= Math.max(p.y, r.y) + 1e-9;
  return (d1 === 0 && on(p3, p1, p4)) || (d2 === 0 && on(p3, p2, p4)) || (d3 === 0 && on(p1, p3, p2)) || (d4 === 0 && on(p1, p4, p2));
}

export function pointInPoly(p: Point, poly: Point[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** First route leg (index) that crosses a wall, or −1. The route includes the start position. */
export function routeCrossesWalls(route: Point[], plan: FloorPlan) {
  for (let i = 0; i + 1 < route.length; i++) for (const w of plan.walls) if (segmentsIntersect(route[i], route[i + 1], w.a, w.b)) return i;
  return -1;
}

export function roomAt(plan: FloorPlan, p: Point) {
  return plan.rooms.find((r) => pointInPoly(p, r.poly));
}

export function inNoGo(plan: FloorPlan, p: Point) {
  return plan.noGo.find((r) => pointInPoly(p, r.poly));
}

// ---------------------------------------------------------------------------
// demo floor plans, generated from the building footprints (a real site imports its own)
// ---------------------------------------------------------------------------

const rect = (x: number, y: number, w: number, d: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + d },
  { x, y: y + d },
];

/** Walls of a rectangle, each side split around door gaps (gap width in metres). */
function wallsWithGaps(a: Point, b: Point, gaps: Point[], gapW = 1.3, kind: Wall['kind'] = 'interior'): Wall[] {
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (len === 0) return [];
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  const cuts = gaps
    .map((g) => (g.x - a.x) * ux + (g.y - a.y) * uy)
    .filter((t) => t > 0 && t < len)
    .sort((p, q) => p - q);
  const out: Wall[] = [];
  let t0 = 0;
  for (const c of cuts) {
    const s = Math.max(t0, c - gapW / 2);
    if (s > t0) out.push({ a: { x: a.x + ux * t0, y: a.y + uy * t0 }, b: { x: a.x + ux * s, y: a.y + uy * s }, kind });
    t0 = Math.min(len, c + gapW / 2);
  }
  if (t0 < len) out.push({ a: { x: a.x + ux * t0, y: a.y + uy * t0 }, b: { ...b }, kind });
  return out;
}

/**
 * Office-type floor: lobby at the main (south) entrance on level 1, a central north–south
 * corridor, rooms either side with doors onto the corridor, a stair core and a lift near the
 * north end. Good enough to show indoor positioning, wall-aware routing and room names.
 */
export function makeOfficeFloor(b: Building, level: number): FloorPlan {
  const cx = b.x + b.w / 2;
  const corridorW = 3;
  const lobbyD = level === 1 ? 14 : 0;
  const north = b.y + 0.3;
  const south = b.y + b.d - 0.3;
  const west = b.x + 0.3;
  const east = b.x + b.w - 0.3;
  const walls: Wall[] = [];
  const rooms: Room[] = [];
  const doors: Door[] = [];
  const noGo: Room[] = [];
  const mainDoor = { x: cx, y: south };
  // exterior walls (main entrance gap on the south face at level 1, fire exits at two corners)
  const fireW = { x: west + 4, y: north };
  const fireE = { x: east - 4, y: south };
  walls.push(...wallsWithGaps({ x: west, y: north }, { x: east, y: north }, level === 1 ? [fireW] : [], 1.3, 'exterior'));
  walls.push(...wallsWithGaps({ x: east, y: north }, { x: east, y: south }, [], 1.3, 'exterior'));
  walls.push(...wallsWithGaps({ x: east, y: south }, { x: west, y: south }, level === 1 ? [mainDoor, fireE] : [], level === 1 ? 3.2 : 1.3, 'exterior'));
  walls.push(...wallsWithGaps({ x: west, y: south }, { x: west, y: north }, [], 1.3, 'exterior'));
  if (level === 1) {
    doors.push({ id: `${b.id}-L1-main`, at: mainDoor, kind: 'door' }, { id: `${b.id}-L1-fw`, at: fireW, kind: 'fire' }, { id: `${b.id}-L1-fe`, at: fireE, kind: 'fire' });
    rooms.push({ id: `${b.id}-L1-lobby`, name: 'Lobby', poly: rect(west, south - lobbyD, east - west, lobbyD) });
    // lobby north wall with the corridor opening
    walls.push(...wallsWithGaps({ x: west, y: south - lobbyD }, { x: east, y: south - lobbyD }, [{ x: cx, y: south - lobbyD }], corridorW + 0.4));
  }
  const corridorN = north + 8; // stair core and lift sit across the north end
  const corridorS = south - lobbyD;
  rooms.push({ id: `${b.id}-L${level}-corr`, name: 'Corridor', poly: rect(cx - corridorW / 2, corridorN, corridorW, corridorS - corridorN) });
  // stair core and lift at the north end (no-go for vehicles)
  const stairs = rect(cx - corridorW / 2 - 5, north, 5, 7.6);
  const lift = rect(cx + corridorW / 2, north, 3.2, 7.6);
  noGo.push({ id: `${b.id}-L${level}-stairs`, name: 'Stairs', poly: stairs }, { id: `${b.id}-L${level}-lift`, name: 'Lift', poly: lift });
  doors.push(
    { id: `${b.id}-L${level}-stairs`, at: { x: cx - corridorW / 2 - 2.5, y: corridorN }, kind: 'stairs' },
    { id: `${b.id}-L${level}-lift`, at: { x: cx + corridorW / 2 + 1.6, y: corridorN }, kind: 'lift' },
  );
  walls.push(
    { a: { x: cx - corridorW / 2 - 5, y: north }, b: { x: cx - corridorW / 2 - 5, y: corridorN } },
    { a: { x: cx + corridorW / 2 + 3.2, y: north }, b: { x: cx + corridorW / 2 + 3.2, y: corridorN } },
  );
  walls.push(
    ...wallsWithGaps({ x: cx - corridorW / 2 - 5, y: corridorN }, { x: cx + corridorW / 2 + 3.2, y: corridorN }, [
      { x: cx - corridorW / 2 - 2.5, y: corridorN },
      { x: cx + corridorW / 2 + 1.6, y: corridorN },
    ]),
  );
  // rooms either side of the corridor
  const roomLen = 9;
  const uses =
    level === 1 ? ['Reception', 'Security office', 'Meeting room', 'Archive', 'Post room', 'Facilities'] : ['Open office', 'Meeting room', 'Office', 'Store', 'Kitchen', 'Office'];
  let n = 0;
  for (const side of [-1, 1] as const) {
    const roomX = side < 0 ? west : cx + corridorW / 2;
    const roomW = side < 0 ? cx - corridorW / 2 - west : east - (cx + corridorW / 2);
    const corrX = side < 0 ? cx - corridorW / 2 : cx + corridorW / 2;
    const doorsOnSide: Point[] = [];
    let y = corridorN;
    while (y + roomLen <= corridorS + 0.01) {
      const id = `${b.id}-L${level}-R${++n}`;
      rooms.push({ id, name: `${uses[(n - 1) % uses.length]} ${level}.${String(n).padStart(2, '0')}`, poly: rect(roomX, y, roomW, roomLen) });
      doorsOnSide.push({ x: corrX, y: y + roomLen / 2 });
      doors.push({ id, at: { x: corrX, y: y + roomLen / 2 }, kind: 'door' });
      if (y + roomLen < corridorS - 0.01) walls.push({ a: { x: roomX, y: y + roomLen }, b: { x: roomX + roomW, y: y + roomLen } });
      y += roomLen;
    }
    walls.push(...wallsWithGaps({ x: corrX, y: corridorN }, { x: corrX, y: corridorS }, doorsOnSide));
  }
  const patrolRoute: Point[] =
    level === 1
      ? [
          { x: cx, y: south - 6 },
          { x: cx, y: corridorS - 2 },
          { x: cx, y: corridorN + 3 },
          { x: cx, y: south - 6 },
        ]
      : [
          { x: cx, y: corridorS - 2 },
          { x: cx, y: corridorN + 3 },
          { x: cx, y: corridorS - 2 },
        ];
  return {
    buildingId: b.id,
    level,
    name: `Level ${level}`,
    walls,
    rooms,
    doors,
    noGo,
    patrolRoute: patrolRoute.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),
  };
}

/**
 * Warehouse / storage floor: one open hall with rows of double-sided pallet racking running
 * north–south, a cross aisle at each end, a goods-in/out staging area behind the loading dock
 * (roller shutters on the south face), a dispatch office in the south-west corner, the fuel store
 * (west) and the forklift charging bay (north-east) as no-go areas. The patrol is a serpentine
 * through every aisle, so the robot's camera looks down each rack face once per round.
 */
export function makeWarehouseFloor(b: Building, level = 1): FloorPlan {
  const north = b.y + 0.3;
  const south = b.y + b.d - 0.3;
  const west = b.x + 0.3;
  const east = b.x + b.w - 0.3;
  const id = (s: string) => `${b.id}-L${level}-${s}`;
  const walls: Wall[] = [];
  const rooms: Room[] = [];
  const doors: Door[] = [];
  const noGo: Room[] = [];
  const racks: Room[] = [];
  const rackD = 2.4; // back-to-back pallet racking
  const aisleW = 3.4; // narrow aisle for a reach truck; the robot drives the centre line
  const pitch = rackD + aisleW;
  const crossN = north + 9.7; // north cross aisle (centre line)
  const crossS = south - 19.7; // south cross aisle, in front of the staging area
  const rackN = crossN + 2;
  const rackS = crossS - 2;
  const rackW0 = west + 12.7; // west main aisle beside the fuel store and office
  const nRows = Math.floor((east - 4.5 - rackW0 + aisleW) / pitch);
  // exterior: 4 dock shutters + a personnel door on the south face, fire exit on the north face
  const officeE = west + 13.7;
  const docks = [0, 1, 2, 3].map((i) => ({ x: officeE + 10 + i * ((east - officeE - 16) / 3), y: south }));
  const staff = { x: officeE + 3, y: south };
  const fire = { x: (west + east) / 2, y: north };
  walls.push(...wallsWithGaps({ x: west, y: north }, { x: east, y: north }, level === 1 ? [fire] : [], 1.3, 'exterior'));
  walls.push(...wallsWithGaps({ x: east, y: north }, { x: east, y: south }, [], 1.3, 'exterior'));
  walls.push(...wallsWithGaps({ x: east, y: south }, { x: west, y: south }, level === 1 ? docks : [], 4, 'exterior'));
  if (level === 1) walls.push(...wallsWithGaps({ x: officeE + 6, y: south }, { x: officeE, y: south }, [staff], 1.2, 'exterior'));
  walls.push(...wallsWithGaps({ x: west, y: south }, { x: west, y: north }, [], 1.3, 'exterior'));
  docks.forEach((d, i) => doors.push({ id: id(`dock${i + 1}`), at: d, kind: 'door' }));
  doors.push({ id: id('staff'), at: staff, kind: 'door' }, { id: id('fire'), at: fire, kind: 'fire' });
  // dispatch office (south-west), door onto the staging area
  const officeN = south - 13;
  const officeDoor = { x: officeE, y: south - 6.5 };
  rooms.push({ id: id('office'), name: 'Dispatch office', poly: rect(west, officeN, officeE - west, south - officeN) });
  walls.push({ a: { x: west, y: officeN }, b: { x: officeE, y: officeN } }, ...wallsWithGaps({ x: officeE, y: officeN }, { x: officeE, y: south }, [officeDoor]));
  doors.push({ id: id('office'), at: officeDoor, kind: 'door' });
  // fuel store (west, fire-rated walls) and forklift charging (north-east): vehicles keep out
  const fuel = rect(west, north + 12, 8, 12);
  noGo.push({ id: id('fuel'), name: 'Fuel store', poly: fuel });
  for (let i = 0; i < 4; i++) walls.push({ a: fuel[i], b: fuel[(i + 1) % 4] });
  noGo.push({ id: id('charge'), name: 'Forklift charging', poly: rect(east - 12, north, 12, 7.5) });
  // staging area behind the dock, the two cross aisles and the west main aisle
  rooms.push({ id: id('staging'), name: 'Goods-in / goods-out staging', poly: rect(officeE, crossS + 2, east - officeE, south - crossS - 2) });
  rooms.push({ id: id('crossN'), name: 'Cross aisle', poly: rect(rackW0, crossN - 2, east - rackW0, 4) });
  rooms.push({ id: id('crossS'), name: 'Cross aisle', poly: rect(west + 8, crossS - 2, east - west - 8, 4) });
  // racking rows and the aisles between them (Aisle A, B, …)
  const aisles: number[] = [];
  for (let k = 0; k < nRows; k++) {
    const x0 = rackW0 + k * pitch;
    const r = rect(x0, rackN, rackD, rackS - rackN);
    racks.push({ id: id(`rack${k + 1}`), name: `Rack ${String(k + 1).padStart(2, '0')}`, poly: r });
    for (let i = 0; i < 4; i++) walls.push({ a: r[i], b: r[(i + 1) % 4], kind: 'rack' });
    if (k + 1 < nRows) {
      const ax = x0 + rackD;
      const letter = String.fromCharCode(65 + k);
      rooms.push({ id: id(`aisle${letter}`), name: `Aisle ${letter}`, poly: rect(ax, rackN, aisleW, rackS - rackN) });
      aisles.push(ax + aisleW / 2);
    }
  }
  // the east aisle between the last rack and the outside wall closes the loop
  const eastAisle = (rackW0 + (nRows - 1) * pitch + rackD + east) / 2;
  rooms.push({ id: id('aisleE'), name: 'East aisle', poly: rect(rackW0 + (nRows - 1) * pitch + rackD, rackN, east - (rackW0 + (nRows - 1) * pitch + rackD), rackS - rackN) });
  // serpentine patrol: up one aisle, down the next, back along the south cross aisle
  const start = { x: rackW0 - 4, y: crossS };
  const route: Point[] = [start];
  aisles.forEach((x, i) => {
    const [a, c] = i % 2 === 0 ? [crossS, crossN] : [crossN, crossS];
    route.push({ x, y: a }, { x, y: c });
  });
  const endY = aisles.length % 2 === 1 ? crossN : crossS;
  route.push({ x: eastAisle, y: endY });
  if (endY === crossN) route.push({ x: eastAisle, y: crossS });
  route.push(start);
  const r1 = (p: Point) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 });
  return { buildingId: b.id, level, name: `Level ${level} · warehouse`, walls, rooms, doors, noGo, racks, rackHeightM: 6, patrolRoute: route.map(r1) };
}

const plans = new Map<string, FloorPlan>();
/** Demo floor plans: Building 2 (levels 1–2), Building 4 (level 1) and the Building 5 warehouse
 *  (level 1). A real site imports its own. */
export const FLOOR_PLANS: FloorPlan[] = [];
/** (Re)build the demo floor plans from the current buildings (after a site switch too). */
export function rebuildFloorPlans() {
  const b = (id: string) => BUILDINGS.find((x) => x.id === id)!;
  FLOOR_PLANS.splice(0, FLOOR_PLANS.length, makeOfficeFloor(b('B2'), 1), makeOfficeFloor(b('B2'), 2), makeOfficeFloor(b('B4'), 1), makeWarehouseFloor(b('B5'), 1));
  plans.clear();
  for (const p of FLOOR_PLANS) plans.set(`${p.buildingId}:${p.level}`, p);
}
rebuildFloorPlans();

export function floorPlan(buildingId: string | undefined, level: number | undefined) {
  return buildingId === undefined || level === undefined ? undefined : plans.get(`${buildingId}:${level}`);
}

export function floorPlansOf(buildingId: string) {
  return FLOOR_PLANS.filter((p) => p.buildingId === buildingId).sort((a, b) => a.level - b.level);
}

/** Quiet time after the last command before an indoor patrol robot goes back to its own round,
 *  so an operator's stop is confirmed and stays visible. */
export const FLOOR_PATROL_RESUME_MS = 20_000;

/**
 * The floor's patrol round as a route starting from `here`: it rejoins at the nearest point
 * reachable in a straight line without crossing a wall or rack, runs the loop once and closes it.
 * Null when there is no round or nothing is reachable (the robot then waits for an operator).
 */
export function floorPatrolLoop(plan: FloorPlan | undefined, here: Point): Point[] | null {
  const loop = plan?.patrolRoute;
  if (!plan || !loop || loop.length < 2) return null;
  const closed = loop[0].x === loop.at(-1)!.x && loop[0].y === loop.at(-1)!.y;
  const ring = closed ? loop.slice(0, -1) : loop;
  let start = -1;
  let best = Infinity;
  ring.forEach((p, i) => {
    const d = Math.hypot(p.x - here.x, p.y - here.y);
    if (d < best && routeCrossesWalls([here, p], plan) < 0) {
      best = d;
      start = i;
    }
  });
  if (start < 0) return null;
  return [...ring.slice(start), ...ring.slice(0, start), ring[start]].map((p) => ({ ...p }));
}

/** Height of a floor above site ground (metres). */
export function levelHeight(b: Building, level: number) {
  return (level - 1) * b.bim.levelHeightM;
}
