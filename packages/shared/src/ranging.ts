// Distance to people (and vehicles) on a camera's video, from where they stand on a flat floor.
// A camera at a known height, tilted down by a known angle, sees every floor point along one ray;
// where the ray through the bottom of a box meets the floor is how far away the feet are. Good
// indoors and up close; with a low camera it gets coarse far away, and it needs the feet in view.
//
// Calibration instead of a tape measure on the camera: someone stands at a known distance (count
// the floor tiles) and the platform keeps where their feet were in the picture. One point gives
// the height (keeping the tilt); two or more give height and tilt together.

/** How the platform turns a box on this device's video into a distance (flat floor). */
export interface CameraRanging {
  /** Lens height above the floor, metres. */
  heightM: number;
  /** Camera axis below the horizon, degrees (positive = looking down), used when no gimbal pitch is reported. */
  tiltDeg: number;
  /** Vertical field of view of the whole picture, degrees. */
  vfovDeg: number;
  /** Added to the gimbal's reported tilt when it reports one (calibrated). */
  pitchOffsetDeg?: number;
  /** Typed in by a person, or worked out from calibration points. */
  source: 'manual' | 'calibrated';
  /** Calibration points, newest last. */
  samples?: RangingSample[];
  /** Calibration fit: mean distance error over the points, percent. */
  errorPct?: number;
  by?: string;
  at?: number;
}

/** A person standing at a known distance, as the AI saw them. */
export interface RangingSample {
  distanceM: number;
  /** Where the feet were: bottom centre of the box, fractions of the picture (x, y from the top-left). */
  foot: [number, number];
  /** Picture width / height. */
  aspect: number;
  /** Camera tilt the gimbal reported then (degrees down), if it reports one. */
  gimbalTiltDeg?: number;
  at: number;
}

/** Box types whose bottom edge is where they touch the floor. */
export const RANGING_TYPES = ['person', 'intrusion', 'loitering', 'vehicle'] as const;
/** Distances outside this are not shown: too close to trust, or too coarse with a low camera. */
export const RANGE_MIN_M = 0.3;
export const RANGE_MAX_M = 40;
/** Most calibration points kept per device. */
export const RANGING_MAX_SAMPLES = 6;
/** Used until someone sets the camera's own (a typical small gimbal camera, 16:9). */
export const DEFAULT_RANGING_VFOV_DEG = 50;

const rad = (d: number) => (d * Math.PI) / 180;

/** Bottom centre of a box, or undefined when the box reaches the bottom edge (the feet may be cut off). */
export function footOf(bbox: readonly number[]): [number, number] | undefined {
  if (bbox.length !== 4 || !bbox.every(Number.isFinite)) return undefined;
  const [x, y, w, h] = bbox;
  const bottom = y + h;
  if (bottom >= 0.985 || h <= 0) return undefined;
  return [x + w / 2, bottom];
}

/**
 * Ground distance (metres) from below the camera to a floor point seen at `foot`, or undefined when
 * that ray never reaches the floor (at or above the horizon) or the result is out of range.
 */
export function floorDistance(foot: readonly [number, number], aspect: number, heightM: number, tiltDeg: number, vfovDeg: number): number | undefined {
  const d = floorDistanceRaw(foot, aspect, heightM, tiltDeg, vfovDeg);
  return d !== undefined && d >= RANGE_MIN_M && d <= RANGE_MAX_M ? d : undefined;
}

function floorDistanceRaw(foot: readonly [number, number], aspect: number, heightM: number, tiltDeg: number, vfovDeg: number): number | undefined {
  if (!(heightM > 0) || !(vfovDeg > 0 && vfovDeg < 179) || !(aspect > 0)) return undefined;
  const tv = Math.tan(rad(vfovDeg) / 2);
  // Ray through the point, camera frame: x right, y down, z forward (pinhole).
  const X = 2 * (foot[0] - 0.5) * tv * aspect;
  const Y = 2 * (foot[1] - 0.5) * tv;
  const t = rad(tiltDeg);
  // Camera tilted down by t; world y points down to the floor, z forward along it.
  const down = Y * Math.cos(t) + Math.sin(t);
  const fwd = Math.cos(t) - Y * Math.sin(t);
  // Within a quarter of a degree of the horizon the distance is meaningless.
  if (down <= Math.sin(rad(0.25)) * Math.hypot(X, Y, 1)) return undefined;
  const s = heightM / down;
  return Math.hypot(s * X, s * fwd);
}

/** The camera's tilt now: the gimbal's (with the calibrated offset) when it reports one, else the set tilt. */
export function cameraTilt(r: CameraRanging, gimbalPitchDeg?: number): number {
  return typeof gimbalPitchDeg === 'number' && Number.isFinite(gimbalPitchDeg) ? -gimbalPitchDeg + (r.pitchOffsetDeg ?? 0) : r.tiltDeg;
}

