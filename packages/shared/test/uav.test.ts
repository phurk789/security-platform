import { describe, expect, it } from 'vitest';
import { UAV_PATROL, UAV_TRANSIT_MPS, uavOnStation, uavOrbitPoint } from '../src/kinematics';

describe('simulated UAV orbit', () => {
  it('moves the orbit centre to the target at transit speed and tightens the orbit on station', () => {
    const centre = { x: UAV_PATROL.cx, y: UAV_PATROL.cy };
    const target = { x: 335, y: 236 };
    const wind = { x: 0, y: 0 };
    let t = 0;
    for (let i = 0; i < 400 && !uavOnStation(centre, target); i++) {
      uavOrbitPoint(centre, target, t, 0.1, wind);
      t += 100;
    }
    expect(uavOnStation(centre, target)).toBe(true);
    const d0 = Math.hypot(target.x - UAV_PATROL.cx, target.y - UAV_PATROL.cy);
    expect(t / 1000).toBeGreaterThan((d0 / UAV_TRANSIT_MPS) * 0.9);
    const p = uavOrbitPoint(centre, target, t, 0.1, wind);
    expect(Math.hypot(p.x - target.x, p.y - target.y)).toBeLessThanOrEqual(21);
    // no target: back to the patrol loop
    for (let i = 0; i < 400; i++) uavOrbitPoint(centre, null, t + i * 100, 0.1, wind);
    expect(Math.hypot(centre.x - UAV_PATROL.cx, centre.y - UAV_PATROL.cy)).toBeLessThan(0.5);
  });
});
