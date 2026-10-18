// The two demo sites: the original civic centre and the Amata plant. Switching swaps buildings,
// floor plans, geofences, indoor device spots and the anchor, and switching back restores them.
import { afterAll, describe, expect, it } from 'vitest';
import { BUILDINGS, DEFAULT_GEOFENCES, LAYOUT, SITE, applySiteVariant, floorPlan, routeCrossesWalls, seedDevices, siteVariant } from '../src';

describe('demo site variants', () => {
  afterAll(() => applySiteVariant('amata'));

  it('civic brings back the original layout and keeps the indoor plans valid', () => {
    applySiteVariant('civic');
    expect(siteVariant).toBe('civic');
    expect(SITE.name).toBe('Civic Center');
    expect(SITE.geo).toMatchObject({ originLat: 13.7563, originLon: 100.5018, rotationDeg: 0 });
    expect(BUILDINGS.find((b) => b.id === 'B3')).toMatchObject({ use: 'Civic Hall', x: 284, y: 40 });
    expect(DEFAULT_GEOFENCES.find((g) => g.id === 'GF-PLAZA')!.poly[0]).toEqual({ x: 186, y: 98 });
    const d = seedDevices(0);
    expect(d['UGV-04'].pos).toEqual({ x: 87, y: 180 });
    expect(d['CCTV-05'].pos).toEqual(LAYOUT.cctv05);
    const wh = floorPlan('B5', 1)!;
    expect(wh.buildingId).toBe('B5');
    expect(routeCrossesWalls(wh.patrolRoute, wh)).toBe(-1);
    expect(wh.patrolRoute[0].x).toBeGreaterThan(78); // inside the civic B5 (x 78–162)
  });

  it('amata restores the plant on the real roofs', () => {
    applySiteVariant('amata');
    expect(SITE.geo.rotationDeg).toBe(-28.5);
    expect(BUILDINGS.find((b) => b.id === 'B5')).toMatchObject({ use: 'Warehouse', x: 60, y: 74 });
    expect(seedDevices(0)['UGV-04'].pos).toEqual({ x: 69, y: 158 });
    expect(floorPlan('B5', 1)!.patrolRoute[0]).toEqual({ x: 69, y: 158 });
  });
});
