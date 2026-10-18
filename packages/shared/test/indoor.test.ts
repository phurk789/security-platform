import { describe, expect, it } from 'vitest';
import { FLOOR_PLANS, floorPlan, inNoGo, roomAt, routeCrossesWalls, segmentsIntersect } from '../src/indoor';
import { constraintChecksAt } from '../src/policy';
import { seedDevices } from '../src/seed';
import type { Mission } from '../src/types';

describe('indoor geometry', () => {
  it('detects crossing segments', () => {
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }, { x: 10, y: 0 })).toBe(true);
    expect(segmentsIntersect({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }, { x: 10, y: 1 })).toBe(false);
  });

  it('builds floor plans with rooms, doors and a patrol route that stays clear of walls', () => {
    const plan = floorPlan('B2', 1)!;
    expect(FLOOR_PLANS.length).toBeGreaterThanOrEqual(3);
    expect(plan.rooms.some((r) => r.name === 'Lobby')).toBe(true);
    expect(plan.doors.some((d) => d.kind === 'fire')).toBe(true);
    expect(routeCrossesWalls(plan.patrolRoute, plan)).toBe(-1);
    expect(roomAt(plan, { x: 219, y: 80 })?.name).toBe('Lobby');
    expect(inNoGo(plan, { x: 215, y: 28 })?.name).toBe('Stairs');
  });

  it('builds a warehouse floor: rack rows, aisles, dock shutters and a serpentine patrol through every aisle', () => {
    const plan = floorPlan('B5', 1)!;
    expect(plan.racks!.length).toBeGreaterThanOrEqual(8);
    const aisles = plan.rooms.filter((r) => /^Aisle /.test(r.name));
    expect(aisles.length).toBe(plan.racks!.length - 1);
    expect(plan.doors.filter((x) => x.id.includes('dock')).length).toBe(4);
    expect(routeCrossesWalls(plan.patrolRoute, plan)).toBe(-1);
    expect(plan.patrolRoute.some((p) => inNoGo(plan, p))).toBe(false);
    for (const a of aisles) expect(plan.patrolRoute.some((p) => roomAt(plan, { x: p.x, y: (a.poly[0].y + a.poly[2].y) / 2 }) === a)).toBe(true);
    expect(plan.patrolRoute[0]).toEqual(plan.patrolRoute.at(-1));
  });

  it('flags a route that goes through a wall into a room', () => {
    const plan = floorPlan('B2', 1)!;
    const room = plan.rooms.find((r) => r.name.startsWith('Reception'))!;
    const c = room.poly.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    // straight line from the lobby into the room centre crosses the room's partition wall
    expect(routeCrossesWalls([{ x: 219, y: 80 }, c], plan)).toBe(0);
  });
});

describe('indoor mission constraints', () => {
  const now = Date.now();
  const d = seedDevices(now)['UGV-04'];
  const mission = (checkpoints: { x: number; y: number }[]): Mission => ({
    id: 'M',
    incidentId: 'I',
    deviceId: d.id,
    operatorId: 'u-somchai',
    checkpoints,
    planVersion: 1,
    status: 'draft',
    nextCp: 0,
    createdAt: now,
  });

  it('accepts the warehouse patrol and rejects routes through racks, outside or into the fuel store', () => {
    const plan = floorPlan('B5', 1)!;
    const ok = constraintChecksAt(now, { ...d, lastSeen: now, battery: 80 }, mission(plan.patrolRoute), () => 'Somchai');
    expect(ok.filter((c) => c.hard).every((c) => c.ok)).toBe(true);
    expect(ok.map((c) => c.label)).toEqual(expect.arrayContaining(['Route inside building', 'Route clear of walls', 'Avoids no-go areas']));
    const outside = constraintChecksAt(now, { ...d, lastSeen: now }, mission([{ x: 300, y: 200 }]), () => '');
    expect(outside.find((c) => c.label === 'Route inside building')?.ok).toBe(false);
    const fuel = plan.noGo.find((r) => r.name === 'Fuel store')!;
    const fc = fuel.poly.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
    const intoFuel = constraintChecksAt(now, { ...d, lastSeen: now }, mission([fc]), () => '');
    expect(intoFuel.find((c) => c.label === 'Avoids no-go areas')?.ok).toBe(false);
    // straight across the hall cuts through the racking
    const across = constraintChecksAt(now, { ...d, lastSeen: now }, mission([{ x: 155, y: 165 }]), () => '');
    expect(across.find((c) => c.label === 'Route clear of walls')?.ok).toBe(false);
  });
});
