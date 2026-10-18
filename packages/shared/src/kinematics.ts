// Vehicle and sensor model shared by the simulated edge-gateway adapters and the offline demo,
// so both behave like real hardware in the same way: the UGV accelerates and brakes, slows for
// turns, reports a noisy GNSS position with an honest accuracy, and its radio link, satellites,
// battery and motor temperature drift with where it is and what it is doing.
import { UGV_SPEED, dist } from './policy';
import { BUILDINGS } from './site';
import type { DeviceKind, Point, SensorState, VehicleMotion } from './types';

/** Forward acceleration (m/s²). */
export const UGV_ACCEL = 1.5;
/** Normal braking (m/s²) — pause, stop, approaching a checkpoint. */
export const UGV_BRAKE = 2.5;
/** Failsafe braking after link loss (m/s²). */
export const UGV_FAILSAFE_BRAKE = 4;
/** Lowest speed used to creep onto a checkpoint (m/s). */
export const UGV_APPROACH = 0.5;
/** Max yaw rate (deg/s). */
export const UGV_YAW_RATE = 140;
/** Link-loss time after which a simulated UGV brakes to a stop (vehicle-side failsafe). */
export const LINK_LOSS_FAILSAFE_MS = 1_500;
/** Radio mast of the site network (roof of Building 2). */
export const SITE_ANTENNA: Point = { x: 219, y: 40 };

const SUBSTEP = 0.05;

export function newMotion(p: Point, heading = 90, maxSpeed?: number): VehicleMotion {
  return { x: p.x, y: p.y, speed: 0, heading, route: null, nextCp: 0, intent: 'hold', brake: 'normal', done: false, maxSpeed };
}

/** Bearing from a to b in degrees, 0 = north (−y), clockwise. */
export function bearing(a: Point, b: Point) {
  const deg = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
  return (deg + 360) % 360;
}

function turnToward(from: number, to: number, maxStep: number) {
  let diff = ((to - from + 540) % 360) - 180;
  if (Math.abs(diff) <= maxStep) return (to + 360) % 360;
  diff = Math.sign(diff) * maxStep;
  return (from + diff + 360) % 360;
}

/** Safe speed through checkpoint i, from how sharply the route turns there. */
function cornerSpeed(v: VehicleMotion, route: Point[], i: number) {
  if (i >= route.length - 1) return 0;
  const prev = i === 0 ? { x: v.x, y: v.y } : route[i - 1];
  const a = bearing(prev, route[i]);
  const b = bearing(route[i], route[i + 1]);
  const turn = Math.abs(((b - a + 540) % 360) - 180); // 0..180
  const top = v.maxSpeed ?? UGV_SPEED;
  return Math.min(top, Math.max(1.2, top * (1 - turn / 130)));
}

/**
 * Advance the vehicle by dt seconds. Returns checkpoints reached in this step and whether the
 * route was completed. Positions snap exactly onto checkpoints.
 */
export function stepMotion(v: VehicleMotion, dt: number): { checkpoints: number[]; completed: boolean } {
  const out = { checkpoints: [] as number[], completed: false };
  let left = dt;
  while (left > 1e-9) {
    const h = Math.min(SUBSTEP, left);
    left -= h;
    const route = v.route;
    if (v.intent === 'drive' && route && v.nextCp < route.length) {
      const target = route[v.nextCp];
      const d = dist(v, target);
      const vCorner = cornerSpeed(v, route, v.nextCp);
      const vAllow = Math.max(UGV_APPROACH, Math.min(v.maxSpeed ?? UGV_SPEED, Math.sqrt(vCorner * vCorner + 2 * UGV_BRAKE * d)));
      v.speed = v.speed < vAllow ? Math.min(vAllow, v.speed + UGV_ACCEL * h) : Math.max(vAllow, v.speed - UGV_BRAKE * h);
      if (d > 0.05) v.heading = turnToward(v.heading, bearing(v, target), UGV_YAW_RATE * h);
      const step = v.speed * h;
      if (step >= d) {
        v.x = target.x;
        v.y = target.y;
        out.checkpoints.push(v.nextCp);
        v.nextCp += 1;
        if (v.nextCp >= route.length) {
          v.speed = 0;
          v.done = true;
          v.intent = 'hold';
          out.completed = true;
        }
      } else {
        v.x += ((target.x - v.x) / d) * step;
        v.y += ((target.y - v.y) / d) * step;
      }
    } else if (v.speed > 0) {
      // Braking: coast along the current heading until stopped.
      const decel = v.brake === 'hard' ? UGV_FAILSAFE_BRAKE : UGV_BRAKE;
      const before = v.speed;
      v.speed = Math.max(0, v.speed - decel * h);
      const step = ((before + v.speed) / 2) * h;
      const rad = (v.heading * Math.PI) / 180;
      v.x += Math.sin(rad) * step;
      v.y -= Math.cos(rad) * step;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sensors and radio
// ---------------------------------------------------------------------------

/** Box–Muller standard normal. */
export function gaussian() {
  let u = 0;
  let w = 0;
  while (u === 0) u = Math.random();
  while (w === 0) w = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * w);
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, n));
}

