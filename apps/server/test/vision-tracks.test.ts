// Camera AI on a vehicle's video: the gateway's vision pipeline streams live boxes, which the server
// checks, thins out and passes to consoles that may see video (never stored), and the camera AI
// is linked to the vehicle it follows.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { sanitizeVisionBox } from '../src/platform';
import { Client, consoleSocket, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let admin: Client;
let sup: Client;
let field: Client;
let gwKey = '';
let gw: WebSocket;
let welcome: { accepted: string[]; reads?: { deviceId: string; follows: string; read: string }[] };
const VEHICLE = 'UGV-T1';
const AI = 'UGV-T1-AI';

const declaration = (deviceId: string, extra: Record<string, unknown> = {}) => ({
  deviceId,
  kind: 'cctv',
  model: 'Camera AI (YOLO)',
  adapterVersion: 'edge-vision 1.0',
  protocolVersion: 'ffmpeg frames',
  firmwareTested: 'n/a',
  integration: 'testing',
  capabilities: ['video', 'analytics'],
  commands: [],
  units: { position: 'site-m', speed: 'm/s', battery: 'percent' },
  rateMs: 5000,
  limitations: '',
  linkLossBehavior: 'none',
  ...extra,
});

const send = (m: unknown) => gw.send(JSON.stringify(m));
const auth = (b: object) =>
  fetch(`${srv.url}/api/v1/media/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.status);
const person = (x: number) => ({ id: 3, type: 'person', label: 'person', confidence: 0.87, bbox: [x, 0.3, 0.1, 0.4] });

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
  srv = await startServer({ env: 'pilot', gateway: false, cfg: { mediaIngestUrl: 'rtsp://media.test:18554/', mediaPublicUrl: 'https://media.test:18889' } });
  delete process.env.ADMIN_PASSWORD;
  admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  for (const [name, role] of [
    ['sup', 'supervisor'],
    ['field', 'responder'],
  ])
    expect((await admin.post('/admin/users', { username: `vt-${name}`, name, role, password: 'longpassword1' })).status).toBe(200);
  [sup, field] = await Promise.all(['sup', 'field'].map((u) => Client.login(srv.url, `vt-${u}`, 'longpassword1')));
  gwKey = (await admin.post('/admin/keys', { label: 'Vision gateway', kind: 'gateway' })).body.secret;
  expect((await admin.post('/devices', { id: VEHICLE, kind: 'ugv', model: 'SIYI rover' })).status).toBe(200);
  expect((await admin.post('/devices', { id: AI, kind: 'cctv', model: 'Camera AI' })).status).toBe(200);
  gw = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${gwKey}` } });
  await new Promise((r) => gw.on('open', r));
  const hello = new Promise<any>((r) => gw.once('message', (m) => r(JSON.parse(String(m)))));
  // This gateway runs only the camera AI; the vehicle itself belongs to another gateway.
  send({ t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId: 'vision-pc', adapters: [declaration(AI, { follows: VEHICLE })] });
  welcome = await hello;
  expect(welcome.accepted).toEqual([AI]);
}, 30_000);
afterAll(async () => {
  gw?.close();
  await srv?.close();
});

