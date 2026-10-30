import { describe, expect, it } from 'vitest';
import { checkpointLabel, routeTimeS, sanitizeRoute } from '../src/route';

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