function distToRect(p: Point, b: { x: number; y: number; w: number; d: number }) {
  const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w));
  const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.d));
  return Math.hypot(dx, dy);
}

function segmentHitsRect(a: Point, c: Point, b: { x: number; y: number; w: number; d: number }) {
  // Sample the segment; good enough for a site this size.
  const n = 40;
  for (let i = 1; i < n; i++) {
    const x = a.x + ((c.x - a.x) * i) / n;
    const y = a.y + ((c.y - a.y) * i) / n;
    if (x > b.x && x < b.x + b.w && y > b.y && y < b.y + b.d) return true;
  }
  return false;
}

/** Site-dependent baselines: GNSS is worse next to buildings; radio drops with range and walls. */
export function siteEnvironment(p: Point) {
  const near = Math.min(...BUILDINGS.map((b) => distToRect(p, b)));
  const urban = clamp(1 - near / 18, 0, 1);
  // The building the antenna stands on does not block it.
  const onRoof = (b: { x: number; y: number; w: number; d: number }) =>
    SITE_ANTENNA.x >= b.x && SITE_ANTENNA.x <= b.x + b.w && SITE_ANTENNA.y >= b.y && SITE_ANTENNA.y <= b.y + b.d;
  const blocked = BUILDINGS.some((b) => !onRoof(b) && segmentHitsRect(SITE_ANTENNA, p, b));
  const edge = p.x > 392 || p.y > 238 || p.x < 24;
  const signal = 99 - dist(p, SITE_ANTENNA) * 0.08 - (blocked ? 17 : 0) - (edge ? 7 : 0);
  return { accuracy: 0.9 + urban * 1.3, satellites: 13.5 - urban * 4, signal, blocked };
}

export function newSensors(battery = 100, kind: DeviceKind = 'ugv'): SensorState {
  return { acc: 0, sig: 0, sat: 0, wind: { x: 0, y: 0 }, tempC: kind === 'uav' ? 36 : 30, battery };
}

/** Mean-reverting random walk. */
function walk(x: number, dt: number, sigma: number, tau: number) {
  return x + gaussian() * sigma * Math.sqrt(dt) - (x * dt) / tau;
}

/** Drift the sensor state and drain the battery for dt seconds at the given speed. */
export function stepSensors(st: SensorState, dt: number, kind: DeviceKind, speed: number) {
  if (dt <= 0) return;
  st.acc = walk(st.acc, dt, 0.12, 25);
  st.sig = walk(st.sig, dt, 1.4, 20);
  st.sat = walk(st.sat, dt, 0.35, 40);
  st.wind = { x: walk(st.wind.x, dt, 0.35, 12), y: walk(st.wind.y, dt, 0.35, 12) };
  if (kind === 'ugv') {
    st.battery = Math.max(0, st.battery - (0.003 + 0.011 * speed) * dt);
    const target = 30.5 + 2.2 * speed;
    st.tempC += (target - st.tempC) * Math.min(1, dt / 40);
  } else if (kind === 'uav') {
    st.battery = Math.max(0, st.battery - 0.02 * dt);
    st.tempC += (38 - st.tempC) * Math.min(1, dt / 60);
  }
}

