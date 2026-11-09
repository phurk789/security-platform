// A vehicle without a hand-held remote (noRemote): the gateway is its remote. Checked against a stand-in ArduPilot
// Rover on a stand-in serial cable that answers arm/disarm/mode and records every RC override.
import { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, common, minimal, type MavLinkPacket } from 'node-mavlink';
import { siteToGeo, type GatewayToServer, type GeoAnchor, type GwVehicleControlResult, type ServerToGateway } from '@13store/shared';
import { ConfigError, adaptersFromConfig, parseSiteConfig } from '../src/real/config';
import type { SerialDeps } from '../src/real/mavlinkLink';
import { MavlinkVehicleAdapter, type MavlinkVehicleConfig } from '../src/real/mavlinkVehicle';
import { noRemoteProblem } from '../src/real/virtualRemote';
import { startGateway } from '../src/gateway';
import { silentLogger } from '../src/sdk';
import { fakeCtx } from './helpers';

const GEO: GeoAnchor = { originLat: 13.75, originLon: 100.5, rotationDeg: 0 };
const UGV01 = { gearChannel: 11, gears: [1100, 1500, 1900], serverLossMs: 1000 };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await wait(10);
  }
  throw new Error('until timed out');
}

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

/** Two connected ends of a cable. */
function cable(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  const end = (other: () => Duplex) =>
    new Duplex({
      read() {},
      write(chunk, _enc, cb) {
        if (!other().destroyed) other().push(chunk);
        cb();
      },
      destroy(err, cb) {
        if (!other().destroyed) other().destroy();
        cb(err);
      },
    });
  ends.push(end(() => ends[1]), end(() => ends[0]));
  return [ends[0], ends[1]];
}

interface Override {
  at: number;
  ch: number[]; // index 1..18
}

/** ArduPilot Rover behind the cable: heartbeat + position every 100 ms, answers COMMAND_LONG, records overrides. */
function fakeRover() {
  const st = {
    armed: false,
    mode: 4, // HOLD
    overrides: [] as Override[],
    commands: [] as { command: number; p1: number; p2: number }[],
    refuseArm: undefined as string | undefined,
    refuseNormalDisarm: false,
  };
  const [pc, board] = cable();
  const proto = new MavLinkProtocolV2(1, 1);
  let seq = 0;
  const send = (m: object) => board.write(proto.serialize(m as never, seq++ & 0xff));
  const ack = (command: number, result: number) => {
    const a = new common.CommandAck();
    a.command = command as never;
    a.result = result as never;
    a.targetSystem = 255;
    a.targetComponent = 190;
    send(a);
  };
  board
    .pipe(new MavLinkPacketSplitter())
    .pipe(new MavLinkPacketParser())
    .on('data', (p: MavLinkPacket) => {
      if (p.header.msgid === 70) {
        const o = p.protocol.data(p.payload, common.RcChannelsOverride) as unknown as Record<string, number>;
        const ch = [0];
        for (let i = 1; i <= 18; i++) ch.push(o[`chan${i}Raw`]);
        st.overrides.push({ at: Date.now(), ch });
      } else if (p.header.msgid === 76) {
        const c = p.protocol.data(p.payload, common.CommandLong) as unknown as { command: number; _param1: number; _param2: number };
        st.commands.push({ command: c.command, p1: c._param1, p2: c._param2 });
        if (c.command === 400 && c._param1 === 1) {
          if (st.refuseArm) {
            const t = new common.StatusText();
            t.severity = 2 as never;
            t.text = st.refuseArm;
            send(t);
            return ack(400, 4);
          }
          st.armed = true;
          return ack(400, 0);
        }
        if (c.command === 400 && c._param1 === 0) {
          if (st.refuseNormalDisarm && c._param2 !== 21196) return ack(400, 4);
          st.armed = false;
          return ack(400, 0);
        }
        if (c.command === 176) {
          st.mode = c._param2;
          return ack(176, 0);
        }
        ack(c.command, 0);
      }
    });
  const timer = setInterval(() => {
    if (board.destroyed) return;
    const hb = new minimal.Heartbeat();
    hb.type = 10 as never;
    hb.autopilot = 3 as never;
    hb.baseMode = ((st.armed ? 128 : 0) | 1) as never;
    hb.customMode = st.mode;
    hb.systemStatus = 4 as never;
    hb.mavlinkVersion = 3;
    const g = siteToGeo(GEO, { x: 50, y: 20 });
    const gp = new common.GlobalPositionInt();
    gp.lat = Math.round(g.lat * 1e7);
    gp.lon = Math.round(g.lon * 1e7);
    const raw = new common.GpsRawInt();
    raw.fixType = 3 as never;
    raw.satellitesVisible = 9;
    for (const m of [hb, raw, gp]) send(m);
  }, 100);
  const serial: SerialDeps = { retryMs: 30, configure: () => {}, open: () => pc };
  cleanup.push(() => {
    clearInterval(timer);
    board.destroy();
  });
  return { st, serial, last: () => st.overrides.at(-1) };
}

