// AI box mode: the gateway runs one vision pipeline per job the server hands it (a vehicle's video
// with a read pass), sends what it sees under the vehicle's id, and stops when the job ends.
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { GatewayToServer, ServerToGateway } from '@13store/shared';
import { startGateway, type GatewayHandle } from '../src/gateway';
import { parseSiteConfig } from '../src/real/config';
import { AiBox, PushSource, encodeJpeg, paintFrame, type AiBoxConfig, type JobContext } from '../src/vision';
import type { Logger } from '../src/sdk';

const W = 320;
const H = 240;
const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} };
/** A hot spot the thermal detector reports (no model needed). */
const hot = () => encodeJpeg(paintFrame(W, H, [60, 60, 60], [{ x: 150, y: 100, w: 20, h: 20, rgb: [200, 200, 200] }]));
const BOX: AiBoxConfig = { capacity: 2, model: 'test model', vision: { detectors: { thermal: { minC: 0, maxC: 100, thresholdC: 60 } }, snapshot: false }, healthMs: 60_000 };

describe('AI box', () => {
  it('starts a pipeline per job, sends under the job device id, renews and stops them', async () => {
    const sent: { deviceId: string; kind: string; detail?: unknown }[] = [];
    const ctx = (deviceId: string): JobContext => ({
      now: () => Date.now(),
      log: quiet,
      event: (e) => sent.push({ deviceId, kind: e.kind }),
      tracks: (t) => sent.push({ deviceId, kind: 'tracks', detail: t.boxes.length }),
    });
    const sources: { url: string; src: PushSource }[] = [];
    const box = new AiBox(BOX, ctx, (url) => {
      const src = new PushSource();
      sources.push({ url, src });
      return src;
    });
    expect(box.offer).toEqual({ capacity: 2, model: 'test model' });

    box.setJobs([{ deviceId: 'UGV-01', read: 'rtsp://read:r2.a@media:18554/ugv-01' }], quiet);
    box.setJobs([{ deviceId: 'UGV-01', read: 'rtsp://read:r2.a@media:18554/ugv-01' }], quiet); // same list: nothing to do
    expect(sources.map((s) => s.url)).toEqual(['rtsp://read:r2.a@media:18554/ugv-01']);
    expect(box.has('UGV-01')).toBe(true);
    sources[0].src.push(hot(), Date.now());
    await vi.waitFor(() => expect(sent.some((m) => m.deviceId === 'UGV-01' && m.kind === 'detection')).toBe(true));
    expect(sent.some((m) => m.deviceId === 'UGV-01' && m.kind === 'tracks')).toBe(true);

    // A renewed pass restarts the reader; a second vehicle gets its own pipeline.
    box.setJobs(
      [
        { deviceId: 'UGV-01', read: 'rtsp://read:r2.b@media:18554/ugv-01' },
        { deviceId: 'UGV-02', read: 'rtsp://read:r2.c@media:18554/ugv-02' },
      ],
      quiet,
    );
    expect(sources.map((s) => s.url).slice(1).sort()).toEqual(['rtsp://read:r2.b@media:18554/ugv-01', 'rtsp://read:r2.c@media:18554/ugv-02']);
    expect(box.active().sort()).toEqual(['UGV-01', 'UGV-02']);

    // Taken away: the pipeline stops and the boxes on screen are cleared.
    sent.length = 0;
    box.setJobs([{ deviceId: 'UGV-02', read: 'rtsp://read:r2.c@media:18554/ugv-02' }], quiet);
    expect(box.active()).toEqual(['UGV-02']);
    expect(sent).toContainEqual({ deviceId: 'UGV-01', kind: 'tracks', detail: 0 });
    box.stopAll();
    expect(box.active()).toEqual([]);
  });

  it('checks the aiBox section of a site config, and lets an AI box have no devices of its own', () => {
    const geo = { originLat: 13.7, originLon: 100.5 };
    const vision = { detectors: { http: { url: 'http://127.0.0.1:8601/detect' } } };
    expect(parseSiteConfig({ geo, aiBox: { capacity: 3, vision } }).devices).toEqual([]);
    expect(() => parseSiteConfig({ geo, devices: [] })).toThrow(/at least one device/);
    expect(() => parseSiteConfig({ geo, aiBox: { capacity: 0, vision } })).toThrow(/capacity/);
    expect(() => parseSiteConfig({ geo, aiBox: { vision: { ...vision, source: { kind: 'folder', dir: '.' } } } })).toThrow(/has no source/);
    expect(() => parseSiteConfig({ geo, aiBox: { vision: { detectors: {} } } })).toThrow(/detectors/);
    expect(() => parseSiteConfig({ geo, aiBox: {} })).toThrow(/aiBox.vision/);
  });
});

