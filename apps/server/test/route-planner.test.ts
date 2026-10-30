// AUTO routes, phase 2: checkpoints carry a name, a speed, a wait and a capture flag; routes are
// kept in a library per site; a capture point keeps the view there as evidence.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoutePoint } from '@13store/shared';
import { Client, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client; // dispatcher
let nida: Client; // supervisor, operates
let ploy: Client; // admin, approves
const ORG = 'org-demo';

beforeAll(async () => {
  srv = await startServer();
  [alex, nida, ploy] = await Promise.all(['alex', 'nida', 'ploy'].map((u) => Client.login(srv.url, u)));
}, 30_000);
afterAll(() => srv?.close());

async function incident() {
  const inc = await alex.post('/incidents', { title: 'Route planner', place: 'Gate', pos: { x: 300, y: 200 } });
  await alex.post(`/incidents/${inc.body.id}/triage`);
  await alex.post(`/incidents/${inc.body.id}/confirm`);
  return inc.body.id as string;
}
async function planned(incidentId: string, deviceId = 'UGV-01') {
  const plan = await alex.post('/routes/plan', { deviceId, incidentId });
  expect(plan.body.ok).toBe(true);
  return plan.body.checkpoints as RoutePoint[];
}

describe('route planner on the server', () => {
  it('keeps each checkpoint’s name, speed, wait and capture, and refuses settings out of range', async () => {
    const incidentId = await incident();
    const pts = await planned(incidentId);
    const set = pts.map((p, i) => (i === 0 ? { ...p, name: '  Service gate  ', speed: 1.25, holdS: 12.4, capture: true, colour: 'red' } : p));
    const m = await alex.post('/missions', { incidentId, deviceId: 'UGV-01', operatorId: 'u-nida', checkpoints: set });
    expect(m.status).toBe(200);
    expect(m.body.checkpoints[0]).toEqual({ x: pts[0].x, y: pts[0].y, name: 'Service gate', speed: 1.3, holdS: 12, capture: true });
    const fast = await alex.patch(`/missions/${m.body.id}/route`, { checkpoints: [{ ...pts[0], speed: 9 }] });
    expect(fast.status).toBe(400);
    expect(fast.body.error).toMatch(/Checkpoint 1: speed must be 0.2–5 m\/s/);
    const long = await alex.patch(`/missions/${m.body.id}/route`, { checkpoints: [{ ...pts[0], holdS: 999 }] });
    expect(long.body.error).toMatch(/the wait must be 0–300 s/);
    await alex.post(`/missions/${m.body.id}/cancel`);
  });

  it('keeps routes in a library per site: save, rename, list, refuse keep-out and duplicate names, delete', async () => {
    const incidentId = await incident();
    const pts = await planned(incidentId);
    const saved = await alex.post('/saved-routes', { name: 'Night loop', points: pts.map((p, i) => (i === 0 ? { ...p, name: 'Gate', holdS: 5 } : p)) });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: 'Night loop', points: expect.arrayContaining([expect.objectContaining({ name: 'Gate', holdS: 5 })]) });
    expect((await alex.post('/saved-routes', { name: 'night LOOP', points: pts })).status).toBe(409);
    const renamed = await alex.patch(`/saved-routes/${saved.body.id}`, { name: 'Night loop A' });
    expect(renamed.body.name).toBe('Night loop A');
    expect(renamed.body.points).toHaveLength(pts.length);
    const list = (await nida.get('/saved-routes')).body as { id: string; name: string }[];
    expect(list.map((r) => r.name)).toContain('Night loop A');
    // A keep-out zone on the first checkpoint: the route can no longer be saved through it.
    const c = pts[0];
    const zone = await nida.post('/geofences', {
      name: 'Wet paint',
      kind: 'keep_out',
      poly: [
        { x: c.x - 3, y: c.y - 3 },
        { x: c.x + 3, y: c.y - 3 },
        { x: c.x + 3, y: c.y + 3 },
        { x: c.x - 3, y: c.y + 3 },
      ],
    });
    const blocked = await alex.patch(`/saved-routes/${saved.body.id}`, { points: pts });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatch(/Wet paint/);
    await nida.req('DELETE', `/geofences/${zone.body.id}`);
    expect((await alex.req('DELETE', `/saved-routes/${saved.body.id}`)).status).toBe(200);
    expect(((await alex.get('/saved-routes')).body as unknown[]).length).toBe(0);
    expect((await alex.req('DELETE', `/saved-routes/${saved.body.id}`)).status).toBe(404);
  });

  it('keeps the view at a capture point as evidence, named after the checkpoint', async () => {
    const incidentId = await incident();
    const pts = await planned(incidentId);
    const set = pts.map((p, i) => (i === 0 ? { ...p, name: 'Gate', holdS: 1, capture: true } : p));
    const m = await alex.post('/missions', { incidentId, deviceId: 'UGV-01', operatorId: 'u-nida', checkpoints: set });
    expect((await alex.post(`/missions/${m.body.id}/submit`)).status).toBe(200);
    expect((await ploy.post(`/missions/${m.body.id}/approve`)).status).toBe(200);
    expect((await nida.post(`/missions/${m.body.id}/accept`)).status).toBe(200);
    expect((await nida.post('/commands', { missionId: m.body.id, type: 'start', idempotencyKey: `${m.body.id}:start` })).status).toBe(200);
    await waitFor(async () => ((await nida.get(`/missions/${m.body.id}`)).body as { status: string }).status === 'executing', 8000);
    srv.built.platform.deviceEvent(ORG, { t: 'event', deviceId: 'UGV-01', at: Date.now(), kind: 'checkpoint', checkpoint: 0 });
    const clips = async () => ((await nida.get(`/incidents/${incidentId}/evidence`)).body as { kind: string; title: string }[]).filter((e) => e.kind === 'clip');
    await waitFor(async () => (await clips()).length > 0, 12_000);
    const tl = srv.db.prepare("SELECT data FROM timeline WHERE incident_id = ? AND data LIKE '%passed checkpoint 1 (Gate)%'").all(incidentId);
    expect(tl.length).toBeGreaterThan(0);
    await nida.post('/commands', { missionId: m.body.id, type: 'stop', idempotencyKey: `${m.body.id}:stop` });
  }, 30_000);
});
