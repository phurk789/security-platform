import { describe, expect, it } from 'vitest';
import { PAD_DEADZONE, keysToSticks, padToSticks, speedLevels, throttleAt } from './drive';

describe('speed buttons', () => {
  it('offers 30 / 60 / 100 % up to the gateway cap, and no choice under an old 30 % cap', () => {
    expect(speedLevels(1)).toEqual([0.3, 0.6, 1]);
    expect(speedLevels(0.8)).toEqual([0.3, 0.6, 0.8]);
    expect(speedLevels(0.5)).toEqual([0.3, 0.5]);
    expect(speedLevels(0.3)).toEqual([0.3]);
    expect(speedLevels(0.2)).toEqual([0.2]);
    expect(speedLevels(0)).toEqual([]);
  });

  it('sends the throttle so the vehicle gets stick × level, whatever the gateway cap', () => {
    // The gateway multiplies by its cap: at cap 1 the level goes through as is.
    expect(throttleAt(1, 0.3, 1)).toBe(0.3);
    expect(throttleAt(-1, 0.6, 1)).toBe(-0.6);
    expect(throttleAt(0.5, 1, 1)).toBe(0.5);
    // Cap 0.5: full stick at 30 % is sent as 0.6 (× 0.5 = 30 %); a level above the cap is the cap.
    expect(throttleAt(1, 0.3, 0.5)).toBe(0.6);
    expect(throttleAt(1, 1, 0.5)).toBe(1);
    expect(throttleAt(0, 0.6, 1)).toBe(0);
    expect(throttleAt(1, 0.3, 0)).toBe(0);
  });
});

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