function vehicle(rover: ReturnType<typeof fakeRover>, extra: Partial<MavlinkVehicleConfig> = {}) {
  return new MavlinkVehicleAdapter({
    deviceId: 'UGV-01',
    kind: 'ugv',
    profile: 'ardupilot-rover',
    link: { mode: 'serial', path: '/dev/ttyACM0' },
    serial: rover.serial,
    geo: GEO,
    teleop: true,
    noRemote: UGV01,
    ...extra,
  });
}

/** Adapter context with a switchable server link and the vehicle control answers. */
function ctxWithServer() {
  const { ctx, got } = fakeCtx();
  const link = { up: false };
  const results: Omit<GwVehicleControlResult, 't' | 'deviceId'>[] = [];
  ctx.serverConnected = () => link.up;
  ctx.vehicleControlResult = (r) => results.push(r);
  return { ctx, got, link, results };
}

const IGNORE = (ch: number) => (ch <= 8 ? 65535 : 0);
const part = (got: ReturnType<typeof fakeCtx>['got'], id: string) =>
  got.telemetry.flatMap((t) => (t as { components?: { id: string; status?: string; detail?: string }[] }).components ?? []).filter((c) => c.id === id).at(-1);

describe('virtual remote (no hand-held remote)', () => {
  it('holds centred sticks and gear 1 ten times a second only while the server has the vehicle', async () => {
    const rover = fakeRover();
    const a = vehicle(rover);
    const { ctx, got, link } = ctxWithServer();
    a.start(ctx);
    cleanup.push(() => a.stop());
    await until(() => got.telemetry.length > 0);
    await wait(300);
    expect(rover.st.overrides).toHaveLength(0); // no server: the vehicle stays in its radio failsafe
    expect(a.declaration.vehicleControl).toEqual({ noRemote: true, gears: 3 });

    link.up = true;
    await until(() => rover.st.overrides.length > 0);
    const n0 = rover.st.overrides.length;
    await wait(1000);
    const perSecond = rover.st.overrides.length - n0;
    expect(perSecond).toBeGreaterThanOrEqual(8);
    expect(perSecond).toBeLessThanOrEqual(12);
    const o = rover.last()!.ch;
    expect([o[1], o[3], o[11]]).toEqual([1500, 1500, 1100]);
    // Everything else, the arm switch (12) and the mode switch (10) included, is left alone.
    for (const ch of [2, 4, 5, 6, 7, 8, 9, 10, 12, 13, 18]) expect(o[ch]).toBe(IGNORE(ch));
    await until(() => part(got, 'remote')?.status === 'ok');

    // Server gone: still the remote for serverLossMs (a short reconnect is not a stop), then nothing.
    link.up = false;
    const down = Date.now();
    await wait(1600);
    const lastAt = rover.last()!.at - down;
    expect(lastAt).toBeGreaterThan(800);
    expect(lastAt).toBeLessThan(1300);
    await until(() => part(got, 'remote')?.status === 'warn', 2000); // shown with the next telemetry

    link.up = true;
    const before = rover.st.overrides.length;
    await until(() => rover.st.overrides.length > before + 2);
    expect(rover.st.mode).toBe(4); // the gateway never changed the mode by itself
  });

  it('arms, switches to MANUAL, drives with the gear and disarms from the console', async () => {
    const rover = fakeRover();
    const a = vehicle(rover);
    const { ctx, link, results } = ctxWithServer();
    link.up = true;
    a.start(ctx);
    cleanup.push(() => a.stop());
    await until(() => rover.st.overrides.length > 0);

    a.onVehicleControl('r1', { kind: 'arm' });
    await until(() => results.length === 1);
    expect(results[0]).toEqual({ requestId: 'r1', ok: true, detail: 'Armed in HOLD · gear 1.' });
    expect(rover.st.armed).toBe(true);

    a.onVehicleControl('r2', { kind: 'mode', mode: 'manual' });
    await until(() => results.length === 2);
    expect(results[1]).toMatchObject({ ok: true, detail: 'Mode MANUAL.' });
    expect(rover.st.mode).toBe(0);

    a.onVehicleControl('r3', { kind: 'gear', gear: 3 });
    await until(() => results.length === 3);
    expect(results[2]).toMatchObject({ ok: true, detail: 'Gear 3 of 3.' });
    await until(() => rover.last()!.ch[11] === 1900);

    // Wait until the gateway has seen MANUAL + armed in a heartbeat, then drive forward (default cap 30 %).
    // Driving starts from centred sticks (drive.ts), then full forward.
    await wait(300);
    a.onDrive({ t: 'drive', deviceId: 'UGV-01', seq: 1, throttle: 0, steer: 0, at: Date.now() });
    await wait(50);
    let seq = 2;
    const forward = setInterval(() => a.onDrive({ t: 'drive', deviceId: 'UGV-01', seq: seq++, throttle: 1, steer: 0, at: Date.now() }), 100);
    cleanup.push(() => clearInterval(forward));
    await until(() => rover.last()!.ch[3] === 1620);
    expect(rover.last()!.ch[11]).toBe(1900); // sticks and gear go out together
    // A gear button on the drive panel rides with a sample and sets the virtual remote's gear; later samples keep it.
    a.onDrive({ t: 'drive', deviceId: 'UGV-01', seq: seq++, throttle: 1, steer: 0, at: Date.now(), gear: 2 });
    await until(() => rover.last()!.ch[11] === 1500);
    await wait(250);
    expect(rover.last()!.ch[11]).toBe(1500);
    clearInterval(forward);
    // Samples stop: the dead-man centres the sticks. Nothing is ever "released" (0): there is no remote to take over.
    await until(() => rover.last()!.ch[3] === 1500, 2000);
    expect(rover.st.overrides.some((x) => x.ch[3] === 0 || x.ch[1] === 0)).toBe(false);

    a.onVehicleControl('r4', { kind: 'disarm' });
    await until(() => results.length === 4);
    expect(results[3]).toMatchObject({ ok: true, detail: 'Disarmed.' });
    expect(rover.st.armed).toBe(false);

    // A new arm starts in gear 1 again.
    await wait(250);
    a.onVehicleControl('r5', { kind: 'arm' });
    await until(() => results.length === 5);
    expect(results[4]).toMatchObject({ ok: true, detail: 'Armed in MANUAL · gear 1.' });
    await until(() => rover.last()!.ch[11] === 1100);
  });

  it('says why the board refused, forces a refused disarm, and checks gears', async () => {
    const rover = fakeRover();
    rover.st.refuseArm = 'PreArm: Radio failsafe on';
    rover.st.refuseNormalDisarm = true;
    const a = vehicle(rover);
    const { ctx, link, results } = ctxWithServer();
    link.up = true;
    a.start(ctx);
    cleanup.push(() => a.stop());
    await until(() => rover.st.overrides.length > 0);

    a.onVehicleControl('r1', { kind: 'arm' });
    await until(() => results.length === 1);
    expect(results[0]).toEqual({ requestId: 'r1', ok: false, detail: 'Arming refused: PreArm: Radio failsafe on' });

    rover.st.refuseArm = undefined;
    rover.st.armed = true;
    await wait(250);
    a.onVehicleControl('r2', { kind: 'disarm' });
    await until(() => results.length === 2);
    expect(results[1]).toMatchObject({ ok: true, detail: 'Disarmed.' });
    expect(rover.st.commands.filter((c) => c.command === 400 && c.p1 === 0).map((c) => c.p2)).toEqual([0, 21196]);

    a.onVehicleControl('r3', { kind: 'gear', gear: 4 });
    await until(() => results.length === 3);
    expect(results[2]).toMatchObject({ ok: false, detail: 'Gear must be 1–3.' });
  });

  it('refuses to arm once the server link is gone', async () => {
    const rover = fakeRover();
    const a = vehicle(rover);
    const { ctx, link, results } = ctxWithServer();
    link.up = true;
    a.start(ctx);
    cleanup.push(() => a.stop());
    await until(() => rover.st.overrides.length > 0);
    link.up = false;
    await wait(1300);
    a.onVehicleControl('r1', { kind: 'arm' });
    await until(() => results.length === 1);
    expect(results[0]).toMatchObject({ ok: false, detail: 'The virtual remote is off (no server link). Not armed.' });
    expect(rover.st.armed).toBe(false);
  });

  it('with a hand-held remote: never sends sticks of its own, disarms and holds, but leaves arming and MANUAL to the pilot', async () => {
    const rover = fakeRover();
    const a = vehicle(rover, { noRemote: undefined });
    const { ctx, link, results } = ctxWithServer();
    link.up = true;
    a.start(ctx);
    cleanup.push(() => a.stop());
    await wait(500);
    expect(rover.st.overrides).toHaveLength(0);
    expect(a.declaration.vehicleControl).toEqual({ noRemote: false, gears: 0 });

    for (const [id, action] of [
      ['r1', { kind: 'arm' }],
      ['r2', { kind: 'mode', mode: 'manual' }],
      ['r3', { kind: 'gear', gear: 1 }],
    ] as const) a.onVehicleControl(id, action);
    await until(() => results.length === 3);
    for (const r of results) expect(r).toMatchObject({ ok: false, detail: 'This vehicle has a hand-held remote: that is done on the remote.' });
    expect(rover.st.armed).toBe(false);

    rover.st.mode = 0;
    rover.st.armed = true;
    await wait(250);
    a.onVehicleControl('r4', { kind: 'mode', mode: 'hold' });
    a.onVehicleControl('r5', { kind: 'disarm' });
    await until(() => results.length === 5);
    expect(results.slice(3)).toMatchObject([{ ok: true, detail: 'Mode HOLD.' }, { ok: true, detail: 'Disarmed.' }]);
  });
});

