// Real-hardware adapters against protocol-accurate fakes: a SIYI camera speaking the SIYI SDK
// over UDP, and a MAVLink vehicle (ArduPilot Rover) behind a UniRC-style UDP datalink.
import dgram from 'node:dgram';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, common, minimal, type MavLinkPacket } from 'node-mavlink';
import { geoToSite, siteToGeo, type GeoAnchor } from '@13store/shared';
import { CMD, decode, encode, req } from '../src/real/siyiProtocol';
import { SiyiCameraAdapter } from '../src/real/siyiCamera';
import { MavlinkVehicleAdapter } from '../src/real/mavlinkVehicle';
import { cmd, fakeCtx } from './helpers';

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
});

describe('SIYI SDK codec', () => {
  it('matches the reference frame from the SIYI SDK (manual zoom out)', () => {
    expect(encode(0x05, [0xff]).toString('hex')).toBe('5566010100000005ff5c6a');
  });

  it('round-trips attitude in tenths of a degree, signed', () => {
    const [f] = decode(req.setAttitude(-90.5, -30));
    expect(f.cmd).toBe(CMD.SET_ATTITUDE);
    expect(f.data.readInt16LE(0)).toBe(-905);
    expect(f.data.readInt16LE(2)).toBe(-300);
  });

  it('skips frames with a bad CRC', () => {
    const good = req.center();
    const bad = Buffer.from(good);
    bad[bad.length - 1] ^= 0xff;
    expect(decode(Buffer.concat([bad, good]))).toHaveLength(1);
  });
});

/** A fake SIYI camera: answers attitude, zoom, info, firmware; acks control commands. */
function fakeCamera(opts: { silent?: () => boolean } = {}) {
  const sock = dgram.createSocket('udp4');
  const got: number[] = [];
  let yaw = 12.3;
  sock.on('message', (msg, r) => {
    if (opts.silent?.()) return;
    for (const f of decode(msg)) {
      got.push(f.cmd);
      const reply = (cmd: number, data: Buffer | number[]) => sock.send(encode(cmd, data, f.seq, false), r.port, r.address);
      if (f.cmd === CMD.GIMBAL_ATTITUDE) {
        const d = Buffer.alloc(12);
        d.writeInt16LE(Math.round(yaw * 10), 0);
        d.writeInt16LE(-150, 2);
        reply(CMD.GIMBAL_ATTITUDE, d);
      } else if (f.cmd === CMD.CURRENT_ZOOM) reply(CMD.CURRENT_ZOOM, [4, 5]);
      else if (f.cmd === CMD.GIMBAL_INFO) reply(CMD.GIMBAL_INFO, [0, 0, 0, 1, 3, 1]);
      else if (f.cmd === CMD.FIRMWARE) {
        const d = Buffer.alloc(12);
        d.writeUInt32LE((0 << 16) | (3 << 8) | 7, 0);
        d.writeUInt32LE((0 << 16) | (2 << 8) | 1, 4);
        reply(CMD.FIRMWARE, d);
      } else if (f.cmd === CMD.SET_ATTITUDE) {
        yaw = f.data.readInt16LE(0) / 10;
        reply(CMD.SET_ATTITUDE, Buffer.alloc(6));
      } else if (f.cmd === CMD.PHOTO_VIDEO) reply(CMD.FUNCTION_FEEDBACK, [0]);
      else if (f.cmd === CMD.GIMBAL_SPEED || f.cmd === CMD.CENTER || f.cmd === CMD.MANUAL_ZOOM) reply(f.cmd, [1]);
    }
  });
  return new Promise<{ port: number; got: number[]; close: () => void }>((resolve) =>
    sock.bind(0, '127.0.0.1', () => resolve({ port: (sock.address() as { port: number }).port, got, close: () => sock.close() })),
  );
}

describe('SIYI camera adapter', () => {
  it('streams gimbal attitude and zoom, and confirms control only when the camera answers', async () => {
    let silent = false;
    const cam = await fakeCamera({ silent: () => silent });
    const a = new SiyiCameraAdapter({ deviceId: 'CAM-01', host: '127.0.0.1', port: cam.port, pos: { x: 330, y: 225 } });
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), cam.close);
    await until(() => got.telemetry.length > 1);
    const t = got.telemetry.at(-1) as { gimbal?: { yaw: number; pitch: number; zoom?: number; recording?: boolean } };
    expect(t.gimbal).toMatchObject({ yaw: 12.3, pitch: -15, zoom: 4.5, recording: true });

    a.onCamera('r1', { action: 'gimbal_angle', yaw: -45, pitch: -20 });
    await until(() => got.camera.some((c) => c.requestId === 'r1'));
    expect(got.camera.find((c) => c.requestId === 'r1')).toMatchObject({ ok: true, confirmed: true });

    a.onCamera('r2', { action: 'photo' });
    await until(() => got.camera.some((c) => c.requestId === 'r2'));
    expect(got.camera.find((c) => c.requestId === 'r2')).toMatchObject({ ok: true, confirmed: true, detail: 'Photo taken.' });

    // Camera stops answering: no more telemetry, and control is refused rather than faked.
    silent = true;
    await wait(3400);
    const n = got.telemetry.length;
    await wait(1200);
    expect(got.telemetry.length).toBe(n);
    a.onCamera('r3', { action: 'center' });
    expect(got.camera.find((c) => c.requestId === 'r3')).toMatchObject({ ok: false, confirmed: false });
  }, 15_000);
});

