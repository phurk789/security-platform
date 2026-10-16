// Simulated UAV. Static display model at the booth: position and video are simulated, no commands.
import type { Device } from '@13store/shared';
import { SimDevice, type SimOptions } from './base';

export class SimUav extends SimDevice {
  pos = { x: 318, y: 52 };
  battery: number;

  constructor(seed: Device, opts: SimOptions = {}) {
    super(seed, opts);
    this.battery = seed.battery ?? 100;
    this.resetState();
  }

  protected resetState() {
    this.battery = this.seed.battery ?? 100;
  }

  protected step(dt: number, now: number) {
    const a = (now / 1000) * 0.08;
    this.pos = { x: 318 + Math.cos(a) * 34, y: 52 + Math.sin(a) * 26 };
    this.battery = Math.max(20, this.battery - 0.01 * dt);
  }

  protected sendTelemetry(now: number) {
    this.ctx.telemetry({
      seq: ++this.seq,
      sourceTime: now,
      pos: { x: Math.round(this.pos.x * 100) / 100, y: Math.round(this.pos.y * 100) / 100 },
      alt: this.seed.alt ?? 40,
      accuracyM: this.seed.accuracyM,
      battery: Math.round(this.battery * 100) / 100,
      speed: 2.7,
      quality: 'good',
    });
  }
}
