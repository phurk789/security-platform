import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { DEFAULT_ROUTE, GATEWAY_PROTOCOL, type GatewayToServer, type GwHello, type ServerToGateway } from '@13store/shared';
import { defaultAdapters } from '../src/adapters';
import { startGateway, type GatewayHandle } from '../src/gateway';
import { silentLogger } from '../src/sdk';

/** Minimal stand-in for the platform server's /api/v1/gateway endpoint. */
class FakeServer {
  wss!: WebSocketServer;
  port = 0;
  received: GatewayToServer[] = [];
  auth: (string | undefined)[] = [];
  paths: (string | undefined)[] = [];
  socket?: WebSocket;
  accept: (ids: string[]) => string[] = (ids) => ids;

  async listen(port = 0) {
    this.wss = new WebSocketServer({ port });
    await new Promise<void>((r) => this.wss.once('listening', () => r()));
    this.port = (this.wss.address() as AddressInfo).port;
    this.wss.on('connection', (sock, req) => {
      this.socket = sock;
      this.auth.push(req.headers.authorization);
      this.paths.push(req.url);
      sock.on('message', (raw) => {
        const msg = JSON.parse(raw.toString()) as GatewayToServer;
        this.received.push(msg);
        if (msg.t === 'hello') {
          const ids = msg.adapters.map((a) => a.deviceId);
          const ok = this.accept(ids);
          this.send({ t: 'welcome', serverTime: Date.now(), accepted: ok, rejected: ids.filter((i) => !ok.includes(i)).map((deviceId) => ({ deviceId, reason: 'not registered' })) });
        }
      });
    });
    return this;
  }
  send(msg: ServerToGateway) {
    this.socket?.send(JSON.stringify(msg));
  }
  of<T extends GatewayToServer['t']>(t: T) {
    return this.received.filter((m) => m.t === t) as Extract<GatewayToServer, { t: T }>[];
  }
  async close() {
    for (const c of this.wss.clients) c.terminate();
    await new Promise<void>((r) => this.wss.close(() => r()));
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await wait(20);
  }
}

let server: FakeServer | undefined;
let gw: GatewayHandle | undefined;
afterEach(async () => {
  await gw?.stop();
  await server?.close().catch(() => {});
  gw = undefined;
  server = undefined;
});

function start(opts: { rateMs?: number } = {}) {
  gw = startGateway({
    serverUrl: `ws://127.0.0.1:${server!.port}`,
    key: 'gw_test_key',
    gatewayId: 'edge-test',
    adapters: defaultAdapters({ rateMs: opts.rateMs ?? 200 }),
    log: silentLogger,
    backoff: { initialMs: 50, maxMs: 200 },
  });
  return gw;
}

