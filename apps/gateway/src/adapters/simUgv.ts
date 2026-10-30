// Simulated patrol UGV. Behaves like the real vehicle should: accelerates and brakes, slows for
// turns, reports a noisy GNSS fix with an honest accuracy, confirms commands only when the effect
// is real, stops by itself on link loss, and never resumes or replays on reconnect.
import {
  UGV_ACCEL,
  UGV_BRAKE,
  UGV_FAILSAFE_BRAKE,
  UGV_SPEED,
  newMotion,
  newSensors,
  readSensors,
  stepMotion,
  stepSensors,
  type Device,
  type Point,
  type RoutePoint,
  type SensorState,
  type SrvCommand,
  type SrvDrive,
  type TeleopLimits,
  type VehicleMotion,
  INDOOR_UGV_SPEED,
  FLOOR_PATROL_RESUME_MS,
  floorPatrolLoop,
  floorPlan,
} from '@13store/shared';
import { DriveState } from '../drive';
import { admitCommand } from '../sdk';
import { SimDevice, type SimOptions } from './base';
import { ComponentTracker } from './components';

/** Link-loss time after which the vehicle stops in place. */
export const UGV_FAILSAFE_MS = 1_500;
/** Command timing on the simulated vehicle. */
export const UGV_ACK_MS = 300;
export const UGV_EXEC_MS = 600;
/** Earliest moment the effect of a command is checked; it is then polled until confirmed. */
export const UGV_CONFIRM_MS = 700;
/** Give up confirming an effect after this long (reported as failed). */
export const UGV_CONFIRM_TIMEOUT_MS = 8_000;
/** Physics step of the simulated vehicle (ms), independent of the telemetry rate. */
const PHYSICS_MS = 100;
/** Console driving on outdoor simulated UGVs: the real adapter's default caps and dead-man. */
export const SIM_TELEOP: TeleopLimits = { maxThrottle: 0.3, maxSteer: 0.6, deadmanMs: 500 };
/** Turn rate at full stick (deg/s), before the steering cap. Tracked vehicles turn on the spot. */
const DRIVE_YAW_RATE = 90;

type Mode = 'idle' | 'moving' | 'paused';

export class SimUgv extends SimDevice {
  motion!: VehicleMotion;
  sensors!: SensorState;
  mode: Mode = 'idle';
  failsafeAt?: number;
  /** Indoor patrol robot (capability `floor_patrol`) driving its own floor round between missions. */
  round = false;
  private lastCmdAt = -Infinity;
  private failsafeTimer?: ReturnType<typeof setTimeout>;
  private physics?: ReturnType<typeof setInterval>;
  private lastPhysics = 0;
  /** Waiting at a checkpoint (its holdS) until this time, like the autopilot's hold time. */
  private holdUntil = 0;
  // console driving
  private drive = new DriveState(SIM_TELEOP.deadmanMs);
  /** Signed speed while driven from the console (m/s, negative = reversing). */
  private driveSpeed = 0;
  private driveComps?: ComponentTracker;

  constructor(seed: Device, opts: SimOptions = {}) {
    super(seed, opts);
    if (!seed.indoor) {
      const part = { id: 'drive', name: 'Console driving (simulated)', kind: 'other' as const, status: 'ok' as const, detail: 'Idle' };
      this.driveComps = new ComponentTracker([part]);
      this.declaration.teleop = SIM_TELEOP;
      this.declaration.components = [...(this.declaration.components ?? []), part];
    }
    this.resetState();
  }

  // True position and state (tests and the vehicle itself use these; telemetry adds sensor noise).
  get pos(): Point {
    return { x: this.motion.x, y: this.motion.y };
  }
  get speed() {
    return this.motion.speed;
  }
  get battery() {
    return this.sensors.battery;
  }
  get route() {
    return this.motion.route;
  }
  get nextCp() {
    return this.motion.nextCp;
  }

  protected resetState() {
    this.clearFailsafeTimer();
    this.motion = newMotion(this.seed.pos, this.seed.heading ?? 90, this.seed.indoor ? INDOOR_UGV_SPEED : undefined);
    this.sensors = newSensors(this.seed.battery ?? 100, 'ugv');
    this.mode = 'idle';
    this.failsafeAt = undefined;
    this.round = false;
    this.lastCmdAt = -Infinity;
    this.drive.end();
    this.driveSpeed = 0;
  }

