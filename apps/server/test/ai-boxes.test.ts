// AI boxes: AI on a vehicle's video, switched on from the console. A gateway that says hello as an
// AI box needs no device of its own; the server hands it the videos people switched AI on for (a
// read pass per vehicle), moves them when a box leaves, and accepts the box's detections, live
// boxes and health only for the vehicles it has the job for.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { Client, consoleSocket, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let admin: Client;
let sup: Client;
let field: Client;
let aud: Client;
let roverKey = '';
let boxKey = '';
let rover: WebSocket;
const V1 = 'UGV-AI1';
const V2 = 'UGV-AI2';

const vehicle = (deviceId: string) => ({
  deviceId,
  kind: 'ugv',
  model: 'Pushed camera rover',
  integration: 'testing',
  capabilities: ['video', 'camera'],
  commands: [],
  rateMs: 1000,
  limitations: '',
  linkLossBehavior: '',
  stream: { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true },
});

const auth = (b: object) =>
  fetch(`${srv.url}/api/v1/media/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then((r) => r.status);
const readToken = (url: string) => /read:([^@]+)@/.exec(url)![1];

interface Box {
  ws: WebSocket;
  /** Every ai_jobs list received, newest last. */
  lists: { deviceId: string; read: string }[][];
  send(m: unknown): void;
  jobs(): string[];
}

async function openBox(gatewayId: string, capacity: number): Promise<Box> {
  const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${boxKey}` } });
  const lists: Box['lists'] = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'ai_jobs') lists.push(m.jobs);
  });
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId, adapters: [], aiBox: { capacity, model: 'YOLOv8s test' } }));
  await waitFor(() => lists.length > 0);
  return {
    ws,
    lists,
    send: (m) => ws.send(JSON.stringify(m)),
    jobs: () => (lists.at(-1) ?? []).map((j) => j.deviceId).sort(),
  };
}

const device = async (id: string) => (await sup.get(`/devices/${id}`)).body;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
  srv = await startServer({ env: 'pilot', gateway: false, cfg: { mediaIngestUrl: 'rtsp://media.test:18554/', mediaPublicUrl: 'https://media.test:18889' } });
  delete process.env.ADMIN_PASSWORD;
  admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  for (const [name, role] of [
    ['sup', 'supervisor'],
    ['field', 'responder'],
    ['aud', 'auditor'],
  ])
    expect((await admin.post('/admin/users', { username: `ab-${name}`, name, role, password: 'longpassword1' })).status).toBe(200);
  [sup, field, aud] = await Promise.all(['sup', 'field', 'aud'].map((u) => Client.login(srv.url, `ab-${u}`, 'longpassword1')));
  roverKey = (await admin.post('/admin/keys', { label: 'Rover gateway', kind: 'gateway' })).body.secret;
  boxKey = (await admin.post('/admin/keys', { label: 'AI box', kind: 'gateway' })).body.secret;
  for (const id of [V1, V2]) expect((await admin.post('/devices', { id, kind: 'ugv', model: 'SIYI rover' })).status).toBe(200);
}, 30_000);
afterAll(async () => {
  rover?.close();
  await srv?.close();
});

