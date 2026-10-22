import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { defaultAdapters, startGateway, type GatewayHandle } from '@13store/gateway';
import { loadConfig, type Config } from '../src/config';
import { openDb } from '../src/db';
import { buildApp } from '../src/http';
import type { Actor } from '../src/platform';
import { DEMO_GATEWAY_KEY, seed } from '../src/seed';

/**
 * A signed-in user with a fresh password check, for organisations without a seeded user of that
 * role (the developer sandbox has no administrator or supervisor).
 */
export function testActor(orgId: string, role: Actor['role']): Actor {
  return { kind: 'user', orgId, siteIds: [], userId: `t-${role}`, name: `Test ${role}`, role, stepUpUntil: Date.now() + 15 * 60_000 };
}

export interface TestServer {
  url: string;
  wsUrl: string;
  cfg: Config;
  db: ReturnType<typeof openDb>;
  built: Awaited<ReturnType<typeof buildApp>>;
  gateway?: GatewayHandle;
  close(): Promise<void>;
}

export async function startServer(opts: { gateway?: boolean; env?: 'demo' | 'pilot'; cfg?: Partial<Config> } = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'ps-test-'));
  const cfg = loadConfig({
    dataDir,
    dbFile: join(dataDir, 'platform.sqlite'),
    env: opts.env ?? 'demo',
    mediaSecret: 'test-secret',
    seedPassword: 'demo1234',
    embedGateway: false,
    port: 0,
    backupIntervalH: 0,
    purgeIntervalMs: 0,
    ...opts.cfg,
  });
  const db = openDb(cfg.dbFile);
  seed(db, cfg);
  const built = await buildApp(db, cfg);
  built.platform.start();
  await built.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = built.app.server.address() as { port: number };
  const url = `http://127.0.0.1:${addr.port}`;
  const wsUrl = `ws://127.0.0.1:${addr.port}`;
  let gateway: GatewayHandle | undefined;
  if (opts.gateway !== false) {
    gateway = startGateway({
      serverUrl: wsUrl,
      key: DEMO_GATEWAY_KEY,
      gatewayId: 'edge-test',
      adapters: defaultAdapters({ rateMs: 200 }),
      log: { info() {}, warn() {}, error() {} } as never,
    });
    await waitFor(() => gateway!.connected && built.platform.listDevices(built.platform.systemActor('org-demo')).some((d) => d.id === 'UGV-01' && Date.now() - d.lastSeen < 1000));
  }
  return {
    url,
    wsUrl,
    cfg,
    db,
    built,
    gateway,
    async close() {
      await gateway?.stop();
      await built.app.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 10_000, stepMs = 50) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor timed out');
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Client {
  token = '';
  constructor(
    private base: string,
    public mode: 'live' | 'replay' = 'live',
  ) {}

  static async login(base: string, username: string, password = 'demo1234') {
    const c = new Client(base);
    const r = await c.req('POST', '/auth/login', { username, password });
    if (r.status !== 200) throw new Error(`login ${username}: ${r.status} ${JSON.stringify(r.body)}`);
    c.token = r.body.token;
    return c;
  }

  static withKey(base: string, key: string) {
    const c = new Client(base);
    c.token = key;
    return c;
  }

  async req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any; headers: Headers }> {
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
        ...(this.mode === 'replay' ? { 'x-console-mode': 'replay' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let parsed: any = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* text body */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get = (p: string) => this.req('GET', p);
  post = (p: string, b: unknown = {}) => this.req('POST', p, b);
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
}

/** Opens a console WebSocket and records events. */
export async function consoleSocket(wsUrl: string, token: string) {
  const ws = new WebSocket(`${wsUrl}/api/v1/ws`);
  const events: any[] = [];
  await new Promise<void>((resolve, reject) => {
    ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', token })));
    ws.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === 'hello') resolve();
      else events.push(m);
    });
    ws.on('error', reject);
    ws.on('close', (code) => reject(new Error(`closed ${code}`)));
  });
  return { ws, events, close: () => ws.close() };
}