/** Distance to whoever stands at the bottom of this box, rounded (0.1 m under 10 m, else 1 m), or undefined. */
export function boxDistance(bbox: readonly number[], aspect: number, r: CameraRanging | undefined, gimbalPitchDeg?: number): number | undefined {
  if (!r) return undefined;
  const foot = footOf(bbox);
  if (!foot) return undefined;
  const d = floorDistance(foot, aspect, r.heightM, cameraTilt(r, gimbalPitchDeg), r.vfovDeg);
  return d === undefined ? undefined : roundDistance(d);
}

export function roundDistance(m: number) {
  return m < 10 ? Math.round(m * 10) / 10 : Math.round(m);
}

export interface RangingFit {
  heightM: number;
  tiltDeg: number;
  pitchOffsetDeg?: number;
  /** Mean distance error over the points, percent. */
  errorPct: number;
}

/**
 * Height and tilt that best explain the calibration points. One point: the height, with the tilt
 * kept (`keep.tiltDeg`, or the gimbal's report plus `keep.pitchOffsetDeg`). Two or more: both, by
 * a search over the tilt (or over the gimbal offset when the points carry a gimbal tilt) with the
 * best height for each. Undefined when the points cannot be explained (feet above the horizon, a
 * height out of range).
 */
export function fitRanging(samples: readonly RangingSample[], vfovDeg: number, keep: { tiltDeg?: number; pitchOffsetDeg?: number } = {}): RangingFit | undefined {
  if (!samples.length) return undefined;
  const gimbal = samples.every((s) => typeof s.gimbalTiltDeg === 'number');
  const tiltOf = (s: RangingSample, x: number) => (gimbal ? s.gimbalTiltDeg! + x : x);
  // For a tilt, the distance at 1 m height scales linearly with the height: best height in closed form
  // (weighted so every point counts by its relative error).
  const bestFor = (x: number) => {
    let num = 0;
    let den = 0;
    const g: number[] = [];
    for (const s of samples) {
      const d1 = floorDistanceRaw(s.foot, s.aspect, 1, tiltOf(s, x), vfovDeg);
      if (d1 === undefined) return undefined;
      g.push(d1);
      num += d1 / s.distanceM;
      den += (d1 * d1) / (s.distanceM * s.distanceM);
    }
    const h = num / den;
    const err = samples.reduce((acc, s, i) => acc + Math.abs(h * g[i] - s.distanceM) / s.distanceM, 0) / samples.length;
    return { h, err };
  };
  let best: { x: number; h: number; err: number } | undefined;
  if (samples.length === 1) {
    const x = gimbal ? (keep.pitchOffsetDeg ?? 0) : (keep.tiltDeg ?? 0);
    const r = bestFor(x);
    if (r) best = { x, ...r };
  } else {
    // Coarse search, then a fine one around the best.
    const span = gimbal ? [-30, 30] : [-20, 80];
    for (let x = span[0]; x <= span[1]; x += 0.5) {
      const r = bestFor(x);
      if (r && (!best || r.err < best.err)) best = { x, ...r };
    }
    if (best) {
      const c = best.x;
      for (let x = c - 0.5; x <= c + 0.5; x += 0.01) {
        const r = bestFor(x);
        if (r && r.err < best.err) best = { x, ...r };
      }
    }
  }
  if (!best || !(best.h >= 0.05 && best.h <= 20)) return undefined;
  const last = samples[samples.length - 1];
  return {
    heightM: Math.round(best.h * 1000) / 1000,
    tiltDeg: Math.round((gimbal ? last.gimbalTiltDeg! + best.x : best.x) * 100) / 100,
    ...(gimbal ? { pitchOffsetDeg: Math.round(best.x * 100) / 100 } : {}),
    errorPct: Math.round(best.err * 1000) / 10,
  };
}

/** Checks a camera geometry typed in by a person; returns the problem in words, or undefined. */
export function rangingProblem(r: { heightM?: unknown; tiltDeg?: unknown; vfovDeg?: unknown }): string | undefined {
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  if (!num(r.heightM) || (r.heightM as number) < 0.05 || (r.heightM as number) > 20) return 'Camera height must be 0.05–20 m.';
  if (r.tiltDeg !== undefined && (!num(r.tiltDeg) || (r.tiltDeg as number) < -30 || (r.tiltDeg as number) > 89)) return 'Camera tilt must be −30…89° (positive = looking down).';
  if (r.vfovDeg !== undefined && (!num(r.vfovDeg) || (r.vfovDeg as number) < 10 || (r.vfovDeg as number) > 150)) return 'Field of view must be 10–150°.';
  return undefined;
}

/** For people: "4.2 m". */
export function fmtDistance(m: number) {
  return `${roundDistance(m)} m`;
}
