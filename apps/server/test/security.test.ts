// Identity, scoping across orgs/sites, field responders, audit integrity, backup/restore.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { restoreBackup, verifyBackup } from '../src/backup';
import { openDb } from '../src/db';
import { verifyAudit } from '../src/audit';
import { DEMO_ALERT_KEY, SANDBOX_KEY } from '../src/seed';
import { Client, consoleSocket, sleep, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client;
let dev: Client; // sandbox org

beforeAll(async () => {
  srv = await startServer();
  alex = await Client.login(srv.url, 'alex');
  dev = await Client.login(srv.url, 'dev');
}, 30_000);
afterAll(() => srv?.close());

describe('authentication', () => {
  it('rejects bad passwords and locks out after repeated failures', async () => {
    const c = new Client(srv.url);
    for (let i = 0; i < 5; i++) expect((await c.post('/auth/login', { username: 'priya', password: 'nope' })).status).toBe(401);
    expect((await c.post('/auth/login', { username: 'priya', password: 'demo1234' })).status).toBe(429);
  });

  it('requires a session for the API and ends it on logout', async () => {
    expect((await new Client(srv.url).get('/incidents')).status).toBe(401);
    const c = await Client.login(srv.url, 'somchai');
    expect((await c.get('/devices')).status).toBe(200);
    await c.post('/auth/logout');
    expect((await c.get('/devices')).status).toBe(401);
  });

  it('asks for a password again before sensitive actions once the window has passed', async () => {
    const nida = await Client.login(srv.url, 'nida');
    srv.db.prepare('UPDATE sessions SET step_up_until = 0').run();
    const r = await nida.post('/devices/UGV-01/handover', { toUserId: 'u-somchai' });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('step_up_required');
    expect((await nida.post('/auth/step-up', { password: 'demo1234' })).status).toBe(200);
    expect((await nida.post('/devices/UGV-01/handover', { toUserId: 'u-somchai' })).status).toBe(200);
  });
});

describe('organisation and site isolation', () => {
  it('another org cannot read incidents, evidence or devices', async () => {
    expect((await dev.get('/incidents/INC-024')).status).toBe(404);
    expect(((await dev.get('/incidents')).body as any[]).some((i) => i.id === 'INC-024')).toBe(false);
    expect((await dev.get('/evidence/EV-0101/content')).status).toBe(404);
    expect((await dev.get('/devices/UGV-01')).status).toBe(404);
    expect((await dev.post('/media/CCTV-02/session')).status).toBe(404);
    expect((await dev.post('/incidents/INC-024/confirm')).status).toBe(404);
  });

  it('media URLs are signed per user and expire', async () => {
    const s = await alex.post('/media/CCTV-02/session');
    expect(s.status).toBe(200);
    expect((await fetch(srv.url + s.body.url)).status).toBe(200);
    const forged = s.body.url.replace(/u=[^&]+/, 'u=u-dev');
    expect((await fetch(srv.url + forged)).status).toBe(403);
    const expired = s.body.url.replace(/exp=\d+/, `exp=${Date.now() - 1000}`);
    expect((await fetch(srv.url + expired)).status).toBe(410);
  });

  it('websocket events do not cross orgs', async () => {
    const mine = await consoleSocket(srv.wsUrl, alex.token);
    const theirs = await consoleSocket(srv.wsUrl, dev.token);
    await alex.post('/incidents', { title: 'Org isolation probe', place: 'Lot' });
    await waitFor(() => mine.events.some((e) => e.type === 'incident' && e.incident.title === 'Org isolation probe'));
    await sleep(300);
    expect(theirs.events.some((e) => e.type === 'incident' || e.type === 'telemetry')).toBe(false);
    mine.close();
    theirs.close();
  });

  it('API keys are bound to their environment and org', async () => {
    const sensor = Client.withKey(srv.url, DEMO_ALERT_KEY);
    const r = await sensor.post('/alerts', { title: 'Door forced', source: 'Door sensor D-4', place: 'Building 4' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('new');
    expect((await sensor.post(`/incidents/${r.body.id}/confirm`)).status).toBe(403);
    const sandbox = Client.withKey(srv.url, SANDBOX_KEY);
    const s = await sandbox.post('/alerts', { title: 'Sandbox alert' });
    expect(s.body.id).toMatch(/^SBX-INC-/);
    expect((await sandbox.get(`/incidents/${r.body.id}`)).status).toBe(404);
  });
});

describe('field responders', () => {
  it('see only their incidents and can report from the field without duplicates', async () => {
    const kitti = await Client.login(srv.url, 'kitti');
    const list = (await kitti.get('/incidents')).body as any[];
    expect(list.map((i) => i.id)).toEqual(['INC-023']);
    expect((await kitti.get('/incidents/INC-024')).status).toBe(404);
    expect((await kitti.get('/devices')).body).toEqual([]);

    const [asg] = (await kitti.get('/assignments')).body as any[];
    expect((await kitti.post(`/assignments/${asg.id}/arrive`)).status).toBe(200);
    const photo = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64');
    const up = { kind: 'photo', mime: 'image/svg+xml', contentBase64: photo, title: 'Cart moved aside', idempotencyKey: 'phone-1' };
    const a = await kitti.post('/incidents/INC-023/evidence', up);
    const b = await kitti.post('/incidents/INC-023/evidence', up); // retry after a dropped connection
    expect(a.body.id).toBe(b.body.id);
    const rep = { note: 'Walkway clear.', idempotencyKey: 'phone-2' };
    expect((await kitti.post(`/assignments/${asg.id}/report`, rep)).body.status).toBe('reported');
    expect((await kitti.post(`/assignments/${asg.id}/report`, rep)).status).toBe(200);
  });

  it('administrators see everything and manage users, but do not handle incidents or command devices', async () => {
    const ploy = await Client.login(srv.url, 'ploy');
    // Read: incidents, missions, video permission and live data, like a supervisor.
    const inc = (await ploy.get('/incidents')).body as { id: string; status: string }[];
    expect(inc.length).toBeGreaterThan(0);
    expect((await ploy.get(`/incidents/${inc[0].id}`)).status).toBe(200);
    const snap = (await ploy.get('/snapshot')).body as { incidents: unknown[]; missions: unknown[]; devices: unknown[] };
    expect(snap.incidents.length).toBeGreaterThan(0);
    expect(snap.devices.length).toBeGreaterThan(0);
    // Act: no incident handling and no mission approval.
    expect((await ploy.post(`/incidents/${inc[0].id}/triage`)).status).toBe(403);
    expect((await ploy.post('/missions/MSN-0001/approve')).status).toBe(403);
    const u = await ploy.post('/admin/users', { username: 'op2', name: 'Second Operator', role: 'operator', password: 'correct-horse-1' });
    expect(u.status).toBe(200);
    expect((await Client.login(srv.url, 'op2', 'correct-horse-1')).token).toMatch(/^ses_/);
    const key = await ploy.post('/admin/keys', { label: 'Sensors', kind: 'integration' });
    expect(key.body.secret).toMatch(/^sk_demo_/);
    expect((await ploy.post('/commands', { missionId: 'x', type: 'start', idempotencyKey: 'k' })).status).toBe(403);
  });
});

describe('edge gateway channel', () => {
  it('refuses unknown keys and non-simulated adapters in the demo environment', async () => {
    const bad = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: 'Bearer nope' } });
    const code = await new Promise<number>((r) => bad.on('close', (c) => r(c)));
    expect(code).toBe(4401);

    const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: 'Bearer gw_demo_local_key' } });
    await new Promise((r) => ws.on('open', r));
    const welcome = new Promise<any>((r) => ws.on('message', (m) => r(JSON.parse(String(m)))));
    ws.send(
      JSON.stringify({
        t: 'hello',
        protocol: GATEWAY_PROTOCOL,
        gatewayId: 'rogue',
        adapters: [
          { deviceId: 'UGV-99', kind: 'ugv', integration: 'simulated' },
          { deviceId: 'UAV-02', kind: 'uav', integration: 'verified' },
        ],
      }),
    );
    const w = await welcome;
    expect(w.accepted).toEqual([]);
    expect(w.rejected.map((r: any) => r.deviceId).sort()).toEqual(['UAV-02', 'UGV-99']);
    ws.close();
  });
});

