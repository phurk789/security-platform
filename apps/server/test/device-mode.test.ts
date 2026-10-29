// L1 safety gate on the server: per-device operational mode (ADR-006) and gateway declarations that
// are no longer trusted (capability matrix §8, ADR-005): integration status and stream URLs.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL, cameraActionMoves, modeAllowsMotion, modeOf, type CameraAction } from '@13store/shared';
import { blockedHost, checkDeclaredUrl, checkedLookup, edgeGet, parseEdgeOrigin, vetStream } from '../src/edgeOrigins';
import { Platform } from '../src/platform';
import { Client, consoleSocket, startServer, waitFor, type TestServer } from './helpers';

// ---------------------------------------------------------------------------
// Rules (no server)
// ---------------------------------------------------------------------------

describe('mode rules', () => {
  it('reads simulated adapters as SIMULATION and every other unknown or missing value as SHADOW', () => {
    expect(modeOf({ integration: 'simulated', mode: 'LIVE_MANUAL' })).toBe('SIMULATION');
    expect(modeOf({ integration: 'testing' })).toBe('SHADOW');
    expect(modeOf({ integration: 'verified', mode: 'SIMULATION' })).toBe('SHADOW');
    expect(modeOf({ integration: 'verified', mode: 'ROOT' as never })).toBe('SHADOW');
    expect(modeOf({ integration: 'testing', mode: 'LIVE_MANUAL' })).toBe('LIVE_MANUAL');
  });

  it('lets a person move a real device only in LIVE modes, and automation only in LIVE_ASSISTED', () => {
    expect(modeAllowsMotion('SHADOW', 'person')).toBe(false);
    expect(modeAllowsMotion('LIVE_MANUAL', 'person')).toBe(true);
    expect(modeAllowsMotion('LIVE_ASSISTED', 'person')).toBe(true);
    expect(modeAllowsMotion('SHADOW', 'automation')).toBe(false);
    expect(modeAllowsMotion('LIVE_MANUAL', 'automation')).toBe(false);
    expect(modeAllowsMotion('LIVE_ASSISTED', 'automation')).toBe(true);
    // A simulator moves nothing physical.
    expect(modeAllowsMotion('SIMULATION', 'automation')).toBe(true);
  });

  it('treats stops, lights off, photo and record as safe camera requests', () => {
    const moves = (a: CameraAction) => cameraActionMoves(a);
    expect(moves({ action: 'gimbal_speed', yaw: 0, pitch: 0 })).toBe(false);
    expect(moves({ action: 'gimbal_speed', yaw: 40, pitch: 0 })).toBe(true);
    expect(moves({ action: 'zoom', dir: 0 })).toBe(false);
    expect(moves({ action: 'zoom', dir: 1 })).toBe(true);
    expect(moves({ action: 'gimbal_angle', yaw: 10, pitch: -5 })).toBe(true);
    expect(moves({ action: 'center' })).toBe(true);
    expect(moves({ action: 'zoom_to', level: 4 })).toBe(true);
    expect(moves({ action: 'spotlight', on: false })).toBe(false);
    expect(moves({ action: 'spotlight', on: true })).toBe(true);
    expect(moves({ action: 'announce', message: 'x' })).toBe(true);
    expect(moves({ action: 'photo' })).toBe(false);
    expect(moves({ action: 'record' })).toBe(false);
  });
});

