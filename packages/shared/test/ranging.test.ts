import { describe, expect, it } from 'vitest';
import { DEPTH_FROM_M, boxDistance, boxDistanceBy, cameraTilt, depthDistance, depthPointOf, fitDepthScale, fitRanging, floorDistance, footOf, rangingProblem, type CameraRanging, type DepthSample, type RangingSample } from '../src/ranging';

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

describe('far away: the depth model scaled against the floor', () => {
  // A camera 1.2 m up, 10° down, 50° tall picture; the depth model's value is A/z + B (unknown to the platform).
  const H = 1.2;
  const TILT = 10;
  const VFOV = 50;
  const A = 3.7;
  const B = 0.42;
  const tv = Math.tan(rad(VFOV) / 2);
  const rayAt = (x: number, y: number) => {
    const X = 2 * (x - 0.5) * tv * ASPECT;
    const Y = 2 * (y - 0.5) * tv;
    const t = rad(TILT);
    return { X, down: Y * Math.cos(t) + Math.sin(t), fwd: Math.cos(t) - Y * Math.sin(t) };
  };
  /** Floor samples on a grid in the lower picture, with a little noise (deterministic). */
  const floor = (noise = 0.01): DepthSample[] => {
    const out: DepthSample[] = [];
    let k = 0;
    for (let y = 0.6; y <= 0.97; y += 0.05)
      for (let x = 0.1; x <= 0.9; x += 0.1) {
        const z = H / rayAt(x, y).down;
        out.push([x, y, A / z + B + noise * Math.sin(k++ * 12.9898)]);
      }
    return out;
  };
  /** The depth model's value on someone standing D metres away, read at picture point p. */
  const relOnBody = (D: number, p: [number, number]) => {
    const r = rayAt(p[0], p[1]);
    return (A * Math.hypot(r.X, r.fwd)) / D + B;
  };

  it('recovers the frame’s scale from the floor, even with things standing on it', () => {
    const samples = floor();
    // A box on the floor near the bottom left: much nearer than the floor there.
    for (const [x, y] of [[0.1, 0.9], [0.2, 0.9], [0.1, 0.95], [0.2, 0.95]] as const) samples.push([x, y, A / 0.5 + B]);
    const fit = fitDepthScale(samples, ASPECT, H, TILT, VFOV)!;
    expect(fit).toBeDefined();
    expect(fit.a).toBeCloseTo(A, 1);
    expect(fit.b).toBeCloseTo(B, 1);
    expect(fit.errPct).toBeLessThan(5);
  });

  it('gives no scale from too few samples, a flat strip, or values that grow with distance', () => {
    expect(fitDepthScale(floor().slice(0, 4), ASPECT, H, TILT, VFOV)).toBeUndefined();
    const strip = floor().filter(([, y]) => Math.abs(y - 0.95) < 0.001);
    expect(fitDepthScale(strip, ASPECT, H, TILT, VFOV)).toBeUndefined();
    const backwards = floor().map(([x, y, rel]) => [x, y, -rel] as DepthSample);
    expect(fitDepthScale(backwards, ASPECT, H, TILT, VFOV)).toBeUndefined();
  });

  it('measures someone 15 m away from the depth model, and up close from the feet', () => {
    const fit = fitDepthScale(floor(), ASPECT, H, TILT, VFOV)!;
    const r: CameraRanging = { heightM: H, tiltDeg: TILT, vfovDeg: VFOV, source: 'manual' };
    // 15 m away, feet in view.
    const foot = project(0, 15, H, TILT, VFOV);
    const far: [number, number, number, number] = [foot[0] - 0.01, foot[1] - 0.08, 0.02, 0.08];
    const at = depthPointOf(far);
    expect(depthDistance(relOnBody(15, at), at, ASPECT, TILT, VFOV, fit)).toBeCloseTo(15, 0);
    const got = boxDistanceBy(far, ASPECT, r, undefined, { rel: relOnBody(15, at), fit })!;
    expect(got.by).toBe('depth');
    expect(Math.abs(got.m - 15) / 15).toBeLessThan(0.05);
    // 4 m away: the feet decide.
    const near = project(0, 4, H, TILT, VFOV);
    const box: [number, number, number, number] = [near[0] - 0.03, near[1] - 0.3, 0.06, 0.3];
    expect(boxDistanceBy(box, ASPECT, r, undefined, { rel: relOnBody(4, depthPointOf(box)), fit })).toEqual({ m: 4, by: 'floor' });
    expect(DEPTH_FROM_M).toBe(8);
  });

  it('measures someone whose feet are out of the picture from the depth model', () => {
    const fit = fitDepthScale(floor(), ASPECT, H, TILT, VFOV)!;
    const r: CameraRanging = { heightM: H, tiltDeg: TILT, vfovDeg: VFOV, source: 'manual' };
    const cut: [number, number, number, number] = [0.45, 0.3, 0.1, 0.69]; // reaches the bottom edge
    expect(boxDistance(cut, ASPECT, r)).toBeUndefined();
    const got = boxDistanceBy(cut, ASPECT, r, undefined, { rel: relOnBody(2.5, depthPointOf(cut)), fit })!;
    expect(got.by).toBe('depth');
    expect(got.m).toBeCloseTo(2.5, 0);
    // No depth value: no distance.
    expect(boxDistanceBy(cut, ASPECT, r, undefined, { fit })).toBeUndefined();
  });
});
