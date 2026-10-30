// Operating areas: a real site defines where its vehicles may work. Routes must stay inside (legs
// included, the area may be concave); without an area the demo site boundary still applies.
import { describe, expect, it } from 'vitest';
import { constraintChecksAt, insideSite, operatingAreas, routeOutsideSite, type Device, type Geofence, type Mission } from '../src';

// An L-shaped yard around the office, north-west of the demo grid (negative y is north of it).
const yard: Geofence = {
  id: 'GF-YARD',
  name: 'Office yard',
  kind: 'operating_area',
  active: true,
  appliesTo: ['ugv', 'uav'],
  poly: [
    { x: 0, y: -40 },
    { x: 40, y: -40 },
    { x: 40, y: -20 },
    { x: 20, y: -20 },
    { x: 20, y: 0 },
    { x: 0, y: 0 },
  ],
};

describe('operating area', () => {
  it('replaces the demo boundary once the site has one', () => {
    expect(insideSite({ x: 10, y: -10 })).toBe(false); // demo box only
    expect(insideSite({ x: 200, y: 120 })).toBe(true);
    expect(insideSite({ x: 10, y: -10 }, [yard], 'ugv')).toBe(true);
    expect(insideSite({ x: 200, y: 120 }, [yard], 'ugv')).toBe(false);
    // Inactive, or not for this kind of vehicle: back to the demo box.
    expect(insideSite({ x: 10, y: -10 }, [{ ...yard, active: false }], 'ugv')).toBe(false);
    expect(operatingAreas([{ ...yard, appliesTo: ['uav'] }], 'ugv')).toEqual([]);
  });

  it('numbers checkpoints outside it, and a leg that cuts across the missing corner of the L', () => {
    const ok = [
      { x: 10, y: -10 },
      { x: 10, y: -30 },
      { x: 35, y: -30 },
    ];
    expect(routeOutsideSite(ok, [yard], 'ugv')).toEqual([]);
    // (10,-10) → (35,-25): both ends inside, the straight leg crosses the cut-out (x>20, y>-20).
    const corner = [
      { x: 10, y: -5 },
      { x: 35, y: -25 },
    ];
    expect(routeOutsideSite(corner, [yard], 'ugv')).toEqual([2]);
    expect(routeOutsideSite([{ x: 10, y: -10 }, { x: 60, y: -30 }], [yard], 'ugv')).toEqual([2]);
    // Without an area the demo box rules, and a leg inside the (convex) box is not sampled.
    expect(routeOutsideSite([{ x: 10, y: -10 }, { x: 200, y: 120 }])).toEqual([1]);
  });

  it('drives the hard approval check', () => {
    const sim = { id: 'UGV-01', kind: 'ugv', integration: 'simulated', pos: { x: 5, y: -5 }, lastSeen: 1000, battery: 90, status: 'idle', commands: ['start'] } as unknown as Device;
    const m = { id: 'MSN-1', deviceId: 'UGV-01', checkpoints: [{ x: 10, y: -10 }, { x: 10, y: -30 }] } as unknown as Mission;
    // A simulated vehicle without an area: the demo boundary, which the yard lies outside.
    expect(constraintChecksAt(1000, sim, m, () => '', []).find((c) => c.label === 'Route inside the site boundary')).toMatchObject({ ok: false, hard: true });
    expect(constraintChecksAt(1000, sim, m, () => '', [yard]).find((c) => c.label === 'Route inside the operating area')).toMatchObject({ ok: true, hard: true });
    // A real vehicle needs an operating area drawn, wherever its route is.
    const real = { ...sim, integration: 'testing' } as Device;
    expect(constraintChecksAt(1000, real, m, () => '', []).find((c) => c.label === 'Route inside the operating area')).toMatchObject({
      ok: false,
      detail: 'No operating area drawn for this site',
    });
    expect(constraintChecksAt(1000, real, m, () => '', [yard]).find((c) => c.label === 'Route inside the operating area')?.ok).toBe(true);
  });
});
