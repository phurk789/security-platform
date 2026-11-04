// Routine tasks: a mission planned on the mission planning page without an alert. The platform
// raises the incident record itself (like a patrol run), so approvals, timeline and audit stay the same.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RoutePoint } from '@13store/shared';
import { Client, startServer, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client; // dispatcher
let ploy: Client; // admin, approves

beforeAll(async () => {
  srv = await startServer();
  [alex, ploy] = await Promise.all(['alex', 'ploy'].map((u) => Client.login(srv.url, u)));
}, 30_000);
afterAll(() => srv?.close());

/** A route the demo site accepts: planned to a confirmed incident's spot. */
async function safeRoute() {
  const inc = await alex.post('/incidents', { title: 'Routine task route', place: 'Gate', pos: { x: 300, y: 200 } });
  await alex.post(`/incidents/${inc.body.id}/triage`);
  await alex.post(`/incidents/${inc.body.id}/confirm`);
  const plan = await alex.post('/routes/plan', { deviceId: 'UGV-01', incidentId: inc.body.id });
  expect(plan.body.ok).toBe(true);
  return plan.body.checkpoints as RoutePoint[];
}

describe('routine task missions', () => {
  it('raises a confirmed task record, drafts the mission on it, and keeps the usual approval', async () => {
    const checkpoints = await safeRoute();
    const m = await alex.post('/missions', { task: '  North   fence check ', deviceId: 'UGV-01', operatorId: 'u-nida', checkpoints });
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ status: 'draft', deviceId: 'UGV-01', planVersion: 1 });
    const inc = await alex.get(`/incidents/${m.body.incidentId}`);
    expect(inc.body).toMatchObject({ title: 'Task: North fence check', type: 'Routine task', status: 'confirmed', severity: 'low', place: 'North fence check' });
    expect(inc.body.pos).toEqual({ x: checkpoints[checkpoints.length - 1].x, y: checkpoints[checkpoints.length - 1].y });
    const timeline = (await alex.get(`/incidents/${m.body.incidentId}/timeline`)).body as { title: string }[];
    expect(timeline.map((e) => e.title)).toEqual(expect.arrayContaining(['Routine task created', `Mission ${m.body.id} drafted`]));
    // Same flow as any mission: submitted by the dispatcher, approved by someone else.
    expect((await alex.post(`/missions/${m.body.id}/submit`)).status).toBe(200);
    expect((await ploy.post(`/missions/${m.body.id}/approve`)).body.status).toBe('approved');
    await alex.post(`/missions/${m.body.id}/cancel`);
  });

  it('needs an incident or a task name of up to 60 characters, and raises nothing when refused', async () => {
    const checkpoints = await safeRoute();
    const before = ((await alex.get('/incidents')).body as unknown[]).length;
    const none = await alex.post('/missions', { deviceId: 'UGV-01', operatorId: 'u-nida', checkpoints });
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/Choose an incident, or name the routine task/);
    expect((await alex.post('/missions', { task: 'x'.repeat(61), deviceId: 'UGV-01', operatorId: 'u-nida', checkpoints })).status).toBe(400);
    expect((await alex.post('/missions', { task: '   ', deviceId: 'UGV-01', operatorId: 'u-nida', checkpoints })).status).toBe(400);
    // A route through a keep-out zone is refused before any task record is raised.
    const bad = await alex.post('/missions', { task: 'Bad route', deviceId: 'UGV-01', operatorId: 'u-nida', checkpoints: [{ x: -5000, y: -5000 }] });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(((await alex.get('/incidents')).body as unknown[]).length).toBe(before);
  });

  it('is refused for a role that may not prepare missions', async () => {
    const somchai = await Client.login(srv.url, 'somchai');
    const checkpoints = await safeRoute();
    const r = await somchai.post('/missions', { task: 'Not mine', deviceId: 'UGV-01', operatorId: 'u-nida', checkpoints });
    expect(r.status).toBe(403);
  });
});