describe('noRemote in site.json', () => {
  const site = (device: Record<string, unknown>) =>
    parseSiteConfig({ geo: GEO, devices: [{ type: 'mavlink', deviceId: 'UGV-01', kind: 'ugv', profile: 'ardupilot-rover', link: { mode: 'serial', path: '/dev/ttyACM0' }, ...device }] });

  it('accepts UGV-01 and a plain true, and declares the console controls', () => {
    expect(() => site({ noRemote: { gearChannel: 11, gears: [1100, 1500, 1900] }, teleop: true })).not.toThrow();
    expect(() => site({ noRemote: true })).not.toThrow();
    const [a] = adaptersFromConfig(site({ noRemote: { gearChannel: 11, gears: [1100, 1500, 1900] } }));
    expect(a.declaration.vehicleControl).toEqual({ noRemote: true, gears: 3 });
    expect(a.declaration.limitations).toMatch(/No hand-held remote/);
  });

  it('refuses it on PX4 or a drone, on the steering channel, without gears, or with an odd timeout', () => {
    expect(() => site({ noRemote: true, profile: 'px4-rover' })).toThrow(ConfigError);
    expect(() => parseSiteConfig({ geo: GEO, devices: [{ type: 'mavlink', deviceId: 'UAV-01', kind: 'uav', profile: 'ardupilot-copter', noRemote: true }] })).toThrow(/ArduPilot Rover ground/);
    expect(noRemoteProblem({ gearChannel: 1, gears: [1500] }, [1, 3])).toMatch(/steering or throttle/);
    expect(noRemoteProblem({ gearChannel: 11 }, [1, 3])).toMatch(/go together/);
    expect(noRemoteProblem({ gearChannel: 11, gears: [500] }, [1, 3])).toMatch(/800 and 2200/);
    expect(noRemoteProblem({ serverLossMs: 100 }, [1, 3])).toMatch(/1000 and 30000/);
    expect(() => site({ noRemote: { gearChannel: 3, gears: [1500] } })).toThrow(/UGV-01: noRemote.gearChannel/);
  });
});

