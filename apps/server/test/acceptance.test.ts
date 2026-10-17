// PRD §11 acceptance checks, run against the real server, database and simulated edge gateway.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, sleep, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client; // dispatcher
let nida: Client; // supervisor
let somchai: Client; // operator
let priya: Client; // auditor

const SHORT_ROUTE = [{ x: 232, y: 218 }];

beforeAll(async () => {
  srv = await startServer();
  [alex, nida, somchai, priya] = await Promise.all(['alex', 'nida', 'somchai', 'priya'].map((u) => Client.login(srv.url, u)));
}, 30_000);
afterAll(() => srv?.close());

async function mission(incidentId: string, route = SHORT_ROUTE) {
  await alex.post(`/incidents/${incidentId}/triage`);
  expect((await alex.post(`/incidents/${incidentId}/confirm`)).status).toBe(200);
  const m = await alex.post('/missions', { incidentId, deviceId: 'UGV-01', operatorId: 'u-somchai', checkpoints: route });
  expect(m.status).toBe(200);
  expect((await alex.post(`/missions/${m.body.id}/submit`)).status).toBe(200);
  return m.body.id as string;
}

async function approvedAndAccepted(incidentId: string, route = SHORT_ROUTE) {
  const id = await mission(incidentId, route);
  expect((await nida.post(`/missions/${id}/approve`)).status).toBe(200);
  expect((await somchai.post(`/missions/${id}/accept`)).status).toBe(200);
  return id;
}

async function cmdStatus(id: string) {
  return (await somchai.get(`/commands?missionId=${id}`)).body as any[];
}

describe('end-to-end incident and mission', () => {
  it('runs from alert to closed incident with evidence, report and audit', async () => {
    const id = await approvedAndAccepted('INC-024');
    const start = await somchai.post('/commands', { missionId: id, type: 'start', idempotencyKey: `${id}:start:0` });
    expect(start.status).toBe(200);
    expect(['authorized', 'sent']).toContain(start.body.status);
    // Not executing until the vehicle confirms.
    expect((await alex.get(`/missions/${id}`)).body.status).toBe('assigned');
    await waitFor(async () => (await cmdStatus(id))[0]?.status === 'succeeded');
    await waitFor(async () => (await alex.get(`/missions/${id}`)).body.status === 'completed', 15_000);
    await waitFor(async () => ((await alex.get('/incidents/INC-024/evidence')).body as any[]).some((e) => e.source === 'UGV-01'));
    const ev = ((await alex.get('/incidents/INC-024/evidence')).body as any[]).find((e) => e.source === 'UGV-01');
    expect(ev.checksum).toMatch(/^[0-9a-f]{64}$/);

    expect((await alex.post('/incidents/INC-024/resolve', { outcome: 'Gate closed. No intrusion.' })).status).toBe(200);
    expect((await alex.post('/incidents/INC-024/close')).status).toBe(200);

    const report = await priya.get('/incidents/INC-024/report?download=1');
    expect(report.status).toBe(200);
    expect(report.body).toContain('approved v1 by Nida W.');
    expect(report.body).toContain(ev.id);
    const audit = (await priya.get('/audit')).body as any[];
    expect(audit.some((a) => a.action === 'report.export' && a.object === 'INC-024')).toBe(true);
    expect((await priya.get('/audit/verify')).body.ok).toBe(true);
  }, 40_000);
});

