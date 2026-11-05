// Serial link to the flight controller (a Raspberry Pi on the vehicle, deploy/pi), with a stand-in port:
// the real one needs Linux, stty and a tty device (checked by hand in WSL with socat, see deploy/pi/README_TH.md).
import { Duplex } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, common, minimal, type MavLinkPacket } from 'node-mavlink';
import { siteToGeo, type GeoAnchor } from '@13store/shared';
import { ConfigError, parseSiteConfig } from '../src/real/config';
import { createLink, describeLink, linkProblem, type SerialDeps } from '../src/real/mavlinkLink';
import { MavlinkVehicleAdapter } from '../src/real/mavlinkVehicle';
import type { Logger } from '../src/sdk';
import { fakeCtx } from './helpers';

const GEO: GeoAnchor = { originLat: 13.75, originLon: 100.5, rotationDeg: 0 };

async function until(fn: () => boolean, ms = 4000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('until timed out');
}

const cleanup: (() => void)[] = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** Two connected ends of a cable: what one writes, the other reads. Destroying one end closes both. */
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

/** A serial port the test can fail, unplug and plug back in. */
function fakeSerial() {
  const s = {
    configured: [] as [string, number][],
    opens: 0,
    missing: false,
    /** The board's end of the current cable. */
    board: undefined as Duplex | undefined,
    pc: undefined as Duplex | undefined,
    deps: {} as SerialDeps,
    unplug() {
      s.pc?.destroy();
      s.board?.destroy();
    },
  };
  s.deps = {
    retryMs: 30,
    configure: (path, baud) => {
      if (s.missing) throw new Error(`stty: ${path}: No such file or directory`);
      s.configured.push([path, baud]);
    },
    open: () => {
      s.opens += 1;
      const [pc, board] = cable();
      s.pc = pc;
      s.board = board;
      return pc;
    },
  };
  return s;
}

function recordingLog() {
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(`info ${m}`), warn: (m) => lines.push(`warn ${m}`), error: (m) => lines.push(`error ${m}`) };
  return { log, lines };
}

describe('link settings in site.json', () => {
  const site = (link: unknown) => parseSiteConfig({ geo: GEO, devices: [{ type: 'mavlink', deviceId: 'UGV-01', kind: 'ugv', profile: 'ardupilot-rover', link }] });

  it('accepts a Pi UART, a USB port by id, the UniRC datalink and a listening port', () => {
    for (const link of [
      { mode: 'serial', path: '/dev/serial0', baud: 115200 },
      { mode: 'serial', path: '/dev/serial/by-id/usb-ArduPilot_UniFC6Pico_3E0031000B51-if00' },
      { mode: 'client', host: '192.168.144.20', port: 19856 },
      { mode: 'listen', port: 14550 },
      undefined,
    ])
      expect(() => site(link)).not.toThrow();
  });

  it('refuses a path outside /dev, an odd baud rate, a missing host and an unknown mode', () => {
    expect(linkProblem({ mode: 'serial', path: 'COM3' })).toMatch(/serial device/);
    expect(linkProblem({ mode: 'serial', path: '/dev/../etc/passwd' })).toMatch(/serial device/);
    expect(linkProblem({ mode: 'serial', path: '/dev/serial0', baud: 115 })).toMatch(/115200/);
    expect(linkProblem({ mode: 'client', port: 19856 })).toMatch(/host/);
    expect(linkProblem({ mode: 'listen', port: 70000 })).toMatch(/UDP port/);
    expect(linkProblem({ mode: 'tcp', host: 'x', port: 1 })).toMatch(/client.*listen.*serial/);
    expect(() => site({ mode: 'serial', path: '/dev/serial0', baud: 12345 })).toThrow(ConfigError);
    expect(() => site({ mode: 'serial', path: '/dev/serial0', baud: 12345 })).toThrow(/UGV-01: link.baud/);
  });

  it('describes each link for logs and the device notes', () => {
    expect(describeLink({ mode: 'serial', path: '/dev/serial0' })).toBe('serial /dev/serial0 at 115200 baud');
    expect(describeLink({ mode: 'client', host: '192.168.144.20', port: 19856 })).toBe('192.168.144.20:19856');
  });
});

