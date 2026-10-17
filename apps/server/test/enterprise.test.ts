// Enterprise foundation: license limits, single sign-on, retention and privacy requests,
// readiness and metrics, scheduled backups.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listBackups, pruneBackups } from '../src/backup';
import { GRACE_DAYS, License, generateKeys, signLicense, verifyLicense, type LicenseBody } from '../src/license';
import { startFakeOidc, type FakeOidc } from './fakeOidc';
import { Client, startServer, waitFor, type TestServer } from './helpers';

const DAY = 86_400_000;

describe('license file', () => {
  const keys = generateKeys();
  const body: LicenseBody = {
    v: 1,
    org: 'org-x',
    customer: 'Port Authority',
    issuedAt: 1000,
    expiresAt: Date.now() + 200 * DAY,
    limits: { sites: 2, devices: 5, users: 10 },
    features: ['analytics'],
  };

  it('signs and verifies, and detects tampering', () => {
    const file = signLicense(body, keys.privateKey);
    expect(verifyLicense(file, keys.publicKey)).toMatchObject({ ok: true });
    expect(verifyLicense({ ...file, limits: { ...file.limits, devices: 500 } }, keys.publicKey)).toMatchObject({ ok: false });
    expect(verifyLicense(file, generateKeys().publicKey)).toMatchObject({ ok: false });
  });

  it('runs as an evaluation without a file, and enforces limits, expiry and grace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lic-'));
    const evalLic = new License({ env: 'pilot' });
    expect(evalLic.state(Date.now())).toBe('evaluation');
    expect(evalLic.check('devices', 10, Date.now())).toMatch(/limit reached/);
    const file = join(dir, 'license.json');
    writeFileSync(file, JSON.stringify(signLicense(body, keys.privateKey)));
    const lic = new License({ env: 'pilot', file, publicKeyPem: keys.publicKey });
    expect(lic.licensed).toBe(true);
    expect(lic.state(Date.now())).toBe('valid');
    expect(lic.check('devices', 4, Date.now())).toBeNull();
    expect(lic.check('devices', 5, Date.now())).toMatch(/limit reached: 5 devices/);
    expect(lic.hasFeature('analytics')).toBe(true);
    expect(lic.hasFeature('patrols')).toBe(false);
    const soon = new License({ env: 'pilot', file, publicKeyPem: keys.publicKey });
    expect(soon.state(body.expiresAt - 10 * DAY)).toBe('expiring');
    expect(soon.state(body.expiresAt + 2 * DAY)).toBe('grace');
    expect(soon.state(body.expiresAt + (GRACE_DAYS + 1) * DAY)).toBe('expired');
    expect(soon.check('users', 0, body.expiresAt + (GRACE_DAYS + 1) * DAY)).toMatch(/expired/);
    const bad = new License({ env: 'pilot', file, publicKeyPem: generateKeys().publicKey });
    expect(bad.licensed).toBe(false);
    expect(bad.problem).toMatch(/signature/);
    expect(new License({ env: 'demo' }).check('devices', 9_000, Date.now())).toBeNull();
  });
});