// ---------------------------------------------------------------------------
// MAVLink
// ---------------------------------------------------------------------------

const GEO: GeoAnchor = { originLat: 13.7563, originLon: 100.5018, rotationDeg: 0 };

/** A fake ArduPilot Rover behind a UDP datalink (like the UniRC 7 Pro's 19856 server). */
function fakeRover(opts: { armed?: boolean } = {}) {
  const sock = dgram.createSocket('udp4');
  const proto = new MavLinkProtocolV2(1, 1);
  const input = new PassThrough();
  let seq = 0;
  let gcs: { port: number; address: string } | null = null;
  const st = { armed: opts.armed ?? true, mode: 4 /* HOLD */, pos: { x: 214, y: 218 }, speed: 0, mission: [] as { lat: number; lon: number }[], expected: 0, received: [] as number[], silent: false, relays: {} as Record<number, number> };
  const send = (m: unknown) => gcs && !st.silent && sock.send(proto.serialize(m as never, seq++ & 0xff), gcs.port, gcs.address);
  input.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser()).on('data', (p: MavLinkPacket) => {
    st.received.push(p.header.msgid);
    const reg = { ...minimal.REGISTRY, ...common.REGISTRY } as Record<number, never>;
    const clazz = reg[p.header.msgid];
    if (!clazz) return;
    const d = p.protocol.data(p.payload, clazz) as unknown as Record<string, number>;
    if (p.header.msgid === 44) {
      st.expected = d.count;
      st.mission = [];
      const r = new common.MissionRequestInt();
      r.targetSystem = 255;
      r.targetComponent = 190;
      r.seq = 0;
      send(r);
    } else if (p.header.msgid === 73) {
      st.mission.push({ lat: d.x / 1e7, lon: d.y / 1e7 });
      if (st.mission.length < st.expected) {
        const r = new common.MissionRequestInt();
        r.targetSystem = 255;
        r.targetComponent = 190;
        r.seq = st.mission.length;
        send(r);
      } else {
        const ack = new common.MissionAck();
        ack.targetSystem = 255;
        ack.targetComponent = 190;
        ack.type = 0 as never;
        send(ack);
      }
    } else if (p.header.msgid === 76) {
      const ack = new common.CommandAck();
      ack.command = d.command as never;
      ack.result = 0 as never;
      if (d.command === 176) {
        st.mode = d._param2;
        st.speed = st.mode === 10 ? 2 : 0;
      }
      if (d.command === 193) st.speed = d._param1 ? 2 : 0;
      if (d.command === 181) st.relays[d._param1] = d._param2; // DO_SET_RELAY
      send(ack);
    }
  });
  sock.on('message', (msg, r) => {
    gcs = { port: r.port, address: r.address };
    input.write(msg);
  });
  const timer = setInterval(() => {
    const hb = new minimal.Heartbeat();
    hb.type = 10 as never; // GROUND_ROVER
    hb.autopilot = 3 as never; // ARDUPILOTMEGA
    hb.baseMode = ((st.armed ? 128 : 0) | 1) as never;
    hb.customMode = st.mode;
    hb.systemStatus = 4 as never;
    hb.mavlinkVersion = 3;
    send(hb);
    if (st.speed > 0) st.pos = { x: st.pos.x + st.speed * 0.2, y: st.pos.y };
    const g = siteToGeo(GEO, st.pos);
    const gp = new common.GlobalPositionInt();
    gp.lat = Math.round(g.lat * 1e7);
    gp.lon = Math.round(g.lon * 1e7);
    gp.relativeAlt = 0;
    gp.vx = 0;
    gp.vy = Math.round(st.speed * 100);
    gp.hdg = 9000;
    send(gp);
    const vfr = new common.VfrHud();
    vfr.groundspeed = st.speed;
    send(vfr);
    const sys = new common.SysStatus();
    sys.batteryRemaining = 76;
    send(sys);
  }, 200);
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

describe('site ↔ WGS 84', () => {
  it('round-trips within a millimetre, with and without grid rotation', () => {
    for (const rot of [0, 23.5]) {
      const a = { ...GEO, rotationDeg: rot };
      const p = geoToSite(a, siteToGeo(a, { x: 333.3, y: 228.8 }));
      expect(Math.hypot(p.x - 333.3, p.y - 228.8)).toBeLessThan(0.001);
    }
  });
});