describe('camera AI live boxes', () => {
  it('links the camera AI to the vehicle it follows', async () => {
    expect((await sup.get(`/devices/${AI}`)).body).toMatchObject({ id: AI, follows: VEHICLE });
  });

  it('passes checked boxes to consoles that may see video, thinned to 10 a second, and never to responders', async () => {
    const con = await consoleSocket(srv.wsUrl, sup.token);
    const fieldCon = await consoleSocket(srv.wsUrl, field.token);
    const tracks = () => con.events.filter((e) => e.type === 'tracks');
    // Freeze the server clock so "within 100 ms" does not depend on how busy the test machine is.
    const realNow = srv.built.platform.now;
    const t0 = Date.now();
    srv.built.platform.now = () => t0;
    try {
      send({
        t: 'tracks',
        deviceId: AI,
        at: Date.now(),
        width: 1280,
        height: 720,
        boxes: [person(0.2), { type: 'robot', confidence: 1, bbox: [0, 0, 0.1, 0.1] }, { type: 'person', confidence: 3, bbox: [0.9, 0.9, 0.5, 0.5], label: 'x'.repeat(80) }],
      });
      await waitFor(() => tracks().length === 1);
      const first = tracks()[0];
      expect(first).toMatchObject({ deviceId: AI, width: 1280, height: 720 });
      // The unknown type is dropped; the box running off the frame is trimmed to it; numbers are clamped.
      expect(first.boxes).toHaveLength(2);
      expect(first.boxes[0]).toEqual({ id: 3, type: 'person', label: 'person', confidence: 0.87, bbox: [0.2, 0.3, 0.1, 0.4] });
      expect(first.boxes[1]).toMatchObject({ type: 'person', confidence: 1, bbox: [0.9, 0.9, 0.1, 0.1] });
      expect(first.boxes[1].label).toHaveLength(40);
      // A burst within 100 ms is thinned; the empty list that clears the screen always goes through.
      send({ t: 'tracks', deviceId: AI, at: Date.now(), boxes: [person(0.21)] });
      send({ t: 'tracks', deviceId: AI, at: Date.now(), boxes: [] });
      await waitFor(() => tracks().length === 2);
      await new Promise((r) => setTimeout(r, 150));
      expect(tracks().map((e) => e.boxes.length)).toEqual([2, 0]);
      // Boxes for a device this gateway does not own are ignored.
      send({ t: 'tracks', deviceId: VEHICLE, at: Date.now(), boxes: [person(0.5)] });
      await new Promise((r) => setTimeout(r, 200));
      expect(tracks()).toHaveLength(2);
      expect(fieldCon.events.filter((e) => e.type === 'tracks')).toHaveLength(0);
    } finally {
      srv.built.platform.now = realNow;
      con.close();
      fieldCon.close();
    }
  }, 15_000);

  it('gives the camera AI a pass to read the video of the vehicle it follows, and nothing else', async () => {
    expect(welcome.reads).toEqual([{ deviceId: AI, follows: VEHICLE, read: expect.stringMatching(/^rtsp:\/\/read:r1\.[^@]+@media\.test:18554\/ugv-t1$/) }]);
    const token = /read:([^@]+)@/.exec(welcome.reads![0].read)![1];
    expect(await auth({ action: 'read', path: 'ugv-t1', user: 'read', password: token })).toBe(200);
    expect(await auth({ action: 'read', path: 'cctv-01', user: 'read', password: token })).toBe(401);
    expect(await auth({ action: 'publish', path: 'ugv-t1', user: 'read', password: token })).toBe(401);
    const forged = token.replace(/\.[^.]+$/, `.${'a'.repeat(64)}`);
    expect(await auth({ action: 'read', path: 'ugv-t1', user: 'read', password: forged })).toBe(401);
  });

  it('keeps only sensible boxes', () => {
    expect(sanitizeVisionBox({ type: 'person', bbox: [0.1, 0.1, 0, 0.2] })).toBeUndefined();
    expect(sanitizeVisionBox({ type: 'person', bbox: [0.1, 0.1, 0.2] })).toBeUndefined();
    expect(sanitizeVisionBox({ type: 'person', bbox: [NaN, 0.1, 0.2, 0.2] })).toBeUndefined();
    expect(sanitizeVisionBox({ type: 'person', id: -1, bbox: [-0.2, 0.1, 0.4, 0.2] })).toEqual({ type: 'person', confidence: 1, bbox: [0, 0.1, 0.2, 0.2] });
  });

  it('the read pass stops working when the gateway of the camera AI disconnects', async () => {
    const token = /read:([^@]+)@/.exec(welcome.reads![0].read)![1];
    gw.close();
    await waitFor(async () => (await auth({ action: 'read', path: 'ugv-t1', user: 'read', password: token })) === 401);
  });
});
