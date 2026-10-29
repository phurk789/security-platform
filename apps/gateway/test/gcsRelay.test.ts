// E-5: UniGCS on the remote runs alongside the gateway through its relay (one client on the datalink).
import dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { MavLinkProtocolV2, common, minimal } from 'node-mavlink';
import type { GeoAnchor, SrvDrive } from '@13store/shared';
import { MavlinkVehicleAdapter } from '../src/real/mavlinkVehicle';
import { ConfigError, parseSiteConfig } from '../src/real/config';
import { describeGcsFrame, splitFrames } from '../src/real/gcsRelay';
import { fakeCtx } from './helpers';

const GEO: GeoAnchor = { originLat: 13.7563, originLon: 100.5018, rotationDeg: 0 };
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

/** UniGCS's own packets: system 255, component 190 (QGroundControl's ids). */
const unigcs = new MavLinkProtocolV2(255, 190);
const gcsHeartbeat = () => {
  const hb = new minimal.Heartbeat();
  hb.type = 6 as never; // MAV_TYPE_GCS
  hb.autopilot = 8 as never;
  hb.mavlinkVersion = 3;
  return hb;
};
const setMode = (mode: number) => {
  const c = new common.CommandLong();
  c.targetSystem = 1;
  c.targetComponent = 1;
  c.command = 176 as never; // DO_SET_MODE
  c._param1 = 1;
  c._param2 = mode;
  return c;
};
const sticks = () => {
  const o = new common.RcChannelsOverride();
  o.targetSystem = 1;
  o.targetComponent = 1;
  o.chan1Raw = 1900;
  o.chan3Raw = 1900;
  return o;
};

describe('MAVLink frames (relay)', () => {
  it('splits a datagram into frames, and hands back what is not a whole frame', () => {
    const a = unigcs.serialize(gcsHeartbeat(), 1);
    const b = unigcs.serialize(setMode(4), 2);
    const v1 = Buffer.from([0xfe, 0, 7, 9, 1, 0, 0xaa, 0xbb]); // MAVLink 1, empty payload
    const cut = b.subarray(0, 8);
    const { frames, rest } = splitFrames(Buffer.concat([a, Buffer.from([1, 2, 3]), b, v1, cut]));
    expect(frames.map((f) => [f.msgid, f.sysid, f.compid])).toEqual([
      [0, 255, 190],
      [76, 255, 190],
      [0, 9, 1],
    ]);
    expect(Buffer.concat(frames.slice(0, 2).map((f) => f.bytes)).equals(Buffer.concat([a, b]))).toBe(true);
    expect(rest.map((r) => r.length)).toEqual([3, 8]);
  });

  it('names what the ground station asks the vehicle to do', () => {
    const name = (m: number) => (m === 4 ? 'HOLD' : `mode ${m}`);
    const frame = (msg: Parameters<typeof unigcs.serialize>[0]) => splitFrames(unigcs.serialize(msg, 0)).frames[0];
    expect(describeGcsFrame(frame(setMode(4)), name)).toBe('mode change to HOLD');
    const arm = new common.CommandLong();
    arm.command = 400 as never;
    arm._param1 = 1;
    expect(describeGcsFrame(frame(arm), name)).toBe('arm');
    arm._param1 = 0;
    expect(describeGcsFrame(frame(arm), name)).toBe('disarm');
    const sm = new common.SetMode();
    sm.customMode = 4;
    expect(describeGcsFrame(frame(sm), name)).toBe('mode change to HOLD');
    expect(describeGcsFrame(frame(gcsHeartbeat()), name)).toBeUndefined();
  });

  it('checks gcsRelay in a site config', () => {
    const site = (gcsRelay: unknown) => ({ geo: GEO, devices: [{ type: 'mavlink', deviceId: 'UGV-09', kind: 'ugv', profile: 'ardupilot-rover', gcsRelay }] });
    expect(() => parseSiteConfig(site(true))).not.toThrow();
    expect(() => parseSiteConfig(site(false))).not.toThrow();
    expect(() => parseSiteConfig(site({ port: 19860 }))).not.toThrow();
    expect(() => parseSiteConfig(site({ port: 70000 }))).toThrow(ConfigError);
    expect(() => parseSiteConfig(site({ host: 'remote.local' }))).toThrow(/IPv4/);
  });
});

/** ArduPilot Rover behind the datalink: records who sent what, and talks to whoever last sent to it. */
function fakeRover() {
  const sock = dgram.createSocket('udp4');
  const proto = new MavLinkProtocolV2(1, 1);
  let seq = 0;
  let client: { port: number; address: string } | null = null;
  const clients = new Set<string>();
  const got: { msgid: number; sysid: number; compid: number }[] = [];
  const st = { armed: true, mode: 0 /* MANUAL */ };
  sock.on('message', (msg, r) => {
    client = { port: r.port, address: r.address };
    clients.add(`${r.address}:${r.port}`);
    for (const f of splitFrames(msg).frames) got.push({ msgid: f.msgid, sysid: f.sysid, compid: f.compid });
  });
  const timer = setInterval(() => {
    if (!client) return;
    const hb = new minimal.Heartbeat();
    hb.type = 10 as never;
    hb.autopilot = 3 as never;
    hb.baseMode = ((st.armed ? 128 : 0) | 1) as never;
    hb.customMode = st.mode;
    hb.mavlinkVersion = 3;
    sock.send(proto.serialize(hb, seq++ & 0xff), client.port, client.address);
  }, 100);
  return new Promise<{ port: number; got: typeof got; clients: Set<string>; close: () => void }>((resolve) =>
    sock.bind(0, '127.0.0.1', () =>
      resolve({
        port: (sock.address() as { port: number }).port,
        got,
        clients,
        close: () => {
          clearInterval(timer);
          sock.close();
        },
      }),
    ),
  );
}