  start(ctx: Parameters<SimDevice['start']>[0]) {
    super.start(ctx);
    this.lastPhysics = ctx.now();
    this.physics = setInterval(() => this.physicsStep(), PHYSICS_MS);
  }

  stop() {
    this.clearFailsafeTimer();
    if (this.physics) clearInterval(this.physics);
    this.physics = undefined;
    super.stop();
  }

  /** Telemetry ticks don't move the vehicle; the physics timer does. */
  protected step() {}

  private physicsStep() {
    const now = this.ctx.now();
    const dt = Math.max(0, now - this.lastPhysics) / 1000;
    this.lastPhysics = now;
    if (this.drive.active || this.driveSpeed !== 0) {
      this.driveStep(now, dt);
      stepSensors(this.sensors, dt, 'ugv', this.motion.speed);
      return;
    }
    this.roundStep(now);
    if (now < this.holdUntil && this.mode !== 'idle') {
      // A checkpoint with a wait: stand still until it is over.
      this.motion.speed = 0;
      stepSensors(this.sensors, dt, 'ugv', 0);
      return;
    }
    const r = stepMotion(this.motion, dt);
    stepSensors(this.sensors, dt, 'ugv', this.motion.speed);
    // Docked: idle within 3 m of the home position → the charger tops the battery up (~1 % per 20 s).
    if (this.mode === 'idle' && this.motion.speed === 0 && Math.hypot(this.motion.x - this.seed.pos.x, this.motion.y - this.seed.pos.y) < 3)
      this.sensors.battery = Math.min(100, this.sensors.battery + 0.05 * dt);
    if (this.round) return; // the robot's own round: no checkpoint or completion events for the platform
    const route = this.motion.route;
    for (const cp of r.checkpoints) {
      if (!route || cp >= route.length) continue;
      this.emit({ kind: 'checkpoint', checkpoint: cp, detail: `Reached checkpoint ${cp + 1} of ${route.length}` });
      const hold = (route[cp] as RoutePoint).holdS;
      if (hold && cp < route.length - 1) this.holdUntil = now + hold * 1000;
    }
    if (r.completed) {
      this.mode = 'idle';
      this.emit({ kind: 'route_complete', detail: 'Final checkpoint reached. Vehicle holding position.' });
      this.emit({ kind: 'snapshot', detail: 'Onboard camera frame at final checkpoint (simulated).', frame: snapshotFrame(this.declaration.deviceId, now) });
    }
  }

  /**
   * Between missions an indoor patrol robot drives its floor's round on a loop, like the real one
   * would on its own schedule. It stops the round when a command arrives, a mission holds it, the
   * link drops or the battery is low, and resumes after FLOOR_PATROL_RESUME_MS of quiet.
   */
  private roundStep(now: number) {
    const seed = this.seed;
    if (!seed.indoor || !seed.capabilities.includes('floor_patrol')) return;
    const m = this.motion;
    const blocked = this.mode !== 'idle' || this.linkCut || this.failsafeAt !== undefined || this.sensors.battery < 20 || now - this.lastCmdAt < FLOOR_PATROL_RESUME_MS;
    if (blocked) {
      if (this.round && this.mode === 'idle') {
        m.intent = 'hold';
        m.route = null;
      }
      this.round = false;
      return;
    }
    if (this.round && m.route && !m.done) return;
    const route = floorPatrolLoop(floorPlan(seed.indoor.buildingId, seed.indoor.level), { x: m.x, y: m.y });
    if (!route) return;
    m.route = route;
    m.nextCp = 0;
    m.done = false;
    m.intent = 'drive';
    m.brake = 'normal';
    this.round = true;
  }

  protected sendTelemetry(now: number) {
    const r = readSensors(this.sensors, this.pos, 'ugv', { slam: !!this.seed.indoor });
    this.publish({
      seq: ++this.seq,
      sourceTime: now,
      pos: r.pos,
      accuracyM: r.accuracyM,
      battery: r.battery,
      speed: Math.round(this.motion.speed * 100) / 100,
      heading: Math.round(this.motion.heading),
      signal: r.signal,
      satellites: r.satellites,
      temperatureC: r.temperatureC,
      quality: r.signal < 45 || r.accuracyM > 2.2 ? 'degraded' : 'good',
      nextCp: this.motion.route && !this.round ? this.motion.nextCp : undefined,
      floorPatrol: this.seed.indoor ? this.round : undefined,
      components: this.driveComps?.flush(),
    });
  }

