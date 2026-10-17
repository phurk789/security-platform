import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ROUTE, seedDevices } from '@13store/shared';
import { SimCctv, SimUav, SimUgv, defaultAdapters } from '../src/adapters';
import { cmd, fakeCtx, statuses } from './helpers';

const seed = seedDevices(0);

beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
afterEach(() => vi.useRealTimers());

function ugv() {
  const a = new SimUgv(seed['UGV-01']);
  const { ctx, got } = fakeCtx();
  a.start(ctx);
  return { a, got };
}

describe('declarations', () => {
  it('builds the ten seed devices, all simulated, CCTV-04 offline by default', () => {
    const list = defaultAdapters();
    expect(list.map((a) => a.declaration.deviceId).sort()).toEqual(['CCTV-01', 'CCTV-02', 'CCTV-03', 'CCTV-04', 'CCTV-05', 'UAV-02', 'UGV-01', 'UGV-02', 'UGV-03', 'UGV-04']);
    expect(list.every((a) => a.declaration.integration === 'simulated')).toBe(true);
    const ugvDecl = list.find((a) => a.declaration.deviceId === 'UGV-01')!.declaration;
    expect(ugvDecl.commands).toEqual(['start', 'pause', 'resume', 'stop']);
    expect(ugvDecl.linkLossBehavior).toMatch(/Stops in place/);
    const cam4 = list.find((a) => a.declaration.deviceId === 'CCTV-04')! as SimCctv;
    const { ctx, got } = fakeCtx();
    cam4.start(ctx);
    vi.advanceTimersByTime(3000);
    expect(got.telemetry).toHaveLength(0);
    cam4.stop();
  });
});

