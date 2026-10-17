import { describe, expect, it } from 'vitest';
import { ComponentTracker } from '../src/adapters/components';

describe('ComponentTracker', () => {
  it('reports only real changes, once, merged per part', () => {
    const c = new ComponentTracker([{ id: 'fc', name: 'FC', kind: 'flight_controller', status: 'pending' }]);
    expect(c.flush()).toBeUndefined();
    c.set('fc', { status: 'pending' }); // no change
    expect(c.flush()).toBeUndefined();
    c.set('fc', { status: 'ok', version: 'ArduPilot' });
    c.set('fc', { detail: 'sys 1' });
    c.set('nope', { status: 'ok' }); // unknown part is ignored
    expect(c.flush()).toEqual([{ id: 'fc', status: 'ok', version: 'ArduPilot', detail: 'sys 1' }]);
    expect(c.flush()).toBeUndefined();
    expect(c.list()[0]).toMatchObject({ status: 'ok', version: 'ArduPilot', detail: 'sys 1' });
  });
});
