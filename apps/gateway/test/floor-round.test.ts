// Server mode: the simulated warehouse robot (UGV-04) drives its aisle round on its own between
// missions, keeps out of no-go areas, and hands over the moment the platform sends a command.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FLOOR_PATROL_RESUME_MS, floorPlan, inNoGo, seedDevices } from '@13store/shared';
import { SimUgv } from '../src/adapters';
import { cmd, fakeCtx, statuses } from './helpers';

beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
afterEach(() => vi.useRealTimers());

describe('indoor floor round (gateway sim)', () => {
  it('starts the warehouse round, reports it, stays out of no-go areas, and yields to a mission', () => {
    const seed = seedDevices(0)['UGV-04'];
    const plan = floorPlan('B5', 1)!;
    const a = new SimUgv(seed);
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    for (let i = 0; i < 60; i++) {
      vi.advanceTimersByTime(1000);
      expect(inNoGo(plan, a.pos)).toBeUndefined();
    }
    expect(a.round).toBe(true);
    expect(Math.hypot(a.pos.x - seed.pos.x, a.pos.y - seed.pos.y)).toBeGreaterThan(20);
    expect(got.telemetry.at(-1)?.floorPatrol).toBe(true);
    expect(got.telemetry.at(-1)?.nextCp).toBeUndefined();
    expect(got.events.filter((e) => e.kind === 'checkpoint')).toHaveLength(0);

    // A mission takes over: the round stops and the mission's route is driven.
    const here = a.pos;
    const c = cmd('start', { deviceId: 'UGV-04', route: [{ x: here.x, y: here.y }] });
    a.onCommand(c);
    vi.advanceTimersByTime(3000);
    expect(a.round).toBe(false);
    expect(statuses(got, c.commandId)).toContain('succeeded');
    // Quiet again: back on the round after the resume delay.
    vi.advanceTimersByTime(FLOOR_PATROL_RESUME_MS + 3000);
    expect(a.round).toBe(true);
    a.stop();
  });

  it('outdoor vehicles never start a round on their own', () => {
    const a = new SimUgv(seedDevices(0)['UGV-01']);
    const { ctx } = fakeCtx();
    a.start(ctx);
    vi.advanceTimersByTime(30_000);
    expect(a.round).toBe(false);
    expect(a.speed).toBe(0);
    a.stop();
  });
});
