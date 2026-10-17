// Camera control (SIYI-style gimbal) and video access through the site media server.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { SANDBOX_GATEWAY_KEY } from '../src/seed';
import { Client, startServer, waitFor, type TestServer } from './helpers';

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

describe('real camera through a gateway (developer sandbox)', () => {
  let gw: WebSocket;
  let answer = true;
  beforeAll(async () => {
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
            stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', whep: 'https://edge.example:8889/sbx-zt30/whep' },
          },
        ],
      }),
    );
    expect((await welcome).accepted).toEqual(['SBX-ROVER-01']);
    let seq = 0;
    const tel = () => gw.send(JSON.stringify({ t: 'telemetry', deviceId: 'SBX-ROVER-01', seq: ++seq, sourceTime: Date.now(), pos: { x: 10, y: 10 }, accuracyM: 1, speed: 0, quality: 'good', gimbal: { yaw: 12.5, pitch: -20, zoom: 2 } }));
    tel();
    const timer = setInterval(tel, 500);
    gw.on('close', () => clearInterval(timer));
    gw.on('message', (raw) => {
      const m = JSON.parse(String(raw));
      if (m.t === 'camera' && answer) gw.send(JSON.stringify({ t: 'camera_result', requestId: m.requestId, deviceId: m.deviceId, ok: true, confirmed: true, detail: `camera got ${m.action}` }));
    });
    await waitFor(async () => (await devop.get('/devices/SBX-ROVER-01')).body.gimbal?.yaw === 12.5);
  });
  afterAll(async () => {
    if (!gw || gw.readyState === WebSocket.CLOSED) return;
    const closed = new Promise((r) => gw.once('close', r));
    gw.close();
    await closed;
    await new Promise((r) => setTimeout(r, 50)); // let the server record the disconnect
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
    const auth = (b: object) => fetch(`${srv.url}/api/v1/media/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.status);
    // What MediaMTX sends: action, path, query string.
    expect(await auth({ action: 'read', path: 'sbx-zt30', protocol: 'webrtc', query: `token=${token}` })).toBe(200);
    expect(await auth({ action: 'read', path: 'cam-other', protocol: 'webrtc', query: `token=${token}` })).toBe(401);
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
