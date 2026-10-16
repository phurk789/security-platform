// BUILD YOUR OWN — a minimal adapter for a home-built patrol rover.
//
// Replace the "device" parts (driveTo / readOdometry) with calls to your controller
// (serial, MAVLink, ROS, vendor SDK…). Everything else is the contract the platform expects:
//   1. declare only what the rover really does (here: start and stop),
//   2. stream telemetry with the time it was measured and an honest accuracy,
//   3. confirm a command only when the rover confirms the effect,
//   4. never run an expired or repeated command (admitCommand does both).
//
// Run it with the gateway:
//   startGateway({ serverUrl, key, gatewayId, adapters: [new PatrolRover({ deviceId: 'ROVER-07', start: { x: 100, y: 200 } })] })
// The device id must first be registered on the server (Admin → Devices).

import type { AdapterDeclaration, Point, SrvCommand, SrvDemo } from '@13store/shared';
import { CommandLedger, admitCommand, type Adapter, type AdapterContext } from '../apps/gateway/src/sdk';

const SPEED = 2; // m/s

export class PatrolRover implements Adapter {
  readonly declaration: AdapterDeclaration;
  private ctx!: AdapterContext;
  private ledger = new CommandLedger();
  private timer?: ReturnType<typeof setInterval>;
  private seq = 0;
  private pos: Point;
  private target: Point[] = [];
  private speed = 0;
  private last = 0;

  constructor(opts: { deviceId: string; start: Point }) {
    this.pos = { ...opts.start };
    this.declaration = {
      deviceId: opts.deviceId,
      kind: 'ugv',
      model: 'DIY patrol rover (example)',
      adapterVersion: 'example 0.1',
      protocolVersion: 'example-serial/1',
      firmwareTested: 'example',
      integration: 'testing',
      capabilities: ['ground_patrol', 'waypoints'],
      commands: ['start', 'stop'],
      units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
      rateMs: 1000,
      limitations: 'Example only. No camera. Flat ground.',
      linkLossBehavior: 'Rover controller stops the motors after 2 s without a heartbeat.',
    };
  }

  start(ctx: AdapterContext) {
    this.ctx = ctx;
    this.last = ctx.now();
    this.timer = setInterval(() => this.loop(), this.declaration.rateMs);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  onCommand(cmd: SrvCommand) {
    if (!admitCommand(this.ctx, this.declaration, this.ledger, cmd)) return;
    if (cmd.type === 'start' && !cmd.route?.length) return this.update(cmd, 'rejected', 'No route given.');
    this.update(cmd, 'acknowledged');
    // Device call happens here; we confirm on the next odometry reading.
    if (cmd.type === 'start') this.driveTo(cmd.route!);
    else this.driveTo([]);
    this.update(cmd, 'executing');
    setTimeout(() => {
      const ok = cmd.type === 'start' ? this.speed > 0 : this.speed === 0;
      this.update(cmd, ok ? 'succeeded' : 'failed', ok ? undefined : 'Rover did not confirm.');
    }, 500);
  }

  onDemo(_action: SrvDemo['action']) {
    // Real hardware: presenter controls do not apply.
  }

  private update(cmd: SrvCommand, status: 'acknowledged' | 'executing' | 'succeeded' | 'rejected' | 'failed', detail?: string) {
    this.ledger.record(cmd, status, detail);
    this.ctx.commandUpdate({ commandId: cmd.commandId, status, detail });
  }

  // --- device side (replace with your controller) ---------------------------

  private driveTo(route: Point[]) {
    this.target = route.map((p) => ({ ...p }));
    this.speed = route.length ? SPEED : 0;
  }

  private loop() {
    const now = this.ctx.now();
    const dt = (now - this.last) / 1000;
    this.last = now;
    const next = this.target[0];
    if (next) {
      const gap = Math.hypot(next.x - this.pos.x, next.y - this.pos.y);
      const stepM = Math.min(gap, SPEED * dt);
      if (gap > 0) this.pos = { x: this.pos.x + ((next.x - this.pos.x) / gap) * stepM, y: this.pos.y + ((next.y - this.pos.y) / gap) * stepM };
      if (gap <= SPEED * dt) {
        this.target.shift();
        if (!this.target.length) {
          this.speed = 0;
          this.ctx.event({ kind: 'route_complete' });
        }
      }
    }
    this.ctx.telemetry({ seq: ++this.seq, sourceTime: now, pos: { ...this.pos }, accuracyM: 3, battery: 90, speed: this.speed, quality: 'good' });
  }
}
