// Edge pairing (CLEANUP_PLAN E-3): one-time code → gateway key + site configuration, no key typed by anyone.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL, PAIRING_CODE_TTL_MIN } from '@13store/shared';
import { Client, startServer, type TestServer } from './helpers';

const UGV = {
  type: 'mavlink',
  deviceId: 'UGV-01',
  kind: 'ugv',
  profile: 'ardupilot-rover',
  link: { mode: 'client', host: '192.168.144.20', port: 19856 },
  stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true },
};

let srv: TestServer;
let admin: Client;
let op: Client;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
  srv = await startServer({ env: 'pilot', gateway: false });
  delete process.env.ADMIN_PASSWORD;
  admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  expect((await admin.post('/admin/users', { username: 'pair-op', name: 'Operator', role: 'operator', password: 'longpassword1' })).status).toBe(200);
  op = await Client.login(srv.url, 'pair-op', 'longpassword1');
}, 30_000);
afterAll(async () => {
  await srv?.close();
});

async function pair(body: unknown) {
  const r = await fetch(`${srv.url}/api/v1/edge/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any, headers: r.headers };
}

const createCode = async (gatewayId = 'edge-unirc-01', devices: unknown[] = [UGV]) => {
  const r = await admin.post('/admin/pairing-codes', { label: 'UniRC 7 Pro', gatewayId, devices });
  expect(r.status).toBe(200);
  return r.body as { id: string; code: string; status: string; expiresAt: number; createdAt: number; deviceIds: string[] };
};

/** Opens the gateway channel with a key; resolves with the welcome, or the close code if refused. */
function gatewayHello(key: string, gatewayId: string): Promise<{ welcome?: any; closed?: number }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${key}` } });
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId, adapters: [] })));
    ws.on('message', (m) => {
      const msg = JSON.parse(String(m));
      if (msg.t === 'welcome') {
        ws.close();
        resolve({ welcome: msg });
      }
    });
    ws.on('close', (code) => resolve({ closed: code }));
  });
}

const row = (id: string) => srv.db.prepare('SELECT * FROM pairing_codes WHERE id = ?').get(id) as Record<string, any>;

describe('edge pairing', () => {
  it('an administrator creates a code; the edge exchanges it once for a working gateway key and its configuration', async () => {
    const c = await createCode();
    expect(c.code).toMatch(/^\d{6}$/);
    expect(c).toMatchObject({ status: 'waiting', deviceIds: ['UGV-01'] });
    expect(c.expiresAt - c.createdAt).toBe(PAIRING_CODE_TTL_MIN * 60_000);
    // The code is shown once: never in the list, never stored in the clear.
    const listed = (await admin.get('/admin/pairing-codes')).body as any[];
    expect(listed.find((x) => x.id === c.id)).not.toHaveProperty('code');
    expect(JSON.stringify(row(c.id))).not.toContain(c.code);

    const r = await pair({ code: c.code.replace(/(\d{3})/, '$1 '), client: 'Edge app test · Android 13' });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(r.body).toMatchObject({ gatewayId: 'edge-unirc-01', devices: [UGV], site: { id: expect.any(String) } });
    expect(r.body.key).toMatch(/^gw_pilot_/);
    expect(r.body.serverUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(Number.isFinite(r.body.geo.originLat) && Number.isFinite(r.body.geo.originLon)).toBe(true);

    // The key opens the gateway channel and is limited to the code's site.
    expect((await gatewayHello(r.body.key, 'edge-unirc-01')).welcome).toBeTruthy();
    const key = srv.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(row(c.id).key_id) as { kind: string; site_ids: string };
    expect(key.kind).toBe('gateway');
    expect(JSON.parse(key.site_ids)).toEqual([r.body.site.id]);

    // Once only; the configuration is gone from the database.
    expect((await pair({ code: c.code })).body.code).toBe('invalid_code');
    expect(row(c.id).config).toBeNull();
    const after = ((await admin.get('/admin/pairing-codes')).body as any[]).find((x) => x.id === c.id);
    expect(after).toMatchObject({ status: 'paired', pairedBy: 'Edge app test · Android 13' });
    const audit = (await admin.get('/audit?limit=100')).body as { action: string; object: string }[];
    expect(audit.some((e) => e.action === 'edge.paired' && e.object === 'edge-unirc-01')).toBe(true);
    expect(audit.some((e) => e.action === 'edge.pairing_code' && e.object === c.id)).toBe(true);
  });

  it('pairing the same gateway again revokes the key of its previous pairing', async () => {
    const first = (await pair({ code: (await createCode('edge-repair')).code })).body.key as string;
    expect((await gatewayHello(first, 'edge-repair')).welcome).toBeTruthy();
    const second = (await pair({ code: (await createCode('edge-repair')).code })).body.key as string;
    expect(second).not.toBe(first);
    expect((await gatewayHello(first, 'edge-repair')).closed).toBe(4401);
    expect((await gatewayHello(second, 'edge-repair')).welcome).toBeTruthy();
  });

  it('cancelled and expired codes do not pair, and forget their configuration', async () => {
    const cancelled = await createCode('edge-cancel');
    expect((await admin.req('DELETE', `/admin/pairing-codes/${cancelled.id}`)).status).toBe(200);
    expect((await pair({ code: cancelled.code })).status).toBe(400);
    expect(row(cancelled.id).config).toBeNull();

    const expired = await createCode('edge-expired');
    srv.db.prepare('UPDATE pairing_codes SET expires_at = ? WHERE id = ?').run(Date.now() - 1, expired.id);
    expect((await pair({ code: expired.code })).status).toBe(400);
    const list = (await admin.get('/admin/pairing-codes')).body as any[];
    expect(list.find((x) => x.id === cancelled.id).status).toBe('cancelled');
    expect(list.find((x) => x.id === expired.id).status).toBe('expired');
    expect(row(expired.id).config).toBeNull();
    expect((await admin.req('DELETE', `/admin/pairing-codes/${expired.id}`)).status).toBe(404);
  });

  it('only administrators create codes, and the device list is checked like a site.json', async () => {
    expect((await op.post('/admin/pairing-codes', { gatewayId: 'edge-x', devices: [UGV] })).status).toBe(403);
    expect((await op.get('/admin/pairing-codes')).status).toBe(403);
    const bad = async (body: unknown) => (await admin.post('/admin/pairing-codes', body)).body.error as string;
    expect(await bad({ gatewayId: 'x', devices: [UGV] })).toMatch(/Gateway id/);
    expect(await bad({ gatewayId: 'edge-x', devices: [] })).toMatch(/at least one device/);
    expect(await bad({ gatewayId: 'edge-x', devices: [{ ...UGV, deviceId: 'ugv 1' }] })).toMatch(/Bad deviceId/);
    expect(await bad({ gatewayId: 'edge-x', devices: [{ ...UGV, profile: 'boat' }] })).toMatch(/unknown profile/);
    expect(await bad({ gatewayId: 'edge-x', devices: [null] })).toMatch(/Device list/);
  });

  it('wrong codes lock the address out, even for a right code', async () => {
    const good = await createCode('edge-throttle');
    const wrong = good.code === '000000' ? '111111' : '000000';
    let status = 0;
    for (let i = 0; i < 6 && status !== 429; i++) status = (await pair({ code: wrong })).status;
    expect(status).toBe(429);
    const r = await pair({ code: good.code });
    expect(r.status).toBe(429);
    expect(row(good.id).paired_at).toBeNull();
  });
});
