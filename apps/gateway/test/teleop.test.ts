// Live driving from the console: the shared dead-man rules, RC overrides on a MAVLink rover
// (against a protocol-accurate fake behind a UDP datalink), and the simulated UGV.
import dgram from 'node:dgram';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, common, minimal, type MavLinkPacket } from 'node-mavlink';
import { seedDevices, type GeoAnchor, type SrvDrive } from '@13store/shared';
import { DRIVE_NEUTRAL_HOLD_MS, DriveState } from '../src/drive';
import { MavlinkVehicleAdapter, TELEOP_DEFAULTS, teleopProblem } from '../src/real/mavlinkVehicle';
import { ConfigError, parseSiteConfig } from '../src/real/config';
import { SimUgv } from '../src/adapters';
import { cmd, fakeCtx } from './helpers';

const GEO: GeoAnchor = { originLat: 13.7563, originLon: 100.5018, rotationDeg: 0 };
const sample = (seq: number, throttle: number, steer: number, extra: Partial<SrvDrive> = {}): SrvDrive => ({ t: 'drive', deviceId: 'UGV-09', seq, throttle, steer, at: 0, ...extra });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(20);
  }
  throw new Error('until timed out');
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
  vi.useRealTimers();
});

describe('drive state (shared by the real and simulated adapters)', () => {
  it('waits for centred sticks, ignores late samples, and holds then ends when samples stop', () => {
    const d = new DriveState(500);
    expect(d.step(0)).toBeNull();
    expect(d.accept(sample(1, 1, 0), 0)).toBe('start');
    // Full throttle on the very first sample does not move the vehicle.
    expect(d.step(0)).toEqual({ kind: 'hold', reason: 'centre' });
    expect(d.accept(sample(2, 0, 0), 100)).toBe('sample');
    expect(d.accept(sample(3, 0.5, -2), 200)).toBe('sample');
    expect(d.step(200)).toEqual({ kind: 'drive', throttle: 0.5, steer: -1 }); // clamped to −1…1
    expect(d.accept(sample(3, 1, 1), 250)).toBe('late');
    expect(d.accept(sample(2, 1, 1), 250)).toBe('late');
    // Dead-man: stopped once 500 ms pass without a sample.
    expect(d.step(700)).toEqual({ kind: 'drive', throttle: 0.5, steer: -1 });
    expect(d.step(701)).toEqual({ kind: 'hold', reason: 'deadman' });
    // Samples coming back after the dead-man tripped: centre first.
    expect(d.accept(sample(4, 1, 0), 900)).toBe('sample');
    expect(d.step(900)).toEqual({ kind: 'hold', reason: 'centre' });
    expect(d.accept(sample(5, 0.02, 0.01), 950)).toBe('sample');
    expect(d.accept(sample(6, 1, 0), 1000)).toBe('sample');
    expect(d.step(1000)).toEqual({ kind: 'drive', throttle: 1, steer: 0 });
    // Something else stopped the vehicle: centre again.
    d.interrupt();
    expect(d.step(1000)).toEqual({ kind: 'hold', reason: 'centre' });
    // No samples for the dead-man time plus the neutral hold: the drive ends.
    expect(d.step(1000 + 500 + DRIVE_NEUTRAL_HOLD_MS - 1)).toEqual({ kind: 'hold', reason: 'deadman' });
    expect(d.step(1000 + 500 + DRIVE_NEUTRAL_HOLD_MS + 1)).toMatchObject({ kind: 'end', reason: expect.stringMatching(/no stick input/) });
    expect(d.accept(sample(7, 0, 0, { release: true }), 1000)).toBe('release');
    d.end();
    expect(d.active).toBe(false);
    expect(d.accept(sample(1, 0, 0), 2000)).toBe('start'); // a new drive may start its numbering again
  });

  it('checks teleop settings, and only allows them on ground vehicles', () => {
    expect(teleopProblem(true)).toBeUndefined();
    expect(teleopProblem({ maxThrottle: 0.5, steerChannel: 2 })).toBeUndefined();
    expect(teleopProblem({ maxThrottle: 1.5 })).toMatch(/maxThrottle/);
    expect(teleopProblem({ deadmanMs: 50 })).toMatch(/deadmanMs/);
    expect(teleopProblem({ steerChannel: 3 })).toMatch(/differ/);
    expect(teleopProblem({ throttleChannel: 19 })).toMatch(/1–18/);
    expect(teleopProblem({ center: 1500, travel: 800 })).toMatch(/µs/);
    const site = (dev: object) => ({ geo: { originLat: 13.9, originLon: 100.4 }, devices: [{ type: 'mavlink', deviceId: 'UGV-09', profile: 'ardupilot-rover', ...dev }] });
    expect(() => parseSiteConfig(site({ kind: 'ugv', teleop: true }))).not.toThrow();
    expect(() => parseSiteConfig(site({ kind: 'uav', profile: 'ardupilot-copter', teleop: true }))).toThrow(ConfigError);
    expect(() => parseSiteConfig(site({ kind: 'ugv', teleop: { maxSteer: 0 } }))).toThrow(/maxSteer/);
  });
});

