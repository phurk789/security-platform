// Pushed video: a gateway publishes a device's camera into the platform's own media server
// (MEDIA_INGEST_URL) and browsers play it from MEDIA_PUBLIC_URL. The gateway needs no address
// of its own, and only the gateway that holds the device may publish its path.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { loadConfig } from '../src/config';
import { cspHeader } from '../src/http';
import { SANDBOX_GATEWAY_KEY } from '../src/seed';
import { Client, startServer, waitFor, type TestServer } from './helpers';

const INGEST = 'rtsp://media.test:18554';
const PUBLIC = 'http://media.test:18889';

function hello(gatewayId: string, stream: object) {
  return {
    t: 'hello',
    protocol: GATEWAY_PROTOCOL,
    gatewayId,
    adapters: [
      {
        deviceId: 'SBX-ROVER-01',
        kind: 'ugv',
        model: 'Pushed camera rover',
        integration: 'testing',
        capabilities: ['video', 'camera'],
        commands: [],
        rateMs: 1000,
        limitations: '',
        linkLossBehavior: '',
        stream,
        components: [{ id: 'cam', name: 'Onboard camera', kind: 'camera', status: 'pending', stream }],
      },
    ],
  };
}

async function connect(url: string, gatewayId: string, stream: object) {
  const ws = new WebSocket(`${url}/api/v1/gateway`, { headers: { authorization: `Bearer ${SANDBOX_GATEWAY_KEY}` } });
  await new Promise((r) => ws.on('open', r));
  const welcome = new Promise<any>((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
  ws.send(JSON.stringify(hello(gatewayId, stream)));
  return { ws, welcome: await welcome };
}

const auth = (base: string, b: object) =>
  fetch(`${base}/api/v1/media/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.status);

describe('pushed video (platform media server)', () => {
  let srv: TestServer;
  let devop: Client;
  beforeAll(async () => {
    srv = await startServer({ gateway: false, cfg: { mediaIngestUrl: `${INGEST}/`, mediaPublicUrl: PUBLIC } });
    devop = await Client.login(srv.url, 'devop');
  }, 30_000);
  afterAll(() => srv?.close());

  it('gives the gateway a publish address and browsers a WHEP address on the platform media server', async () => {
    const { ws, welcome } = await connect(srv.wsUrl, 'remote-edge', { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true });
    try {
      expect(welcome.accepted).toEqual(['SBX-ROVER-01']);
      expect(welcome.media).toHaveLength(1);
      expect(welcome.media[0].deviceId).toBe('SBX-ROVER-01');
      expect(welcome.media[0].publish).toMatch(/^rtsp:\/\/pub:p1\.[\w-]+\.[\w-]+@media\.test:18554\/sbx-rover-01$/);

      // The viewer link points at the platform's media server, not at the gateway.
      const s = await devop.post('/media/SBX-ROVER-01/session');
      expect(s.status).toBe(200);
      expect(s.body.whep).toMatch(/^http:\/\/media\.test:18889\/sbx-rover-01\/whep\?token=/);
      const viewToken = new URL(s.body.whep).searchParams.get('token')!;
      expect(await auth(srv.url, { action: 'read', path: 'sbx-rover-01', protocol: 'webrtc', query: `token=${viewToken}` })).toBe(200);

      // What MediaMTX sends for an RTSP publish with basic auth: user "pub", password = token.
      const token = decodeURIComponent(new URL(welcome.media[0].publish).password);
      expect(await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp', user: 'pub', password: token })).toBe(200);
      // Not another path, not a tampered token, not without credentials, not a viewer token.
      expect(await auth(srv.url, { action: 'publish', path: 'other-cam', protocol: 'rtsp', user: 'pub', password: token })).toBe(401);
      expect(await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp', user: 'pub', password: `${token.slice(0, -2)}xx` })).toBe(401);
      expect(await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp' })).toBe(401);
      expect(await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp', user: 'pub', password: viewToken })).toBe(401);
      // A publish credential is not a viewer token.
      expect(await auth(srv.url, { action: 'read', path: 'sbx-rover-01', protocol: 'webrtc', query: `token=${token}` })).toBe(401);

      // Once the gateway is gone its credential stops working.
      ws.close();
      await waitFor(async () => (await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp', user: 'pub', password: token })) === 401);
    } finally {
      ws.close();
    }
  });

  it('a credential from an earlier gateway does not work after another gateway took the device', async () => {
    const first = await connect(srv.wsUrl, 'remote-edge', { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true });
    const oldToken = decodeURIComponent(new URL(first.welcome.media[0].publish).password);
    first.ws.close();
    const second = await connect(srv.wsUrl, 'laptop-edge', { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true });
    try {
      const newToken = decodeURIComponent(new URL(second.welcome.media[0].publish).password);
      expect(await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp', user: 'pub', password: oldToken })).toBe(401);
      expect(await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp', user: 'pub', password: newToken })).toBe(200);
    } finally {
      second.ws.close();
    }
  });

  it('expires the publish credential after its lifetime', async () => {
    const { ws, welcome } = await connect(srv.wsUrl, 'remote-edge', { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true });
    const token = decodeURIComponent(new URL(welcome.media[0].publish).password);
    const realNow = srv.built.platform.now;
    srv.built.platform.now = () => Date.now() + 8 * 24 * 3600_000;
    try {
      expect(await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp', user: 'pub', password: token })).toBe(401);
    } finally {
      srv.built.platform.now = realNow;
      ws.close();
    }
  });
});

describe('pushed video without a platform media server', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer({ gateway: false });
  }, 30_000);
  afterAll(() => srv?.close());

  it('accepts the device, sends no publish address, refuses publishing and records why', async () => {
    const { ws, welcome } = await connect(srv.wsUrl, 'remote-edge', { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true });
    try {
      expect(welcome.accepted).toEqual(['SBX-ROVER-01']);
      expect(welcome.media).toBeUndefined();
      const devop = await Client.login(srv.url, 'devop');
      expect((await devop.post('/media/SBX-ROVER-01/session')).body.whep).toBeUndefined();
      expect(await auth(srv.url, { action: 'publish', path: 'sbx-rover-01', protocol: 'rtsp', user: 'pub', password: 'p1.x.y' })).toBe(401);
      const row = srv.db.prepare("SELECT detail FROM audit WHERE action = 'gateway.stream_rejected' ORDER BY rowid DESC LIMIT 1").get() as { detail: string };
      expect(row.detail).toMatch(/MEDIA_INGEST_URL/);
    } finally {
      ws.close();
    }
  });
});

describe('media server settings', () => {
  it('needs both URLs, each scheme://host:port only, and normalises them', () => {
    expect(() => loadConfig({ mediaIngestUrl: INGEST })).toThrow(/together/);
    expect(() => loadConfig({ mediaPublicUrl: PUBLIC })).toThrow(/together/);
    expect(() => loadConfig({ mediaIngestUrl: 'http://media.test:18554', mediaPublicUrl: PUBLIC })).toThrow(/MEDIA_INGEST_URL must start with rtsp/);
    expect(() => loadConfig({ mediaIngestUrl: INGEST, mediaPublicUrl: 'http://media.test:18889/live' })).toThrow(/host:port only/);
    expect(() => loadConfig({ mediaIngestUrl: 'rtsp://u:p@media.test:18554', mediaPublicUrl: PUBLIC })).toThrow(/host:port only/);
    const cfg = loadConfig({ mediaIngestUrl: `${INGEST}/`, mediaPublicUrl: `${PUBLIC}/` });
    expect(cfg.mediaIngestUrl).toBe(INGEST);
    expect(cfg.mediaPublicUrl).toBe(PUBLIC);
  });

  it('lets the console reach the platform media server even over plain http', () => {
    expect(cspHeader({ cspConnectSrc: [], mediaPublicUrl: PUBLIC })).toMatch(/connect-src 'self' https: wss: http:\/\/media\.test:18889;/);
    expect(cspHeader({ cspConnectSrc: [] })).toMatch(/connect-src 'self' https: wss:;/);
  });
});