describe('developer sandbox', () => {
  it('accepts a home-built adapter that the demo organisation would refuse', async () => {
    const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: 'Bearer gw_sandbox_demo_key' } });
    await new Promise((r) => ws.on('open', r));
    const welcome = new Promise<any>((r) => ws.on('message', (m) => r(JSON.parse(String(m)))));
    ws.send(
      JSON.stringify({
        t: 'hello',
        protocol: GATEWAY_PROTOCOL,
        gatewayId: 'diy',
        adapters: [{ deviceId: 'SBX-ROVER-01', kind: 'ugv', model: 'DIY', integration: 'testing', capabilities: ['ground_patrol'], commands: ['start', 'stop'], rateMs: 1000, limitations: '', linkLossBehavior: 'stop' }],
      }),
    );
    expect((await welcome).accepted).toEqual(['SBX-ROVER-01']);
    ws.close();
    const devop = await Client.login(srv.url, 'devop');
    expect((await devop.get('/devices/SBX-ROVER-01')).body.commands).toEqual(['start', 'stop']);
    expect((await devop.get('/devices/UGV-01')).status).toBe(404);
  });
});

describe('audit and backup', () => {
  it('detects tampering with the audit log', async () => {
    const copyDir = mkdtempSync(join(tmpdir(), 'ps-audit-'));
    const file = join(copyDir, 'copy.sqlite');
    srv.db.prepare('VACUUM INTO ?').run(file);
    const copy = openDb(file);
    expect(verifyAudit(copy, 'org-demo').ok).toBe(true);
    copy.prepare("UPDATE audit SET detail = 'edited' WHERE org_id = 'org-demo' AND seq = 2").run();
    const v = verifyAudit(copy, 'org-demo');
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(2);
    copy.close();
  });

  it('backs up, verifies and restores incidents and evidence', async () => {
    const ploy = await Client.login(srv.url, 'ploy');
    const b = await ploy.post('/admin/backups');
    expect(b.status).toBe(200);
    const id = b.body.id as string;
    expect((await ploy.post(`/admin/backups/${id}/verify`)).body.ok).toBe(true);

    const target = mkdtempSync(join(tmpdir(), 'ps-restore-'));
    restoreBackup(srv.cfg.dataDir, id, target);
    const restored = openDb(join(target, 'platform.sqlite'));
    const n = (t: string) => (restored.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    expect(n('incidents')).toBe(b.body.counts.incidents);
    expect(n('evidence')).toBe(b.body.counts.evidence);
    expect(verifyAudit(restored, 'org-demo').ok).toBe(true);
    const ev = restored.prepare("SELECT path FROM evidence WHERE id = 'EV-0101'").get() as { path: string };
    expect(existsSync(join(target, ev.path))).toBe(true);
    restored.close();

    writeFileSync(join(srv.cfg.dataDir, 'backups', id, ev.path), 'tampered');
    expect(verifyBackup(srv.cfg.dataDir, id).ok).toBe(false);
  });
});
