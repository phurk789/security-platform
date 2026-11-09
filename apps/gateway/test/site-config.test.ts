// site.json → adapters: what a real vehicle declares before any hardware answers.
import { describe, expect, it } from 'vitest';
import { adaptersFromConfig, parseSiteConfig } from '../src/real/config';
import { MavlinkVehicleAdapter } from '../src/real/mavlinkVehicle';
import { SiyiCameraAdapter } from '../src/real/siyiCamera';

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

  it('accepts missionFence for ArduPilot and refuses it for PX4 or a non-boolean value', () => {
    expect(() => site({ missionFence: true })).not.toThrow();
    expect(() => site({ profile: 'px4-rover', missionFence: true })).toThrow(/ArduPilot profiles only/);
    expect(() => site({ missionFence: 'yes' })).toThrow(/true or false/);
  });

  it('shows the flight controller and radio names from site.json on the Equipment tab', () => {
    const [a] = adaptersFromConfig(site({ flightController: 'SIYI UniFC 6 Pico', radio: 'SIYI UniRC 7 Pro datalink' }));
    const names = Object.fromEntries((a.declaration.components ?? []).map((c) => [c.id, c.name]));
    expect(names).toMatchObject({ fc: 'SIYI UniFC 6 Pico', radio: 'SIYI UniRC 7 Pro datalink' });
  });
});

describe('SIYI gimbal camera riding on a vehicle (UGV-01 on a Pi)', () => {
  const GEO = { originLat: 13.75, originLon: 100.5, rotationDeg: 0 };
  const ugv = { type: 'mavlink', deviceId: 'UGV-01', kind: 'ugv', profile: 'ardupilot-rover', stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true } };
  const cam = (extra: Record<string, unknown> = {}) => ({ type: 'siyi-camera', deviceId: 'UGV-01-CAM', model: 'SIYI A8 mini', yawSpeedSign: 1, yawAngleSign: -1, ...extra });
  const parse = (c: Record<string, unknown>) => parseSiteConfig({ geo: GEO, devices: [ugv, c] });

  it('needs no pos when it follows the vehicle, and declares the vehicle it rides on', () => {
    const config = parse(cam({ follows: 'UGV-01', mount: { bearingDeg: 0, heightM: 0.6 } }));
    const [vehicle, camera] = adaptersFromConfig(config);
    expect(vehicle.declaration.capabilities).not.toContain('gimbal');
    expect(camera).toBeInstanceOf(SiyiCameraAdapter);
    expect(camera.declaration).toMatchObject({ deviceId: 'UGV-01-CAM', kind: 'cctv', follows: 'UGV-01', mount: { bearingDeg: 0, heightM: 0.6 } });
    expect(camera.declaration.capabilities).toEqual(expect.arrayContaining(['gimbal', 'zoom', 'photo']));
    expect(camera.declaration.stream).toBeUndefined(); // the video stays on the vehicle
    expect(camera.declaration.limitations).toMatch(/Camera on UGV-01/);
  });

  it('refuses a camera with neither pos nor follows, a pos beside follows, and a bad vehicle id', () => {
    expect(() => parse(cam())).toThrow(/pos \{x, y\} \(site metres\) is required, or "follows"/);
    expect(() => parse(cam({ follows: 'UGV-01', pos: { x: 1, y: 2 } }))).toThrow(/takes its position from it\. Remove pos/);
    expect(() => parse(cam({ follows: 'ugv 01' }))).toThrow(/follows must be the id of the vehicle/);
    expect(() => parse(cam({ follows: 'UGV-01-CAM' }))).toThrow(/follows must be the id of the vehicle/);
    expect(() => parse(cam({ follows: 'UGV-01', mount: { heightM: 0.6 } }))).toThrow(/mount needs bearingDeg and heightM/);
    // A fixed mast camera is unchanged.
    expect(() => parse(cam({ pos: { x: 376, y: 212 } }))).not.toThrow();
  });
});
