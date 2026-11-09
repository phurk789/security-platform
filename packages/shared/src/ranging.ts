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

// ---------------------------------------------------------------------------------------------
// Far away: a depth model scaled against the floor.
//
// The AI box can run a single-picture depth model (Depth Anything V2 Small). It says what is nearer
// and what is further, not how many metres: its value `rel` is, up to noise, a·(1/z) + b, where z is
// the distance along the camera axis and a, b change from frame to frame. The floor is the ruler:
// from the camera's height and tilt the platform knows z for every floor pixel, so a straight-line
// fit of `rel` against 1/z over floor samples gives a and b for that frame, and then any box's z.
// The floor method stays in charge up close (it is exact there); the depth model takes over far
// away and when the feet are out of the picture.

/** A floor sample from the depth model: where in the picture (fractions, from the top-left) and its value there. */
export type DepthSample = readonly [x: number, y: number, rel: number];

/** The depth model's values in metres for one frame: rel ≈ a / z + b. */
export interface DepthFit {
  a: number;
  b: number;
  /** Floor samples the fit kept. */
  n: number;
  /** Mean error of the fit over those samples, percent of their distance. */
  errPct: number;
}

/** Beyond this the floor method gets coarse with a low camera: the depth model's distance is used. */
export const DEPTH_FROM_M = 8;
/** Floor samples used for the fit: near enough to be exact, far enough to see the slope. */
const FIT_MIN_M = 0.6;
const FIT_MAX_M = 15;
/** A fit worse than this is not used. */
const FIT_MAX_ERR_PCT = 20;

/** The camera ray through a picture point: lateral and forward share of the ground distance, and the floor depth there. */
function ray(x: number, y: number, aspect: number, tiltDeg: number, vfovDeg: number) {
  const tv = Math.tan(rad(vfovDeg) / 2);
  const X = 2 * (x - 0.5) * tv * aspect;
  const Y = 2 * (y - 0.5) * tv;
  const t = rad(tiltDeg);
  return { X, down: Y * Math.cos(t) + Math.sin(t), fwd: Math.cos(t) - Y * Math.sin(t), norm: Math.hypot(X, Y, 1) };
}

/**
 * The depth model's scale for this frame from floor samples, or undefined when there are too few
 * usable ones, they do not spread far enough, or they do not line up (a cluttered floor). Things
 * standing on the floor are dropped as outliers.
 */
export function fitDepthScale(samples: readonly DepthSample[], aspect: number, heightM: number, tiltDeg: number, vfovDeg: number): DepthFit | undefined {
  if (!(heightM > 0) || !(aspect > 0) || !(vfovDeg > 0 && vfovDeg < 179)) return undefined;
  // u = 1/z of each floor sample the camera geometry can place on the floor.
  let pts: { u: number; rel: number }[] = [];
  for (const [x, y, rel] of samples) {
    if (![x, y, rel].every(Number.isFinite)) continue;
    const r = ray(x, y, aspect, tiltDeg, vfovDeg);
    if (r.down <= Math.sin(rad(1)) * r.norm) continue;
    const z = heightM / r.down;
    const ground = z * Math.hypot(r.X, r.fwd);
    if (ground < FIT_MIN_M || ground > FIT_MAX_M) continue;
    pts.push({ u: 1 / z, rel });
  }
  const line = (p: typeof pts) => {
    const n = p.length;
    const mu = p.reduce((s, q) => s + q.u, 0) / n;
    const mr = p.reduce((s, q) => s + q.rel, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (const q of p) {
      sxy += (q.u - mu) * (q.rel - mr);
      sxx += (q.u - mu) ** 2;
    }
    const a = sxx > 0 ? sxy / sxx : NaN;
    return { a, b: mr - a * mu };
  };
  for (let round = 0; round < 3; round++) {
    if (pts.length < 6) return undefined;
    const { a, b } = line(pts);
    if (!(a > 0)) return undefined;
    // Drop the samples far off the line (a box, a person, a wall at the bottom of the picture).
    const res = pts.map((q) => Math.abs(q.rel - (a * q.u + b)));
    const sorted = [...res].sort((m, n) => m - n);
    const mad = sorted[Math.floor(sorted.length / 2)] || 1e-9;
    const kept = pts.filter((_, i) => res[i] <= 3 * mad + 1e-9);
    if (kept.length === pts.length) break;
    pts = kept;
  }
  if (pts.length < 6) return undefined;
  // The samples must span distances, or the slope means nothing.
  const us = pts.map((q) => q.u);
  if (Math.max(...us) / Math.min(...us) < 1.5) return undefined;
  const { a, b } = line(pts);
  if (!(a > 0)) return undefined;
  const errPct = (pts.reduce((s, q) => s + Math.abs((q.rel - b) / a - q.u) / q.u, 0) / pts.length) * 100;
  if (!(errPct <= FIT_MAX_ERR_PCT)) return undefined;
  return { a: Math.round(a * 1e4) / 1e4, b: Math.round(b * 1e4) / 1e4, n: pts.length, errPct: Math.round(errPct * 10) / 10 };
}

/**
 * Ground distance to something whose depth-model value is `rel`, seen at picture point (x, y), with
 * this frame's fit. Undefined when the value is beyond the fit (as far as the horizon or further) or
 * the result is out of range.
 */
export function depthDistance(rel: number, at: readonly [number, number], aspect: number, tiltDeg: number, vfovDeg: number, fit: DepthFit): number | undefined {
  if (!Number.isFinite(rel) || !(fit.a > 0)) return undefined;
  const u = (rel - fit.b) / fit.a;
  if (!(u > 0)) return undefined;
  const r = ray(at[0], at[1], aspect, tiltDeg, vfovDeg);
  const d = (1 / u) * Math.hypot(r.X, r.fwd);
  return d >= RANGE_MIN_M && d <= RANGE_MAX_M ? d : undefined;
}

/** Where in a box the depth model's value is read (vision_server.py samples the middle of the body). */
export function depthPointOf(bbox: readonly number[]): [number, number] {
  return [bbox[0] + bbox[2] / 2, bbox[1] + bbox[3] * 0.6];
}

/**
 * Distance to whoever is in this box and how it was found: from the feet on the floor up close, from
 * the depth model (scaled against the floor this frame) far away or when the feet are out of view.
 */
export function boxDistanceBy(
  bbox: readonly number[],
  aspect: number,
  r: CameraRanging | undefined,
  gimbalPitchDeg?: number,
  depth?: { rel?: number; fit?: DepthFit },
): { m: number; by: 'floor' | 'depth' } | undefined {
  if (!r) return undefined;
  const floor = boxDistance(bbox, aspect, r, gimbalPitchDeg);
  const far =
    depth?.fit && typeof depth.rel === 'number' && (floor === undefined || floor > DEPTH_FROM_M)
      ? depthDistance(depth.rel, depthPointOf(bbox), aspect, cameraTilt(r, gimbalPitchDeg), r.vfovDeg, depth.fit)
      : undefined;
  if (far !== undefined && (floor === undefined || far > DEPTH_FROM_M)) return { m: roundDistance(far), by: 'depth' };
  return floor === undefined ? undefined : { m: floor, by: 'floor' };
}
