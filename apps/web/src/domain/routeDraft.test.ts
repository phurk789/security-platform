import { afterEach, describe, expect, it } from 'vitest';
import type { Geofence } from '@13store/shared';
import { MAX_CHECKPOINTS, MAX_ZONE_POINTS, addPoint, checkDraft, finishedDraft, insertPoint, maxPoints, movePoint, northUpRect, removePoint, routeDraft } from './routeDraft';

const keepOut: Geofence = {
  id: 'GF-X',
  name: 'Crane',
  kind: 'keep_out',
  active: true,
  appliesTo: ['ugv'],
  poly: [
    { x: 100, y: 100 },
    { x: 120, y: 100 },
    { x: 120, y: 120 },
    { x: 100, y: 120 },
  ],
};

afterEach(() => routeDraft.clear());

describe('drawing a route on the map', () => {
  it('adds, moves and removes checkpoints, rounded to 10 cm, up to the limit', () => {
    let pts = addPoint([], { x: 50.04, y: 60.06 });
    pts = addPoint(pts, { x: 70, y: 60 });
    expect(pts).toEqual([
      { x: 50, y: 60.1 },
      { x: 70, y: 60 },
    ]);
    expect(movePoint(pts, 1, { x: 80.123, y: 61 })[1]).toEqual({ x: 80.1, y: 61 });
    expect(movePoint(pts, 5, { x: 0, y: 0 })).toBe(pts);
    expect(removePoint(pts, 0)).toEqual([{ x: 70, y: 60 }]);
    const full = Array.from({ length: MAX_CHECKPOINTS }, (_, i) => ({ x: 30 + i, y: 30 }));
    expect(addPoint(full, { x: 1, y: 1 })).toBe(full);
    expect(maxPoints('zone')).toBe(MAX_ZONE_POINTS);
  });

  it('checks the route as it is drawn: site boundary, keep-out zones, length from the vehicle', () => {
    const from = { x: 50, y: 110 };
    const fine = checkDraft([{ x: 50, y: 150 }], from, [keepOut], 'ugv');
    expect(fine).toMatchObject({ ok: true, lengthM: 40, outside: [], fences: [] });
    const through = checkDraft([{ x: 150, y: 110 }], from, [keepOut], 'ugv');
    expect(through.ok).toBe(false);
    expect(through.fences.map((f) => f.name)).toEqual(['Crane']);
    const out = checkDraft([{ x: 50, y: 150 }, { x: 5, y: 150 }], from, [], 'ugv');
    expect(out).toMatchObject({ ok: false, outside: [2] });
    expect(checkDraft([], from, [], 'ugv').ok).toBe(false);
  });

  it('a zone outline needs three corners and is measured around', () => {
    const tri = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 40 },
    ];
    expect(checkDraft(tri.slice(0, 2), undefined, [], 'ugv', 'zone').ok).toBe(false);
    // Outside the demo box is fine: an operating area is what defines the site.
    expect(checkDraft(tri, undefined, [], 'ugv', 'zone')).toMatchObject({ ok: true, lengthM: 120, outside: [] });
  });

  it('undoes every change, inserts corners, and draws north-up rectangles', () => {
    routeDraft.start({ purpose: 'geofence', deviceId: '', points: [] });
    routeDraft.setPoints(addPoint([], { x: 0, y: 0 }));
    routeDraft.setPoints(addPoint(routeDraft.get()!.points, { x: 10, y: 0 }));
    routeDraft.setPoints(movePoint(routeDraft.get()!.points, 1, { x: 12, y: 0 }));
    routeDraft.undo();
    expect(routeDraft.get()!.points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    routeDraft.undo();
    routeDraft.undo();
    expect(routeDraft.get()!.points).toEqual([]);
    routeDraft.undo(); // nothing left: no change
    expect(routeDraft.get()!.past).toEqual([]);
    expect(insertPoint([{ x: 0, y: 0 }, { x: 10, y: 0 }], 1, { x: 5, y: 3 })).toEqual([
      { x: 0, y: 0 },
      { x: 5, y: 3 },
      { x: 10, y: 0 },
    ]);
    // On a rotated site grid the rectangle is north-up on the map, so not axis-aligned in site metres.
    const anchor = { originLat: 13.95, originLon: 100.46, rotationDeg: -28.5 };
    const r = northUpRect({ x: 0, y: 0 }, { x: 40, y: 30 }, anchor);
    expect(r).toHaveLength(4);
    expect(r[0]).toEqual({ x: 0, y: 0 });
    expect(r[2]).toEqual({ x: 40, y: 30 });
    expect(r[1].x === 0 || r[1].y === 0).toBe(false);
    const c = checkDraft(r, undefined, [], 'ugv', 'geofence');
    expect(c).toMatchObject({ ok: true, crosses: false });
    expect(c.areaM2).toBeGreaterThan(0);
    expect(checkDraft([r[0], r[2], r[1], r[3]], undefined, [], 'ugv', 'geofence')).toMatchObject({ ok: false, crosses: true });
  });

  it('keeps one draft: start, finish, cancel back to where it started', () => {
    const seen: number[] = [];
    const off = routeDraft.subscribe(() => seen.push(routeDraft.get()?.points.length ?? -1));
    routeDraft.start({ purpose: 'patrol', deviceId: 'UGV-01', points: [{ x: 40, y: 40 }], returnTo: 'missions', meta: { name: 'Night' } });
    expect(routeDraft.get()?.state).toBe('drawing');
    routeDraft.setPoints(addPoint(routeDraft.get()!.points, { x: 60, y: 40 }));
    routeDraft.cancel();
    expect(routeDraft.get()).toMatchObject({ state: 'done', points: [{ x: 40, y: 40 }], meta: { name: 'Night' } });
    expect(finishedDraft(routeDraft.get(), 'patrol', 'UGV-01')).not.toBeNull();
    expect(finishedDraft(routeDraft.get(), 'patrol', 'UGV-02')).toBeNull();
    expect(finishedDraft(routeDraft.get(), 'mission-new', 'UGV-01')).toBeNull();
    routeDraft.start({ purpose: 'mission-new', deviceId: 'UGV-01', points: [] });
    routeDraft.cancel();
    expect(finishedDraft(routeDraft.get(), 'mission-new', 'UGV-01')).toBeNull(); // nothing drawn
    routeDraft.clear();
    off();
    expect(seen).toEqual([1, 2, 1, 0, 0, -1]);
  });
});