  // ---- console driving --------------------------------------------------------------------

  onDrive(s: SrvDrive) {
    if (!this.declaration.teleop || this.linkCut) return; // the radio never delivered it
    if (this.mode !== 'idle') return; // on a route: the route owns the vehicle
    const r = this.drive.accept(s, this.ctx.now());
    if (r === 'release') return this.endDrive('released by the console');
    if (r === 'start') this.ctx.log.info(`${this.declaration.deviceId}: console driving started`);
  }

  private endDrive(why: string) {
    if (!this.drive.active) return;
    this.drive.end();
    this.ctx.log.info(`${this.declaration.deviceId}: console driving ended (${why})`);
    this.driveComps?.set('drive', { status: 'ok', detail: `Idle (${why})` });
  }

  /** Throttle sets a target speed, steering a turn rate; the vehicle accelerates and brakes as on a route. */
  private driveStep(now: number, dt: number) {
    const lim = this.declaration.teleop!;
    const step = this.drive.step(now);
    if (step?.kind === 'end') this.endDrive(step.reason);
    let throttle = 0;
    let steer = 0;
    if (step && step.kind !== 'end') {
      if (this.mode !== 'idle') {
        // A route started: it owns the vehicle now.
        this.endDrive('a route started');
        this.driveSpeed = 0;
        return;
      }
      if (step.kind === 'drive') {
        throttle = step.throttle * lim.maxThrottle;
        steer = step.steer * lim.maxSteer;
      }
      this.driveComps?.set(
        'drive',
        step.kind === 'drive'
          ? { status: 'ok', detail: `Driving from the console · throttle ≤${Math.round(lim.maxThrottle * 100)}% · steering ≤${Math.round(lim.maxSteer * 100)}%` }
          : step.reason === 'deadman'
            ? { status: 'warn', detail: 'No stick input from the console: stopped' }
            : { status: 'warn', detail: 'Stopped: centre the sticks to drive' },
      );
    }
    const m = this.motion;
    const target = throttle * (m.maxSpeed ?? UGV_SPEED);
    // Speeding up in the same direction uses the drive acceleration; anything else is braking.
    const speedingUp = Math.abs(target) > Math.abs(this.driveSpeed) && target * this.driveSpeed >= 0;
    const dv = (speedingUp ? UGV_ACCEL : UGV_BRAKE) * dt;
    this.driveSpeed = this.driveSpeed < target ? Math.min(target, this.driveSpeed + dv) : Math.max(target, this.driveSpeed - dv);
    if (Math.abs(this.driveSpeed) < 1e-3) this.driveSpeed = 0;
    m.heading = (m.heading + steer * DRIVE_YAW_RATE * dt + 360) % 360;
    const rad = (m.heading * Math.PI) / 180;
    m.x += Math.sin(rad) * this.driveSpeed * dt;
    m.y -= Math.cos(rad) * this.driveSpeed * dt;
    m.speed = Math.abs(this.driveSpeed);
    m.intent = 'hold';
  }

  protected handleCommand(cmd: SrvCommand) {
    if (!admitCommand(this.ctx, this.declaration, this.ledger, cmd)) return;
    // Any command from the platform takes over from the robot's own round.
    this.lastCmdAt = this.ctx.now();
    if (this.round) {
      this.round = false;
      this.motion.intent = 'hold';
      this.motion.route = null;
    }
    const why = this.invalid(cmd);
    if (why) return this.report(cmd.commandId, 'rejected', cmd, why);
    this.later(UGV_ACK_MS, () => this.report(cmd.commandId, 'acknowledged', cmd));
    this.later(UGV_EXEC_MS, () => {
      const late = this.invalid(cmd);
      if (late) return this.report(cmd.commandId, 'failed', cmd, late);
      this.apply(cmd);
      this.report(cmd.commandId, 'executing', cmd);
      this.later(UGV_CONFIRM_MS - UGV_EXEC_MS, () => this.awaitEffect(cmd, this.ctx.now() + UGV_CONFIRM_TIMEOUT_MS));
    });
  }