describe('AI switch and AI boxes', () => {
  it('only people who may control cameras switch it, and only for a vehicle whose video is on the media server', async () => {
    expect((await field.post(`/devices/${V1}/ai`, { on: true })).status).toBe(403);
    expect((await aud.post(`/devices/${V1}/ai`, { on: true })).status).toBe(403);
    expect((await sup.post(`/devices/${V1}/ai`, { on: 'yes' })).status).toBe(400);
    // No gateway has pushed its video yet.
    const r = await sup.post(`/devices/${V1}/ai`, { on: true });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/sends no video to the site media server/);
  });

  it('waits for an AI box, then hands the video to one with a read pass for that vehicle only', async () => {
    rover = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${roverKey}` } });
    await new Promise((r) => rover.on('open', r));
    const welcome = new Promise<any>((r) => rover.once('message', (m) => r(JSON.parse(String(m)))));
    rover.send(JSON.stringify({ t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId: 'rover-gw', adapters: [vehicle(V1), vehicle(V2)] }));
    expect((await welcome).accepted.sort()).toEqual([V1, V2]);

    const on = await sup.post(`/devices/${V1}/ai`, { on: true });
    expect(on.status).toBe(200);
    expect(on.body.ai).toMatchObject({ on: true, by: 'sup', state: 'no_box' });

    const a = await openBox('box-a', 1);
    expect(a.jobs()).toEqual([V1]);
    const job = a.lists.at(-1)![0];
    expect(job.read).toMatch(/^rtsp:\/\/read:r2\.[^@]+@media\.test:18554\/ugv-ai1$/);
    await waitFor(async () => (await device(V1)).ai?.state === 'assigned');
    expect((await device(V1)).ai).toMatchObject({ on: true, state: 'assigned', box: 'box-a' });
    // The pass reads that vehicle's path and nothing else; it never publishes.
    const token = readToken(job.read);
    expect(await auth({ action: 'read', path: 'ugv-ai1', user: 'read', password: token })).toBe(200);
    expect(await auth({ action: 'read', path: 'ugv-ai2', user: 'read', password: token })).toBe(401);
    expect(await auth({ action: 'publish', path: 'ugv-ai1', user: 'read', password: token })).toBe(401);
    expect(await auth({ action: 'read', path: 'ugv-ai1', user: 'read', password: token.replace(/\.[^.]+$/, `.${'b'.repeat(64)}`) })).toBe(401);
    // The boxes connected now, for people checking the setup.
    expect((await sup.get('/ai/boxes')).body).toEqual([{ gatewayId: 'box-a', capacity: 1, model: 'YOLOv8s test', jobs: [V1] }]);
    a.ws.close();
    await waitFor(async () => (await device(V1)).ai?.state === 'no_box');
    expect(await auth({ action: 'read', path: 'ugv-ai1', user: 'read', password: token })).toBe(401);
  });

  it('says a box is full, fills a new one, and moves jobs when a box leaves', async () => {
    const a = await openBox('box-a', 1);
    expect(a.jobs()).toEqual([V1]);
    expect((await sup.post(`/devices/${V2}/ai`, { on: true })).status).toBe(200);
    await waitFor(async () => (await device(V2)).ai?.state === 'full');

    const b = await openBox('box-b', 2);
    expect(b.jobs()).toEqual([V2]);
    await waitFor(async () => (await device(V2)).ai?.box === 'box-b');

    // Box A leaves: its vehicle goes to box B, which has room for two.
    a.ws.close();
    await waitFor(() => b.jobs().length === 2);
    expect(b.jobs()).toEqual([V1, V2]);
    await waitFor(async () => (await device(V1)).ai?.box === 'box-b');

    // Box B reconnects before its old connection closes: it keeps its jobs.
    const b2 = await openBox('box-b', 2);
    expect(b2.jobs()).toEqual([V1, V2]);
    b.ws.close();
    await new Promise((r) => setTimeout(r, 200));
    expect((await device(V1)).ai).toMatchObject({ state: 'assigned', box: 'box-b' });
    expect(await auth({ action: 'read', path: 'ugv-ai1', user: 'read', password: readToken(b2.lists.at(-1)!.find((j) => j.deviceId === V1)!.read) })).toBe(200);

    // Switched off: the job ends, the box gets the shorter list, the boxes on screen are cleared.
    const con = await consoleSocket(srv.wsUrl, sup.token);
    try {
      const off = await sup.post(`/devices/${V2}/ai`, { on: false });
      expect(off.status).toBe(200);
      expect(off.body.ai).toEqual({ on: false, by: 'sup', at: expect.any(Number) });
      await waitFor(() => b2.jobs().length === 1);
      expect(b2.jobs()).toEqual([V1]);
      await waitFor(() => con.events.some((e) => e.type === 'tracks' && e.deviceId === V2 && e.boxes.length === 0));
    } finally {
      con.close();
      b2.ws.close();
    }
    await waitFor(async () => (await device(V1)).ai?.state === 'no_box');
  });

  it("takes a box's detections, live boxes and health only for its own jobs, and nothing else about the vehicle", async () => {
    const box = await openBox('box-c', 1);
    expect(box.jobs()).toEqual([V1]);
    const con = await consoleSocket(srv.wsUrl, sup.token);
    try {
      const before = await device(V1);
      // Live boxes for its job go to consoles; for another vehicle they are dropped.
      box.send({ t: 'tracks', deviceId: V1, at: Date.now(), width: 960, height: 540, boxes: [{ id: 1, type: 'person', confidence: 0.9, bbox: [0.4, 0.3, 0.1, 0.4] }] });
      box.send({ t: 'tracks', deviceId: V2, at: Date.now(), boxes: [{ id: 2, type: 'person', confidence: 0.9, bbox: [0.1, 0.1, 0.1, 0.1] }] });
      await waitFor(() => con.events.some((e) => e.type === 'tracks' && e.deviceId === V1 && e.boxes.length === 1));
      // Health shows on the vehicle, marked as the AI box's.
      box.send({ t: 'event', deviceId: V1, kind: 'analytics', at: Date.now(), analytics: { provider: 'edge-vision', running: true, fps: 7.5, model: 'yolov8s.engine' } });
      await waitFor(async () => (await device(V1)).analytics?.fps === 7.5);
      expect((await device(V1)).analytics.provider).toBe('ai-box box-c');
      // A detection is filed under the vehicle, named after the box.
      box.send({ t: 'event', deviceId: V1, kind: 'detection', at: Date.now(), detail: 'intrusion 91%', detection: { type: 'intrusion', confidence: 0.91, bbox: [0.4, 0.3, 0.1, 0.4] } });
      await waitFor(async () => ((await sup.get('/detections?limit=10')).body as any[]).some((d) => d.deviceId === V1 && d.type === 'intrusion'));
      const det = ((await sup.get('/detections?limit=10')).body as any[]).find((d) => d.deviceId === V1 && d.type === 'intrusion');
      expect(det.source).toBe(`${V1} AI · box-c`);
      // Anything else about the vehicle is not the box's to say.
      box.send({ t: 'telemetry', deviceId: V1, seq: 1, sourceTime: Date.now(), pos: { x: 999, y: 999 }, accuracyM: 1, speed: 3, quality: 'good' });
      box.send({ t: 'event', deviceId: V1, kind: 'route_complete', at: Date.now() });
      box.send({ t: 'event', deviceId: V2, kind: 'detection', at: Date.now(), detection: { type: 'fire', confidence: 0.99 } });
      await new Promise((r) => setTimeout(r, 300));
      expect((await device(V1)).pos).toEqual(before.pos);
      expect(con.events.some((e) => e.type === 'tracks' && e.deviceId === V2)).toBe(false);
      expect(((await sup.get('/detections?limit=20')).body as any[]).some((d) => d.deviceId === V2)).toBe(false);
      // Switching off drops the box's health from the vehicle.
      expect((await sup.post(`/devices/${V1}/ai`, { on: false })).status).toBe(200);
      await waitFor(async () => (await device(V1)).analytics === undefined);
      expect(box.jobs()).toEqual([]);
    } finally {
      con.close();
      box.ws.close();
    }
  });
});
