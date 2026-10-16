// Simulated fixed camera: 1 Hz heartbeat at a fixed position. Video is drawn by the clients.
import { SimDevice } from './base';

export class SimCctv extends SimDevice {
  protected resetState() {}
  protected step() {}

  protected sendTelemetry(now: number) {
    this.ctx.telemetry({
      seq: ++this.seq,
      sourceTime: now,
      pos: { ...this.seed.pos },
      accuracyM: this.seed.accuracyM,
      speed: 0,
      quality: 'good',
    });
  }
}
