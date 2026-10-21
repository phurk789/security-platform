import { describe, expect, it } from 'vitest';
import type { Device, DeviceComponent } from '@13store/shared';
import { readinessRows, showsReadiness } from './readiness';

const ugv = (over: Partial<Device> = {}): Device =>
  ({ id: 'UGV-9', kind: 'ugv', integration: 'testing', capabilities: [], commands: [], components: [], ...over }) as unknown as Device;
const part = (kind: DeviceComponent['kind'], name: string, status: DeviceComponent['status']): DeviceComponent => ({ id: name, kind, name, status });
const byKey = (d: Device, live = true) => Object.fromEntries(readinessRows(d, live).map((r) => [r.key, r.status]));

describe('UGV hardware readiness', () => {
  it('is shown only for real UGVs', () => {
    expect(showsReadiness(ugv())).toBe(true);
    expect(showsReadiness(ugv({ integration: 'simulated' }))).toBe(false);
    expect(showsReadiness(ugv({ kind: 'uav' }))).toBe(false);
  });

  it('nothing passes on a fresh vehicle except a live link', () => {
    expect(byKey(ugv())).toEqual({ telemetry: 'ok', controller: 'pending', camera: 'pending', depth: 'pending', estop: 'pending' });
    expect(byKey(ugv(), false).telemetry).toBe('offline');
  });

  it('follows what the adapter reports, worst part wins', () => {
    const d = ugv({
      components: [part('flight_controller', 'SIYI UniFC', 'ok'), part('radio', 'SIYI link', 'ok'), part('camera', 'SIYI A8 mini', 'warn'), part('camera', 'Depth camera', 'ok')],
    });
    expect(byKey(d)).toMatchObject({ controller: 'ok', camera: 'warn', depth: 'ok', estop: 'pending' });
  });

  it('a lidar counts as the depth sensor whatever its name', () => {
    expect(byKey(ugv({ components: [part('lidar', 'Ouster OS1', 'fault')] })).depth).toBe('fault');
  });

  it('E-stop passes only after site sign-off', () => {
    expect(byKey(ugv({ integration: 'verified' })).estop).toBe('ok');
  });
});
