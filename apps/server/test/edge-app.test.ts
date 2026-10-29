// In-app updates for the edge Android app: an administrator publishes an APK + its build manifest,
// paired apps read the latest release and download it with their gateway key.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EDGE_APP_PACKAGE } from '@13store/shared';
import { EdgeAppStore } from '../src/edgeApp';
import { Client, startServer, type TestServer } from './helpers';

const APK = 'application/vnd.android.package-archive';
let srv: TestServer;
let admin: Client;
let op: Client;
let key = '';

/** Something shaped like an APK (a zip archive), with its manifest. */
function build(versionCode: number, versionName: string, size = 300_000) {
  const bytes = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), randomBytes(size - 4)]);
  return { bytes, manifest: { packageName: EDGE_APP_PACKAGE, versionCode, versionName, sha256: createHash('sha256').update(bytes).digest('hex'), size } };
}

async function upload(token: string, b: ReturnType<typeof build>, over: Record<string, string | number> = {}, body: Buffer = b.bytes) {
  const q = new URLSearchParams(Object.entries({ ...b.manifest, ...over }).map(([k, v]) => [k, String(v)]));
  const r = await fetch(`${srv.url}/api/v1/admin/edge-app?${q}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': APK }, body: new Uint8Array(body) });
  return { status: r.status, body: (await r.json()) as any };
}

const edge = (path: string, token = key, headers: Record<string, string> = {}) => fetch(`${srv.url}/api/v1/edge/app/${path}`, { headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
  srv = await startServer({ env: 'pilot', gateway: false });
  delete process.env.ADMIN_PASSWORD;
  admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  expect((await admin.post('/admin/users', { username: 'app-op', name: 'Operator', role: 'operator', password: 'longpassword1' })).status).toBe(200);
  op = await Client.login(srv.url, 'app-op', 'longpassword1');
  // A remote paired the usual way: its gateway key is what the app uses for updates.
  const code = (await admin.post('/admin/pairing-codes', { gatewayId: 'edge-unirc-01', devices: [{ type: 'mavlink', deviceId: 'UGV-01', kind: 'ugv', profile: 'ardupilot-rover' }] })).body.code;
  const paired = await fetch(`${srv.url}/api/v1/edge/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  key = ((await paired.json()) as any).key;
}, 30_000);
afterAll(async () => {
  await srv?.close();
});

describe('edge app updates', () => {
  const v2 = build(2, '0.2.0');

  it('says when nothing is published', async () => {
    expect((await admin.get('/admin/edge-app')).body).toEqual({ release: null });
    const r = await edge('latest');
    expect(r.status).toBe(404);
    expect(((await r.json()) as any).code).toBe('not_found');
  });

  it('an administrator publishes a build; a paired app sees it and downloads exactly those bytes', async () => {
    const pub = await upload(admin.token, v2);
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ ...v2.manifest, publishedBy: 'Administrator' });
    expect(existsSync(join(srv.cfg.dataDir, 'edge-app', 'app.apk'))).toBe(true);

    const latest = await edge('latest');
    expect(latest.status).toBe(200);
    const rel = (await latest.json()) as any;
    expect(rel).toMatchObject(v2.manifest);
    expect(rel).not.toHaveProperty('publishedBy');

    const dl = await edge('download', key, { 'x-edge-app': 'Edge app 0.1.0 (1) · SIYI UniRC 7 Pro' });
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe(APK);
    expect(dl.headers.get('x-sha256')).toBe(v2.manifest.sha256);
    expect(Buffer.from(await dl.arrayBuffer()).equals(v2.bytes)).toBe(true);

    const audit = (await admin.get('/audit?limit=50')).body as { action: string; object: string; detail?: string }[];
    expect(audit.some((e) => e.action === 'edge.app_publish' && e.object === `${EDGE_APP_PACKAGE} 0.2.0`)).toBe(true);
    expect(audit.find((e) => e.action === 'edge.app_download')?.detail).toMatch(/Edge app 0\.1\.0 \(1\)/);
  });

  it('keeps the release in the data folder, so it survives a restart or redeploy', () => {
    const again = new EdgeAppStore(srv.cfg.dataDir, srv.built.platform);
    expect(again.latest()).toMatchObject(v2.manifest);
  });

  it('refuses a file that does not match its manifest, is not an APK, is not newer, or is another app', async () => {
    const v3 = build(3, '0.3.0');
    expect((await upload(admin.token, v3, { sha256: v2.manifest.sha256 })).body.error).toMatch(/does not match its manifest/);
    const notZip = Buffer.from('not an apk at all');
    expect((await upload(admin.token, v3, { sha256: createHash('sha256').update(notZip).digest('hex') }, notZip)).body.error).toMatch(/not an APK/);
    const same = await upload(admin.token, build(2, '0.2.0-b'));
    expect(same.status).toBe(409);
    expect(same.body.error).toMatch(/not newer/);
    expect((await upload(admin.token, v3, { packageName: 'com.example.other' })).body.error).toMatch(/not the edge app/);
    expect((await upload(admin.token, v3, { versionName: 'zero point three' })).status).toBe(400);
    expect((await upload(admin.token, v3, { versionCode: 'x' })).status).toBe(400);
    // The rejected uploads changed nothing.
    expect(((await (await edge('latest')).json()) as any).versionCode).toBe(2);
    // A newer build replaces it.
    expect((await upload(admin.token, v3)).status).toBe(200);
    expect(((await (await edge('latest')).json()) as any).versionName).toBe('0.3.0');
  });

  it('only administrators publish; a gateway key reads updates and nothing else', async () => {
    const v4 = build(4, '0.4.0');
    expect((await upload(op.token, v4)).status).toBe(403);
    expect((await upload(key, v4)).status).toBe(403);
    expect((await edge('latest', '')).status).toBe(401);
    expect((await edge('latest', op.token)).status).toBe(403);
    expect((await Client.withKey(srv.url, key).get('/snapshot')).status).toBe(403);
    expect((await edge('latest', admin.token)).status).toBe(200);
  });

  it('an administrator can take the release down', async () => {
    expect((await admin.req('DELETE', '/admin/edge-app')).status).toBe(200);
    expect((await edge('latest')).status).toBe(404);
    expect((await edge('download')).status).toBe(404);
  });
});
