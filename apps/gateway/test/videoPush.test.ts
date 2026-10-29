// Pushed video: the gateway runs ffmpeg to copy a camera's RTSP stream into the platform's media
// server. These tests use a fake ffmpeg (a Node script) so they run without ffmpeg or a camera.
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AdapterDeclaration, GatewayToServer, ServerToGateway } from '@13store/shared';
import { startGateway, type GatewayHandle } from '../src/gateway';
import type { Adapter, Logger } from '../src/sdk';
import { VideoPusher, ffmpegArgs, readFfmpegLine, redact, type PushState, type Pusher, type VideoPushOptions } from '../src/videoPush';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await wait(20);
  }
}
function linesLog() {
  const lines: string[] = [];
  const log: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) };
  return { log, lines };
}

// A stand-in for ffmpeg. FAKE_FFMPEG picks what it does; it prints what real ffmpeg prints.
const dir = mkdtempSync(join(tmpdir(), 'fake-ffmpeg-'));
const fake = join(dir, 'ffmpeg.js');
writeFileSync(
  fake,
  `const mode = process.env.FAKE_FFMPEG || 'ok';
const target = process.argv[process.argv.length - 1];
const out = (s) => process.stderr.write(s + '\\n');
if (mode === 'fail') {
  out("[rtsp @ 0x7b] method ANNOUNCE failed: 401 Unauthorized");
  out("Could not write header (incorrect codec parameters ?): Server returned 401 Unauthorized (authorization failed) " + target);
  process.exit(1);
}
const codec = mode === 'hevc' ? 'hevc (Main)' : 'h264 (High)';
out("Input #0, rtsp, from 'rtsp://192.168.144.25:8554/main.264':");
out("  Stream #0:0: Video: " + codec + ", yuvj420p(pc), 1920x1080, 30 fps");
setTimeout(() => { out("Output #0, rtsp, to '" + target + "':"); out("  Stream #0:0: Video: " + codec); }, 50);
setInterval(() => {}, 1000);
`,
);
const SECRET = 'p1.c2VjcmV0.sig';
const TARGET = `rtsp://pub:${SECRET}@media.test:18554/ugv-01`;

const running: Pusher[] = [];
function pusher(mode: string, o: Partial<VideoPushOptions> = {}) {
  process.env.FAKE_FFMPEG = mode;
  const states: PushState[] = [];
  const { log, lines } = linesLog();
  const p = new VideoPusher({
    deviceId: 'UGV-01',
    source: 'rtsp://192.168.144.25:8554/main.264',
    target: TARGET,
    ffmpeg: process.execPath,
    prefixArgs: [fake],
    log,
    onState: (s) => states.push(s),
    backoff: { initialMs: 50, maxMs: 200 },
    ...o,
  });
  running.push(p);
  return { p, states, lines };
}
afterEach(() => {
  for (const p of running.splice(0)) p.stop();
});

describe('ffmpeg push helpers', () => {
  it('copies the video over TCP to the publish address and never prints the credential', () => {
    const args = ffmpegArgs('rtsp://cam/main.264', TARGET);
    expect(args.slice(-1)).toEqual([TARGET]);
    expect(args.join(' ')).toMatch(/-rtsp_transport tcp .*-i rtsp:\/\/cam\/main\.264 .*-c copy -an -f rtsp -rtsp_transport tcp/);
    expect(redact(`Output #0, rtsp, to '${TARGET}':`)).toBe("Output #0, rtsp, to 'rtsp://pub:***@media.test:18554/ugv-01':");
    expect(redact('rtsp://192.168.144.25:8554/main.264')).toBe('rtsp://192.168.144.25:8554/main.264');
  });

  it('reads the codec, the start of publishing and problems from ffmpeg output', () => {
    expect(readFfmpegLine('  Stream #0:0: Video: hevc (Main), yuvj420p(pc), 1920x1080').codec).toBe('hevc');
    expect(readFfmpegLine('  Stream #0:0[0x1]: Video: h264 (High)').codec).toBe('h264');
    expect(readFfmpegLine(`Output #0, rtsp, to '${TARGET}':`).publishing).toBe(true);
    const p = readFfmpegLine(`[tcp @ 0x1] Connection to tcp://media.test:18554 failed: Connection refused ${TARGET}`).problem!;
    expect(p).toMatch(/Connection refused/);
    expect(p).not.toContain(SECRET);
  });
});