describe('edge origin guard', () => {
  const allowed = ['https://edge.site.example:8889', 'http://192.168.10.5:9996'];

  it('never allows loopback, link-local, metadata or non-unicast hosts', () => {
    for (const h of ['127.0.0.1', '127.9.9.9', 'localhost', 'cam.localhost', '[::1]', '::ffff:7f00:1', '0.0.0.0', '::', '224.0.0.1', '255.255.255.255'])
      expect(blockedHost(h), h).toBeTruthy();
    expect(blockedHost('169.254.169.254')).toBe('cloud metadata');
    expect(blockedHost('100.100.100.200')).toBe('cloud metadata');
    expect(blockedHost('fd00:ec2::254')).toBe('cloud metadata');
    expect(blockedHost('metadata.google.internal')).toBe('cloud metadata');
    expect(blockedHost('169.254.10.1')).toBe('link-local');
    expect(blockedHost('[fe80::1]')).toBe('link-local');
    expect(blockedHost('64:ff9b::a9fe:a9fe')).toBe('cloud metadata');
    // Edge PCs live on private site networks: allowed, but only once on the list.
    for (const h of ['192.168.144.10', '10.0.0.5', '172.16.4.2', 'edge.site.example']) expect(blockedHost(h), h).toBeUndefined();
  });

  it('checks declared URLs against the list after URL normalisation', () => {
    expect(checkDeclaredUrl('https://edge.site.example:8889/cam-1/whep', allowed)).toEqual({ url: 'https://edge.site.example:8889/cam-1/whep' });
    expect(checkDeclaredUrl('http://192.168.10.5:9996', allowed)).toEqual({ url: 'http://192.168.10.5:9996/' });
    // Other ports, hosts and schemes of an allowed host are different origins.
    expect(checkDeclaredUrl('https://edge.site.example:8890/cam-1/whep', allowed)).toHaveProperty('error');
    expect(checkDeclaredUrl('http://edge.site.example:8889/cam-1/whep', allowed)).toHaveProperty('error');
    expect(checkDeclaredUrl('https://evil.example/cam-1/whep', allowed)).toHaveProperty('error');
    // Encoded loopback and metadata addresses are caught after normalisation, even if listed.
    for (const u of ['http://2130706433:9996/', 'http://0x7f.1:9996/', 'http://127.1:9996/', 'http://[::ffff:127.0.0.1]:9996/', 'http://169.254.169.254/latest/meta-data/'])
      expect(checkDeclaredUrl(u, [...allowed, new URL(u).origin]), u).toHaveProperty('error');
    expect(checkDeclaredUrl('https://u:p@edge.site.example:8889/x', allowed)).toEqual({ error: 'credentials in the URL' });
    expect(checkDeclaredUrl('file:///etc/passwd', allowed)).toHaveProperty('error');
    expect(checkDeclaredUrl(42, allowed)).toHaveProperty('error');
  });

  it('accepts only clean origins on the administrator list', () => {
    expect(parseEdgeOrigin('https://edge.site.example:443/')).toEqual({ origin: 'https://edge.site.example' });
    expect(parseEdgeOrigin('https://edge.site.example:8889')).toEqual({ origin: 'https://edge.site.example:8889' });
    expect(parseEdgeOrigin('https://edge.site.example:8889/cam/whep')).toHaveProperty('error');
    expect(parseEdgeOrigin('http://127.0.0.1:9996')).toHaveProperty('error');
    expect(parseEdgeOrigin('http://169.254.169.254')).toHaveProperty('error');
    expect(parseEdgeOrigin('ftp://edge.site.example')).toHaveProperty('error');
    expect(parseEdgeOrigin('https://admin:pw@edge.site.example')).toHaveProperty('error');
  });

  it('keeps allowed stream URLs, drops the rest and strips credentials from RTSP sources', () => {
    const r = vetStream(
      {
        whep: 'https://edge.site.example:8889/cam/whep',
        hls: 'http://127.0.0.1:8888/cam/index.m3u8',
        playback: 'http://169.254.169.254',
        rtsp: 'rtsp://admin:secret@192.168.144.25:8554/main.264',
      },
      allowed,
    );
    expect(r.stream).toEqual({ whep: 'https://edge.site.example:8889/cam/whep', rtsp: 'rtsp://192.168.144.25:8554/main.264' });
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected.join(' ')).toMatch(/hls: 127\.0\.0\.1:8888 is a loopback address/);
  });

  it('refuses to fetch a blocked address and refuses names that resolve to one', async () => {
    await expect(edgeGet('http://169.254.169.254/latest/meta-data/', { timeoutMs: 1000, maxBytes: 100 })).rejects.toThrow(/metadata/);
    await expect(edgeGet('http://localhost:9/', { timeoutMs: 1000, maxBytes: 100 })).rejects.toThrow(/loopback/);
    // The address check runs at connect time (DNS pinning), not just on the name.
    const err = await new Promise<NodeJS.ErrnoException | null>((r) => checkedLookup('localhost', {}, (e) => r(e)));
    expect(err?.code).toBe('EBLOCKED');
  });
});

