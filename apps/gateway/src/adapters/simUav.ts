// Simulated UAV. Static display model at the booth: position and video are simulated, no commands.
// It loiters on an overwatch orbit with wind drift, small altitude hold error and battery drain.
import { gaussian, newSensors, readSensors, stepSensors, type Device, type Point, type SensorState } from '@13store/shared';
import { SimDevice, type SimOptions } from './base';

const ORBIT = { cx: 318, cy: 52, rx: 34, ry: 26, rate: 0.08 };

export class SimUav extends SimDevice {
  pos: Point = { x: ORBIT.cx + ORBIT.rx, y: ORBIT.cy };
  heading = 180;
  speed = 0;
  alt = 40;
  sensors!: SensorState;
  private placed = false;

  constructor(seed: Device, opts: SimOptions = {}) {
    super(seed, opts);
    this.resetState();
  }

  get battery() {
    return this.sensors.battery;
  }

  protected resetState() {
    this.sensors = newSensors(this.seed.battery ?? 100, 'uav');
    this.alt = this.seed.alt ?? 40;
    this.placed = false;
  }

  protected step(dt: number, now: number) {
    stepSensors(this.sensors, dt, 'uav', this.speed);
    const a = (now / 1000) * ORBIT.rate;
    const w = this.sensors.wind;
    const next = { x: ORBIT.cx + Math.cos(a) * ORBIT.rx + w.x * 1.5, y: ORBIT.cy + Math.sin(a) * ORBIT.ry + w.y * 1.5 };
    if (!this.placed) {
      this.placed = true;
    } else if (dt > 0) {
      const dx = next.x - this.pos.x;
      const dy = next.y - this.pos.y;
      this.speed = Math.hypot(dx, dy) / dt;
      if (Math.hypot(dx, dy) > 0.01) this.heading = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    }
    this.pos = next;
    // Altitude hold: ±0.5 m around the set point.
    const target = this.seed.alt ?? 40;
    this.alt += (target - this.alt) * Math.min(1, dt / 4) + gaussian() * 0.12 * Math.sqrt(Math.max(dt, 0));
    this.sensors.battery = Math.max(20, this.sensors.battery);
  }

  protected sendTelemetry(now: number) {
    const r = readSensors(this.sensors, this.pos, 'uav');
    this.publish({
      seq: ++this.seq,
      sourceTime: now,
      pos: r.pos,
      alt: Math.round(this.alt * 10) / 10,
      accuracyM: r.accuracyM,
      battery: r.battery,
      speed: Math.round(this.speed * 10) / 10,
      heading: Math.round(this.heading),
      signal: r.signal,
      satellites: r.satellites,
      temperatureC: r.temperatureC,
      quality: 'good',
    });
  }
}