describe('VideoPusher', () => {
  afterAll(() => delete process.env.FAKE_FFMPEG);

  it('reports pushing with the codec once the media server accepted the stream', async () => {
    const { p, states, lines } = pusher('ok');
    await until(() => p.state.status === 'pushing');
    expect(p.state.codec).toBe('h264');
    expect(states.map((s) => s.status)).toEqual(['starting', 'pushing']);
    expect(lines.join('\n')).toContain('video pushed to rtsp://pub:***@media.test:18554/ugv-01 (h264)');
    expect(lines.join('\n')).not.toContain(SECRET);
    p.stop();
    expect(p.state.status).toBe('stopped');
  });

  it('warns once when the camera sends H.265, which browsers cannot play', async () => {
    const { p, lines } = pusher('hevc');
    await until(() => p.state.status === 'pushing');
    expect(p.state.codec).toBe('hevc');
    expect(lines.filter((l) => /H\.265/.test(l))).toHaveLength(1);
  });

  it('retries with backoff, says why, and keeps the credential out of the detail', async () => {
    const { p, states, lines } = pusher('fail');
    await until(() => states.filter((s) => s.status === 'retrying').length >= 3);
    const r = states.find((s) => s.status === 'retrying')!;
    expect(r.detail).toMatch(/401 Unauthorized.*retrying in/);
    expect(JSON.stringify(states) + lines.join('\n')).not.toContain(SECRET);
    p.stop();
  });

  it('starts at once with a fresh credential while it waits to retry', async () => {
    const { p, lines } = pusher('fail', { backoff: { initialMs: 60_000, maxMs: 60_000 } });
    await until(() => p.state.status === 'retrying');
    process.env.FAKE_FFMPEG = 'ok';
    p.setTarget('rtsp://pub:new@two.test:18554/ugv-01');
    await until(() => p.state.status === 'pushing', 2000);
    expect(lines.join('\n')).toContain('video pushed to rtsp://pub:***@two.test:18554/ugv-01');
  });

  it('says so when ffmpeg is not installed', async () => {
    const { p, states } = pusher('ok', { ffmpeg: join(dir, 'no-such-ffmpeg'), prefixArgs: [] });
    await until(() => p.state.status === 'missing');
    expect(states.at(-1)!.detail).toMatch(/ffmpeg not found.*apt install ffmpeg/);
  });
});

// ---------------------------------------------------------------------------
// Gateway: the welcome's publish addresses start, refresh and stop pushes.
// ---------------------------------------------------------------------------

