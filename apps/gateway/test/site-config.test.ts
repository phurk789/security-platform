// site.json → adapters: what a real vehicle declares before any hardware answers.
import { describe, expect, it } from 'vitest';
import { adaptersFromConfig, parseSiteConfig } from '../src/real/config';
import { MavlinkVehicleAdapter } from '../src/real/mavlinkVehicle';

const site = (device: Record<string, unknown>) =>
  parseSiteConfig({ geo: { originLat: 13.75, originLon: 100.5, rotationDeg: 0 }, devices: [{ type: 'mavlink', deviceId: 'UGV-02', kind: 'ugv', profile: 'ardupilot-rover', ...device }] });

describe('mavlink vehicle from site.json', () => {
  it('declares the onboard camera stream on the vehicle, video only', () => {
    const stream = { rtsp: 'rtsp://192.168.144.25:8554/main.264', whep: 'http://192.168.10.50:8889/ugv-02/whep' };
    const [a] = adaptersFromConfig(site({ stream }));
    expect(a).toBeInstanceOf(MavlinkVehicleAdapter);
    expect(a.declaration.stream).toEqual(stream);
    expect(a.declaration.capabilities).toContain('video');
    expect(a.declaration.capabilities).not.toContain('gimbal'); // no camera control through MAVLink
    const cam = a.declaration.components?.find((c) => c.id === 'cam');
    expect(cam).toMatchObject({ kind: 'camera', status: 'pending', stream });
  });

  it('declares no stream and no camera part when none is configured', () => {
    const [a] = adaptersFromConfig(site({}));
    expect(a.declaration.stream).toBeUndefined();
    expect(a.declaration.capabilities).not.toContain('video');
    expect(a.declaration.components?.some((c) => c.id === 'cam')).toBe(false);
  });

  it('shows the flight controller and radio names from site.json on the Equipment tab', () => {
    const [a] = adaptersFromConfig(site({ flightController: 'SIYI UniFC 6 Pico', radio: 'SIYI UniRC 7 Pro datalink' }));
    const names = Object.fromEntries((a.declaration.components ?? []).map((c) => [c.id, c.name]));
    expect(names).toMatchObject({ fc: 'SIYI UniFC 6 Pico', radio: 'SIYI UniRC 7 Pro datalink' });
  });
});
