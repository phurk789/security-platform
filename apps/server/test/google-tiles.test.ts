// Google basemaps through the official Map Tiles API, proxied by the server: the key stays on the
// server, sessions are shared and renewed, and only signed-in users get tiles. A fake Google answers.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tileXYZ } from '../src/googleTiles';
import { Client, startServer, type TestServer } from './helpers';

const KEY = 'test-google-key-123';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function fakeGoogle() {
  const st = { sessions: [] as Record<string, unknown>[], tiles: [] as string[], rejectSession: '' as string, down: false, keysSeen: new Set<string>() };
  let n = 0;
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    st.keysSeen.add(u.searchParams.get('key') ?? '');
    if (st.down) return res.writeHead(503).end();
    if (req.method === 'POST' && u.pathname === '/v1/createSession') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        st.sessions.push(JSON.parse(body));
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ session: `S${++n}`, expiry: String(Math.floor(Date.now() / 1000) + 14 * 86400), tileWidth: 256, imageFormat: 'png' }));
      });
      return;
    }
    const m = /^\/v1\/2dtiles\/(\d+)\/(\d+)\/(\d+)$/.exec(u.pathname);
    if (m) {
      const s = u.searchParams.get('session')!;
      st.tiles.push(`${m[1]}/${m[2]}/${m[3]}@${s}`);
      if (s === st.rejectSession) return res.writeHead(403, { 'content-type': 'application/json' }).end('{"error":{"status":"PERMISSION_DENIED"}}');
      return res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', etag: '"t1"' }).end(PNG);
    }
    if (u.pathname === '/tile/v1/viewport') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ copyright: 'Imagery ©2026 Airbus, Map data ©2026 Google' }));
    res.writeHead(404).end();
  });
  return new Promise<{ url: string; st: typeof st; close: () => void }>((r) => srv.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, st, close: () => srv.close() })));
}

describe('Google basemaps (Map Tiles API via the server)', () => {
  let g: Awaited<ReturnType<typeof fakeGoogle>>;
  let srv: TestServer;
  let user: Client;
  const tile = (path: string, token = user.token) => fetch(`${srv.url}/api/v1/basemaps/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  beforeAll(async () => {
    g = await fakeGoogle();
    srv = await startServer({ gateway: false, cfg: { googleMapsApiKey: KEY, googleTilesUrl: g.url } });
    user = await Client.login(srv.url, 'alex');
  }, 30_000);
  afterAll(() => {
    srv?.close();
    g?.close();
  });

  it('lists the Google basemaps with tile paths on this server, and no key', async () => {
    const r = await user.get('/basemaps');
    expect(r.status).toBe(200);
    expect(r.body.map((b: { id: string }) => b.id)).toEqual(['google-satellite', 'google-hybrid', 'google-roadmap']);
    expect(r.body[0].tiles).toEqual(['/api/v1/basemaps/google-satellite/tiles/{z}/{x}/{y}']);
    expect(JSON.stringify(r.body)).not.toContain(KEY);
  });

  it('serves tiles to signed-in users with one shared session, passing Google cache rules on and the key never', async () => {
    for (const xyz of ['17/102319/60598', '17/102320/60598', '17/102319/60599']) {
      const r = await tile(`google-satellite/tiles/${xyz}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/png');
      expect(r.headers.get('cache-control')).toBe('private, max-age=86400');
      expect(Buffer.from(await r.arrayBuffer())).toEqual(PNG);
      expect([...r.headers.values()].join(' ')).not.toContain(KEY);
    }
    expect(g.st.sessions).toHaveLength(1);
    expect(g.st.sessions[0]).toMatchObject({ mapType: 'satellite', language: 'th', region: 'TH' });
    expect(g.st.keysSeen.has(KEY)).toBe(true); // the server, not the browser, holds the key
    // Hybrid is satellite with the roadmap labels layer.
    expect((await tile('google-hybrid/tiles/10/797/473')).status).toBe(200);
    expect(g.st.sessions.at(-1)).toMatchObject({ mapType: 'satellite', layerTypes: ['layerRoadmap'], overlay: false });
  });

  it('refuses anonymous requests, unknown basemaps and tiles outside the pyramid', async () => {
    expect((await tile('google-satellite/tiles/1/0/0', '')).status).toBe(401);
    expect((await tile('mt1-google/tiles/1/0/0')).status).toBe(404);
    expect((await tile('google-satellite/tiles/2/4/0')).status).toBe(400);
    expect((await tile('google-satellite/tiles/23/0/0')).status).toBe(400);
    expect((await tile('google-satellite/tiles/1/0/..%2F..')).status).toBe(400);
    expect(tileXYZ('3', '7', '7')).toEqual({ z: 3, x: 7, y: 7 });
    expect(tileXYZ('3', '8', '0')).toBeUndefined();
    expect(tileXYZ('-1', '0', '0')).toBeUndefined();
  });

  it('renews a session Google rejects, and answers 502 when Google is down', async () => {
    const before = g.st.sessions.length;
    g.st.rejectSession = 'S1';
    expect((await tile('google-satellite/tiles/5/25/14')).status).toBe(200);
    expect(g.st.sessions.length).toBe(before + 1);
    g.st.down = true;
    try {
      expect((await tile('google-satellite/tiles/5/25/15')).status).toBe(502);
    } finally {
      g.st.down = false;
    }
  });

  it('gives the copyright line for what is on screen', async () => {
    const r = await user.get('/basemaps/google-hybrid/attribution?zoom=17&north=13.44&south=13.43&east=101.04&west=101.02');
    expect(r.body).toEqual({ copyright: 'Imagery ©2026 Airbus, Map data ©2026 Google' });
    expect((await user.get('/basemaps/google-hybrid/attribution?zoom=17')).status).toBe(400);
  });
});

describe('Google basemaps without a key', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer({ gateway: false });
  }, 30_000);
  afterAll(() => srv?.close());

  it('offers none and serves none', async () => {
    const u = await Client.login(srv.url, 'alex');
    expect((await u.get('/basemaps')).body).toEqual([]);
    expect((await fetch(`${srv.url}/api/v1/basemaps/google-satellite/tiles/1/0/0`, { headers: { authorization: `Bearer ${u.token}` } })).status).toBe(404);
  });
});
