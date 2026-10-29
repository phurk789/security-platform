// Console driving state shared by the real and simulated adapters: sample order, the dead-man,
// and "centre the sticks after any stop". The adapter decides what a stick position does.
import type { SrvDrive } from '@13store/shared';

/** After the dead-man trips, hold the sticks at neutral this long, then hand them back to the remote. */
export const DRIVE_NEUTRAL_HOLD_MS = 1000;
/** Sticks closer to the middle than this count as centred. */
const CENTRED = 0.05;

export type DriveStep =
  /** Apply these stick positions (−1…1, before the adapter's caps). */
  | { kind: 'drive'; throttle: number; steer: number }
  /** Keep the vehicle stopped: the console has not centred its sticks yet, or samples stopped. */
  | { kind: 'hold'; reason: 'centre' | 'deadman' }
  /** No samples for the dead-man time plus DRIVE_NEUTRAL_HOLD_MS: end the drive. */
  | { kind: 'end'; reason: string };

export class DriveState {
  private last: { seq: number; throttle: number; steer: number; at: number } | null = null;
  private needsCentre = true;

  constructor(private deadmanMs: number) {}

  /** A drive is open (samples arrived and it has not ended). */
  get active() {
    return this.last !== null;
  }

  /**
   * One message from the server. `release`: the console let go (the adapter ends the drive).
   * `late`: older than one already applied, ignored. `start`: the first sample of a drive.
   */
  accept(s: SrvDrive, now: number): 'start' | 'sample' | 'release' | 'late' {
    if (s.release) return 'release';
    if (this.last && s.seq <= this.last.seq) return 'late';
    const v = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? Math.max(-1, Math.min(1, x)) : 0);
    const first = !this.last;
    this.last = { seq: s.seq, throttle: v(s.throttle), steer: v(s.steer), at: now };
    if (Math.abs(this.last.throttle) < CENTRED && Math.abs(this.last.steer) < CENTRED) this.needsCentre = false;
    return first ? 'start' : 'sample';
  }

  /** Something else stopped the vehicle (disarmed, wrong mode, link): wait for centred sticks again. */
  interrupt() {
    this.needsCentre = true;
  }

  /** What the vehicle should do now, or null when no drive is open. */
  step(now: number): DriveStep | null {
    const d = this.last;
    if (!d) return null;
    const age = now - d.at;
    if (age > this.deadmanMs + DRIVE_NEUTRAL_HOLD_MS) return { kind: 'end', reason: `no stick input for ${(age / 1000).toFixed(1)} s` };
    if (age > this.deadmanMs) {
      this.needsCentre = true;
      return { kind: 'hold', reason: 'deadman' };
    }
    if (this.needsCentre) return { kind: 'hold', reason: 'centre' };
    return { kind: 'drive', throttle: d.throttle, steer: d.steer };
  }

  end() {
    this.last = null;
    this.needsCentre = true;
  }
}
