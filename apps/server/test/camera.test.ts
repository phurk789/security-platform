// Camera control (SIYI-style gimbal) and video access through the site media server.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILDINGS, GATEWAY_PROTOCOL, aimAt, lineOfSight } from '@13store/shared';
import { SANDBOX_GATEWAY_KEY } from '../src/seed';
import { Client, startServer, testActor, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client;
let priya: Client;
let devop: Client;

beforeAll(async () => {
  srv = await startServer();
  [alex, priya, devop] = await Promise.all([Client.login(srv.url, 'alex'), Client.login(srv.url, 'priya'), Client.login(srv.url, 'devop')]);
}, 30_000);
afterAll(() => srv?.close());

const sys = () => srv.built.platform.systemActor('org-demo');

describe('pointing cameras at places', () => {
  it('works out pan, tilt and zoom from the mount, and sees when a building is in the way', () => {
    const mount = { bearingDeg: 240, heightM: 6.5, fovDeg: 52 };
    const a = aimAt({ x: 376, y: 212 }, mount, { x: 335, y: 236 });
    expect(a.reachable).toBe(true);
    expect(Math.abs(a.yaw)).toBeLessThan(2); // INC-024 is straight ahead of CCTV-02
    expect(a.pitch).toBeLessThan(-5);
    expect(a.zoom).toBeGreaterThan(4);
    expect(aimAt({ x: 376, y: 212 }, mount, { x: 420, y: 150 }).reachable).toBe(false); // behind the camera
    expect(lineOfSight({ x: 376, y: 212 }, { x: 335, y: 236 }, BUILDINGS, 6.5)).toBe(true);
    expect(lineOfSight({ x: 376, y: 212 }, { x: 320, y: 110 }, BUILDINGS, 6.5)).toBe(false); // Building 4
  });

  it('turns the nearest camera that can see a new alert, and logs it on the incident', async () => {
    const inc = (await alex.post('/demo/inject-alert')).body;
    await waitFor(async () => ((await alex.get(`/incidents/${inc.id}/timeline`)).body as any[]).some((e) => /CCTV-02 turned to the alert automatically/.test(e.title)));
    const ev = ((await alex.get(`/incidents/${inc.id}/timeline`)).body as any[]).find((e) => /turned to the alert/.test(e.title));
    expect(ev.detail).toMatch(/Confirmed by the camera/);
    await waitFor(() => (srv.built.platform.getDevice(sys(), 'CCTV-02').gimbal?.zoom ?? 1) > 4);
  });

  it('points a camera at an incident on request, refuses places it cannot turn to', async () => {
    const r = await alex.post('/devices/CCTV-02/aim', { incidentId: 'INC-024' });
    expect(r.body).toMatchObject({ ok: true, confirmed: true, lineOfSight: true });
    expect(r.body.aim.distanceM).toBe(48);
    expect((await alex.post('/devices/CCTV-02/aim', { x: 420, y: 150 })).status).toBe(409);
    expect((await alex.post('/devices/CCTV-02/aim', { x: 'here' })).status).toBe(400);
    expect((await priya.post('/devices/CCTV-02/aim', { incidentId: 'INC-024' })).status).toBe(403);
  });

  it('leaves a camera alone for a minute after an operator used it', async () => {
    // alex just pointed CCTV-02 by hand (previous test): a new alert must not move it.
    const inc = (await alex.post('/demo/inject-alert')).body;
    await new Promise((r) => setTimeout(r, 800));
    const tl = (await alex.get(`/incidents/${inc.id}/timeline`)).body as any[];
    expect(tl.some((e) => /turned to the alert/.test(e.title))).toBe(false);
  });
});

describe('camera control on the simulated SIYI gimbal', () => {
  it('pans the camera, confirms only on the camera answer, reports the new attitude and audits it', async () => {
    const r = await alex.post('/devices/CCTV-02/camera', { action: 'gimbal_speed', yaw: 80, pitch: 0 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, confirmed: true });
    await waitFor(() => (srv.built.platform.getDevice(sys(), 'CCTV-02').gimbal?.yaw ?? 0) > 5);
    expect((await alex.post('/devices/CCTV-02/camera', { action: 'gimbal_speed', yaw: 0, pitch: 0 })).body.detail).toMatch(/stopped/);
    const z = await alex.post('/devices/CCTV-02/camera', { action: 'zoom_to', level: 6 });
    expect(z.body.ok).toBe(true);
    await waitFor(() => (srv.built.platform.getDevice(sys(), 'CCTV-02').gimbal?.zoom ?? 1) > 5.5);
    const audit = await Client.login(srv.url, 'priya').then((c) => c.get('/audit?action=camera.control'));
    const rows = (audit.body.items ?? audit.body) as any[];
    expect(rows.some((e) => e.action === 'camera.control' && e.object === 'CCTV-02' && /pan\/tilt speed yaw 80/.test(e.detail))).toBe(true);
  });

  it('refuses roles without camera control, cameras without a gimbal and malformed actions', async () => {
    expect((await priya.post('/devices/CCTV-02/camera', { action: 'center' })).status).toBe(403);
    expect((await alex.post('/devices/CCTV-01/camera', { action: 'center' })).status).toBe(400);
    expect((await alex.post('/devices/CCTV-02/camera', { action: 'self_destruct' })).status).toBe(400);
    expect((await alex.post('/devices/CCTV-02/camera', { action: 'gimbal_speed', yaw: 'fast' })).status).toBe(400);
    // Another org cannot see the device at all.
    expect((await devop.post('/devices/CCTV-02/camera', { action: 'center' })).status).toBe(404);
  });

  it('leaves a vehicle camera to the operator holding control', async () => {
    const ugv = srv.built.platform.getDevice(sys(), 'UGV-01');
    ugv.controlOwner = 'u-somchai';
    try {
      const r = await alex.post('/devices/UGV-01/camera', { action: 'center' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('not_control_owner');
      const somchai = await Client.login(srv.url, 'somchai');
      expect((await somchai.post('/devices/UGV-01/camera', { action: 'photo' })).body).toMatchObject({ ok: true, confirmed: true, detail: 'Photo taken.' });
    } finally {
      ugv.controlOwner = undefined;
    }
  });

  it('says so when the camera link is down instead of claiming success', async () => {
    await alex.post('/demo/link', { deviceId: 'CCTV-02', cut: true });
    try {
      const r = await alex.post('/devices/CCTV-02/camera', { action: 'center' });
      expect(r.body).toMatchObject({ ok: false, confirmed: false });
    } finally {
      await alex.post('/demo/link', { deviceId: 'CCTV-02', cut: false });
    }
  });
});

describe('4-in-1 module on the catalogue vehicles (simulated D50 / D100 / D200)', () => {
  it('registers the D50, D100 and D200 with their catalogue models and modules', async () => {
    const list = (await alex.get('/devices')).body as any[];
    const ugvs = Object.fromEntries(list.filter((d) => d.kind === 'ugv').map((d) => [d.id, d]));
    expect(ugvs['UGV-01']).toMatchObject({ catalogId: 'D50', payloads: ['loudhailer-4in1'] });
    expect(ugvs['UGV-02']).toMatchObject({ catalogId: 'D100', payloads: ['loudhailer-4in1'] });
    expect(ugvs['UGV-03'].catalogId).toBe('D200');
    expect(ugvs['UGV-03'].capabilities).toContain('cargo');
    expect(ugvs['UGV-03'].capabilities).not.toContain('spotlight');
  });

  it('switches the searchlight and warning light, plays a preset, and logs each one', async () => {
    expect((await alex.post('/devices/UGV-02/camera', { action: 'spotlight', on: true })).body).toMatchObject({ ok: true, confirmed: true, detail: 'Searchlight on.' });
    expect((await alex.post('/devices/UGV-02/camera', { action: 'beacon', on: true })).body.ok).toBe(true);
    expect((await alex.post('/devices/UGV-02/camera', { action: 'announce', message: 'restricted' })).body.ok).toBe(true);
    await waitFor(() => {
      const g = srv.built.platform.getDevice(sys(), 'UGV-02').gimbal;
      return !!g?.spotlight && !!g?.beacon && /restricted area/.test(g?.announcing ?? '');
    });
    const audit = ((await priya.get('/audit')).body.items ?? (await priya.get('/audit')).body) as any[];
    expect(audit.some((e) => e.action === 'payload.control' && e.object === 'UGV-02' && /announce "This is a restricted area/.test(e.detail))).toBe(true);
  });

  it('refuses the module to roles without the permission and on vehicles that do not carry it', async () => {
    expect((await priya.post('/devices/UGV-02/camera', { action: 'beacon', on: true })).status).toBe(403);
    const r = await alex.post('/devices/UGV-03/camera', { action: 'spotlight', on: true });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/no searchlight/);
    expect((await alex.post('/devices/UGV-02/camera', { action: 'announce', message: '' })).status).toBe(400);
  });
});

describe('real camera through a gateway (developer sandbox)', () => {
  let gw: WebSocket;
  let answer = true;
  beforeAll(async () => {
    // The edge media server's origin is allowed for the sandbox before the gateway declares it.
    srv.built.platform.setEdgeOrigins(testActor('org-sandbox', 'admin'), { origins: ['https://edge.example:8889'] });
    gw = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${SANDBOX_GATEWAY_KEY}` } });
    await new Promise((r) => gw.on('open', r));
    const welcome = new Promise<any>((r) => gw.once('message', (m) => r(JSON.parse(String(m)))));
    gw.send(
      JSON.stringify({
        t: 'hello',
        protocol: GATEWAY_PROTOCOL,
        gatewayId: 'edge-siyi',
        adapters: [
          {
            deviceId: 'SBX-ROVER-01',
            kind: 'ugv',
            model: 'Rover with SIYI ZT30',
            integration: 'testing',
            capabilities: ['camera', 'video', 'gimbal', 'zoom', 'photo', 'record'],
            commands: ['start', 'stop'],
            rateMs: 1000,
            limitations: '',
            linkLossBehavior: 'stop',
            stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', whep: 'https://edge.example:8889/sbx-zt30/whep', whepSub: 'https://edge.example:8889/sbx-zt30-sub/whep' },
            components: [
              { id: 'cam', name: 'SIYI ZT30', kind: 'camera', status: 'pending', facing: 'front' },
              { id: 'fc', name: 'Flight controller', kind: 'flight_controller', status: 'nonsense', detail: 'x'.repeat(500) },
              { id: 'bad id!', name: 'dropped', kind: 'camera', status: 'ok' },
              { id: 'cam', name: 'duplicate id dropped', kind: 'camera', status: 'ok' },
            ],
          },
        ],
      }),
    );
    expect((await welcome).accepted).toEqual(['SBX-ROVER-01']);
    let seq = 0;
    const tel = () =>
      gw.send(
        JSON.stringify({
          t: 'telemetry',
          deviceId: 'SBX-ROVER-01',
          seq: ++seq,
          sourceTime: Date.now(),
          pos: { x: 10, y: 10 },
          accuracyM: 1,
          speed: 0,
          quality: 'good',
          gimbal: { yaw: 12.5, pitch: -20, zoom: 2 },
        }),
      );
    tel();
    const timer = setInterval(tel, 500);
    gw.on('close', () => clearInterval(timer));
    gw.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'camera' && answer)
        gw.send(JSON.stringify({ t: 'camera_result', requestId: m.requestId, deviceId: m.deviceId, ok: true, confirmed: true, detail: `camera got ${m.action}` }));
    });
    await waitFor(async () => (await devop.get('/devices/SBX-ROVER-01')).body.gimbal?.yaw === 12.5);
    // A real device starts in SHADOW; camera moves need a supervisor's promotion (device-mode.test.ts).
    srv.built.platform.transitionMode(testActor('org-sandbox', 'supervisor'), 'SBX-ROVER-01', { to: 'LIVE_MANUAL', reason: 'Bench test, camera only' });
  });
  afterAll(async () => {
    if (!gw || gw.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((r) => gw.once('close', r));
    gw.close();
    await closed;
    await new Promise((r) => setTimeout(r, 50)); // let the server record the disconnect
  });

  it('keeps the declared equipment (sanitised) and applies status updates from telemetry', async () => {
    const d0 = (await devop.get('/devices/SBX-ROVER-01')).body;
    expect(d0.components.map((c: { id: string }) => c.id)).toEqual(['cam', 'fc']);
    expect(d0.components[1]).toMatchObject({ status: 'pending', kind: 'flight_controller' });
    expect(d0.components[1].detail).toHaveLength(160);
    gw.send(
      JSON.stringify({
        t: 'telemetry',
        deviceId: 'SBX-ROVER-01',
        seq: 10_000,
        sourceTime: Date.now(),
        pos: { x: 10, y: 10 },
        accuracyM: 1,
        speed: 0,
        quality: 'good',
        components: [
          { id: 'cam', status: 'ok', version: 'camera 1.2.3 · gimbal 2.0' },
          { id: 'ghost', status: 'ok' },
        ],
      }),
    );
    await waitFor(async () => (await devop.get('/devices/SBX-ROVER-01')).body.components?.[0]?.status === 'ok');
    const d1 = (await devop.get('/devices/SBX-ROVER-01')).body;
    expect(d1.components[0]).toMatchObject({ id: 'cam', status: 'ok', version: 'camera 1.2.3 · gimbal 2.0' });
    expect(d1.components).toHaveLength(2);
  });

  it('routes the request to the gateway and returns the camera answer', async () => {
    const r = await devop.post('/devices/SBX-ROVER-01/camera', { action: 'gimbal_angle', yaw: 30, pitch: -15 });
    expect(r.body).toEqual({ ok: true, confirmed: true, detail: 'camera got gimbal_angle' });
  });

  it('times out honestly when the gateway does not answer', async () => {
    answer = false;
    try {
      const r = await devop.post('/devices/SBX-ROVER-01/camera', { action: 'center' });
      expect(r.body.ok).toBe(false);
      expect(r.body.detail).toMatch(/No answer/);
    } finally {
      answer = true;
    }
  }, 10_000);

  it('hands out a short-lived WebRTC link that the media server checks with the platform', async () => {
    const s = await devop.post('/media/SBX-ROVER-01/session');
    expect(s.status).toBe(200);
    expect(s.body.label).toBe('LIVE');
    expect(s.body.whep).toMatch(/^https:\/\/edge\.example:8889\/sbx-zt30\/whep\?token=/);
    const token = new URL(s.body.whep).searchParams.get('token')!;
    const auth = (b: object) =>
      fetch(`${srv.url}/api/v1/media/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.status);
    // What MediaMTX sends: action, path, query string.
    expect(await auth({ action: 'read', path: 'sbx-zt30', protocol: 'webrtc', query: `token=${token}` })).toBe(200);
    expect(await auth({ action: 'read', path: 'cam-other', protocol: 'webrtc', query: `token=${token}` })).toBe(401);
    // Low-resolution sub-stream: its own link, same token rules.
    expect(s.body.whepSub).toMatch(/\/sbx-zt30-sub\/whep\?token=/);
    expect(await auth({ action: 'read', path: 'sbx-zt30-sub', protocol: 'webrtc', query: `token=${token}` })).toBe(200);
    expect(await auth({ action: 'publish', path: 'sbx-zt30', query: `token=${token}` })).toBe(401);
    expect(await auth({ action: 'read', path: 'sbx-zt30', query: `token=${token.slice(0, -2)}xx` })).toBe(401);
    expect(await auth({ action: 'read', path: 'sbx-zt30' })).toBe(401);
    const realNow = srv.built.platform.now;
    srv.built.platform.now = () => Date.now() + 61_000;
    try {
      expect(await auth({ action: 'read', path: 'sbx-zt30', query: `token=${token}` })).toBe(401);
    } finally {
      srv.built.platform.now = realNow;
    }
    // Simulated devices never get a media-server link.
    expect((await alex.post('/media/CCTV-02/session')).body.whep).toBeUndefined();
  });
});
