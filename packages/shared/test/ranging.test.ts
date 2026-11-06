import { describe, expect, it } from 'vitest';
import { boxDistance, cameraTilt, fitRanging, floorDistance, footOf, rangingProblem, type CameraRanging, type RangingSample } from '../src/ranging';

const ASPECT = 16 / 9;
const rad = (d: number) => (d * Math.PI) / 180;

/** Where a floor point (x to the right, d ahead) appears in the picture of a camera at height h tilted down by tilt. */
function project(x: number, d: number, h: number, tilt: number, vfov: number, aspect = ASPECT): [number, number] {
  const t = rad(tilt);
  const z = h * Math.sin(t) + d * Math.cos(t);
  const X = x / z;
  const Y = (h * Math.cos(t) - d * Math.sin(t)) / z;
  const tv = Math.tan(rad(vfov) / 2);
  return [0.5 + X / (2 * tv * aspect), 0.5 + Y / (2 * tv)];
}

describe('distance from where feet touch the floor', () => {
  it('gives back the distance of floor points ahead and to the side', () => {
    for (const d of [1, 2, 5, 10, 20]) {
      expect(floorDistance(project(0, d, 0.5, 8, 50), ASPECT, 0.5, 8, 50)).toBeCloseTo(d, 6);
      expect(floorDistance(project(1, d, 0.5, 8, 50), ASPECT, 0.5, 8, 50)).toBeCloseTo(Math.hypot(1, d), 6);
    }
  });

  it('says nothing for points at or above the horizon, or out of range', () => {
    // Camera level: the middle of the picture is the horizon, the top half is above it.
    expect(floorDistance([0.5, 0.5], ASPECT, 0.5, 0, 50)).toBeUndefined();
    expect(floorDistance([0.5, 0.3], ASPECT, 0.5, 0, 50)).toBeUndefined();
    // Just below the horizon with a low camera: far beyond 40 m.
    expect(floorDistance([0.5, 0.505], ASPECT, 0.5, 0, 50)).toBeUndefined();
    expect(floorDistance([0.5, 0.9], ASPECT, 0, 8, 50)).toBeUndefined();
  });

  it('uses the bottom middle of a box, and not a box cut off at the bottom edge', () => {
    expect(footOf([0.4, 0.3, 0.1, 0.4])).toEqual([0.45, 0.7]);
    expect(footOf([0.4, 0.5, 0.1, 0.49])).toBeUndefined();
    const r: CameraRanging = { heightM: 0.5, tiltDeg: 8, vfovDeg: 50, source: 'manual' };
    const [u, v] = project(0, 4.23, 0.5, 8, 50);
    expect(boxDistance([u - 0.05, v - 0.4, 0.1, 0.4], ASPECT, r)).toBe(4.2);
    const far = project(0, 12.6, 0.5, 8, 50);
    expect(boxDistance([far[0] - 0.02, far[1] - 0.1, 0.04, 0.1], ASPECT, r)).toBe(13);
    expect(boxDistance([0.4, 0.3, 0.1, 0.4], ASPECT, undefined)).toBeUndefined();
  });

  it('follows a gimbal that reports its pitch, with the calibrated offset', () => {
    const r: CameraRanging = { heightM: 0.5, tiltDeg: 8, vfovDeg: 50, pitchOffsetDeg: 1.5, source: 'calibrated' };
    expect(cameraTilt(r)).toBe(8);
    expect(cameraTilt(r, -10)).toBe(11.5);
    expect(cameraTilt({ ...r, pitchOffsetDeg: undefined }, -10)).toBe(10);
  });
});

describe('calibration from people standing at known distances', () => {
  const sample = (d: number, h: number, tilt: number, vfov = 50, x = 0, gimbalTiltDeg?: number): RangingSample => ({
    distanceM: Math.hypot(x, d),
    foot: project(x, d, h, tilt, vfov),
    aspect: ASPECT,
    ...(gimbalTiltDeg !== undefined ? { gimbalTiltDeg } : {}),
    at: 0,
  });

  it('one point gives the height, keeping the tilt', () => {
    const fit = fitRanging([sample(3, 0.62, 11)], 50, { tiltDeg: 11 });
    expect(fit!.heightM).toBeCloseTo(0.62, 3);
    expect(fit!.tiltDeg).toBe(11);
    expect(fit!.errorPct).toBe(0);
  });

  it('two or more points give height and tilt together', () => {
    const fit = fitRanging([sample(2, 0.62, 11), sample(5, 0.62, 11), sample(4, 0.62, 11, 50, 1.2)], 50);
    expect(fit!.heightM).toBeCloseTo(0.62, 2);
    expect(fit!.tiltDeg).toBeCloseTo(11, 1);
    expect(fit!.errorPct).toBeLessThan(0.5);
    expect(fit!.pitchOffsetDeg).toBeUndefined();
  });

  it('with a gimbal that reports its tilt, finds the offset between the report and the truth', () => {
    // The gimbal says 10° down; the camera is really 12° down.
    const fit = fitRanging([sample(2, 0.5, 12, 50, 0, 10), sample(6, 0.5, 12, 50, 0, 10)], 50);
    expect(fit!.heightM).toBeCloseTo(0.5, 2);
    expect(fit!.pitchOffsetDeg).toBeCloseTo(2, 1);
    expect(fit!.tiltDeg).toBeCloseTo(12, 1);
  });

  it('refuses points that no camera over a flat floor explains', () => {
    // Feet above the middle of a level camera's picture cannot be on the floor.
    expect(fitRanging([{ distanceM: 3, foot: [0.5, 0.3], aspect: ASPECT, at: 0 }], 50, { tiltDeg: 0 })).toBeUndefined();
    expect(fitRanging([], 50)).toBeUndefined();
  });

  it('checks geometry typed in by hand', () => {
    expect(rangingProblem({ heightM: 0.6, tiltDeg: 10, vfovDeg: 50 })).toBeUndefined();
    expect(rangingProblem({ heightM: 0 })).toMatch(/height/);
    expect(rangingProblem({ heightM: 0.6, tiltDeg: 95 })).toMatch(/tilt/);
    expect(rangingProblem({ heightM: 0.6, vfovDeg: 5 })).toMatch(/Field of view/);
  });
});
