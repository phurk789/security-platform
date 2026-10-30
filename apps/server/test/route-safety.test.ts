// AUTO routes, phase 1: the platform holds a vehicle that leaves the operating area or runs low on
// battery, follows what the vehicle reports (interrupted on the remote, resumed, finished while held),
// ends a broken-off route as failed, and checks the zones again at start.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GwDeviceEvent, GwTelemetry, Point } from '@13store/shared';
import { Client, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client; // dispatcher
let nida: Client; // supervisor, operates
let ploy: Client; // admin, approves
const ORG = 'org-demo';

beforeAll(async () => {
  srv = await startServer();
  [alex, nida, ploy] = await Promise.all(['alex', 'nida', 'ploy'].map((u) => Client.login(srv.url, u)));
  // The whole demo plant is the operating area.
  const all = [
    { x: -5, y: -5 },
    { x: 425, y: -5 },
    { x: 425, y: 295 },
    { x: -5, y: 295 },
  ];
  expect((await nida.post('/geofences', { name: 'Plant', kind: 'operating_area', appliesTo: ['ugv', 'uav'], poly: all })).status).toBe(200);
}, 30_000);
afterAll(() => srv?.close());

type M = { id: string; status: string; note?: string; checkpoints: Point[] };
const mission = async (id: string) => ((await nida.get('/missions')).body as M[]).find((x) => x.id === id)!;
const status = (id: string, want: string, ms = 8000) => waitFor(async () => (await mission(id)).status === want, ms);

/** Drafted, approved by the administrator and accepted by the supervisor (two-person rule). */
async function accepted(deviceId: string) {
  const inc = await alex.post('/incidents', { title: `Route safety ${deviceId}`, place: 'Gate', pos: { x: 300, y: 200 } });
  await alex.post(`/incidents/${inc.body.id}/triage`);
  await alex.post(`/incidents/${inc.body.id}/confirm`);
  const plan = await alex.post('/routes/plan', { deviceId, incidentId: inc.body.id });
  expect(plan.body.ok).toBe(true);
  const m = await alex.post('/missions', { incidentId: inc.body.id, deviceId, operatorId: 'u-nida', checkpoints: plan.body.checkpoints });
  expect(m.status).toBe(200);
  expect((await alex.post(`/missions/${m.body.id}/submit`)).status).toBe(200);
  expect((await ploy.post(`/missions/${m.body.id}/approve`)).status).toBe(200);
  expect((await nida.post(`/missions/${m.body.id}/accept`)).status).toBe(200);
  return m.body as M;
}
async function running(deviceId: string) {
  const m = await accepted(deviceId);
  expect((await nida.post('/commands', { missionId: m.id, type: 'start', idempotencyKey: `${m.id}:start` })).status).toBe(200);
  await status(m.id, 'executing');
  return m;
}

// Samples injected as if from the vehicle, numbered past the simulator's own (which are then ignored).
let seq = 1_000_000_000;
const sample = (deviceId: string, extra: Partial<GwTelemetry>): GwTelemetry => {
  const d = srv.built.platform.listDevices(srv.built.platform.systemActor(ORG)).find((x) => x.id === deviceId)!;
  return { t: 'telemetry', deviceId, seq: ++seq, sourceTime: Date.now(), pos: d.pos, accuracyM: 1, speed: 1, quality: 'good', battery: 80, ...extra };
};
const event = (deviceId: string, kind: GwDeviceEvent['kind'], detail?: string) =>
  srv.built.platform.deviceEvent(ORG, { t: 'event', deviceId, at: Date.now(), kind, detail });

describe('AUTO routes: safety on the platform', () => {
  it('checks the zones again at start: a keep-out drawn across the route after approval refuses it', async () => {
    const m = await accepted('UGV-01');
    const c = m.checkpoints[0];
    const box = [
      { x: c.x - 3, y: c.y - 3 },
      { x: c.x + 3, y: c.y - 3 },
      { x: c.x + 3, y: c.y + 3 },
      { x: c.x - 3, y: c.y + 3 },
    ];
    const zone = await nida.post('/geofences', { name: 'Wet paint', kind: 'keep_out', poly: box });
    expect(zone.status).toBe(200);
    const r = await nida.post('/commands', { missionId: m.id, type: 'start', idempotencyKey: `${m.id}:start` });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Wet paint.*zones changed since approval/);
    await nida.post(`/missions/${m.id}/cancel`);
    await nida.req('DELETE', `/geofences/${zone.body.id}`);
  }, 30_000);

  it('holds a vehicle that leaves the operating area; a stop then ends the mission as failed', async () => {
    const m = await running('UGV-01');
    srv.built.platform.telemetry(ORG, sample('UGV-01', { pos: { x: 470, y: 200 } }));
    await status(m.id, 'paused');
    expect((await mission(m.id)).note).toMatch(/UGV-01 left the operating area/);
    const cmds = (await nida.get(`/commands?missionId=${m.id}`)).body as { type: string; status: string }[];
    expect(cmds.filter((c) => c.type === 'pause')).toHaveLength(1);
    expect((await nida.post('/commands', { missionId: m.id, type: 'stop', idempotencyKey: `${m.id}:stop` })).status).toBe(200);
    await status(m.id, 'failed');
    expect((await mission(m.id)).note).toMatch(/^Ended after: UGV-01 left the operating area/);
  }, 30_000);

  it('follows the vehicle: interrupted on the remote, resumed there, and finished while held', async () => {
    const m = await running('UGV-02');
    event('UGV-02', 'route_interrupted', 'Mode changed to MANUAL outside the platform (remote switch or vehicle failsafe) at checkpoint 1 of 3.');
    await status(m.id, 'paused');
    expect((await mission(m.id)).note).toMatch(/MANUAL/);
    event('UGV-02', 'route_resumed', 'Mode changed back to AUTO on the remote.');
    await status(m.id, 'executing');
    expect((await mission(m.id)).note).toBeUndefined();
    // Held at the last checkpoint a moment before the vehicle says it arrived: still completed.
    event('UGV-02', 'route_interrupted', 'Mode changed to HOLD.');
    await status(m.id, 'paused');
    event('UGV-02', 'route_complete');
    await status(m.id, 'completed');
  }, 30_000);

  it('warns once on low battery and holds at the hold level', async () => {
    const m = await running('UGV-03');
    srv.built.platform.telemetry(ORG, sample('UGV-03', { battery: 19 }));
    srv.built.platform.telemetry(ORG, sample('UGV-03', { battery: 18 }));
    const tl = () => (srv.db.prepare("SELECT id FROM timeline WHERE data LIKE '%UGV-03 battery low%'").all() as unknown[]).length;
    expect(tl()).toBe(1);
    expect((await mission(m.id)).status).toBe('executing');
    srv.built.platform.telemetry(ORG, sample('UGV-03', { battery: 14 }));
    await status(m.id, 'paused');
    expect((await mission(m.id)).note).toMatch(/Battery 14% on UGV-03/);
  }, 30_000);

});
