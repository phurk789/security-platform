import { describe, expect, it } from 'vitest';
import { PAD_DEADZONE, keysToSticks, padToSticks } from './drive';

describe('console driving input', () => {
  it('maps WASD and arrow keys; opposite keys cancel', () => {
    expect(keysToSticks(new Set())).toEqual({ throttle: 0, steer: 0 });
    expect(keysToSticks(new Set(['w']))).toEqual({ throttle: 1, steer: 0 });
    expect(keysToSticks(new Set(['arrowdown', 'a']))).toEqual({ throttle: -1, steer: -1 });
    expect(keysToSticks(new Set(['w', 'arrowup', 'd']))).toEqual({ throttle: 1, steer: 1 });
    expect(keysToSticks(new Set(['w', 's', 'a', 'arrowright']))).toEqual({ throttle: 0, steer: 0 });
    expect(keysToSticks(new Set(['q', ' ']))).toEqual({ throttle: 0, steer: 0 });
  });

  it('reads the pad: up is forward, right is right, a dead zone in the middle, clamped to the rim', () => {
    expect(padToSticks(0, 0, 100)).toEqual({ throttle: 0, steer: 0 });
    expect(padToSticks(0, -100, 100)).toEqual({ throttle: 1, steer: 0 });
    expect(padToSticks(100, 0, 100)).toEqual({ throttle: 0, steer: 1 });
    expect(padToSticks(-300, 0, 100)).toEqual({ throttle: 0, steer: -1 });
    // A resting finger near the centre does not creep the vehicle.
    expect(padToSticks(PAD_DEADZONE * 100 - 1, -(PAD_DEADZONE * 100 - 1), 100)).toEqual({ throttle: 0, steer: 0 });
    // Just outside the dead zone starts near 0, not with a jump.
    expect(padToSticks(0, -(PAD_DEADZONE * 100 + 2), 100).throttle).toBeLessThan(0.05);
    // Diagonal beyond the rim: clamped to the circle, so never more than full stick on both axes together.
    const d = padToSticks(300, 300, 100);
    expect(d.throttle).toBeLessThan(0);
    expect(d.steer).toBeGreaterThan(0);
    expect(Math.hypot(d.throttle, d.steer)).toBeLessThanOrEqual(1.0001);
    expect(padToSticks(10, 10, 0)).toEqual({ throttle: 0, steer: 0 });
  });
});
