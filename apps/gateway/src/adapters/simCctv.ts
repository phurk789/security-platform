// Simulated fixed camera: 1 Hz heartbeat at a fixed position with link quality. Video is rendered
// by the clients.
import { newSensors, readSensors, stepSensors, type SensorState } from '@13store/shared';
import { SimDevice } from './base';

export class SimCctv extends SimDevice {
  private sensors: SensorState = newSensors(100, 'cctv');

  protected resetState() {
    this.sensors = newSensors(100, 'cctv');
  }

  protected step(dt: number) {
    stepSensors(this.sensors, dt, 'cctv', 0);
  }

  protected sendTelemetry(now: number) {
    const r = readSensors(this.sensors, this.seed.pos, 'cctv');
    this.publish({
      seq: ++this.seq,
      sourceTime: now,
      pos: { ...this.seed.pos },
      accuracyM: this.seed.accuracyM,
      speed: 0,
      signal: r.signal,
      quality: 'good',
    });
  }
}