describe('serial link', () => {
  it('sets the port to the configured speed, passes bytes both ways, and reopens it after an unplug', async () => {
    const s = fakeSerial();
    const { log, lines } = recordingLog();
    const link = createLink({ mode: 'serial', path: '/dev/serial0', baud: 57600 }, log, 'UGV-01', s.deps);
    const got: Buffer[] = [];
    link.start((b) => got.push(b));
    cleanup.push(() => link.stop());
    expect(s.configured).toEqual([['/dev/serial0', 57600]]);

    s.board!.write(Buffer.from([0xfd, 1, 2]));
    await until(() => got.length === 1);
    const fromPc: Buffer[] = [];
    s.board!.on('data', (b: Buffer) => fromPc.push(b));
    link.send(Buffer.from([7, 8]));
    await until(() => fromPc.length === 1);
    expect([...fromPc[0]]).toEqual([7, 8]);

    s.unplug();
    link.send(Buffer.from([9])); // dropped, no throw
    await until(() => s.opens === 2);
    s.board!.write(Buffer.from([3]));
    await until(() => got.length === 2);
    expect(lines.some((l) => /warn .*closed/.test(l))).toBe(true);
    expect(lines.at(-1)).toMatch(/info UGV-01: serial port back/);
  });

  it('keeps trying a missing port, logging the problem once, and stops trying when stopped', async () => {
    const s = fakeSerial();
    s.missing = true;
    const { log, lines } = recordingLog();
    const link = createLink({ mode: 'serial', path: '/dev/ttyACM0' }, log, 'UGV-01', s.deps);
    link.start(() => {});
    await new Promise((r) => setTimeout(r, 100));
    expect(s.opens).toBe(0);
    expect(lines.filter((l) => l.startsWith('warn'))).toEqual(['warn UGV-01: cannot open /dev/ttyACM0 (stty: /dev/ttyACM0: No such file or directory); trying again every 0.03 s']);
    s.missing = false;
    await until(() => s.opens === 1);
    expect(s.configured).toEqual([['/dev/ttyACM0', 115200]]);
    link.stop();
    s.unplug();
    await new Promise((r) => setTimeout(r, 100));
    expect(s.opens).toBe(1);
  });
});

/** ArduPilot Rover on the other end of the cable: heartbeat and position every 100 ms; records what it receives. */
function boardOn(s: ReturnType<typeof fakeSerial>) {
  const proto = new MavLinkProtocolV2(1, 1);
  const heard: MavLinkPacket[] = [];
  let seq = 0;
  let parsedFrom: Duplex | undefined;
  const timer = setInterval(() => {
    const port = s.board;
    if (!port || port.destroyed) return;
    if (parsedFrom !== port) {
      parsedFrom = port;
      port.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser()).on('data', (p: MavLinkPacket) => heard.push(p));
    }
    const hb = new minimal.Heartbeat();
    hb.type = 10 as never; // GROUND_ROVER
    hb.autopilot = 3 as never; // ARDUPILOTMEGA
    hb.baseMode = 1 as never;
    hb.customMode = 4; // HOLD
    hb.systemStatus = 4 as never;
    hb.mavlinkVersion = 3;
    const g = siteToGeo(GEO, { x: 50, y: 20 });
    const gp = new common.GlobalPositionInt();
    gp.lat = Math.round(g.lat * 1e7);
    gp.lon = Math.round(g.lon * 1e7);
    gp.hdg = 9000;
    const raw = new common.GpsRawInt();
    raw.fixType = 3 as never;
    raw.satellitesVisible = 9;
    for (const m of [hb, raw, gp]) port.write(proto.serialize(m, seq++ & 0xff));
  }, 100);
  return { heard, close: () => clearInterval(timer) };
}

describe('MAVLink vehicle over a serial port (Raspberry Pi on the vehicle)', () => {
  it('reports the vehicle, heart-beats to the board, and comes back after the cable is pulled', async () => {
    const s = fakeSerial();
    const board = boardOn(s);
    const a = new MavlinkVehicleAdapter({
      deviceId: 'UGV-01',
      kind: 'ugv',
      profile: 'ardupilot-rover',
      link: { mode: 'serial', path: '/dev/serial0', baud: 115200 },
      serial: s.deps,
      geo: GEO,
    });
    const { ctx, got } = fakeCtx();
    a.start(ctx);
    cleanup.push(() => a.stop(), board.close);
    expect(a.declaration.limitations).toMatch(/^Flight controller via serial \/dev\/serial0 at 115200 baud\./);

    await until(() => got.telemetry.some((t) => t.pos && Math.hypot(t.pos.x - 50, t.pos.y - 20) < 0.05));
    // The gateway's own heartbeat reaches the board (GCS 255): the board's GCS failsafe watches it.
    await until(() => board.heard.some((p) => p.header.msgid === 0 && p.header.sysid === 255));

    s.unplug();
    const before = got.telemetry.length;
    await until(() => s.opens === 2);
    await until(() => got.telemetry.length > before + 2);
    expect(got.telemetry.at(-1)!.pos).toBeDefined();
  });
});