// ---------------------------------------------------------------------------
// Pilot server: a real device, a gateway, people with each role
// ---------------------------------------------------------------------------

let srv: TestServer;
let admin: Client;
let sup: Client;
let op: Client;
let disp: Client;
let gwKey = '';
const DEV = 'UGV-L1';
const ROUTE = [{ x: 232, y: 218 }];
const put = (c: Client, path: string, body: unknown) => c.req('PUT', path, body);

const declaration = (extra: Record<string, unknown> = {}) => ({
  deviceId: DEV,
  kind: 'ugv',
  model: 'SIYI UniFC 6 Pico rover',
  adapterVersion: 'mavlink 0.1',
  protocolVersion: 'MAVLink 2',
  firmwareTested: 'ArduRover 4.5',
  // A gateway claiming more than it may: the server keeps what the administrator set.
  integration: 'verified',
  mode: 'LIVE_MANUAL',
  capabilities: ['ground_patrol', 'camera', 'video', 'gimbal', 'zoom', 'photo', 'record', 'spotlight'],
  commands: ['start', 'pause', 'resume', 'stop'],
  units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
  rateMs: 200,
  limitations: '',
  linkLossBehavior: 'hold, then RTL',
  ...extra,
});

interface FakeGateway {
  ws: WebSocket;
  welcome: { accepted: string[]; rejected: { deviceId: string; reason: string }[] };
  close(): Promise<void>;
}

