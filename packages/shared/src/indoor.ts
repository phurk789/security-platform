// Indoor operations: floor plans (from BIM or a facility drawing) and the geometry checks that keep
// an indoor vehicle's route inside the building, off the stairs and clear of walls.
// Coordinates stay in the site grid (metres), with the floor level kept separately, so one map
// serves outdoor and indoor devices.
import { BUILDINGS, type Building } from './site';
import type { Point } from './types';

export interface Wall {
  a: Point;
  b: Point;
  kind?: 'exterior' | 'interior' | 'glass';
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
  const on = (p: Point, q: Point, r: Point) => Math.min(p.x, r.x) - 1e-9 <= q.x && q.x <= Math.max(p.x, r.x) + 1e-9 && Math.min(p.y, r.y) - 1e-9 <= q.y && q.y <= Math.max(p.y, r.y) + 1e-9;
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
  doors.push({ id: `${b.id}-L${level}-stairs`, at: { x: cx - corridorW / 2 - 2.5, y: corridorN }, kind: 'stairs' }, { id: `${b.id}-L${level}-lift`, at: { x: cx + corridorW / 2 + 1.6, y: corridorN }, kind: 'lift' });
  walls.push({ a: { x: cx - corridorW / 2 - 5, y: north }, b: { x: cx - corridorW / 2 - 5, y: corridorN } }, { a: { x: cx + corridorW / 2 + 3.2, y: north }, b: { x: cx + corridorW / 2 + 3.2, y: corridorN } });
  walls.push(...wallsWithGaps({ x: cx - corridorW / 2 - 5, y: corridorN }, { x: cx + corridorW / 2 + 3.2, y: corridorN }, [{ x: cx - corridorW / 2 - 2.5, y: corridorN }, { x: cx + corridorW / 2 + 1.6, y: corridorN }]));
  // rooms either side of the corridor
  const roomLen = 9;
  const uses = level === 1 ? ['Reception', 'Security office', 'Meeting room', 'Archive', 'Post room', 'Facilities'] : ['Open office', 'Meeting room', 'Office', 'Store', 'Kitchen', 'Office'];
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
  const patrolRoute: Point[] = level === 1 ? [{ x: cx, y: south - 6 }, { x: cx, y: corridorS - 2 }, { x: cx, y: corridorN + 3 }, { x: cx, y: south - 6 }] : [{ x: cx, y: corridorS - 2 }, { x: cx, y: corridorN + 3 }, { x: cx, y: corridorS - 2 }];
  return { buildingId: b.id, level, name: `Level ${level}`, walls, rooms, doors, noGo, patrolRoute: patrolRoute.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })) };
}

const plans = new Map<string, FloorPlan>();
/** Demo floor plans: Building 2 (levels 1–2) and Building 4 (level 1). A real site imports its own. */
export const FLOOR_PLANS: FloorPlan[] = [
  makeOfficeFloor(BUILDINGS.find((b) => b.id === 'B2')!, 1),
  makeOfficeFloor(BUILDINGS.find((b) => b.id === 'B2')!, 2),
  makeOfficeFloor(BUILDINGS.find((b) => b.id === 'B4')!, 1),
];
for (const p of FLOOR_PLANS) plans.set(`${p.buildingId}:${p.level}`, p);

export function floorPlan(buildingId: string | undefined, level: number | undefined) {
  return buildingId === undefined || level === undefined ? undefined : plans.get(`${buildingId}:${level}`);
}

export function floorPlansOf(buildingId: string) {
  return FLOOR_PLANS.filter((p) => p.buildingId === buildingId).sort((a, b) => a.level - b.level);
}

/** Height of a floor above site ground (metres). */
export function levelHeight(b: Building, level: number) {
  return (level - 1) * b.bim.levelHeightM;
}