describe('SimUgv', () => {
  it('sends 1 Hz telemetry with increasing seq and source time', () => {
    const { a, got } = ugv();
    vi.advanceTimersByTime(3000);
    expect(got.telemetry.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(got.telemetry[2].sourceTime - got.telemetry[0].sourceTime).toBe(2000);
    // GNSS noise: the reported fix sits within a couple of metres of the true position.
    const t0 = got.telemetry[0];
    expect(Math.hypot(t0.pos.x - seed['UGV-01'].pos.x, t0.pos.y - seed['UGV-01'].pos.y)).toBeLessThan(2.5);
    expect(t0.speed).toBe(0);
    expect(t0.battery).toBeCloseTo(82, 0);
    expect(t0.accuracyM).toBeGreaterThanOrEqual(0.8);
    expect(t0.accuracyM).toBeLessThanOrEqual(2.5);
    expect(t0.signal).toBeGreaterThan(20);
    expect(t0.satellites).toBeGreaterThan(5);
    a.stop();
  });

  it('start: acknowledged → executing → succeeded, then the vehicle moves along the route', () => {
    const { a, got } = ugv();
    const c = cmd('start', { route: DEFAULT_ROUTE });
    a.onCommand(c);
    expect(statuses(got, c.commandId)).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(statuses(got, c.commandId)).toEqual(['acknowledged', 'executing', 'succeeded']);
    vi.advanceTimersByTime(3000);
    const last = got.telemetry[got.telemetry.length - 1];
    expect(last.pos.x).toBeGreaterThan(seed['UGV-01'].pos.x);
    expect(last.speed).toBeGreaterThan(0);
    expect(last.nextCp).toBe(0);
    a.stop();
  });

  it('reaches the end of the route: checkpoint events, route_complete and a snapshot', () => {
    const { a, got } = ugv();
    a.onCommand(cmd('start', { route: DEFAULT_ROUTE }));
    vi.advanceTimersByTime(40_000);
    expect(got.events.filter((e) => e.kind === 'checkpoint').map((e) => e.checkpoint)).toEqual([0, 1, 2]);
    expect(got.events.some((e) => e.kind === 'route_complete')).toBe(true);
    const snap = got.events.find((e) => e.kind === 'snapshot')!;
    expect(snap.frame?.mime).toBe('image/svg+xml');
    expect(Buffer.from(snap.frame!.base64, 'base64').toString()).toContain('SIMULATED');
    expect(a.pos).toEqual(DEFAULT_ROUTE[DEFAULT_ROUTE.length - 1]);
    expect(got.telemetry[got.telemetry.length - 1].speed).toBe(0);
    a.stop();
  });

  it('never executes the same idempotency key twice and re-reports its status', () => {
    const { a, got } = ugv();
    const c = cmd('start', { route: DEFAULT_ROUTE });
    a.onCommand(c);
    vi.advanceTimersByTime(1000);
    a.onCommand({ ...c, commandId: 'CMD-retry' });
    a.onCommand(c);
    vi.advanceTimersByTime(1000);
    // Only one lifecycle; duplicates only echo the final status.
    expect(statuses(got, c.commandId)).toEqual(['acknowledged', 'executing', 'succeeded', 'succeeded', 'succeeded']);
    expect(got.updates.some((u) => u.commandId === 'CMD-retry')).toBe(false);
    a.stop();
  });

  it('rejects an expired command without executing it', () => {
    const { a, got } = ugv();
    const c = cmd('start', { route: DEFAULT_ROUTE, expiresAt: Date.now() - 1 });
    a.onCommand(c);
    vi.advanceTimersByTime(3000);
    expect(statuses(got, c.commandId)).toEqual(['rejected']);
    expect(got.updates[0].detail).toMatch(/expired/);
    expect(a.mode).toBe('idle');
    a.stop();
  });

  it('rejects commands that do not fit the current state', () => {
    const { a, got } = ugv();
    const p = cmd('pause');
    a.onCommand(p);
    const s = cmd('start');
    a.onCommand(s);
    expect(statuses(got, p.commandId)).toEqual(['rejected']);
    expect(statuses(got, s.commandId)).toEqual(['rejected']);
    a.stop();
  });

  it('pause holds position, resume continues, stop ends the route', () => {
    const { a, got } = ugv();
    a.onCommand(cmd('start', { route: DEFAULT_ROUTE }));
    vi.advanceTimersByTime(3000);
    const pause = cmd('pause');
    a.onCommand(pause);
    // The vehicle brakes (2.5 m/s²); the pause is confirmed only once it has stopped.
    vi.advanceTimersByTime(1000);
    expect(statuses(got, pause.commandId)).toEqual(['acknowledged', 'executing']);
    expect(a.speed).toBeGreaterThan(0);
    vi.advanceTimersByTime(3000);
    expect(statuses(got, pause.commandId)).toEqual(['acknowledged', 'executing', 'succeeded']);
    expect(a.speed).toBe(0);
    const held = { ...a.pos };
    vi.advanceTimersByTime(3000);
    expect(a.pos).toEqual(held);
    a.onCommand(cmd('resume'));
    vi.advanceTimersByTime(3000);
    expect(a.pos).not.toEqual(held);
    const stop = cmd('stop');
    a.onCommand(stop);
    vi.advanceTimersByTime(4000);
    expect(statuses(got, stop.commandId)).toEqual(['acknowledged', 'executing', 'succeeded']);
    expect(a.mode).toBe('idle');
    expect(a.route).toBeNull();
    a.stop();
  });

  it('cut link: telemetry stops, commands are lost, the vehicle stops by failsafe', () => {
    const { a, got } = ugv();
    a.onCommand(cmd('start', { route: DEFAULT_ROUTE }));
    vi.advanceTimersByTime(2000);
    a.onDemo('cut_link');
    const cutAt = Date.now();
    const n = got.telemetry.length;
    const lost = cmd('stop');
    a.onCommand(lost);
    vi.advanceTimersByTime(5000);
    expect(got.telemetry.length).toBe(n);
    expect(statuses(got, lost.commandId)).toEqual([]);
    expect(a.speed).toBe(0);
    expect(a.mode).toBe('paused');
    expect(a.failsafeAt).toBe(cutAt + 1500);
    a.stop();
  });

  it('restore: reports failsafe_stop, does not move by itself, never runs commands lost during the cut', () => {
    const { a, got } = ugv();
    a.onCommand(cmd('start', { route: DEFAULT_ROUTE }));
    vi.advanceTimersByTime(2000);
    a.onDemo('cut_link');
    const lost = cmd('resume');
    a.onCommand(lost);
    vi.advanceTimersByTime(4000);
    const stoppedAt = { ...a.pos };
    a.onDemo('restore_link');
    const fs = got.events.find((e) => e.kind === 'failsafe_stop')!;
    expect(fs).toBeTruthy();
    expect(fs.at).toBeLessThan(Date.now());
    vi.advanceTimersByTime(5000);
    expect(a.pos).toEqual(stoppedAt);
    expect(got.telemetry[got.telemetry.length - 1].speed).toBe(0);
    expect(statuses(got, lost.commandId)).toEqual([]);
    // The same key re-sent after reconnect is a new delivery and now runs (operator chose to resume).
    a.onCommand(lost);
    vi.advanceTimersByTime(3000);
    expect(statuses(got, lost.commandId)).toEqual(['acknowledged', 'executing', 'succeeded']);
    expect(a.pos).not.toEqual(stoppedAt);
    a.stop();
  });

  it('a short blip under the failsafe time does not stop the vehicle', () => {
    const { a, got } = ugv();
    a.onCommand(cmd('start', { route: DEFAULT_ROUTE }));
    vi.advanceTimersByTime(1500);
    a.onDemo('cut_link');
    vi.advanceTimersByTime(800);
    a.onDemo('restore_link');
    vi.advanceTimersByTime(2000);
    expect(a.mode).toBe('moving');
    expect(got.events.some((e) => e.kind === 'failsafe_stop')).toBe(false);
    a.stop();
  });

  it('accelerates gradually, reaches cruise speed and brakes onto the final checkpoint', () => {
    const { a } = ugv();
    a.onCommand(cmd('start', { route: DEFAULT_ROUTE }));
    vi.advanceTimersByTime(1500);
    expect(a.speed).toBeGreaterThan(0);
    expect(a.speed).toBeLessThan(2); // ~0.9 s of 1.5 m/s²
    const speeds: number[] = [];
    for (let i = 0; i < 300; i++) {
      vi.advanceTimersByTime(100);
      speeds.push(a.speed);
    }
    expect(Math.max(...speeds)).toBeCloseTo(6, 0);
    const lastMoving = speeds.findLastIndex((v) => v > 0);
    expect(speeds[lastMoving]).toBeLessThan(1.5); // creeping onto the checkpoint, not slamming into it
    expect(a.pos).toEqual(DEFAULT_ROUTE[DEFAULT_ROUTE.length - 1]);
    a.stop();
  });

  it('latency option: samples arrive 45–400 ms after they were measured, in order', () => {
    const a = new SimUgv(seed['UGV-01'], { latency: true });
    const { ctx, got } = fakeCtx();
    const arrivals: number[] = [];
    const orig = ctx.telemetry;
    ctx.telemetry = (s) => {
      arrivals.push(Date.now() - s.sourceTime);
      orig(s);
    };
    a.start(ctx);
    vi.advanceTimersByTime(5500);
    expect(got.telemetry.map((s) => s.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(arrivals.every((ms) => ms >= 45 && ms <= 400)).toBe(true);
    a.stop();
  });

  it('reset returns to the seed state', () => {
    const { a } = ugv();
    a.onCommand(cmd('start', { route: DEFAULT_ROUTE }));
    vi.advanceTimersByTime(4000);
    a.onDemo('reset');
    expect(a.pos).toEqual(seed['UGV-01'].pos);
    expect(a.mode).toBe('idle');
    expect(a.battery).toBe(82);
    a.stop();
  });
});

describe('SimUav and SimCctv', () => {
  it('UAV orbits at 40 m and rejects commands', () => {
    const a = new SimUav(seed['UAV-02']);
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    vi.advanceTimersByTime(3000);
    expect(got.telemetry).toHaveLength(3);
    expect(got.telemetry[0].alt).toBeCloseTo(40, 0);
    expect(got.telemetry[0].heading).toBeGreaterThanOrEqual(0);
    expect(got.telemetry[0].pos).not.toEqual(got.telemetry[2].pos);
    const c = cmd('start', { deviceId: 'UAV-02' });
    a.onCommand(c);
    expect(statuses(got, c.commandId)).toEqual(['rejected']);
    a.stop();
  });

  it('CCTV heartbeats at a fixed position and can be cut and restored', () => {
    const a = new SimCctv(seed['CCTV-02']);
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    vi.advanceTimersByTime(2000);
    expect(got.telemetry.every((t) => t.pos.x === 376 && t.pos.y === 212)).toBe(true);
    a.onDemo('cut_link');
    vi.advanceTimersByTime(3000);
    expect(got.telemetry).toHaveLength(2);
    a.onDemo('restore_link');
    vi.advanceTimersByTime(1000);
    expect(got.telemetry).toHaveLength(3);
    a.stop();
  });
});

describe('SimUav', () => {
  it('orbits the patrol loop, flies to an overwatch target on demand and returns when released', () => {
    const a = new SimUav(seed['UAV-02']);
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    vi.advanceTimersByTime(3000);
    const p0 = got.telemetry.at(-1)!.pos;
    expect(Math.hypot(p0.x - 318, p0.y - 52)).toBeLessThan(45);
    a.onDemo('overwatch', { x: 335, y: 236 });
    vi.advanceTimersByTime(40_000);
    const p1 = got.telemetry.at(-1)!.pos;
    expect(Math.hypot(p1.x - 335, p1.y - 236)).toBeLessThan(26);
    expect(got.telemetry.at(-1)!.alt).toBeGreaterThan(30);
    a.onDemo('overwatch', null);
    vi.advanceTimersByTime(40_000);
    const p2 = got.telemetry.at(-1)!.pos;
    expect(Math.hypot(p2.x - 318, p2.y - 52)).toBeLessThan(45);
    a.stop();
  });
});
