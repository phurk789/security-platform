// The vehicle's camera when it is its own device riding on the vehicle (`follows`), as the server
// and the console both work it out: which camera, where it is, and that auto-aim leaves it alone.
import { describe, expect, it } from 'vitest';
import { cameraPose, pickCamera, vehicleCameraOf, type Device } from '../src';

const dev = (id: string, extra: Partial<Device>): Device =>
  ({ id, kind: 'cctv', capabilities: [], pos: { x: 0, y: 0 }, accuracyM: 1, speed: 0, lastSeen: 0, ...extra }) as Device;

const ugv = dev('UGV-01', { kind: 'ugv', capabilities: ['video'], pos: { x: 200, y: 200 }, heading: 90 });
const siyi = dev('UGV-01-CAM', { capabilities: ['gimbal', 'zoom', 'photo'], follows: 'UGV-01', noFix: true, mount: { bearingDeg: 180, heightM: 0.6 } });
const ai = dev('UGV-01-AI', { capabilities: ['video', 'analytics'], follows: 'UGV-01' });

describe('the camera that films for a vehicle', () => {
  it('is its own gimbal, or a gimbal camera riding on it, never a camera AI', () => {
    expect(vehicleCameraOf(ugv, [ugv, ai, siyi])?.id).toBe('UGV-01-CAM');
    expect(vehicleCameraOf(ugv, [ugv, ai])).toBeUndefined();
    const own = { ...ugv, capabilities: ['video', 'gimbal'] };
    expect(vehicleCameraOf(own, [own, siyi])?.id).toBe('UGV-01');
  });

  it('stands where the vehicle is and turns with it; its mount bearing counts from the nose', () => {
    // Facing east (90°), camera mounted looking back (180°): its centre points west.
    expect(cameraPose(siyi, ugv)).toEqual({ pos: { x: 200, y: 200 }, mount: { bearingDeg: 270, heightM: 0.6, fovDeg: 50, rangeM: 150 } });
    expect(cameraPose(siyi, { ...ugv, noFix: true })).toBeNull();
    expect(cameraPose(siyi, undefined)).toBeNull();
    // A fixed camera keeps its own place and mount.
    const mast = dev('CAM-01', { capabilities: ['gimbal'], pos: { x: 376, y: 212 }, mount: { bearingDeg: 240, heightM: 6.5 } });
    expect(cameraPose(mast)).toEqual({ pos: { x: 376, y: 212 }, mount: mast.mount });
  });

  it('is not one of the fixed cameras auto-aim turns to an alert', () => {
    const near = { ...siyi, pos: { x: 205, y: 200 }, mount: { bearingDeg: 90, heightM: 0.6 } };
    expect(pickCamera([near], { x: 230, y: 200 }, [], () => true)).toBeNull();
    const { follows: _f, ...fixed } = near;
    expect(pickCamera([fixed as Device], { x: 230, y: 200 }, [], () => true)?.device.id).toBe('UGV-01-CAM');
  });
});
