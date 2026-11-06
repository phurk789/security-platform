// Distance to people on a vehicle's video: the server adds it to live boxes and detections from
// the camera's ranging (set by hand, or calibrated from someone standing at a known distance),
// never from what a gateway claims.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { Client, consoleSocket, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let admin: Client;
let sup: Client;
let field: Client;
let rover: WebSocket;
let box: WebSocket;
const V = 'UGV-RG1';
const ASPECT = 16 / 9;
const rad = (d: number) => (d * Math.PI) / 180;

/** Where a floor point d metres ahead (x to the side) appears for a camera at height h tilted down by tilt. */
function foot(d: number, h: number, tilt: number, vfov = 50, x = 0): [number, number] {
  const t = rad(tilt);
  const z = h * Math.sin(t) + d * Math.cos(t);
  const tv = Math.tan(rad(vfov) / 2);
  return [0.5 + x / z / (2 * tv * ASPECT), 0.5 + (h * Math.cos(t) - d * Math.sin(t)) / z / (2 * tv)];
}
/** A person box whose feet are at that point. */
const personAt = ([u, v]: [number, number], id = 1) => ({ id, type: 'intrusion', label: 'person', confidence: 0.9, bbox: [u - 0.04, v - 0.35, 0.08, 0.35] });
const tracks = (boxes: object[]) => box.send(JSON.stringify({ t: 'tracks', deviceId: V, at: Date.now(), width: 960, height: 540, boxes }));
const device = async () => (await sup.get(`/devices/${V}`)).body;

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
  srv = await startServer({ env: 'pilot', gateway: false, cfg: { mediaIngestUrl: 'rtsp://media.test:18554/', mediaPublicUrl: 'https://media.test:18889' } });
  delete process.env.ADMIN_PASSWORD;
  admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  for (const [name, role] of [
    ['sup', 'supervisor'],
    ['field', 'responder'],
  ])
    expect((await admin.post('/admin/users', { username: `rg-${name}`, name, role, password: 'longpassword1' })).status).toBe(200);
  [sup, field] = await Promise.all(['sup', 'field'].map((u) => Client.login(srv.url, `rg-${u}`, 'longpassword1')));
  const roverKey = (await admin.post('/admin/keys', { label: 'Rover', kind: 'gateway' })).body.secret;
  const boxKey = (await admin.post('/admin/keys', { label: 'AI box', kind: 'gateway' })).body.secret;
  expect((await admin.post('/devices', { id: V, kind: 'ugv', model: 'Rover' })).status).toBe(200);
  const open = async (key: string) => {
    const ws = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${key}` } });
    await new Promise((r) => ws.on('open', r));
    return ws;
  };
  rover = await open(roverKey);
  const stream = { rtsp: 'rtsp://192.168.144.25:8554/main.264', push: true };
  rover.send(
    JSON.stringify({
      t: 'hello',
      protocol: GATEWAY_PROTOCOL,
      gatewayId: 'rover',
      adapters: [{ deviceId: V, kind: 'ugv', model: 'Rover', integration: 'testing', capabilities: ['video', 'camera'], commands: [], rateMs: 1000, limitations: '', linkLossBehavior: '', stream }],
    }),
  );
  box = await open(boxKey);
  const jobs: string[][] = [];
  box.on('message', (m) => {
    const x = JSON.parse(String(m));
    if (x.t === 'ai_jobs') jobs.push(x.jobs.map((j: { deviceId: string }) => j.deviceId));
  });
  box.send(JSON.stringify({ t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId: 'box', adapters: [], aiBox: { capacity: 1 } }));
  await waitFor(async () => (await sup.post(`/devices/${V}/ai`, { on: true })).status === 200);
  await waitFor(() => jobs.at(-1)?.[0] === V);
}, 30_000);
afterAll(async () => {
  rover?.close();
  box?.close();
  await srv?.close();
});

describe('distance to people', () => {
  it('adds no distance until the camera geometry is known, then the distance from where the feet are', async () => {
    const con = await consoleSocket(srv.wsUrl, sup.token);
    try {
      const at = (n: number) => con.events.filter((e) => e.type === 'tracks' && e.deviceId === V).at(n);
      tracks([personAt(foot(4, 0.5, 8))]);
      await waitFor(() => !!at(-1));
      expect(at(-1).boxes[0].distM).toBeUndefined();
      expect((await sup.put(`/devices/${V}/ranging`, { heightM: 0.5, tiltDeg: 8, vfovDeg: 50 })).body.ranging).toMatchObject({ heightM: 0.5, tiltDeg: 8, vfovDeg: 50, source: 'manual', by: 'sup' });
      const before = con.events.length;
      await new Promise((r) => setTimeout(r, 150));
      // A gateway cannot set the distance itself; boxes that touch the bottom edge (feet cut off) get none.
      tracks([{ ...personAt(foot(4, 0.5, 8)), distM: 99 }, { id: 2, type: 'person', confidence: 0.8, bbox: [0.1, 0.5, 0.1, 0.5] }]);
      await waitFor(() => con.events.length > before && !!at(-1)?.boxes.length);
      expect(at(-1).boxes[0].distM).toBe(4);
      expect(at(-1).boxes[1].distM).toBeUndefined();
    } finally {
      con.close();
    }
  });

  it('calibrates from one person standing at known distances: one point gives the height, two give the tilt too', async () => {
    expect((await sup.del(`/devices/${V}/ranging`)).body.ranging).toBeUndefined();
    // The camera is really 0.62 m up, tilted 11° down.
    tracks([personAt(foot(2, 0.62, 11))]);
    await new Promise((r) => setTimeout(r, 120));
    const one = await sup.post(`/devices/${V}/ranging/points`, { distanceM: 2 });
    expect(one.status).toBe(200);
    expect(one.body.ranging).toMatchObject({ source: 'calibrated', samples: [expect.objectContaining({ distanceM: 2 })] });
    await new Promise((r) => setTimeout(r, 120));
    tracks([personAt(foot(5, 0.62, 11))]);
    await new Promise((r) => setTimeout(r, 120));
    const two = await sup.post(`/devices/${V}/ranging/points`, { distanceM: 5 });
    expect(two.status).toBe(200);
    expect(two.body.ranging.samples).toHaveLength(2);
    expect(two.body.ranging.heightM).toBeCloseTo(0.62, 2);
    expect(two.body.ranging.tiltDeg).toBeCloseTo(11, 1);
    expect(two.body.ranging.errorPct).toBeLessThan(1);
    // Someone at 3.5 m now gets 3.5 m.
    const con = await consoleSocket(srv.wsUrl, sup.token);
    try {
      await new Promise((r) => setTimeout(r, 120));
      tracks([personAt(foot(3.5, 0.62, 11))]);
      await waitFor(() => con.events.some((e) => e.type === 'tracks' && e.deviceId === V && e.boxes[0]?.distM !== undefined));
      expect(con.events.filter((e) => e.type === 'tracks').at(-1).boxes[0].distM).toBe(3.5);
    } finally {
      con.close();
    }
  });

  it('refuses a calibration point it cannot measure, and people who may not control cameras', async () => {
    await new Promise((r) => setTimeout(r, 120));
    tracks([personAt(foot(3, 0.62, 11), 1), personAt(foot(4, 0.62, 11, 50, 1), 2)]);
    await new Promise((r) => setTimeout(r, 120));
    const many = await sup.post(`/devices/${V}/ranging/points`, { distanceM: 3 });
    expect(many.status).toBe(409);
    expect(many.body.error).toMatch(/exactly one person in view of UGV-RG1; the AI sees 2/);
    tracks([{ id: 3, type: 'person', confidence: 0.9, bbox: [0.4, 0.4, 0.1, 0.6] }]);
    await new Promise((r) => setTimeout(r, 120));
    expect((await sup.post(`/devices/${V}/ranging/points`, { distanceM: 3 })).body.error).toMatch(/feet are cut off/);
    expect((await sup.post(`/devices/${V}/ranging/points`, { distanceM: 0.2 })).status).toBe(400);
    expect((await sup.put(`/devices/${V}/ranging`, { heightM: 0 })).status).toBe(400);
    expect((await field.post(`/devices/${V}/ranging/points`, { distanceM: 3 })).status).toBe(403);
    expect((await field.put(`/devices/${V}/ranging`, { heightM: 1 })).status).toBe(403);
    // Old boxes do not count: the person must be in view now.
    await new Promise((r) => setTimeout(r, 2_100));
    expect((await sup.post(`/devices/${V}/ranging/points`, { distanceM: 3 })).body.error).toMatch(/No live AI boxes on UGV-RG1/);
    // The calibration from before is still there.
    expect((await device()).ranging.samples).toHaveLength(2);
  }, 10_000);

  it("files a detection with the server's distance, never the gateway's", async () => {
    box.send(
      JSON.stringify({
        t: 'event',
        deviceId: V,
        kind: 'detection',
        at: Date.now(),
        detection: { type: 'intrusion', confidence: 0.91, bbox: personAt(foot(4.2, 0.62, 11)).bbox, attributes: { label: 'person', distanceM: 99 } },
      }),
    );
    await waitFor(async () => ((await sup.get('/detections?limit=5')).body as any[]).some((d) => d.deviceId === V));
    const det = ((await sup.get('/detections?limit=5')).body as any[]).find((d) => d.deviceId === V);
    expect(det.attributes.distanceM).toBe(4.2);
    // Without a camera geometry there is no distance, whatever the gateway says.
    await sup.del(`/devices/${V}/ranging`);
    box.send(JSON.stringify({ t: 'event', deviceId: V, kind: 'detection', at: Date.now(), detection: { type: 'person', confidence: 0.8, bbox: [0.4, 0.3, 0.1, 0.4], attributes: { distanceM: 99 } } }));
    await waitFor(async () => ((await sup.get('/detections?limit=5')).body as any[]).some((d) => d.deviceId === V && d.type === 'person'));
    const second = ((await sup.get('/detections?limit=5')).body as any[]).find((d) => d.deviceId === V && d.type === 'person');
    expect(second.attributes?.distanceM).toBeUndefined();
  });
});