describe('gateway ↔ server', () => {
  it('routes vehicle control to the adapter, answers for devices without it, and stops the remote when the server goes', async () => {
    const received: GatewayToServer[] = [];
    let socket: WebSocket | undefined;
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    wss.on('connection', (sock) => {
      socket = sock;
      sock.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as GatewayToServer;
        received.push(msg);
        if (msg.t === 'hello')
          sock.send(JSON.stringify({ t: 'welcome', serverTime: Date.now(), accepted: msg.adapters.map((d) => d.deviceId), rejected: [] } satisfies ServerToGateway));
      });
    });
    const rover = fakeRover();
    const gw = startGateway({
      serverUrl: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
      key: 'k',
      gatewayId: 'edge-pi-test',
      adapters: [vehicle(rover)],
      geo: GEO,
      log: silentLogger,
      backoff: { initialMs: 50, maxMs: 200 },
    });
    cleanup.push(() => gw.stop());
    cleanup.push(() => new Promise<void>((r) => wss.close(() => r())));
    await until(() => rover.st.overrides.length > 0);

    const send = (m: ServerToGateway) => socket!.send(JSON.stringify(m));
    send({ t: 'vehicle_control', requestId: 'q1', deviceId: 'UGV-01', action: { kind: 'arm' } });
    await until(() => received.some((m) => m.t === 'vehicle_control_result'));
    expect(received.find((m) => m.t === 'vehicle_control_result')).toEqual({ t: 'vehicle_control_result', deviceId: 'UGV-01', requestId: 'q1', ok: true, detail: 'Armed in HOLD · gear 1.' });

    // The server goes away for good: one second later (serverLossMs) the gateway is no longer the remote.
    for (const c of wss.clients) c.terminate();
    wss.close();
    const down = Date.now();
    await wait(1700);
    expect(rover.last()!.at - down).toBeLessThan(1300);
  });
});
