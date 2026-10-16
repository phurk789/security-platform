// Simulated patrol UGV. Behaves like the real vehicle should: confirms commands only when the
// effect is real, stops by itself on link loss, and never resumes or replays on reconnect.
import { UGV_SPEED, dist, type Device, type Point, type SrvCommand } from '@13store/shared';
import { admitCommand } from '../sdk';
import { SimDevice, type SimOptions } from './base';

/** Link-loss time after which the vehicle stops in place. */
export const UGV_FAILSAFE_MS = 1_500;
/** Command timing on the simulated vehicle. */
export const UGV_ACK_MS = 300;
export const UGV_EXEC_MS = 600;
export const UGV_CONFIRM_MS = 900;

type Mode = 'idle' | 'moving' | 'paused';

export class SimUgv extends SimDevice {
  pos!: Point;
  battery!: number;
  speed = 0;
  mode: Mode = 'idle';
  route: Point[] | null = null;
  nextCp = 0;
  failsafeAt?: number;
  private failsafeTimer?: ReturnType<typeof setTimeout>;

  constructor(seed: Device, opts: SimOptions = {}) {
    super(seed, opts);
    this.resetState();
  }

  protected resetState() {
    this.clearFailsafeTimer();
    this.pos = { ...this.seed.pos };
    this.battery = this.seed.battery ?? 100;
    this.speed = 0;
    this.mode = 'idle';
    this.route = null;
    this.nextCp = 0;
    this.failsafeAt = undefined;
  }

  stop() {
    this.clearFailsafeTimer();
    super.stop();
  }

  protected step(dt: number) {
    if (this.mode !== 'moving' || !this.route) {
      this.speed = this.mode === 'moving' ? this.speed : 0;
      return;
    }
    let budget = UGV_SPEED * dt;
    while (budget > 0 && this.nextCp < this.route.length) {
      const target = this.route[this.nextCp];
      const gap = dist(this.pos, target);
      if (gap <= budget) {
        this.pos = { ...target };
        budget -= gap;
        this.nextCp += 1;
        this.emit({ kind: 'checkpoint', checkpoint: this.nextCp - 1, detail: `Reached checkpoint ${this.nextCp} of ${this.route.length}` });
      } else {
        this.pos = { x: this.pos.x + ((target.x - this.pos.x) / gap) * budget, y: this.pos.y + ((target.y - this.pos.y) / gap) * budget };
        budget = 0;
      }
    }
    this.battery = Math.max(0, this.battery - 0.05 * dt);
    if (this.nextCp >= this.route.length) {
      this.mode = 'idle';
      this.speed = 0;
      this.emit({ kind: 'route_complete', detail: 'Final checkpoint reached. Vehicle holding position.' });
      this.emit({ kind: 'snapshot', detail: 'Onboard camera frame at final checkpoint (simulated).', frame: snapshotFrame(this.declaration.deviceId, this.ctx.now()) });
    }
  }

  protected sendTelemetry(now: number) {
    this.ctx.telemetry({
      seq: ++this.seq,
      sourceTime: now,
      pos: { x: round(this.pos.x), y: round(this.pos.y) },
      accuracyM: this.seed.accuracyM,
      battery: round(this.battery),
      speed: this.speed,
      quality: 'good',
      nextCp: this.route ? this.nextCp : undefined,
    });
  }

  protected handleCommand(cmd: SrvCommand) {
    if (!admitCommand(this.ctx, this.declaration, this.ledger, cmd)) return;
    const why = this.invalid(cmd);
    if (why) return this.report(cmd.commandId, 'rejected', cmd, why);
    this.later(UGV_ACK_MS, () => this.report(cmd.commandId, 'acknowledged', cmd));
    this.later(UGV_EXEC_MS, () => {
      const late = this.invalid(cmd);
      if (late) return this.report(cmd.commandId, 'failed', cmd, late);
      this.apply(cmd);
      this.report(cmd.commandId, 'executing', cmd);
    });
    this.later(UGV_CONFIRM_MS, () => {
      if (this.statusOf(cmd) !== 'executing') return; // failed earlier
      const ok = this.confirmed(cmd);
      this.report(cmd.commandId, ok ? 'succeeded' : 'failed', cmd, ok ? undefined : `Effect not confirmed (vehicle ${this.mode}, speed ${this.speed}).`);
    });
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
    switch (cmd.type) {
      case 'start':
        this.route = cmd.route!.map((p) => ({ ...p }));
        this.nextCp = 0;
        this.mode = 'moving';
        this.speed = UGV_SPEED;
        break;
      case 'resume':
        this.mode = 'moving';
        this.speed = UGV_SPEED;
        this.failsafeAt = undefined;
        break;
      case 'pause':
        this.mode = 'paused';
        this.speed = 0;
        break;
      case 'stop':
        this.mode = 'idle';
        this.route = null;
        this.nextCp = 0;
        this.speed = 0;
        break;
    }
  }

  private confirmed(cmd: SrvCommand) {
    if (cmd.type === 'start' || cmd.type === 'resume') return (this.mode === 'moving' && this.speed > 0) || (this.route !== null && this.nextCp >= this.route.length);
    return this.speed === 0;
  }

  protected onLinkLost() {
    this.clearFailsafeTimer();
    this.failsafeTimer = setTimeout(() => {
      this.failsafeTimer = undefined;
      if (!this.linkCut) return;
      if (this.mode === 'moving' || this.speed > 0) {
        this.mode = 'paused';
        this.speed = 0;
        this.failsafeAt = this.ctx.now();
        this.ctx.log.warn(`${this.declaration.deviceId}: link-loss failsafe, stopped in place`);
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

function round(n: number) {
  return Math.round(n * 100) / 100;
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