describe('pilot server under a license', () => {
  let srv: TestServer;
  let admin: Client;
  const keys = generateKeys();
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lic-'));
    const file = join(dir, 'license.json');
    writeFileSync(
      file,
      JSON.stringify(
        signLicense(
          { v: 1, org: '*', customer: 'Pilot Co', issuedAt: Date.now(), expiresAt: Date.now() + 90 * DAY, limits: { sites: 1, devices: 1, users: 3 }, features: [] },
          keys.privateKey,
        ),
      ),
    );
    process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
    srv = await startServer({ env: 'pilot', gateway: false, cfg: { licenseFile: file, licensePublicKey: keys.publicKey, metricsToken: 'scrape-me' } });
    admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  }, 30_000);
  afterAll(() => srv?.close());

  it('reports the license and stops registrations past the limits with a clear error', async () => {
    const st = (await admin.get('/license')).body;
    expect(st).toMatchObject({ state: 'valid', customer: 'Pilot Co', limits: { devices: 1 }, usage: { users: 1, sites: 1 } });
    expect((await admin.post('/devices', { id: 'CAM-01', kind: 'cctv', model: 'ONVIF dome' })).status).toBe(200);
    const r = await admin.post('/devices', { id: 'CAM-02', kind: 'cctv', model: 'ONVIF dome' });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('license');
    expect(r.body.error).toMatch(/License limit reached: 1 devices/);
    expect((await admin.post('/admin/users', { username: 'ops1', name: 'Ops One', role: 'dispatcher', password: 'longpassword1' })).status).toBe(200);
    expect((await admin.post('/admin/users', { username: 'ops2', name: 'Ops Two', role: 'dispatcher', password: 'longpassword1' })).status).toBe(200);
    expect((await admin.post('/admin/users', { username: 'ops3', name: 'Ops Three', role: 'dispatcher', password: 'longpassword1' })).status).toBe(402);
    const audit = (await admin.get('/audit')).body as { action: string; result: string; detail?: string }[];
    expect(audit.some((e) => e.action === 'admin.user_create' && e.result === 'denied' && /limit/.test(e.detail ?? ''))).toBe(true);
  });

  it('serves readiness and Prometheus metrics (token or administrator only)', async () => {
    const ready = await fetch(`${srv.url}/api/v1/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ ok: true, db: true, license: 'valid' });
    expect((await fetch(`${srv.url}/api/v1/metrics`)).status).toBe(403);
    const m = await fetch(`${srv.url}/api/v1/metrics`, { headers: { authorization: 'Bearer scrape-me' } });
    expect(m.status).toBe(200);
    const text = await m.text();
    expect(text).toMatch(/ps_http_requests_total\{route="\/api\/v1\/license",method="GET",status="200"\} \d+/);
    expect(text).toMatch(/ps_devices\{freshness="offline"\} 1/);
    expect(text).toMatch(/ps_http_request_duration_seconds_count \d+/);
    expect(text).toMatch(/ps_license_days_left \d+/);
    const asAdmin = await admin.get('/metrics');
    expect(asAdmin.status).toBe(200);
  });

  it('takes scheduled backups and prunes old ones', () => {
    const p = srv.built.platform;
    expect(p.runScheduledBackup()).not.toBeNull();
    p.now = () => Date.now() + 1000;
    expect(p.runScheduledBackup()).not.toBeNull();
    expect(listBackups(srv.cfg.dataDir).length).toBe(2);
    expect(pruneBackups(srv.cfg.dataDir, 1)).toHaveLength(1);
    expect(listBackups(srv.cfg.dataDir).length).toBe(1);
  });
});

describe('single sign-on (OpenID Connect)', () => {
  let srv: TestServer;
  let idp: FakeOidc;
  beforeAll(async () => {
    idp = await startFakeOidc();
    srv = await startServer({
      gateway: false,
      cfg: {
        oidc: {
          issuer: idp.issuer,
          clientId: 'ps-console',
          clientSecret: 'ps-secret',
          redirectUri: 'http://placeholder/',
          name: 'Corp SSO',
          roleClaim: 'groups',
          roleMap: { Supervisors: 'supervisor', SecurityOps: 'dispatcher' },
          orgId: 'org-demo',
          syncRole: true,
        },
      },
    });
    srv.cfg.oidc!.redirectUri = `${srv.url}/api/v1/auth/sso/callback`;
  }, 30_000);
  afterAll(async () => {
    await srv?.close();
    await idp.close();
  });

  const hop = async (url: string) => {
    const r = await fetch(url, { redirect: 'manual' });
    return r.headers.get('location') ?? '';
  };
  /** Walks start → provider → callback and returns the final redirect (with #sso=… or #sso_error=…). */
  const signIn = async () => {
    const toIdp = await hop(`${srv.url}/api/v1/auth/sso`);
    expect(toIdp).toContain(`${idp.issuer}/authorize?`);
    expect(toIdp).toContain('code_challenge_method=S256');
    const back = await hop(toIdp);
    expect(back).toContain('/api/v1/auth/sso/callback?code=');
    return hop(back);
  };

  it('is advertised in meta, provisions the user from the mapped group and opens a session', async () => {
    expect((await (await fetch(`${srv.url}/api/v1/meta`)).json()).sso).toEqual({ name: 'Corp SSO', startUrl: '/api/v1/auth/sso' });
    const final = await signIn();
    const token = decodeURIComponent(final.split('#sso=')[1] ?? '');
    expect(token.startsWith('ses_')).toBe(true);
    const me = await (await fetch(`${srv.url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(me.user).toMatchObject({ name: 'Alex SSO', role: 'dispatcher', username: 'alex.sso@example.com', orgId: 'org-demo' });
    // password login is not possible for an SSO-provisioned account
    const c = new Client(srv.url);
    expect((await c.post('/auth/login', { username: 'alex.sso@example.com', password: 'anything-at-all' })).status).toBe(401);
  });

  it('syncs the role when the group changes and refuses users without a mapped group', async () => {
    idp.claims = { ...idp.claims, groups: ['Supervisors'] };
    const final = await signIn();
    const token = decodeURIComponent(final.split('#sso=')[1] ?? '');
    const me = await (await fetch(`${srv.url}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } })).json();
    expect(me.user.role).toBe('supervisor');
    idp.claims = { ...idp.claims, groups: ['Visitors'] };
    const refused = await signIn();
    expect(refused).toContain('#sso_error=');
    expect(decodeURIComponent(refused)).toMatch(/not assigned a platform role/);
    idp.claims = { ...idp.claims, groups: ['SecurityOps'] };
  });

  it('rejects a replayed or unknown state and a disabled account', async () => {
    const toIdp = await hop(`${srv.url}/api/v1/auth/sso`);
    const back = await hop(toIdp);
    expect(await hop(back)).toContain('#sso=');
    expect(await hop(back)).toContain('#sso_error='); // same state twice
    expect(await hop(`${srv.url}/api/v1/auth/sso/callback?code=x&state=nope`)).toContain('#sso_error=');
    const ploy = await Client.login(srv.url, 'ploy');
    const users = (await ploy.get('/admin/users')).body as { id: string; username: string }[];
    const sso = users.find((u) => u.username === 'alex.sso@example.com')!;
    expect((await ploy.patch(`/admin/users/${sso.id}`, { active: false })).status).toBe(200);
    expect(decodeURIComponent(await signIn())).toMatch(/disabled/);
  });
});

describe('retention and privacy requests', () => {
  let srv: TestServer;
  let ploy: Client;
  let alex: Client;
  beforeAll(async () => {
    srv = await startServer({ gateway: false });
    ploy = await Client.login(srv.url, 'ploy');
    alex = await Client.login(srv.url, 'alex');
  }, 30_000);
  afterAll(() => srv?.close());

  it('stores retention settings per organisation and purges expired telemetry', async () => {
    expect((await ploy.get('/admin/settings')).body).toEqual({ retention: { telemetryDays: 90, closedIncidentDays: 0, evidenceDays: 0 } });
    expect((await ploy.patch('/admin/settings', { retention: { telemetryDays: 7000 } })).status).toBe(400);
    expect((await ploy.patch('/admin/settings', { retention: { telemetryDays: 1 } })).body.retention.telemetryDays).toBe(1);
    expect((await alex.get('/admin/settings')).status).toBe(403);
    const now = Date.now();
    const ins = srv.db.prepare('INSERT INTO telemetry (device_id, seq, source_time, received_time, x, y, accuracy, battery, speed, quality) VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 5; i++) ins.run('UGV-01', 900 + i, now - 3 * DAY, now - 3 * DAY + i, 10, 10, 1, 80, 0, 'good');
    ins.run('UGV-01', 999, now, now, 10, 10, 1, 80, 0, 'good');
    const r = (await ploy.post('/admin/retention/run')).body;
    expect(r.telemetry).toBe(5);
    expect((srv.db.prepare("SELECT COUNT(*) AS n FROM telemetry WHERE device_id = 'UGV-01'").get() as { n: number }).n).toBe(1);
    const audit = (await ploy.get('/audit')).body as { action: string }[];
    expect(audit.some((e) => e.action === 'retention.run')).toBe(true);
  });

  it("finds and erases a person's name across incident text, with the erasure audited", async () => {
    const inc = (await alex.post('/incidents', { title: 'Visitor Somsak Jaidee refused to leave', place: 'Service gate', zone: 'Zone B', source: 'Guard' })).body;
    await alex.post(`/incidents/${inc.id}/confirm`);
    await alex.post(`/incidents/${inc.id}/resolve`, { outcome: 'Somsak Jaidee escorted out by field team.' });
    const hits = (await ploy.get('/admin/privacy?q=Somsak%20Jaidee')).body as { table: string; id: string; field: string }[];
    expect(hits.map((h) => `${h.table}.${h.field}`).sort()).toEqual(expect.arrayContaining(['incidents.outcome', 'incidents.title', 'timeline.detail']));
    expect((await ploy.get('/admin/privacy?q=So')).status).toBe(400);
    const erase = await ploy.post('/admin/privacy/erase', { q: 'Somsak Jaidee', reason: 'DSAR-2026-014' });
    expect(erase.status).toBe(200);
    expect(erase.body.changed).toBeGreaterThanOrEqual(3);
    const after = (await alex.get(`/incidents/${inc.id}`)).body;
    expect(after.title).toBe('Visitor [erased] refused to leave');
    expect(after.outcome).toMatch(/^\[erased\] escorted/);
    expect((await ploy.get('/admin/privacy?q=Somsak%20Jaidee')).body).toEqual([]);
    const audit = (await ploy.get('/audit')).body as { action: string; detail?: string }[];
    expect(audit.find((e) => e.action === 'privacy.erase')?.detail).toMatch(/DSAR-2026-014/);
    await waitFor(async () => (await ploy.get('/audit/verify')).body.ok === true);
  });
});