describe('permissions are enforced by the server', () => {
  it('a dispatcher cannot approve, even calling the API directly', async () => {
    const inc = (await alex.post('/incidents', { title: 'Test approval', place: 'Lot', zone: 'Zone A' })).body;
    const id = await mission(inc.id);
    const r = await alex.post(`/missions/${id}/approve`);
    expect(r.status).toBe(403);
    const audit = (await nida.get('/audit')).body as any[];
    expect(audit.find((a) => a.action === 'mission.approve' && a.object === id)?.result).toBe('denied');
    await alex.post(`/missions/${id}/cancel`);
  });

  it('an auditor cannot send commands; a supervisor without control is refused', async () => {
    const inc = (await alex.post('/incidents', { title: 'Control lock', place: 'Lot' })).body;
    const id = await approvedAndAccepted(inc.id);
    expect((await priya.post('/commands', { missionId: id, type: 'start', idempotencyKey: 'x1' })).status).toBe(403);
    const r = await nida.post('/commands', { missionId: id, type: 'start', idempotencyKey: 'x2' });
    expect(r.status).toBe(403); // supervisors have no device.command permission at all
    await alex.post(`/missions/${id}/cancel`);
  });

  it('changing the route after approval forces re-approval', async () => {
    const inc = (await alex.post('/incidents', { title: 'Re-approval', place: 'Lot' })).body;
    const id = await approvedAndAccepted(inc.id);
    const e = await alex.patch(`/missions/${id}/route`, { checkpoints: [{ x: 240, y: 210 }] });
    expect(e.body.status).toBe('pending_approval');
    const s = await somchai.post('/commands', { missionId: id, type: 'start', idempotencyKey: `${id}-s` });
    expect(s.status).toBe(409);
    await alex.post(`/missions/${id}/cancel`);
  });

  it('replay consoles cannot change anything', async () => {
    const replay = new Client(srv.url, 'replay');
    replay.token = alex.token;
    const r = await replay.post('/incidents', { title: 'From replay' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('replay_mode');
  });
});

describe('command certainty', () => {
  it('the same idempotency key never creates a second command', async () => {
    const inc = (await alex.post('/incidents', { title: 'Idempotency', place: 'Lot' })).body;
    const id = await approvedAndAccepted(inc.id, [{ x: 250, y: 214 }]);
    const key = `${id}:start:0`;
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => somchai.post('/commands', { missionId: id, type: 'start', idempotencyKey: key })));
    expect(new Set([a.body.id, b.body.id, c.body.id]).size).toBe(1);
    expect((await cmdStatus(id)).length).toBe(1);
    await waitFor(async () => (await alex.get(`/missions/${id}`)).body.status === 'completed', 15_000);
  }, 30_000);

  it('network loss: stale data, held commands, failsafe, and no replay after reconnect', async () => {
    const inc = (await alex.post('/incidents', { title: 'Link loss', place: 'Lot' })).body;
    const id = await approvedAndAccepted(inc.id, [{ x: 300, y: 222 }, { x: 320, y: 224 }]);
    await somchai.post('/commands', { missionId: id, type: 'start', idempotencyKey: `${id}:start` });
    await waitFor(async () => (await alex.get(`/missions/${id}`)).body.status === 'executing');
    await sleep(600);

    expect((await alex.post('/demo/link', { deviceId: 'UGV-01', cut: true })).status).toBe(200);
    // A stop request while the link is down must not be shown as done.
    const stop = await somchai.post('/commands', { missionId: id, type: 'stop', idempotencyKey: `${id}:stop` });
    expect(stop.status).toBe(200);
    await waitFor(async () => (await cmdStatus(id)).find((c) => c.type === 'stop')?.status === 'timed_out', 8000);
    expect((await alex.get(`/missions/${id}`)).body.status).not.toBe('cancelled');

    await waitFor(async () => {
      const d = (await alex.get('/devices/UGV-01')).body;
      return Date.now() - d.lastSeen > 5500;
    }, 8000);
    const posAtLoss = (await alex.get('/devices/UGV-01')).body.pos;
    const resume = await somchai.post('/commands', { missionId: id, type: 'resume', idempotencyKey: `${id}:resume` });
    expect(resume.status).toBe(409);

    expect((await alex.post('/demo/link', { deviceId: 'UGV-01', cut: false })).status).toBe(200);
    await waitFor(async () => (await alex.get(`/missions/${id}`)).body.status === 'paused', 8000);
    // The vehicle rolls on until its own failsafe trips (~1.5 s), then stays put after reconnect.
    await waitFor(async () => Date.now() - (await alex.get('/devices/UGV-01')).body.lastSeen < 300, 5000);
    await sleep(300);
    const atReconnect = (await alex.get('/devices/UGV-01')).body.pos;
    expect(Math.hypot(atReconnect.x - posAtLoss.x, atReconnect.y - posAtLoss.y)).toBeLessThan(15);
    await sleep(1500);
    const after = (await alex.get('/devices/UGV-01')).body;
    // Reported fixes carry GNSS noise (< ~1 m); driving would cover ~9 m in this time.
    expect(after.speed).toBe(0);
    expect(Math.hypot(after.pos.x - atReconnect.x, after.pos.y - atReconnect.y)).toBeLessThan(3);
    const stopCmd = (await cmdStatus(id)).find((c) => c.type === 'stop');
    expect(stopCmd.delivered).toBe(false);
    const timeline = (await alex.get(`/incidents/${inc.id}/timeline`)).body as any[];
    expect(timeline.some((e) => /failsafe/.test(e.title))).toBe(true);

    // Clean up: operator stops the paused mission.
    await somchai.post('/commands', { missionId: id, type: 'stop', idempotencyKey: `${id}:stop2` });
    await waitFor(async () => (await alex.get(`/missions/${id}`)).body.status === 'cancelled', 8000);
  }, 45_000);
});

