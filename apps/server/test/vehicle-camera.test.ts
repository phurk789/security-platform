// A gimbal camera that rides on a vehicle (UGV-01's SIYI A8 mini on its own SDK link, `follows` the
// vehicle): the platform treats it as the vehicle's camera for checkpoint jobs, aims it from the
// vehicle's position and heading, leaves it to the operator holding the vehicle, and uses its tilt
// for distances on the vehicle's video. A camera AI that follows the vehicle is not its camera.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL, aimAt, type Device } from '@13store/shared';
import { Client, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let admin: Client;
let sup: Client;
let op: Client;
let disp: Client;
let gw: WebSocket;
let welcome: { accepted: string[]; reads?: { deviceId: string; follows: string; read: string }[] };
const VEH = 'UGV-R1';
const CAM = 'UGV-R1-CAM';
const AI = 'UGV-R1-AI';

const base = { adapterVersion: 'test', protocolVersion: 'test', firmwareTested: 'n/a', integration: 'testing', units: { position: 'site-m', speed: 'm/s', battery: 'percent' }, limitations: '', linkLossBehavior: 'hold' };
const declarations = [
  { ...base, deviceId: VEH, kind: 'ugv', model: 'ArduPilot Rover', capabilities: ['ground_patrol', 'camera', 'video'], commands: ['start', 'pause', 'resume', 'stop'], rateMs: 200 },
  { ...base, deviceId: CAM, kind: 'cctv', model: 'SIYI A8 mini', capabilities: ['video', 'camera', 'gimbal', 'zoom', 'photo', 'record'], commands: [], rateMs: 200, follows: VEH, mount: { bearingDeg: 0, heightM: 0.8 } },
  { ...base, deviceId: AI, kind: 'cctv', model: 'Camera AI', capabilities: ['video', 'analytics'], commands: [], rateMs: 5000, follows: VEH },
];

/** What the fake Pi reports: the vehicle's fix and heading, the gimbal as last commanded. */
const state = { pos: { x: 200, y: 200 } as { x: number; y: number } | undefined, heading: 90, gimbal: { yaw: 0, pitch: 0, zoom: 1 } };
/** Camera requests the server sent, in order. */
const sent: { deviceId: string; action: string; yaw?: number; pitch?: number; level?: number }[] = [];
let seq = 0;
let timer: ReturnType<typeof setInterval>;

function telemetry() {
  if (gw.readyState !== gw.OPEN) return;
  const t = { t: 'telemetry', seq: ++seq, sourceTime: Date.now(), accuracyM: 1, speed: 0, quality: 'good' };
  gw.send(JSON.stringify({ ...t, deviceId: VEH, ...(state.pos ? { pos: state.pos } : {}), heading: state.heading, battery: 90 }));
  // The riding camera knows its gimbal, not where it is.
  gw.send(JSON.stringify({ ...t, deviceId: CAM, gimbal: state.gimbal }));
}

const stored = (id: string) => (srv.built.platform as unknown as { devices: Map<string, Device & { orgId: string; siteId: string }> }).devices.get(id)!;
const plat = () =>
  srv.built.platform as unknown as {
    vehicleCamera(d: Device): Device | undefined;
    rangingFor(d: Device): { gimbalPitch?: number };
    checkpointCamera(o: string, d: Device, m: unknown, i: number): void;
  };
const said = (incidentId: string, like: string) =>
  (srv.db.prepare('SELECT data FROM timeline WHERE incident_id = ? AND data LIKE ?').all(incidentId, `%${like}%`) as { data: string }[]).map((r) => JSON.parse(r.data) as { title: string; detail?: string });
async function incident() {
  const inc = await disp.post('/incidents', { title: 'Riding camera', place: 'Yard', pos: { x: 230, y: 210 } });
  expect(inc.status, JSON.stringify(inc.body)).toBe(200);
  return inc.body.id as string;
}

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
  srv = await startServer({ env: 'pilot', gateway: false, cfg: { mediaIngestUrl: 'rtsp://media.test:18554/', mediaPublicUrl: 'https://media.test:18889' } });
  delete process.env.ADMIN_PASSWORD;
  admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
  for (const [name, role] of [
    ['sup', 'supervisor'],
    ['op', 'operator'],
    ['disp', 'dispatcher'],
  ])
    expect((await admin.post('/admin/users', { username: `rc-${name}`, name, role, password: 'longpassword1' })).status).toBe(200);
  [sup, op, disp] = await Promise.all(['sup', 'op', 'disp'].map((u) => Client.login(srv.url, `rc-${u}`, 'longpassword1')));
  const key = (await admin.post('/admin/keys', { label: 'Pi on UGV-R1', kind: 'gateway' })).body.secret;
  expect((await admin.post('/devices', { id: VEH, kind: 'ugv', model: 'Rover' })).status).toBe(200);
  expect((await admin.post('/devices', { id: CAM, kind: 'cctv', model: 'SIYI A8 mini' })).status).toBe(200);
  expect((await admin.post('/devices', { id: AI, kind: 'cctv', model: 'Camera AI' })).status).toBe(200);

  gw = new WebSocket(`${srv.wsUrl}/api/v1/gateway`, { headers: { authorization: `Bearer ${key}` } });
  await new Promise((r) => gw.on('open', r));
  const hello = new Promise<any>((r) => gw.once('message', (m) => r(JSON.parse(String(m)))));
  gw.send(JSON.stringify({ t: 'hello', protocol: GATEWAY_PROTOCOL, gatewayId: 'edge-pi-r1', adapters: declarations }));
  welcome = await hello;
  expect(welcome.accepted.sort()).toEqual([AI, CAM, VEH].sort());
  // The fake camera does what it is told and confirms it.
  gw.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t !== 'camera') return;
    sent.push({ deviceId: m.deviceId, action: m.action, yaw: m.yaw, pitch: m.pitch, level: m.level });
    if (m.action === 'gimbal_angle') Object.assign(state.gimbal, { yaw: m.yaw, pitch: m.pitch });
    if (m.action === 'zoom_to') state.gimbal.zoom = m.level;
    gw.send(JSON.stringify({ t: 'camera_result', requestId: m.requestId, deviceId: m.deviceId, ok: true, confirmed: true, detail: `did ${m.action}` }));
  });
  telemetry();
  timer = setInterval(telemetry, 200);
  await waitFor(() => Date.now() - stored(CAM).lastSeen < 1000 && Date.now() - stored(VEH).lastSeen < 1000);
}, 30_000);
afterAll(async () => {
  clearInterval(timer);
  gw?.close();
  await srv?.close();
});

