import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PatrolRover } from '../../../examples/custom-adapter';
import { cmd, fakeCtx, statuses } from './helpers';

beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
afterEach(() => vi.useRealTimers());

describe('examples/custom-adapter (BUILD YOUR OWN)', () => {
  it('declares start/stop only and follows the command rules', () => {
    const rover = new PatrolRover({ deviceId: 'ROVER-07', start: { x: 100, y: 200 } });
    expect(rover.declaration.commands).toEqual(['start', 'stop']);
    const { ctx, got } = fakeCtx();
    rover.start(ctx);
    vi.advanceTimersByTime(1000);
    expect(got.telemetry).toHaveLength(1);

    const pause = cmd('pause', { deviceId: 'ROVER-07' });
    rover.onCommand(pause);
    expect(statuses(got, pause.commandId)).toEqual(['rejected']);

    const go = cmd('start', { deviceId: 'ROVER-07', route: [{ x: 130, y: 200 }] });
    rover.onCommand(go);
    rover.onCommand(go); // retry with same key
    vi.advanceTimersByTime(3000);
    expect(statuses(got, go.commandId).filter((s) => s === 'succeeded')).toHaveLength(1);
    expect(got.telemetry[got.telemetry.length - 1].pos.x).toBeGreaterThan(100);

    const stop = cmd('stop', { deviceId: 'ROVER-07' });
    rover.onCommand(stop);
    vi.advanceTimersByTime(1500);
    expect(statuses(got, stop.commandId)).toContain('succeeded');
    expect(got.telemetry[got.telemetry.length - 1].speed).toBe(0);

    const expired = cmd('start', { deviceId: 'ROVER-07', route: [{ x: 150, y: 200 }], expiresAt: Date.now() - 1 });
    rover.onCommand(expired);
    expect(statuses(got, expired.commandId)).toEqual(['rejected']);
    rover.stop();
  });
});
