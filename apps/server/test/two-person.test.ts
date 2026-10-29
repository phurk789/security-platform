// Roles as levels with the two-person rule: a supervisor (or administrator) may operate a vehicle,
// but never a mission they approved, and a patrol's creator (its standing approver) is not its operator.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client; // dispatcher
let nida: Client; // supervisor
let somchai: Client; // operator
let ploy: Client; // admin

beforeAll(async () => {
  srv = await startServer();
  [alex, nida, somchai, ploy] = await Promise.all(['alex', 'nida', 'somchai', 'ploy'].map((u) => Client.login(srv.url, u)));
}, 30_000);
afterAll(() => srv?.close());

async function draft(deviceId: string, operatorId: string) {
  const inc = await alex.post('/incidents', { title: `Two-person ${deviceId}`, place: 'Gate', pos: { x: 300, y: 200 } });
  await alex.post(`/incidents/${inc.body.id}/triage`);
  await alex.post(`/incidents/${inc.body.id}/confirm`);
  const plan = await alex.post('/routes/plan', { deviceId, incidentId: inc.body.id });
  expect(plan.body.ok).toBe(true);
  const m = await alex.post('/missions', { incidentId: inc.body.id, deviceId, operatorId, checkpoints: plan.body.checkpoints });
  expect(m.status).toBe(200);
  expect((await alex.post(`/missions/${m.body.id}/submit`)).status).toBe(200);
  return { id: m.body.id as string, checkpoints: plan.body.checkpoints };
}

describe('two-person rule', () => {
  it('lets a supervisor operate a mission someone else approved, never one they approve themselves', async () => {
    const m = await draft('UGV-01', 'u-nida');
    const own = await nida.post(`/missions/${m.id}/approve`);
    expect(own.status).toBe(409);
    expect(own.body.error).toMatch(/two-person rule/);
    expect((await ploy.post(`/missions/${m.id}/approve`)).status).toBe(200); // the administrator approves
    expect((await nida.post(`/missions/${m.id}/accept`)).status).toBe(200); // the supervisor operates
    const start = await nida.post('/commands', { missionId: m.id, type: 'start', idempotencyKey: `${m.id}:start:0` });
    expect(start.status).toBe(200);
    await waitFor(async () => ((await nida.get('/missions')).body as { id: string; status: string }[]).find((x) => x.id === m.id)?.status === 'executing', 8000);
    expect((await nida.post('/commands', { missionId: m.id, type: 'stop', idempotencyKey: `${m.id}:stop:0` })).status).toBe(200);
  });

  it('refuses a start from the approver even after control was handed to them', async () => {
    const m = await draft('UGV-02', 'u-somchai');
    expect((await nida.post(`/missions/${m.id}/approve`)).status).toBe(200);
    expect((await somchai.post(`/missions/${m.id}/accept`)).status).toBe(200);
    expect((await nida.post('/devices/UGV-02/handover', { toUserId: 'u-nida' })).status).toBe(200);
    const start = await nida.post('/commands', { missionId: m.id, type: 'start', idempotencyKey: `${m.id}:start:0` });
    expect(start.status).toBe(409);
    expect(start.body.error).toMatch(/approved this mission/);
    expect((await nida.post(`/missions/${m.id}/cancel`)).status).toBe(200);
  });

  it('keeps a patrol creator from being its operator', async () => {
    const route = [
      { x: 262, y: 200 },
      { x: 300, y: 200 },
    ];
    const base = { name: 'Gate loop', deviceId: 'UGV-03', days: [1], times: ['22:00'], route };
    const self = await nida.post('/patrols', { ...base, operatorId: 'u-nida' });
    expect(self.status).toBe(400);
    expect(self.body.error).toMatch(/two-person rule/);
    const ok = await nida.post('/patrols', { ...base, operatorId: 'u-ploy' }); // an administrator may operate
    expect(ok.status).toBe(200);
    await nida.req('DELETE', `/patrols/${ok.body.id}`);
  });
});
