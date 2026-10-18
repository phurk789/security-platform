// The warehouse robot (UGV-04) drives its aisle round on its own between missions, stays on the
// floor plan, and hands over to the platform when a command arrives.
import { describe, expect, it } from 'vitest';
import { floorPlan, inNoGo } from '@13store/shared';
import { makeInitialState, reducer } from './reducer';

describe('indoor floor patrol (offline sim)', () => {
  it('UGV-04 starts its warehouse round, moves along the aisles and never enters a no-go area', () => {
    let s = makeInitialState();
    const plan = floorPlan('B5', 1)!;
    const start = { ...s.devices['UGV-04'].pos };
    let maxDist = 0;
    for (let i = 0; i < 1200; i++) {
      s = reducer(s, { type: 'tick', dt: 100 });
      const p = s.sim!['UGV-04'].motion;
      expect(inNoGo(plan, p)).toBeUndefined();
      maxDist = Math.max(maxDist, Math.hypot(p.x - start.x, p.y - start.y));
    }
    expect(s.sim!['UGV-04'].floorPatrol).toBe(true);
    expect(maxDist).toBeGreaterThan(20);
    expect(s.sim!['UGV-04'].motion.speed).toBeLessThanOrEqual(1.5 + 1e-9);
  });
});