describe('telemetry realism', () => {
  it('devices report heading, link quality, satellites and measured latency; history keeps them', async () => {
    await waitFor(async () => (await alex.get('/devices/UGV-01')).body.latencyMs !== undefined);
    const d = (await alex.get('/devices/UGV-01')).body;
    expect(d.signal).toBeGreaterThan(20);
    expect(d.signal).toBeLessThanOrEqual(99);
    expect(d.satellites).toBeGreaterThan(5);
    expect(d.heading).toBeGreaterThanOrEqual(0);
    expect(d.latencyMs).toBeGreaterThanOrEqual(30); // simulated radio + backhaul delay
    expect(d.latencyMs).toBeLessThan(1000);
    expect(d.accuracyM).toBeGreaterThanOrEqual(0.8);
    const hist = (await alex.get(`/devices/UGV-01/telemetry?from=${Date.now() - 60_000}`)).body as any[];
    expect(hist.length).toBeGreaterThan(3);
    const last = hist[hist.length - 1];
    expect(last.latencyMs).toBe(last.receivedTime - last.sourceTime);
    expect(last.signal).toBeGreaterThan(0);
    expect(typeof last.heading).toBe('number');
  });
});

describe('duplicates and evidence', () => {
  it('merging a duplicate keeps the original evidence', async () => {
    const dupe = (await alex.post('/demo/inject-alert')).body;
    const note = await alex.post(`/incidents/${dupe.id}/evidence`, { text: 'Second trigger, same camera' });
    expect(note.status).toBe(200);
    const target = (await alex.post('/incidents', { title: 'Primary gate alert', place: 'Service gate' })).body;
    expect((await alex.post(`/incidents/${dupe.id}/merge`, { intoId: target.id, reason: '' })).status).toBe(400);
    expect((await alex.post(`/incidents/${dupe.id}/merge`, { intoId: target.id, reason: 'Same sensor' })).status).toBe(200);
    const list = (await alex.get(`/incidents/${target.id}/evidence`)).body as any[];
    expect(list.map((e) => e.id)).toContain(note.body.id);
    const content = await alex.get(`/evidence/${note.body.id}/content`);
    expect(content.status).toBe(200);
    expect(content.headers.get('x-integrity')).toBe('ok');
  });

  it('dispatchers can view evidence but not export it', async () => {
    const list = (await alex.get('/incidents/INC-024/evidence')).body as any[];
    expect((await alex.get(`/evidence/${list[0].id}/content?download=1`)).status).toBe(403);
    expect((await priya.get(`/evidence/${list[0].id}/content?download=1`)).status).toBe(200);
  });
});