  /** Confirm only once the vehicle really does it (moving for start/resume, speed 0 for pause/stop). */
  private awaitEffect(cmd: SrvCommand, deadline: number) {
    if (this.statusOf(cmd) !== 'executing') return;
    if (this.confirmed(cmd)) return this.report(cmd.commandId, 'succeeded', cmd);
    if (this.ctx.now() >= deadline) {
      return this.report(cmd.commandId, 'failed', cmd, `Effect not confirmed (vehicle ${this.mode}, speed ${this.motion.speed.toFixed(1)} m/s).`);
    }
    this.later(PHYSICS_MS, () => this.awaitEffect(cmd, deadline));
  }

  private statusOf(cmd: SrvCommand) {
    const c = this.ledger.check(cmd, -Infinity);
    return c.kind === 'duplicate' ? c.status : undefined;
  }

  /** Why the vehicle cannot do this right now, or undefined if it can. */
  private invalid(cmd: SrvCommand): string | undefined {
    switch (cmd.type) {
      case 'start':
        if (this.mode !== 'idle') return `Vehicle is ${this.mode}. Stop the current route first.`;
        if (!cmd.route?.length) return 'Start needs a route with at least one checkpoint.';
        return;
      case 'pause':
        return this.mode === 'moving' ? undefined : `Cannot pause while ${this.mode}.`;
      case 'resume':
        return this.mode === 'paused' ? undefined : `Cannot resume while ${this.mode}.`;
      case 'stop':
        return this.mode === 'idle' ? 'Vehicle is not on a route.' : undefined;
    }
  }

  private apply(cmd: SrvCommand) {
    const m = this.motion;
    switch (cmd.type) {
      case 'start':
        m.route = cmd.route!.map((p) => ({ ...p }));
        m.nextCp = 0;
        m.done = false;
        this.holdUntil = 0;
        m.intent = 'drive';
        m.brake = 'normal';
        this.mode = 'moving';
        break;
      case 'resume':
        m.intent = 'drive';
        m.brake = 'normal';
        this.mode = 'moving';
        this.failsafeAt = undefined;
        break;
      case 'pause':
        m.intent = 'hold';
        m.brake = 'normal';
        this.mode = 'paused';
        break;
      case 'stop':
        m.intent = 'hold';
        m.brake = 'normal';
        m.route = null;
        m.nextCp = 0;
        this.mode = 'idle';
        break;
    }
  }

  private confirmed(cmd: SrvCommand) {
    const m = this.motion;
    if (cmd.type === 'start' || cmd.type === 'resume') return (this.mode === 'moving' && m.speed > 0) || m.done;
    return m.speed === 0;
  }

  protected onLinkLost() {
    this.clearFailsafeTimer();
    this.failsafeTimer = setTimeout(() => {
      this.failsafeTimer = undefined;
      if (!this.linkCut) return;
      if (this.mode === 'moving' || this.motion.speed > 0) {
        this.mode = 'paused';
        this.motion.intent = 'hold';
        this.motion.brake = 'hard';
        this.failsafeAt = this.ctx.now();
        this.ctx.log.warn(`${this.declaration.deviceId}: link-loss failsafe, braking to a stop (${UGV_FAILSAFE_BRAKE} m/s²)`);
      }
    }, UGV_FAILSAFE_MS);
  }

  protected onLinkRestored() {
    this.clearFailsafeTimer();
    if (this.failsafeAt !== undefined) {
      this.emit({ kind: 'failsafe_stop', at: this.failsafeAt, detail: 'Stopped in place after link loss. Waiting for the operator to resume.' });
      this.failsafeAt = undefined;
    }
  }

  private clearFailsafeTimer() {
    if (this.failsafeTimer) clearTimeout(this.failsafeTimer);
    this.failsafeTimer = undefined;
  }
}

/** Small SVG frame standing in for an onboard camera snapshot. */
export function snapshotFrame(deviceId: string, at: number) {
  const ts = new Date(at).toISOString().replace('T', ' ').slice(0, 19);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#1c2a3c"/>` +
    `<polygon points="0,180 130,92 190,92 320,180" fill="#2b3543"/><rect x="112" y="78" width="96" height="5" fill="#e8edf2"/>` +
    `<rect x="214" y="58" width="30" height="32" fill="#26364a" stroke="#4b5f78"/>` +
    `<text x="8" y="16" fill="#fbbf24" font-family="monospace" font-size="10">SIMULATED · ${deviceId}</text>` +
    `<text x="8" y="172" fill="#f1f5f9" font-family="monospace" font-size="10">${ts} UTC</text></svg>`;
  return { mime: 'image/svg+xml', base64: Buffer.from(svg).toString('base64') };
}