describe('MAVLink vehicle adapter (UniFC 6 Pico class, via UniRC datalink)', () => {
  it('maps GPS to the site grid, uploads the approved route, and confirms start from telemetry', async () => {
    const rover = await fakeRover();
    const a = new MavlinkVehicleAdapter({ deviceId: 'UGV-02', kind: 'ugv', profile: 'ardupilot-rover', link: { mode: 'client', host: '127.0.0.1', port: rover.port }, geo: GEO });
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), rover.close);
    await until(() => got.telemetry.length > 0);
    const t0 = got.telemetry.at(-1)!;
    expect(Math.hypot(t0.pos.x - 214, t0.pos.y - 218)).toBeLessThan(0.05);
    expect(t0.battery).toBe(76);

    const route = [{ x: 262, y: 218 }, { x: 312, y: 222 }];
    a.onCommand(cmd('start', { deviceId: 'UGV-02', route }));
    await until(() => got.updates.some((u) => u.status === 'succeeded'), 8000);
    const statuses = got.updates.map((u) => u.status);
    expect(statuses.indexOf('acknowledged')).toBeLessThan(statuses.indexOf('executing'));
    expect(statuses.indexOf('executing')).toBeLessThan(statuses.indexOf('succeeded'));
    // ArduPilot: item 0 is home, then the route; coordinates land back on the route points.
    expect(rover.st.mission).toHaveLength(3);
    const p1 = geoToSite(GEO, rover.st.mission[1]);
    expect(Math.hypot(p1.x - 262, p1.y - 218)).toBeLessThan(0.05);
    expect(rover.st.mode).toBe(10); // AUTO

    a.onCommand(cmd('stop', { deviceId: 'UGV-02' }));
    await until(() => got.updates.filter((u) => u.status === 'succeeded').length === 2, 6000);
    expect(rover.st.mode).toBe(4); // HOLD
  }, 20_000);

  it('refuses to start a disarmed vehicle unless remote arming is enabled', async () => {
    const rover = await fakeRover({ armed: false });
    const a = new MavlinkVehicleAdapter({ deviceId: 'UGV-03', kind: 'ugv', profile: 'ardupilot-rover', link: { mode: 'client', host: '127.0.0.1', port: rover.port }, geo: GEO });
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), rover.close);
    await until(() => got.telemetry.length > 0);
    a.onCommand(cmd('start', { deviceId: 'UGV-03', route: [{ x: 250, y: 218 }] }));
    await until(() => got.updates.length > 0);
    expect(got.updates[0]).toMatchObject({ status: 'rejected' });
    expect(got.updates[0].detail).toMatch(/disarmed/);
    expect(rover.st.received).not.toContain(44); // no mission upload attempted
  }, 10_000);

  it('switches the 4-in-1 module through flight-controller relays and declares the catalogue model', async () => {
    const rover = await fakeRover();
    const a = new MavlinkVehicleAdapter({
      deviceId: 'UGV-04',
      kind: 'ugv',
      profile: 'ardupilot-rover',
      catalogId: 'D100',
      payload: { module: 'loudhailer-4in1', spotlightRelay: 0, beaconRelay: 1 },
      link: { mode: 'client', host: '127.0.0.1', port: rover.port },
      geo: GEO,
    });
    expect(a.declaration).toMatchObject({ catalogId: 'D100', payloads: ['loudhailer-4in1'] });
    expect(a.declaration.capabilities).toEqual(expect.arrayContaining(['ground_patrol', 'spotlight', 'beacon']));
    expect(a.declaration.capabilities).not.toContain('speaker'); // no MAVLink path for announcements
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), rover.close);
    await until(() => got.telemetry.length > 0);
    a.onCamera('r1', { action: 'spotlight', on: true });
    a.onCamera('r2', { action: 'beacon', on: true });
    await until(() => got.camera.length === 2, 6000);
    expect(got.camera.every((r) => r.ok && r.confirmed)).toBe(true);
    expect(rover.st.relays).toEqual({ 0: 1, 1: 1 });
    await until(() => !!got.telemetry.at(-1)?.gimbal?.beacon);
    expect(got.telemetry.at(-1)!.gimbal).toMatchObject({ spotlight: true, beacon: true });
    a.onCamera('r3', { action: 'announce', message: 'hello' });
    await until(() => got.camera.length === 3);
    expect(got.camera[2]).toMatchObject({ ok: false, confirmed: false });
  }, 15_000);

  it('reports a mode change made on the remote and goes quiet when the link drops', async () => {
    const rover = await fakeRover();
    const a = new MavlinkVehicleAdapter({ deviceId: 'UGV-04', kind: 'ugv', profile: 'ardupilot-rover', link: { mode: 'client', host: '127.0.0.1', port: rover.port }, geo: GEO });
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), rover.close);
    await until(() => got.telemetry.length > 0);
    a.onCommand(cmd('start', { deviceId: 'UGV-04', route: [{ x: 300, y: 218 }] }));
    await until(() => got.updates.some((u) => u.status === 'succeeded'), 8000);
    rover.st.mode = 0; // pilot flips to MANUAL on the remote
    await until(() => got.events.some((e) => e.kind === 'fault' && /MANUAL/.test(e.detail ?? '')));
    rover.st.silent = true;
    await wait(3300);
    const n = got.telemetry.length;
    await wait(1200);
    expect(got.telemetry.length).toBe(n);
  }, 20_000);
});