/** ArduPilot Rover behind a UDP datalink; records every RC_CHANNELS_OVERRIDE it receives. */
function fakeRover() {
  const sock = dgram.createSocket('udp4');
  const proto = new MavLinkProtocolV2(1, 1);
  const input = new PassThrough();
  let seq = 0;
  let gcs: { port: number; address: string } | null = null;
  const st = { armed: true, mode: 0 /* MANUAL */, overrides: [] as Record<string, number>[], intervals: [] as number[][] };
  const send = (m: unknown) => gcs && sock.send(proto.serialize(m as never, seq++ & 0xff), gcs.port, gcs.address);
  input
    .pipe(new MavLinkPacketSplitter())
    .pipe(new MavLinkPacketParser())
    .on('data', (p: MavLinkPacket) => {
      const clazz = ({ ...minimal.REGISTRY, ...common.REGISTRY } as Record<number, never>)[p.header.msgid];
      if (!clazz) return;
      const d = p.protocol.data(p.payload, clazz) as unknown as Record<string, number>;
      if (p.header.msgid === 70) st.overrides.push({ ...d, sysid: p.header.sysid });
      if (p.header.msgid === 76 && d.command === 511) st.intervals.push([d._param1, d._param2]);
    });
  sock.on('message', (msg, r) => {
    gcs = { port: r.port, address: r.address };
    input.write(msg);
  });
  const timer = setInterval(() => {
    const hb = new minimal.Heartbeat();
    hb.type = 10 as never;
    hb.autopilot = 3 as never;
    hb.baseMode = ((st.armed ? 128 : 0) | 1) as never;
    hb.customMode = st.mode;
    hb.systemStatus = 4 as never;
    hb.mavlinkVersion = 3;
    send(hb);
  }, 100);
  return new Promise<{ port: number; st: typeof st; close: () => void }>((resolve) =>
    sock.bind(0, '127.0.0.1', () =>
      resolve({
        port: (sock.address() as { port: number }).port,
        st,
        close: () => {
          clearInterval(timer);
          sock.close();
        },
      }),
    ),
  );
}

async function roverAdapter(teleop: ConstructorParameters<typeof MavlinkVehicleAdapter>[0]['teleop'] = true) {
  const rover = await fakeRover();
  const a = new MavlinkVehicleAdapter({ deviceId: 'UGV-09', kind: 'ugv', profile: 'ardupilot-rover', link: { mode: 'client', host: '127.0.0.1', port: rover.port }, geo: GEO, teleop });
  const { ctx, got } = fakeCtx();
  a.start(ctx);
  cleanup.push(() => a.stop(), rover.close);
  await until(() => got.telemetry.length > 0);
  const driveDetail = () =>
    got.telemetry
      .flatMap((t) => t.components ?? [])
      .filter((c) => c.id === 'drive')
      .at(-1);
  return { a, rover, got, driveDetail };
}

/** Steering on ch1 and throttle on ch3 of the last override; the other channels must be left alone. */
function last(st: { overrides: Record<string, number>[] }) {
  const o = st.overrides.at(-1) ?? {};
  return { steer: o.chan1Raw, throttle: o.chan3Raw, others: [o.chan2Raw, o.chan4Raw, o.chan8Raw, o.chan9Raw, o.chan12Raw], sysid: o.sysid };
}

