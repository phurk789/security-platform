// Simulated UAV. Static display model at the booth: position and video are simulated, no commands.
// It loiters on a patrol orbit with wind drift, small altitude hold error and battery drain, and
// moves its orbit over an incident when the platform asks for overwatch (demo message).
import { UAV_PATROL, gaussian, newSensors, readSensors, stepSensors, uavOrbitPoint, type Device, type Point, type SensorState, type SrvDemo } from '@13store/shared';
import { SimDevice, type SimOptions } from './base';

const ORBIT = UAV_PATROL;

export class SimUav extends SimDevice {
  pos: Point = { x: ORBIT.cx + ORBIT.rx, y: ORBIT.cy };
  heading = 180;
  speed = 0;
  alt = 40;
  sensors!: SensorState;
  private placed = false;
  /** Current orbit centre and where it is heading (incident under overwatch, or the patrol loop). */
  private centre: Point = { x: ORBIT.cx, y: ORBIT.cy };
  private target: Point | null = null;

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
    this.centre = { x: ORBIT.cx, y: ORBIT.cy };
    this.target = null;
  }

  onDemo(action: SrvDemo['action'], target?: SrvDemo['target']) {
    if (action === 'overwatch') {
      this.target = target ?? null;
      return;
    }
    super.onDemo(action, target);
  }

  protected step(dt: number, now: number) {
    stepSensors(this.sensors, dt, 'uav', this.speed);
    const w = this.sensors.wind;
    const next = uavOrbitPoint(this.centre, this.target, now, dt, w);
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