describe('a gimbal camera riding on a vehicle', () => {
  it('is the vehicle’s camera; a camera AI on the vehicle’s video is not, and only the AI gets a pass to read the video', async () => {
    const cam = (await op.get(`/devices/${CAM}`)).body;
    expect(cam).toMatchObject({ id: CAM, follows: VEH, noFix: true }); // no position of its own
    expect(plat().vehicleCamera(stored(VEH))?.id).toBe(CAM);
    expect(welcome.reads?.map((r) => r.deviceId)).toEqual([AI]);
  });

  it('is turned at a checkpoint only in a LIVE mode; the photo is taken either way', async () => {
    const job = { x: 230, y: 210, look: { pitch: -30, yaw: 45, zoom: 3 }, photo: true };
    // Registered real devices start in SHADOW: the camera is not moved.
    const first = await incident();
    sent.length = 0;
    plat().checkpointCamera(stored(VEH).orgId, stored(VEH), { id: 'MSN-R1', incidentId: first, checkpoints: [job] }, 0);
    expect(said(first, 'Camera at checkpoint 1 not turned')[0]?.detail).toBe(`${CAM} is in SHADOW mode. Camera moves need LIVE_MANUAL; a supervisor promotes the device.`);
    await waitFor(() => said(first, 'Photo taken at checkpoint 1').length > 0, 5000);
    expect(sent.filter((s) => s.action !== 'photo')).toEqual([]);

    // A supervisor promotes the camera: the checkpoint turns and zooms it, then it goes back to the front at 1×.
    expect((await sup.post('/auth/step-up', { password: 'longpassword1' })).status).toBe(200);
    const promoted = await sup.post(`/devices/${CAM}/mode-transitions`, { to: 'LIVE_MANUAL', reason: 'Gimbal tested on the bench with the Pi' });
    expect(promoted.status, JSON.stringify(promoted.body)).toBe(200);
    const second = await incident();
    sent.length = 0;
    plat().checkpointCamera(stored(VEH).orgId, stored(VEH), { id: 'MSN-R2', incidentId: second, checkpoints: [job] }, 0);
    await waitFor(() => said(second, 'Camera at checkpoint 1: down 30°, right 45°, 3×').length > 0, 5000);
    expect(said(second, 'Camera at checkpoint 1: down 30°')[0].detail).toBe(`On ${CAM}.`);
    expect(sent.slice(0, 2)).toEqual([
      { deviceId: CAM, action: 'gimbal_angle', yaw: 45, pitch: -30, level: undefined },
      { deviceId: CAM, action: 'zoom_to', yaw: undefined, pitch: undefined, level: 3 },
    ]);
    await waitFor(() => said(second, 'Photo taken at checkpoint 1').length > 0, 5000);
    await waitFor(() => sent.some((s) => s.action === 'zoom_to' && s.level === 1), 9000);
    expect(sent.find((s) => s.action === 'gimbal_angle' && s.yaw === 0)).toMatchObject({ deviceId: CAM, pitch: 0 });
    expect(sent.every((s) => s.deviceId === CAM)).toBe(true);
  }, 25_000);

  it('is pointed from where the vehicle is and the way it faces', async () => {
    const target = { x: 250, y: 200 }; // 50 m east of the vehicle
    const mount = (heading: number) => ({ bearingDeg: heading, heightM: 0.8, fovDeg: 50, rangeM: 150 });
    // Facing east: straight ahead.
    const ahead = await op.post(`/devices/${CAM}/aim`, target);
    expect(ahead.status, JSON.stringify(ahead.body)).toBe(200);
    expect(ahead.body.aim).toEqual(aimAt({ x: 200, y: 200 }, mount(90), target));
    expect(ahead.body.aim.yaw).toBe(0);
    expect(sent.at(-2)).toMatchObject({ deviceId: CAM, action: 'gimbal_angle', yaw: 0 });
    // The vehicle turns to face north: the same place is now 90° to the right.
    state.heading = 0;
    await waitFor(() => stored(VEH).heading === 0);
    expect((await op.post(`/devices/${CAM}/aim`, target)).body.aim.yaw).toBe(90);
    // No fix on the vehicle: the camera's place is unknown, so it is not pointed anywhere.
    state.pos = undefined;
    await waitFor(() => stored(VEH).noFix === true);
    const lost = await op.post(`/devices/${CAM}/aim`, target);
    expect(lost.status).toBe(409);
    expect(lost.body.error).toBe(`${CAM} rides on ${VEH}, which has no position fix, so it cannot be pointed at a place.`);
    state.pos = { x: 200, y: 200 };
    state.heading = 90;
    await waitFor(() => !stored(VEH).noFix && stored(VEH).heading === 90);
  });

  it('is left to the operator holding the vehicle', async () => {
    const veh = stored(VEH);
    veh.controlOwner = 'u-someone-else';
    try {
      const r = await op.post(`/devices/${CAM}/camera`, { action: 'center' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('not_control_owner');
      expect(r.body.error).toBe(`Another operator holds control of ${VEH}. Ask them to hand over control.`);
    } finally {
      veh.controlOwner = undefined;
    }
    expect((await op.post(`/devices/${CAM}/camera`, { action: 'center' })).body).toMatchObject({ ok: true, confirmed: true });
  });

  it('gives its tilt to the distances on the vehicle’s video', async () => {
    const r = await sup.req('PUT', `/devices/${VEH}/ranging`, { heightM: 0.8, tiltDeg: 10 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    state.gimbal.pitch = -25;
    await waitFor(() => stored(CAM).gimbal?.pitch === -25);
    expect(plat().rangingFor(stored(VEH)).gimbalPitch).toBe(-25);
    expect(plat().rangingFor(stored(AI)).gimbalPitch).toBe(-25); // the camera AI's boxes, on the same video
  });
});
