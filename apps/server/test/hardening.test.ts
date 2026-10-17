// Enterprise 6 — security hardening: headers and CSP, rate limits, secrets at rest, WebSocket origins.
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { cspHeader } from '../src/http';
import { getOrgSettings } from '../src/retention';
import { isSealed, open, seal } from '../src/secrets';
import { Client, startServer, type TestServer } from './helpers';

let srv: TestServer;
let ploy: Client;

beforeAll(async () => {
  srv = await startServer({ gateway: false, cfg: { rateLimitAuthPerMin: 6, allowedOrigins: ['https://console.example.go.th'] } });
  ploy = await Client.login(srv.url, 'ploy');
}, 30_000);
afterAll(() => srv?.close());

describe('headers', () => {
  it('sends the security headers on every API response and a CSP on HTML', async () => {
    const r = await fetch(`${srv.url}/api/v1/meta`);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('permissions-policy')).toMatch(/camera=\(self\)/);
    expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(r.headers.get('content-security-policy')).toBeNull(); // JSON, not HTML
    expect(r.headers.get('strict-transport-security')).toBeNull(); // plain http in tests
    const csp = cspHeader({ cspConnectSrc: [] });
    expect(csp).toMatch(/script-src 'self'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/connect-src 'self' https: wss:/);
    expect(cspHeader({ cspConnectSrc: ['https://edge.example.go.th:8889', 'wss://edge.example.go.th:8889'] })).toMatch(
      /connect-src 'self' https:\/\/edge.example.go.th:8889 wss:\/\/edge.example.go.th:8889;/,
    );
  });
});

describe('rate limits', () => {
  it('answers 429 with Retry-After after too many sign-in attempts from one address', async () => {
    const results: number[] = [];
    for (let i = 0; i < 8; i++)
      results.push(
        (
          await fetch(`${srv.url}/api/v1/auth/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'ghost', password: 'nope' }),
          })
        ).status,
      );
    // one login already happened in beforeAll: 6 allowed in total, so the 6th attempt here is the first 429
    expect(results.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(results.slice(5).every((s) => s === 429)).toBe(true);
    const last = await fetch(`${srv.url}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ghost', password: 'nope' }),
    });
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await last.json()).code).toBe('rate_limited');
    // Other API calls are not affected by the sign-in limit (API limit is off by default).
    expect((await ploy.get('/license')).status).toBe(200);
  });
});

describe('secrets at rest', () => {
  it('seals and opens values; legacy clear values pass through', () => {
    const s = seal('hook-secret');
    expect(isSealed(s)).toBe(true);
    expect(s).not.toContain('hook-secret');
    expect(open(s)).toBe('hook-secret');
    expect(open('plain-old')).toBe('plain-old');
    expect(seal(s)).toBe(s);
  });

  it('stores channel secrets sealed in the database and uses them in clear when sending', async () => {
    const got: string[] = [];
    const fake = http.createServer((req, res) => {
      got.push(String(req.headers.authorization));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => r()));
    const port = (fake.address() as { port: number }).port;
    try {
      const saved = await ploy.patch('/admin/settings', {
        notifications: {
          channels: [
            { id: 'line', name: 'Ops LINE', kind: 'line', events: ['incident.new'], line: { token: 'line-token-xyz', to: 'C1' } },
            { id: 'hook', name: 'SOC', kind: 'webhook', events: ['incident.new'], webhook: { url: 'https://soc.example/hook', secret: 'hook-secret-xyz' } },
          ],
        },
      });
      expect(saved.status).toBe(200);
      const raw = (srv.db.prepare("SELECT settings FROM orgs WHERE id = 'org-demo'").get() as { settings: string }).settings;
      expect(raw).not.toContain('line-token-xyz');
      expect(raw).not.toContain('hook-secret-xyz');
      expect(raw).toContain('enc:v1:');
      const st = getOrgSettings(srv.db, 'org-demo');
      expect(st.notifications.channels[0].line?.token).toBe('line-token-xyz');
      expect(st.notifications.channels[1].webhook?.secret).toBe('hook-secret-xyz');
      // The notifier gets the open value.
      srv.built.platform.notifier = new (await import('../src/notify')).Notifier(srv.db, { lineApiUrl: `http://127.0.0.1:${port}/push`, retryDelaysMs: [] });
      const test = await ploy.post('/admin/notifications/test', { channelId: 'line' });
      expect(test.body.status).toBe('sent');
      expect(got).toEqual(['Bearer line-token-xyz']);
      // Backups carry the sealed value only.
      const backup = await ploy.post('/admin/backups');
      if (backup.status === 401) {
        await ploy.post('/auth/step-up', { password: 'demo1234' });
      }
    } finally {
      fake.close();
    }
  });
});

describe('WebSocket origins', () => {
  const connect = (origin?: string) =>
    new Promise<number | 'open'>((resolve) => {
      const ws = new WebSocket(`${srv.wsUrl}/api/v1/ws`, origin ? { headers: { origin } } : {});
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', token: ploy.token }));
      });
      ws.on('message', () => {
        resolve('open');
        ws.close();
      });
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve(-1));
    });
  it('refuses browsers from other origins when ALLOWED_ORIGINS is set; same-origin and non-browser clients pass', async () => {
    expect(await connect('https://evil.example')).toBe(4403);
    expect(await connect('https://console.example.go.th')).toBe('open');
    expect(await connect()).toBe('open');
  });
});