describe('gateway ↔ server', () => {
  it('authenticates with a bearer key and declares every adapter in hello', async () => {
    server = await new FakeServer().listen();
    start();
    await until(() => server!.of('hello').length > 0);
    expect(server.auth[0]).toBe('Bearer gw_test_key');
    expect(server.paths[0]).toBe('/api/v1/gateway');
    const hello = server.of('hello')[0] as GwHello;
    expect(hello).toMatchObject({ protocol: GATEWAY_PROTOCOL, gatewayId: 'edge-test' });
    expect(hello.adapters).toHaveLength(10);
    expect(hello.adapters.every((a) => a.integration === 'simulated' && a.units.position === 'site-m')).toBe(true);
    await until(() => gw!.accepted.size === 10);
    expect(gw!.connected).toBe(true);
  });

  it('streams telemetry only for accepted devices; offline CCTV-04 sends nothing', async () => {
    server = await new FakeServer().listen();
    server.accept = (ids) => ids.filter((i) => i !== 'CCTV-01');
    start();
    await wait(700);
    const tel = server.of('telemetry');
    const ids = new Set(tel.map((t) => t.deviceId));
    expect(ids.has('UGV-01')).toBe(true);
    expect(ids.has('UAV-02')).toBe(true);
    expect(ids.has('CCTV-01')).toBe(false);
    expect(ids.has('CCTV-04')).toBe(false);
  });

  it('routes commands to the adapter and relays its status updates', async () => {
    server = await new FakeServer().listen();
    start();
    await until(() => gw!.accepted.size === 10);
    server.send({ t: 'command', commandId: 'C1', idempotencyKey: 'k1', deviceId: 'UGV-01', type: 'start', route: DEFAULT_ROUTE, missionId: 'M1', expiresAt: Date.now() + 10_000 });
    await until(() => server!.of('cmd').some((c) => c.commandId === 'C1' && c.status === 'succeeded'));
    expect(server.of('cmd').filter((c) => c.commandId === 'C1').map((c) => c.status)).toEqual(['acknowledged', 'executing', 'succeeded']);
    await wait(500);
    const ugv = server.of('telemetry').filter((t) => t.deviceId === 'UGV-01');
    expect(ugv[ugv.length - 1].speed).toBeGreaterThan(0);
  });

  it('ignores commands for devices the server did not accept', async () => {
    server = await new FakeServer().listen();
    server.accept = (ids) => ids.filter((i) => i !== 'UGV-01');
    start();
    await until(() => gw!.accepted.size === 9);
    server.send({ t: 'command', commandId: 'C2', idempotencyKey: 'k2', deviceId: 'UGV-01', type: 'start', route: DEFAULT_ROUTE, missionId: 'M1', expiresAt: Date.now() + 10_000 });
    await wait(1200);
    expect(server.of('cmd')).toHaveLength(0);
  });

  it('demo cut/restore over the wire: telemetry stops, failsafe_stop on restore', async () => {
    server = await new FakeServer().listen();
    start({ rateMs: 200 });
    await until(() => gw!.accepted.size === 10);
    server.send({ t: 'command', commandId: 'C3', idempotencyKey: 'k3', deviceId: 'UGV-01', type: 'start', route: DEFAULT_ROUTE, missionId: 'M1', expiresAt: Date.now() + 10_000 });
    await until(() => server!.of('cmd').some((c) => c.commandId === 'C3' && c.status === 'succeeded'));
    server.send({ t: 'demo', deviceId: 'UGV-01', action: 'cut_link' });
    await wait(100);
    const before = server.of('telemetry').filter((t) => t.deviceId === 'UGV-01').length;
    server.send({ t: 'command', commandId: 'C4', idempotencyKey: 'k4', deviceId: 'UGV-01', type: 'stop', missionId: 'M1', expiresAt: Date.now() + 10_000 });
    await wait(2000);
    expect(server.of('telemetry').filter((t) => t.deviceId === 'UGV-01').length).toBe(before);
    server.send({ t: 'demo', deviceId: 'UGV-01', action: 'restore_link' });
    await until(() => server!.of('event').some((e) => e.kind === 'failsafe_stop'));
    await wait(600);
    const after = server.of('telemetry').filter((t) => t.deviceId === 'UGV-01');
    expect(after.length).toBeGreaterThan(before);
    expect(after[after.length - 1].speed).toBe(0);
    expect(server.of('cmd').some((c) => c.commandId === 'C4')).toBe(false);
  });

  it('reconnects after the server restarts and says hello again', async () => {
    server = await new FakeServer().listen();
    start();
    await until(() => gw!.accepted.size === 10);
    const port = server.port;
    await server.close();
    await until(() => !gw!.connected);
    server = await new FakeServer().listen(port);
    await until(() => server!.of('hello').length === 1 && gw!.connected, 5000);
    await until(() => server!.of('telemetry').length > 0);
  });

  it('keeps adapters running while disconnected and does not buffer telemetry', async () => {
    server = await new FakeServer().listen();
    start({ rateMs: 100 });
    await until(() => gw!.accepted.size === 10);
    const port = server.port;
    await server.close();
    await wait(600);
    server = await new FakeServer().listen(port);
    await until(() => server!.of('hello').length === 1);
    // Nothing from the outage is replayed: the first telemetry seen is fresh.
    await until(() => server!.of('telemetry').length > 0);
    const first = server.of('telemetry')[0];
    expect(Date.now() - first.sourceTime).toBeLessThan(500);
  });
});