class FakeServer {
  wss!: WebSocketServer;
  port = 0;
  socket?: WebSocket;
  media: (n: number) => { deviceId: string; publish: string }[] = (n) => [{ deviceId: 'UGV-01', publish: `rtsp://pub:t${n}@media.test:18554/ugv-01` }];
  accept: string[] = ['UGV-01', 'CAM-2'];
  hellos = 0;
  async listen() {
    this.wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (sock) => {
      this.socket = sock;
      sock.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as GatewayToServer;
        if (msg.t !== 'hello') return;
        this.hellos += 1;
        const ids = msg.adapters.map((a) => a.deviceId).filter((id) => this.accept.includes(id));
        const welcome: ServerToGateway = { t: 'welcome', serverTime: Date.now(), accepted: ids, rejected: [], media: this.media(this.hellos) };
        sock.send(JSON.stringify(welcome));
      });
    });
    return this;
  }
  async close() {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

function adapter(deviceId: string, stream: AdapterDeclaration['stream'], states: PushState[] = []): Adapter {
  return {
    declaration: {
      deviceId,
      kind: 'ugv',
      model: 'test',
      adapterVersion: 'test',
      protocolVersion: 'test',
      firmwareTested: '',
      integration: 'testing',
      capabilities: ['video'],
      commands: [],
      units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
      rateMs: 1000,
      limitations: '',
      linkLossBehavior: '',
      stream,
    },
    start() {},
    stop() {},
    onCommand() {},
    onDemo() {},
    onMediaState: (s) => states.push(s),
  };
}

describe('gateway video push', () => {
  let server: FakeServer | undefined;
  let gw: GatewayHandle | undefined;
  afterEach(async () => {
    await gw?.stop();
    await server?.close().catch(() => {});
    gw = server = undefined;
  });

  it('starts one push per device from the welcome, refreshes its credential on reconnect and stops it on shutdown', async () => {
    server = await new FakeServer().listen();
    const made: { o: VideoPushOptions; targets: string[]; stopped: boolean }[] = [];
    const createPusher = (o: VideoPushOptions): Pusher => {
      const rec = { o, targets: [o.target], stopped: false };
      made.push(rec);
      return {
        setTarget: (u) => rec.targets.push(u),
        stop: () => (rec.stopped = true),
        get state() {
          return { status: 'pushing' as const, detail: '' };
        },
      };
    };
    const states: PushState[] = [];
    const { log, lines } = linesLog();
    gw = startGateway({
      serverUrl: `ws://127.0.0.1:${server.port}`,
      key: 'k',
      gatewayId: 'edge-test',
      adapters: [adapter('UGV-01', { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true }, states), adapter('CAM-2', { whep: 'http://edge.test/cam2/whep' })],
      log,
      backoff: { initialMs: 50, maxMs: 200 },
      createPusher,
    });
    await until(() => made.length === 1);
    expect(made[0].o).toMatchObject({ deviceId: 'UGV-01', source: 'rtsp://192.168.144.25:8554/main.264', target: 'rtsp://pub:t1@media.test:18554/ugv-01' });
    made[0].o.onState?.({ status: 'pushing', detail: 'ok', codec: 'h264' });
    expect(states).toEqual([{ status: 'pushing', detail: 'ok', codec: 'h264' }]);

    // Server link drops and comes back: same push, new credential.
    server.socket!.terminate();
    await until(() => made[0].targets.length === 2);
    expect(made).toHaveLength(1);
    expect(made[0].targets[1]).toBe('rtsp://pub:t2@media.test:18554/ugv-01');

    // The server no longer accepts the device: its push stops.
    server.accept = ['CAM-2'];
    server.media = () => [];
    server.socket!.terminate();
    await until(() => made[0].stopped);
    expect(lines.join('\n')).not.toMatch(/no camera to push/);
  });

  it('warns when the server has no media server for a pushing device, and ignores addresses for devices that do not push', async () => {
    server = await new FakeServer().listen();
    server.media = () => [{ deviceId: 'CAM-2', publish: 'rtsp://pub:x@media.test:18554/cam-2' }];
    const made: VideoPushOptions[] = [];
    const { log, lines } = linesLog();
    gw = startGateway({
      serverUrl: `ws://127.0.0.1:${server.port}`,
      key: 'k',
      gatewayId: 'edge-test',
      adapters: [adapter('UGV-01', { rtsp: 'rtsp://cam/main.264', push: true }), adapter('CAM-2', { whep: 'http://edge.test/cam2/whep' })],
      log,
      backoff: { initialMs: 50, maxMs: 200 },
      createPusher: (o) => {
        made.push(o);
        return { setTarget() {}, stop() {}, state: { status: 'starting', detail: '' } };
      },
    });
    await until(() => lines.some((l) => /registered/.test(l)));
    await wait(50);
    expect(made).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/UGV-01: the server gave no video publish address/);
    expect(lines.join('\n')).toMatch(/publish address for CAM-2, which has no camera to push here/);
  });
});
