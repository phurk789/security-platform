import { describe, expect, it } from 'vitest';
import { ALLOWED_OUTGOING, ForbiddenMessageError, assertGcsHeartbeat, assertSendAllowed } from '../guard';

describe('bench probe guard', () => {
  it('allows only heartbeat and parameter reads', () => {
    expect([...ALLOWED_OUTGOING.keys()].sort((a, b) => a - b)).toEqual([0, 20, 21]);
    expect(() => assertSendAllowed(0)).not.toThrow();
    expect(() => assertSendAllowed(20)).not.toThrow();
    expect(() => assertSendAllowed(21)).not.toThrow();
  });

  it.each([
    [23, 'PARAM_SET'],
    [39, 'MISSION_ITEM'],
    [44, 'MISSION_COUNT'],
    [69, 'MANUAL_CONTROL'],
    [70, 'RC_CHANNELS_OVERRIDE'],
    [73, 'MISSION_ITEM_INT'],
    [75, 'COMMAND_INT'],
    [76, 'COMMAND_LONG'],
    [11, 'SET_MODE'],
    [86, 'SET_POSITION_TARGET_GLOBAL_INT'],
  ])('refuses %i (%s)', (id, name) => {
    expect(() => assertSendAllowed(id, name)).toThrow(ForbiddenMessageError);
  });

  it('accepts only a passive GCS heartbeat', () => {
    expect(() => assertGcsHeartbeat({ type: 6, autopilot: 8, baseMode: 0, customMode: 0 })).not.toThrow();
    expect(() => assertGcsHeartbeat({ type: 10, autopilot: 3, baseMode: 0, customMode: 0 })).toThrow(ForbiddenMessageError);
    expect(() => assertGcsHeartbeat({ type: 6, autopilot: 8, baseMode: 128, customMode: 0 })).toThrow(ForbiddenMessageError);
    expect(() => assertGcsHeartbeat({ type: 6, autopilot: 8, baseMode: 0, customMode: 10 })).toThrow(ForbiddenMessageError);
  });
});