/** UniGCS on the remote, pointed at the gateway's relay port. */
async function fakeUniGcs(port: number) {
  const sock = dgram.createSocket('udp4');
  const heard: { msgid: number; sysid: number }[] = [];
  sock.on('message', (m) => {
    for (const f of splitFrames(m).frames) heard.push({ msgid: f.msgid, sysid: f.sysid });
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  let seq = 0;
  const send = (msg: Parameters<typeof unigcs.serialize>[0]) => sock.send(unigcs.serialize(msg, seq++ & 0xff), port, '127.0.0.1');
  const timer = setInterval(() => send(gcsHeartbeat()), 100);
  let open = true;
  return {
    heard,
    send,
    close: () => {
      clearInterval(timer);
      if (open) sock.close();
      open = false;
    },
  };
}

const sample = (seq: number, throttle: number, extra: Partial<SrvDrive> = {}): SrvDrive => ({ t: 'drive', deviceId: 'UGV-09', seq, throttle, steer: 0, at: 0, ...extra });

describe('ground station relay: UniGCS and the gateway on one datalink', () => {
  async function setup() {
    const rover = await fakeRover();
    const a = new MavlinkVehicleAdapter({
      deviceId: 'UGV-09',
      kind: 'ugv',
      profile: 'ardupilot-rover',
      link: { mode: 'client', host: '127.0.0.1', port: rover.port },
      geo: GEO,
      teleop: true,
      gcsRelay: { host: '127.0.0.1', port: 0 },
      gcsRelayStaleMs: 400,
    });
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), rover.close);
    await until(() => !!a.relayState()?.listen && !a.relayState()!.listen.endsWith(':0'));
    const port = Number(a.relayState()!.listen.split(':')[1]);
    const gcs = await fakeUniGcs(port);
    cleanup.push(gcs.close);
    const gcsPart = () =>
      got.telemetry
        .flatMap((t) => t.components ?? [])
        .filter((c) => c.id === 'gcs')
        .at(-1);
    return { a, rover, gcs, got, gcsPart };
  }

  it('passes traffic both ways, keeps one client on the datalink, and shows UniGCS as connected', async () => {
    const { a, rover, gcs, gcsPart } = await setup();
    expect(a.declaration.components?.find((c) => c.id === 'gcs')).toMatchObject({ status: 'pending' });
    // The vehicle's heartbeats reach UniGCS through the gateway.
    await until(() => gcs.heard.some((h) => h.msgid === 0 && h.sysid === 1));
    // UniGCS's own frames reach the vehicle unchanged (255/190); the gateway speaks as 255/191.
    gcs.send(setMode(4));
    await until(() => rover.got.some((g) => g.msgid === 76 && g.compid === 190));
    expect(rover.got.some((g) => g.msgid === 0 && g.sysid === 255 && g.compid === 190)).toBe(true);
    expect(rover.got.some((g) => g.msgid === 0 && g.sysid === 255 && g.compid === 191)).toBe(true);
    expect(rover.clients.size).toBe(1); // only the gateway talks to the datalink
    expect(a.relayState()).toMatchObject({ connected: true, sysid: 255 });
    await until(() => gcsPart()?.status === 'ok');
    expect(gcsPart()!.detail).toMatch(/Connected through the gateway \(sys 255\) · last: mode change to HOLD/);
    // UniGCS closes: shown as disconnected.
    gcs.close();
    await until(() => a.relayState()?.connected === false, 3000);
    await until(() => gcsPart()?.status === 'offline');
  }, 15_000);

  it("holds back UniGCS's sticks while the console drives, and lets them through again after", async () => {
    const { a, rover, gcs } = await setup();
    await until(() => a.relayState()?.connected === true);
    const sticksFrom = (comp: number) => rover.got.filter((g) => g.msgid === 70 && g.compid === comp).length;
    gcs.send(sticks());
    await until(() => sticksFrom(190) === 1);

    a.onDrive(sample(1, 0));
    a.onDrive(sample(2, 0.5));
    await until(() => sticksFrom(191) > 2); // the console's overrides go out
    for (let i = 0; i < 5; i++) gcs.send(sticks());
    gcs.send(setMode(4)); // a stop from the remote is never held back
    await until(() => rover.got.filter((g) => g.msgid === 76 && g.compid === 190).length === 1);
    await wait(100);
    expect(sticksFrom(190)).toBe(1);

    a.onDrive(sample(3, 0, { release: true }));
    await wait(300);
    gcs.send(sticks());
    await until(() => sticksFrom(190) === 2);
  }, 15_000);
});
