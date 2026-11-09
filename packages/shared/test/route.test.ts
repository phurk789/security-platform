import { describe, expect, it } from 'vitest';
import { checkpointLabel, pointActs, pointUsesCamera, routeTimeS, sanitizeRoute, sweepYaws } from '../src/route';

describe('route points', () => {
  it('keeps known settings, rounds them, drops the rest, and explains what is wrong', () => {
    expect(sanitizeRoute([{ x: 1, y: 2, name: ' Gate ', speed: 1.26, holdS: 4.6, capture: true, extra: 1 }])).toEqual([
      { x: 1, y: 2, name: 'Gate', speed: 1.3, holdS: 5, capture: true },
    ]);
    expect(sanitizeRoute([{ x: 1, y: 2, name: '', speed: null, holdS: 0, capture: false }])).toEqual([{ x: 1, y: 2 }]);
    expect(sanitizeRoute([])).toMatch(/1–50 checkpoints/);
    expect(sanitizeRoute([{ x: 1, y: 'a' }])).toMatch(/\{x, y\} numbers/);
    expect(sanitizeRoute([{ x: 1, y: 2 }, { x: 3, y: 4, speed: 0.1 }])).toMatch(/^Checkpoint 2: speed must be/);
    expect(sanitizeRoute([{ x: 1, y: 2, holdS: 301 }])).toMatch(/wait must be 0–300 s/);
    expect(sanitizeRoute([{ x: 1, y: 2, name: 5 }])).toMatch(/name must be text/);
  });
  it('keeps the camera jobs at a checkpoint: direction, sweep and photo, checked and rounded', () => {
    expect(sanitizeRoute([{ x: 1, y: 2, holdS: 10, look: { pitch: -30.4, yaw: 44.6, zoom: 3.04 }, sweep: 59.6, photo: true }])).toEqual([
      { x: 1, y: 2, holdS: 10, look: { pitch: -30, yaw: 45, zoom: 3 }, sweep: 60, photo: true },
    ]);
    // Level, straight ahead and 1× are where the camera already is: nothing to keep.
    expect(sanitizeRoute([{ x: 1, y: 2, look: { pitch: 0, yaw: 0, zoom: 1 }, sweep: 0, photo: false }])).toEqual([{ x: 1, y: 2 }]);
    expect(sanitizeRoute([{ x: 1, y: 2, look: { pitch: -91 } }])).toMatch(/^Checkpoint 1: the camera tilt \(°\) must be -90–30/);
    expect(sanitizeRoute([{ x: 1, y: 2, look: { yaw: 200 } }])).toMatch(/camera pan \(°\) must be -135–135/);
    expect(sanitizeRoute([{ x: 1, y: 2, look: { zoom: 0.5 } }])).toMatch(/camera zoom/);
    expect(sanitizeRoute([{ x: 1, y: 2, look: 'down' }])).toMatch(/camera direction must be/);
    expect(sanitizeRoute([{ x: 1, y: 2, sweep: 5 }])).toMatch(/sweep must be 10–135° either side/);
  });
  it('tells which checkpoints have something to do and which need the camera', () => {
    expect(pointActs({ x: 0, y: 0 })).toBe(false);
    expect(pointActs({ x: 0, y: 0, speed: 2 })).toBe(false);
    expect(pointActs({ x: 0, y: 0, holdS: 5 })).toBe(true);
    expect(pointActs({ x: 0, y: 0, photo: true })).toBe(true);
    expect(pointUsesCamera({ x: 0, y: 0, holdS: 5 })).toBe(false);
    expect(pointUsesCamera({ x: 0, y: 0, look: { pitch: -20 } })).toBe(true);
  });
  it('sweeps from the centre to one end, across to the other and back, in steps of at most 30°', () => {
    expect(sweepYaws(0, 60)).toEqual([-30, -60, -30, 0, 30, 60, 30, 0]);
    expect(sweepYaws(45, 20)).toEqual([25, 45, 65, 45]);
    // Kept within the gimbal's ±135°.
    const near = sweepYaws(120, 60);
    expect(Math.max(...near)).toBe(135);
    expect(near[near.length - 1]).toBe(120);
  });
  it('times a route leg by leg at each point’s speed, waits included', () => {
    const pts = [
      { x: 10, y: 0 },
      { x: 10, y: 20, speed: 2, holdS: 5 },
    ];
    // 10 m at 1 m/s, then 20 m at 2 m/s, plus a 5 s wait.
    expect(routeTimeS(pts, { x: 0, y: 0 }, 1)).toBe(25);
    expect(routeTimeS(pts, undefined, 1)).toBe(15);
    expect(checkpointLabel([{ x: 0, y: 0, name: 'Gate' }, { x: 1, y: 1 }], 0)).toBe('1 (Gate)');
    expect(checkpointLabel([{ x: 0, y: 0, name: 'Gate' }, { x: 1, y: 1 }], 1)).toBe('2');
  });
});