/** An edge gateway: says hello, streams telemetry and confirms every command and camera request. */
async function connectGateway(gatewayId: string, decl = declaration()): Promise<FakeGateway> {
  const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${gwKey}` } });
  await new Promise((r) => ws.on('open', r));
  const welcome = new Promise<any>((r) => ws.once('message', (m) => r(JSON.parse(String(m)))));
  ws.send(JSON.stringify({ t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId, adapters: [decl] }));
  const w = await welcome;
  let seq = 0;
  const tel = () =>
    ws.readyState === ws.OPEN &&
    ws.send(JSON.stringify({ t: 'telemetry', deviceId: DEV, seq: ++seq, sourceTime: Date.now(), pos: { x: 214, y: 218 }, accuracyM: 1, speed: 0, battery: 90, quality: 'good' }));
  tel();
  const timer = setInterval(tel, 200);
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'command') setTimeout(() => ws.send(JSON.stringify({ t: 'cmd', commandId: m.commandId, status: 'succeeded', at: Date.now() })), 20);
    if (m.t === 'camera') ws.send(JSON.stringify({ t: 'camera_result', requestId: m.requestId, deviceId: m.deviceId, ok: true, confirmed: true, detail: `did ${m.action}` }));
  });
  return {
    ws,
    welcome: w,
    async close() {
      clearInterval(timer);
      if (ws.readyState === ws.CLOSED) return;
      const closed = new Promise((r) => ws.once('close', r));
      ws.close();
      await closed;
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

const device = async () => (await op.get(`/devices/${DEV}`)).body;
const audit = async () => (await sup.get('/audit?limit=500')).body as { action: string; object: string; result: string; detail?: string; actor: string; role: string }[];
const live = () => waitFor(async () => Date.now() - (await device()).lastSeen < 1000);

let gw: FakeGateway;
let missionId = '';

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
  srv = await startServer({ env: 'pilot', gateway: false });
  delete process.env.ADMIN_PASSWORD;
  admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  for (const [name, role] of [
    ['sup', 'supervisor'],
    ['op', 'operator'],
    ['disp', 'dispatcher'],
  ])
    expect((await admin.post('/admin/users', { username: `l1-${name}`, name, role, password: 'longpassword1' })).status).toBe(200);
  [sup, op, disp] = await Promise.all(['sup', 'op', 'disp'].map((u) => Client.login(srv.url, `l1-${u}`, 'longpassword1')));
  gwKey = (await admin.post('/admin/keys', { label: 'Edge L1', kind: 'gateway' })).body.secret;
  expect((await admin.post('/devices', { id: DEV, kind: 'ugv', model: 'SIYI rover' })).status).toBe(200);
}, 30_000);
afterAll(async () => {
  await gw?.close();
  await srv?.close();
});

describe('per-device operational mode', () => {
  it('a registered real device starts in SHADOW; the gateway cannot raise its mode or integration status', async () => {
    const registered = (await op.get(`/devices/${DEV}`)).body;
    expect(registered).toMatchObject({ mode: 'SHADOW', integration: 'testing' });
    gw = await connectGateway('edge-l1');
    expect(gw.welcome.accepted).toEqual([DEV]);
    await live();
    expect(await device()).toMatchObject({ mode: 'SHADOW', integration: 'testing', model: 'SIYI UniFC 6 Pico rover' });
    const connect = (await audit()).find((e) => e.action === 'gateway.connect' && e.object === 'edge-l1');
    expect(connect?.detail).toMatch(/ignored UGV-L1 declared verified, kept testing/);
  });

  it('refuses start in SHADOW and records the refusal', async () => {
    const inc = (await disp.post('/incidents', { title: 'L1 rehearsal', place: 'Plaza' })).body;
    await disp.post(`/incidents/${inc.id}/triage`);
    expect((await disp.post(`/incidents/${inc.id}/confirm`)).status).toBe(200);
    const users = (await disp.get('/users')).body as { id: string; role: string }[];
    const m = await disp.post('/missions', { incidentId: inc.id, deviceId: DEV, operatorId: users.find((u) => u.role === 'operator')!.id, checkpoints: ROUTE });
    expect(m.status).toBe(200);
    missionId = m.body.id;
    expect((await disp.post(`/missions/${missionId}/submit`)).status).toBe(200);
    expect((await sup.post(`/missions/${missionId}/approve`)).status).toBe(200);
    expect((await op.post(`/missions/${missionId}/accept`)).status).toBe(200);

    const r = await op.post('/commands', { missionId, type: 'start', idempotencyKey: 'l1-start-shadow' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('mode_not_live');
    expect(r.body.error).toMatch(/SHADOW mode.*promote it to LIVE_MANUAL/);
    const cmds = (await op.get(`/commands?missionId=${missionId}`)).body as { type: string; status: string }[];
    expect(cmds).toEqual([expect.objectContaining({ type: 'start', status: 'rejected' })]);
    expect((await audit()).some((e) => e.action === 'device.command' && e.result === 'error' && /SHADOW mode/.test(e.detail ?? ''))).toBe(true);
  });

  it('promotion needs the supervisor permission, a recent password check and a reason', async () => {
    const path = `/devices/${DEV}/mode-transitions`;
    const body = { to: 'LIVE_MANUAL', reason: 'E-stop and link-loss failsafe tested; pilot holds the UniRC; cordon set' };
    expect((await op.post(path, body)).status).toBe(403);
    // Administrators have every supervisor permission: past the permission check, the missing reason is refused.
    expect((await admin.post(path, { to: 'LIVE_MANUAL' })).status).toBe(400);
    expect((await sup.post(path, { to: 'LIVE_MANUAL' })).status).toBe(400);
    expect((await sup.post(path, { to: 'TURBO', reason: 'x' })).status).toBe(400);

    srv.db.prepare('UPDATE sessions SET step_up_until = 0').run();
    const noStepUp = await sup.post(path, body);
    expect(noStepUp.status).toBe(401);
    expect(noStepUp.body.code).toBe('step_up_required');
    expect((await device()).mode).toBe('SHADOW');
    expect((await sup.post('/auth/step-up', { password: 'longpassword1' })).status).toBe(200);

    const con = await consoleSocket(srv.wsUrl, sup.token);
    const changes: { from: string; to: string; by: string }[] = [];
    srv.built.platform.bus.on('device.mode_changed', (c) => changes.push(c));
    const ok = await sup.post(path, body);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ from: 'SHADOW', to: 'LIVE_MANUAL', device: { id: DEV, mode: 'LIVE_MANUAL' } });
    expect(changes).toEqual([expect.objectContaining({ deviceId: DEV, from: 'SHADOW', to: 'LIVE_MANUAL', by: 'sup' })]);
    await waitFor(() => con.events.some((e) => e.type === 'device' && e.device.id === DEV && e.device.mode === 'LIVE_MANUAL'));
    await waitFor(() => con.events.some((e) => e.type === 'notice' && /UGV-L1 mode SHADOW → LIVE_MANUAL by sup/.test(e.text)));
    con.close();

    // Hash-chained audit: the denials and the change are all there, and the chain verifies.
    const log = await audit();
    const modeLog = log.filter((e) => e.action === 'device.mode_change' || e.action === 'device.mode.promote').map((e) => `${e.result} ${e.actor}`);
    expect(modeLog).toEqual(expect.arrayContaining(['ok sup', 'denied sup', 'denied op']));
    expect(log.find((e) => e.action === 'device.mode_change' && e.result === 'ok')?.detail).toBe(`SHADOW → LIVE_MANUAL: ${body.reason}`);
    expect(log.find((e) => e.action === 'device.mode_change' && e.result === 'denied' && e.actor === 'sup')?.detail).toMatch(/step-up required/);
    expect((await sup.get('/audit/verify')).body.ok).toBe(true);

    // LIVE_ASSISTED needs an automation policy that does not exist yet.
    const assisted = await sup.post(path, { to: 'LIVE_ASSISTED', reason: 'try' });
    expect(assisted.status).toBe(409);
    expect(assisted.body.code).toBe('not_enabled');
  });

  it('in LIVE_MANUAL the start goes through; after demotion pause and stop still work but resume does not', async () => {
    const start = await op.post('/commands', { missionId, type: 'start', idempotencyKey: 'l1-start-live' });
    expect(start.status).toBe(200);
    await waitFor(async () => (await op.get(`/missions/${missionId}`)).body.status === 'executing');

    const demote = await admin.post(`/devices/${DEV}/mode-transitions`, { to: 'SHADOW', reason: 'Spectator inside the cordon' });
    expect(demote.status).toBe(200);
    expect((await device()).mode).toBe('SHADOW');

    expect((await op.post('/commands', { missionId, type: 'pause', idempotencyKey: 'l1-pause' })).status).toBe(200);
    await waitFor(async () => (await op.get(`/missions/${missionId}`)).body.status === 'paused');
    const resume = await op.post('/commands', { missionId, type: 'resume', idempotencyKey: 'l1-resume' });
    expect(resume.status).toBe(409);
    expect(resume.body.code).toBe('mode_not_live');
    expect((await op.post('/commands', { missionId, type: 'stop', idempotencyKey: 'l1-stop' })).status).toBe(200);
    await waitFor(async () => (await op.get(`/missions/${missionId}`)).body.status === 'cancelled');
    const log = await audit();
    expect(log.some((e) => e.action === 'device.mode_change' && e.result === 'ok' && e.detail === 'LIVE_MANUAL → SHADOW: Spectator inside the cordon')).toBe(true);
  });

  it('camera moves need LIVE_MANUAL; stops, lights off, photo and record work in SHADOW', async () => {
    const cam = (b: object) => op.post(`/devices/${DEV}/camera`, b);
    const refused = await cam({ action: 'gimbal_angle', yaw: 30, pitch: -10 });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('mode_not_live');
    expect((await cam({ action: 'gimbal_speed', yaw: 50, pitch: 0 })).status).toBe(409);
    expect((await cam({ action: 'spotlight', on: true })).status).toBe(409);
    expect((await op.post(`/devices/${DEV}/aim`, { x: 240, y: 200 })).status).toBe(409);
    for (const safe of [{ action: 'gimbal_speed', yaw: 0, pitch: 0 }, { action: 'zoom', dir: 0 }, { action: 'spotlight', on: false }, { action: 'photo' }, { action: 'record' }]) {
      const r = await cam(safe);
      expect(r.status, JSON.stringify(safe)).toBe(200);
      expect(r.body.ok).toBe(true);
    }
    expect((await audit()).some((e) => e.action === 'camera.control' && e.result === 'denied' && /mode SHADOW/.test(e.detail ?? ''))).toBe(true);
  });

  it('never promotes on reconnect, re-hello or restart; a different gateway demotes', async () => {
    // SHADOW, and the same gateway reconnects claiming LIVE_MANUAL and verified: still SHADOW.
    await gw.close();
    gw = await connectGateway('edge-l1');
    await live();
    expect(await device()).toMatchObject({ mode: 'SHADOW', integration: 'testing' });

    // LIVE_MANUAL survives the same gateway reconnecting (same mode, never higher).
    expect((await sup.post(`/devices/${DEV}/mode-transitions`, { to: 'LIVE_MANUAL', reason: 'Second rehearsal' })).status).toBe(200);
    await gw.close();
    gw = await connectGateway('edge-l1');
    await live();
    expect((await device()).mode).toBe('LIVE_MANUAL');

    // Server restart: the stored mode is read back as it was, and an unknown stored value reads as SHADOW.
    expect(new Platform(srv.db, srv.cfg).getDevice(srv.built.platform.systemActor('org-demo'), DEV).mode).toBe('LIVE_MANUAL');
    srv.db.prepare("UPDATE devices SET data = json_set(data, '$.mode', 'ROOT') WHERE id = ?").run(DEV);
    expect(new Platform(srv.db, srv.cfg).getDevice(srv.built.platform.systemActor('org-demo'), DEV).mode).toBe('SHADOW');

    // Another gateway takes the device: a new control path, so the system demotes it.
    await gw.close();
    gw = await connectGateway('edge-l1-spare');
    await live();
    expect((await device()).mode).toBe('SHADOW');
    const demotion = (await audit()).find((e) => e.action === 'device.mode_change' && e.role === 'system');
    expect(demotion).toMatchObject({ result: 'ok', actor: 'Safety demotion', detail: 'LIVE_MANUAL → SHADOW: control path changed: gateway edge-l1 → edge-l1-spare' });
  });

  it('integration status is set by an administrator only, never across the simulated boundary', async () => {
    const path = `/devices/${DEV}/integration`;
    expect((await sup.patch(path, { integration: 'verified', reason: 'HIL' })).status).toBe(403);
    expect((await admin.patch(path, { integration: 'verified' })).status).toBe(400);
    const ok = await admin.patch(path, { integration: 'verified', reason: 'Bench test HARDWARE_SIYI 13/13' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ integration: 'verified', mode: 'SHADOW' });
    const sim = await admin.patch(path, { integration: 'simulated', reason: 'x' });
    expect(sim.status).toBe(409);
    expect(sim.body.code).toBe('mode_locked');
    expect((await audit()).some((e) => e.action === 'device.integration' && e.result === 'ok' && /testing → verified/.test(e.detail ?? ''))).toBe(true);
  });
});

describe('gateway-declared stream URLs', () => {
  const ORIGIN = 'https://edge.site.example:8889';
  const PLAYBACK = 'https://edge.site.example:9996';

  it('the administrator list refuses blocked hosts and needs a password check', async () => {
    const origins = (o: string[]) => put(admin, '/admin/edge-origins', { siteId: 'site-civic', origins: o });
    srv.db.prepare('UPDATE sessions SET step_up_until = 0').run();
    expect((await origins([ORIGIN])).body.code).toBe('step_up_required');
    expect((await admin.post('/auth/step-up', { password: 'pilot-admin-pass' })).status).toBe(200);
    expect((await origins(['http://127.0.0.1:9996'])).status).toBe(400);
    expect((await origins(['http://169.254.169.254'])).status).toBe(400);
    expect((await origins([`${ORIGIN}/cam/whep`])).status).toBe(400);
    expect((await put(sup, '/admin/edge-origins', { siteId: 'site-civic', origins: [ORIGIN] })).status).toBe(403);
    const ok = await origins([ORIGIN]);
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ siteId: 'site-civic', origins: [ORIGIN] });
    srv.db.prepare('UPDATE sessions SET step_up_until = 0').run();
    expect((await admin.get('/admin/edge-origins')).body).toEqual([expect.objectContaining({ siteId: 'site-civic', origin: ORIGIN })]);
    expect((await sup.get('/admin/edge-origins')).status).toBe(403);
    expect((await admin.post('/auth/step-up', { password: 'pilot-admin-pass' })).status).toBe(200);
  });

  it('stores and hands out only URLs on an allowed edge origin', async () => {
    let fetched = 0;
    srv.built.platform.edgeGet = async () => {
      fetched++;
      return { status: 200, body: Buffer.from('[]') };
    };
    await gw.close();
    gw = await connectGateway(
      'edge-l1-spare',
      declaration({
        stream: {
          whep: `${ORIGIN}/cam-l1/whep`,
          whepSub: 'http://169.254.169.254/latest/meta-data/',
          hls: 'http://127.0.0.1:8888/cam-l1/index.m3u8',
          playback: 'http://[::ffff:127.0.0.1]:9996',
          rtsp: 'rtsp://admin:secret@192.168.144.25:8554/main.264',
        },
        components: [{ id: 'cam', name: 'SIYI ZT30', kind: 'camera', status: 'ok', stream: { whep: 'https://evil.example/x/whep' } }],
      }),
    );
    await live();
    const d = await device();
    expect(d.stream).toEqual({ whep: `${ORIGIN}/cam-l1/whep`, rtsp: 'rtsp://192.168.144.25:8554/main.264' });
    expect(d.components[0].stream).toBeUndefined();
    const refused = (await audit()).find((e) => e.action === 'gateway.stream_rejected' && e.object === DEV);
    expect(refused?.result).toBe('denied');
    expect(refused?.detail).toMatch(/whepSub: 169\.254\.169\.254 is a cloud metadata address/);
    expect(refused?.detail).toMatch(/hls: 127\.0\.0\.1:8888 is a loopback address/);
    expect(refused?.detail).toMatch(/playback: .* is a loopback address/);
    expect(refused?.detail).toMatch(/cam\.whep: https:\/\/evil\.example is not an allowed edge origin/);

    const s = (await op.post(`/media/${DEV}/session`)).body;
    expect(s.whep).toMatch(new RegExp(`^${ORIGIN}/cam-l1/whep\\?token=`));
    expect(s.whepSub).toBeUndefined();
    expect(s.hls).toBeUndefined();
    // No playback origin passed, so recordings never reach the server-side fetch.
    const now = Date.now();
    expect((await op.get(`/media/${DEV}/recordings?from=${now - 60_000}&to=${now}`)).body.label).toBe('SIMULATED');
    expect(fetched).toBe(0);
  });

  it('fetches only allowed playback origins, and shrinking the list removes stored URLs at once', async () => {
    const urls: string[] = [];
    srv.built.platform.edgeGet = async (u) => {
      urls.push(u);
      return { status: 200, body: Buffer.from(JSON.stringify([{ start: new Date(Date.now() - 30_000).toISOString(), duration: 10 }])) };
    };
    expect((await put(admin, '/admin/edge-origins', { siteId: 'site-civic', origins: [ORIGIN, PLAYBACK] })).status).toBe(200);
    await gw.close();
    gw = await connectGateway('edge-l1-spare', declaration({ stream: { whep: `${ORIGIN}/cam-l1/whep`, playback: PLAYBACK } }));
    await live();
    expect((await device()).stream).toEqual({ whep: `${ORIGIN}/cam-l1/whep`, playback: `${PLAYBACK}/` });
    const now = Date.now();
    const rec = await op.get(`/media/${DEV}/recordings?from=${now - 60_000}&to=${now}`);
    expect(rec.body).toMatchObject({ label: 'RECORDED', playback: true });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(new RegExp(`^${PLAYBACK}/list\\?path=cam-l1&`));

    expect((await put(admin, '/admin/edge-origins', { siteId: 'site-civic', origins: [ORIGIN] })).status).toBe(200);
    expect((await device()).stream).toEqual({ whep: `${ORIGIN}/cam-l1/whep` });
    expect((await op.get(`/media/${DEV}/recordings?from=${now - 60_000}&to=${now}`)).body.label).toBe('SIMULATED');
    expect(urls).toHaveLength(1);
    expect((await audit()).some((e) => e.action === 'admin.edge_origins' && e.result === 'ok' && /site site-civic: \[https:\/\/edge\.site\.example:8889\]/.test(e.detail ?? ''))).toBe(true);
  });
});