// ---------------------------------------------------------------------------
// The gateway in AI box mode against a fake server.
// ---------------------------------------------------------------------------

class FakeServer {
  wss!: WebSocketServer;
  socket?: WebSocket;
  got: GatewayToServer[] = [];
  async listen() {
    this.wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.wss.on('connection', (sock) => {
      this.socket = sock;
      sock.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as GatewayToServer;
        this.got.push(msg);
        if (msg.t === 'hello') sock.send(JSON.stringify({ t: 'welcome', serverTime: Date.now(), accepted: [], rejected: [] } satisfies ServerToGateway));
      });
    });
    return this;
  }
  get url() {
    return `ws://127.0.0.1:${(this.wss.address() as AddressInfo).port}`;
  }
  send(m: ServerToGateway) {
    this.socket!.send(JSON.stringify(m));
  }
  async close() {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

describe('gateway as an AI box', () => {
  let gw: GatewayHandle | undefined;
  let server: FakeServer | undefined;
  afterEach(async () => {
    await gw?.stop();
    await server?.close();
    gw = server = undefined;
  });

  it('offers itself in the hello, runs the jobs it is handed, and sends only for its jobs', async () => {
    server = await new FakeServer().listen();
    const sources: { url: string; src: PushSource }[] = [];
    gw = startGateway({
      serverUrl: server.url,
      key: 'k',
      gatewayId: 'jetson-ai-01',
      adapters: [],
      log: quiet,
      aiBox: BOX,
      aiBoxSource: (url) => {
        const src = new PushSource();
        sources.push({ url, src });
        return src;
      },
    });
    await vi.waitFor(() => expect(server!.got.some((m) => m.t === 'hello')).toBe(true));
    expect(server.got.find((m) => m.t === 'hello')).toMatchObject({ gatewayId: 'jetson-ai-01', adapters: [], aiBox: { capacity: 2, model: 'test model' } });

    server.send({ t: 'ai_jobs', jobs: [{ deviceId: 'UGV-01', read: 'rtsp://read:r2.a@media:18554/ugv-01' }] });
    await vi.waitFor(() => expect(sources).toHaveLength(1));
    expect(gw.status().aiBox).toEqual({ capacity: 2, jobs: ['UGV-01'] });
    sources[0].src.push(hot(), Date.now());
    await vi.waitFor(() => expect(server!.got.some((m) => m.t === 'event' && m.deviceId === 'UGV-01' && m.kind === 'detection')).toBe(true));
    expect(server.got.some((m) => m.t === 'tracks' && m.deviceId === 'UGV-01')).toBe(true);

    // The job is taken away: the pipeline stops, an empty list clears the screen, nothing more is sent for it.
    server.send({ t: 'ai_jobs', jobs: [] });
    await vi.waitFor(() => expect(gw!.status().aiBox!.jobs).toEqual([]));
    await vi.waitFor(() => expect(server!.got.some((m) => m.t === 'tracks' && m.deviceId === 'UGV-01' && m.boxes.length === 0)).toBe(true));
    const count = server.got.length;
    sources[0].src.push(hot(), Date.now());
    await new Promise((r) => setTimeout(r, 200));
    expect(server.got.slice(count).filter((m) => 'deviceId' in m && m.deviceId === 'UGV-01')).toEqual([]);
  });
});