describe('MAVLink rover: console driving through RC overrides', () => {
  it('declares its limits, waits for centred sticks, then overrides only steering and throttle within the caps', async () => {
    const { a, rover, driveDetail } = await roverAdapter();
    expect(a.declaration.teleop).toEqual({ maxThrottle: 0.3, maxSteer: 0.6, deadmanMs: 500 });
    expect(a.declaration.components?.find((c) => c.id === 'drive')).toMatchObject({ status: 'pending' });

    a.onDrive(sample(1, 1, 1));
    await until(() => rover.st.overrides.length > 0);
    // First sample is full stick: the vehicle is held at neutral until the sticks are centred.
    expect(last(rover.st)).toMatchObject({ steer: 1500, throttle: 1500, sysid: 255 });
    a.onDrive(sample(2, 0, 0));
    a.onDrive(sample(3, 1, 1));
    await until(() => last(rover.st).throttle !== 1500);
    // 1500 ± stick × cap × 400 µs; every other channel "ignore" (65535 on 1–8, 0 on 9–18).
    expect(last(rover.st)).toEqual({ steer: 1500 + 0.6 * 400, throttle: 1500 + 0.3 * 400, others: [65535, 65535, 65535, 0, 0], sysid: 255 });
    a.onDrive(sample(4, -1, -0.5));
    await until(() => last(rover.st).throttle === 1500 - 120);
    expect(last(rover.st).steer).toBe(1500 - 120);
    await until(() => driveDetail()?.status === 'ok');
    expect(driveDetail()!.detail).toMatch(/Driving from the console/);
    // Faster position reports while driving.
    expect(rover.st.intervals).toContainEqual([33, 250_000]);

    // Release: neutral first, then both channels handed back to the remote (0 = release on 1–8).
    a.onDrive(sample(5, 0, 0, { release: true }));
    await until(() => last(rover.st).throttle === 0);
    const tail = rover.st.overrides.slice(-3).map((o) => [o.chan1Raw, o.chan3Raw]);
    expect(tail).toEqual([
      [1500, 1500],
      [0, 0],
      [0, 0],
    ]);
    const n = rover.st.overrides.length;
    await wait(300);
    expect(rover.st.overrides.length).toBe(n); // nothing more once released
    expect(rover.st.intervals).toContainEqual([33, 1_000_000]);
  }, 15_000);

  it('stops at neutral when samples stop, then hands the sticks back', async () => {
    const { a, rover, driveDetail } = await roverAdapter();
    a.onDrive(sample(1, 0, 0));
    a.onDrive(sample(2, 1, 0));
    await until(() => last(rover.st).throttle === 1620);
    const quietFrom = Date.now();
    await until(() => last(rover.st).throttle === 1500, 1500);
    expect(Date.now() - quietFrom).toBeGreaterThanOrEqual(400);
    expect(Date.now() - quietFrom).toBeLessThan(900);
    await until(() => driveDetail()?.detail === 'No stick input from the console: stopped');
    await until(() => last(rover.st).throttle === 0, 2500);
    expect(Date.now() - quietFrom).toBeGreaterThanOrEqual(500 + DRIVE_NEUTRAL_HOLD_MS - 100);
    await until(() => /Idle, the remote has the sticks \(no stick input/.test(driveDetail()?.detail ?? ''));
  }, 15_000);

  it('never overrides a disarmed vehicle or one outside a manual mode, and lets go when the pilot changes mode', async () => {
    const { a, rover, driveDetail } = await roverAdapter();
    rover.st.armed = false;
    await wait(250);
    a.onDrive(sample(1, 0, 0));
    a.onDrive(sample(2, 1, 0));
    await until(() => /disarmed/.test(driveDetail()?.detail ?? ''));
    expect(rover.st.overrides).toHaveLength(0);

    rover.st.armed = true;
    rover.st.mode = 4; // HOLD
    await wait(250);
    a.onDrive(sample(3, 1, 0));
    await until(() => /HOLD: switch it to MANUAL/.test(driveDetail()?.detail ?? ''));
    expect(rover.st.overrides).toHaveLength(0);

    // Back in MANUAL: still held until the sticks are centred again.
    rover.st.mode = 0;
    await wait(250);
    a.onDrive(sample(4, 1, 0));
    await until(() => rover.st.overrides.length > 0);
    expect(last(rover.st).throttle).toBe(1500);
    a.onDrive(sample(5, 0, 0));
    a.onDrive(sample(6, 1, 0));
    await until(() => last(rover.st).throttle === 1620);

    // The pilot flips to HOLD mid-drive: the adapter releases at once and does not fight it.
    const keep = setInterval(() => a.onDrive(sample(Date.now(), 1, 0)), 100);
    cleanup.push(() => clearInterval(keep));
    rover.st.mode = 4;
    await until(() => last(rover.st).throttle === 0);
    const n = rover.st.overrides.length;
    await wait(400);
    expect(rover.st.overrides.length).toBe(n);
  }, 15_000);

  it('uses the configured channels and directions', async () => {
    const { a, rover } = await roverAdapter({ steerChannel: 2, throttleChannel: 10, reverseSteer: true, maxThrottle: 0.5, maxSteer: 1, travel: 500 });
    a.onDrive(sample(1, 0, 0));
    a.onDrive(sample(2, 1, 1));
    await until(() => rover.st.overrides.at(-1)?.chan10Raw === 1750);
    const o = rover.st.overrides.at(-1)!;
    expect(o.chan2Raw).toBe(1000); // reversed, full travel
    expect(o.chan1Raw).toBe(65535);
    expect(o.chan3Raw).toBe(65535);
    a.onDrive(sample(3, 0, 0, { release: true }));
    await until(() => rover.st.overrides.at(-1)?.chan10Raw === 65534); // release on channels 9–18
    expect(rover.st.overrides.at(-1)!.chan2Raw).toBe(0);
  }, 10_000);

  it('offers no driving unless configured, and none on air vehicles', () => {
    const base = { deviceId: 'X-01', profile: 'ardupilot-rover' as const, link: { mode: 'client' as const, host: '127.0.0.1', port: 9 }, geo: GEO };
    expect(new MavlinkVehicleAdapter({ ...base, kind: 'ugv' }).declaration.teleop).toBeUndefined();
    expect(new MavlinkVehicleAdapter({ ...base, kind: 'uav', profile: 'ardupilot-copter', teleop: true }).declaration.teleop).toBeUndefined();
    expect(TELEOP_DEFAULTS).toMatchObject({ steerChannel: 1, throttleChannel: 3, center: 1500 });
  });
});

describe('simulated UGV: console driving', () => {
  const seed = seedDevices(0);

  function sim() {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const a = new SimUgv(seed['UGV-01']);
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop());
    return { a, got };
  }
  /** Keep sending the same stick position every 100 ms for `ms`. */
  function hold(a: SimUgv, from: number, ms: number, throttle: number, steer: number) {
    let seq = from;
    for (let t = 0; t < ms; t += 100) {
      a.onDrive(sample(seq++, throttle, steer));
      vi.advanceTimersByTime(100);
    }
    return seq;
  }

  it('declares the same limits as the real adapter and drives where the sticks point', () => {
    const { a, got } = sim();
    expect(a.declaration.teleop).toEqual({ maxThrottle: 0.3, maxSteer: 0.6, deadmanMs: 500 });
    const start = { ...a.pos };
    const heading = a.motion.heading;
    let seq = hold(a, 1, 300, 0, 0);
    seq = hold(a, seq, 3000, 1, 0);
    // Capped at 30 % of the 6 m/s top speed.
    expect(a.speed).toBeCloseTo(1.8, 1);
    const moved = { x: a.pos.x - start.x, y: a.pos.y - start.y };
    const rad = (heading * Math.PI) / 180;
    expect(moved.x * Math.sin(rad) - moved.y * Math.cos(rad)).toBeGreaterThan(3); // forward along the heading
    expect(a.motion.heading).toBeCloseTo(heading, 5);
    hold(a, seq, 1000, 0.5, 1);
    expect(a.motion.heading).not.toBeCloseTo(heading, 0); // turning right
    expect(got.telemetry.flatMap((t) => t.components ?? []).some((c) => c.id === 'drive' && /Driving from the console/.test(c.detail ?? ''))).toBe(true);
  });

  it('stops by itself when samples stop, and ignores samples sent while its radio link is cut', () => {
    const { a } = sim();
    hold(a, 1, 200, 0, 0);
    hold(a, 3, 3000, 1, 0);
    expect(a.speed).toBeGreaterThan(1);
    vi.advanceTimersByTime(500 + 1500);
    expect(a.speed).toBe(0);
    a.onDemo('cut_link');
    hold(a, 40, 1000, 0, 0);
    hold(a, 60, 1000, 1, 0);
    expect(a.speed).toBe(0);
  });

  it('hands the vehicle to a route that starts', () => {
    const { a } = sim();
    hold(a, 1, 200, 0, 0);
    hold(a, 3, 1000, 1, 0);
    a.onCommand(cmd('start', { route: [{ x: a.pos.x + 60, y: a.pos.y }] }));
    // Samples keep coming, but once the route starts they are ignored and the route drives.
    hold(a, 20, 3000, 0, 1);
    expect(a.mode).toBe('moving');
    expect(a.nextCp).toBe(0);
    expect(a.speed).toBeGreaterThan(1);
  });
});