export interface SensorReading {
  pos: Point;
  accuracyM: number;
  signal: number;
  satellites?: number;
  temperatureC?: number;
  battery?: number;
}

/** What the device would report right now at its true position. */
export function readSensors(st: SensorState, truePos: Point, kind: DeviceKind, opts: { slam?: boolean } = {}): SensorReading {
  const env = siteEnvironment(truePos);
  const signal = Math.round(clamp(env.signal + st.sig, 25, 99));
  if (kind === 'cctv') return { pos: { ...truePos }, accuracyM: 1, signal: Math.round(clamp(94 + st.sig * 0.5, 80, 99)) };
  if (opts.slam) {
    // Indoor LiDAR SLAM on the floor map: no satellites, ~0.3 m, Wi-Fi link.
    const accuracyM = Math.round(clamp(0.3 + st.acc * 0.2, 0.2, 0.6) * 10) / 10;
    return {
      pos: { x: round2(truePos.x + gaussian() * accuracyM * 0.2), y: round2(truePos.y + gaussian() * accuracyM * 0.2) },
      accuracyM,
      signal: Math.round(clamp(88 + st.sig * 0.5, 60, 99)),
      satellites: 0,
      temperatureC: Math.round(st.tempC * 10) / 10,
      battery: round2(st.battery),
    };
  }
  const open = kind === 'uav';
  const accuracyM = Math.round(clamp((open ? 1.5 : env.accuracy) + st.acc, open ? 1.2 : 0.8, open ? 4 : 2.5) * 10) / 10;
  const sigma = accuracyM * 0.22;
  return {
    pos: { x: round2(truePos.x + gaussian() * sigma), y: round2(truePos.y + gaussian() * sigma) },
    accuracyM,
    signal,
    satellites: Math.round(clamp((open ? 16 : env.satellites) + st.sat, 6, 19)),
    temperatureC: Math.round(st.tempC * 10) / 10,
    battery: round2(st.battery),
  };
}

/** Typical radio + backhaul delay for one telemetry sample (ms). */
export function sampleLatency(signal: number) {
  const base = 60 + (100 - signal) * 1.6;
  return Math.round(clamp(base + Math.abs(gaussian()) * 35, 45, 400));
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// simulated UAV: patrol loop, and an overwatch orbit over an incident
// ---------------------------------------------------------------------------

/** Patrol loop over the north-east of the site (centre, radii in metres, angular rate rad/s). */
export const UAV_PATROL = { cx: 318, cy: 52, rx: 34, ry: 26, rate: 0.08 };
/** Tighter, faster orbit when watching an incident. */
export const UAV_WATCH = { rx: 20, ry: 16, rate: 0.14 };
/** How fast the orbit centre relocates (m/s). */
export const UAV_TRANSIT_MPS = 9;

/**
 * Advance the orbit centre towards `target` (or back to the patrol loop when null) and return the
 * aircraft position on the orbit for this instant. `centre` is mutated.
 */
export function uavOrbitPoint(centre: Point, target: Point | null, nowMs: number, dt: number, wind: Point): Point {
  const goal = target ?? { x: UAV_PATROL.cx, y: UAV_PATROL.cy };
  const dx = goal.x - centre.x;
  const dy = goal.y - centre.y;
  const d = Math.hypot(dx, dy);
  if (d > 0.01) {
    const step = Math.min(d, UAV_TRANSIT_MPS * Math.max(0, dt));
    centre.x += (dx / d) * step;
    centre.y += (dy / d) * step;
  }
  const watching = !!target && d < 30;
  const rx = watching ? UAV_WATCH.rx : UAV_PATROL.rx;
  const ry = watching ? UAV_WATCH.ry : UAV_PATROL.ry;
  const rate = watching ? UAV_WATCH.rate : UAV_PATROL.rate;
  const a = (nowMs / 1000) * rate;
  return { x: centre.x + Math.cos(a) * rx + wind.x * 1.5, y: centre.y + Math.sin(a) * ry + wind.y * 1.5 };
}

/** True once the orbit centre is over the target (within a few metres). */
export function uavOnStation(centre: Point, target: Point) {
  return Math.hypot(target.x - centre.x, target.y - centre.y) < 4;
}
