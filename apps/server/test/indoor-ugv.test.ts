// UGV-04 (indoor, Building 2 level 1): planned on its floor, limited to walking pace, SLAM telemetry,
// and refused outdoor patrol routes.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INDOOR_UGV_SPEED, floorPlan, newMotion, planFor, rankUnits, readSensors, newSensors, seedDevices, stepMotion } from '@13store/shared';
import { Client, startServer, type TestServer } from './helpers';

const u4 = seedDevices(Date.now())['UGV-04'];

describe('indoor planning', () => {
  it('refuses an alert outside its building with a clear reason, and goes straight to one on its floor', () => {
    const out = planFor(u4, { x: 335, y: 236 });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.reason).toMatch(/Indoor only.*Building 2.*outside the building/);
    const plan = floorPlan('B2', 1)!;
    const inside = planFor(u4, plan.patrolRoute[1]);
    expect(inside.ok).toBe(true);
    // Ranking keeps indoor units with their reason instead of an impossible outdoor route.
    const ranked = rankUnits([u4, seedDevices(Date.now())['UGV-01']], { x: 335, y: 236 }, []);
    expect(ranked[0].unit.id).toBe('UGV-01');
    expect(ranked.find((r) => r.unit.id === 'UGV-04')?.plan.ok).toBe(false);
  });

  it('drives at walking pace and reports SLAM positioning (no satellites)', () => {
    const m = newMotion(u4.pos, 0, INDOOR_UGV_SPEED);
    m.route = [{ x: u4.pos.x, y: u4.pos.y - 40 }];
    m.intent = 'drive';
    let top = 0;
    for (let i = 0; i < 400; i++) {
      stepMotion(m, 0.05);
      top = Math.max(top, m.speed);
    }
    expect(top).toBeLessThanOrEqual(INDOOR_UGV_SPEED + 1e-9);
    const r = readSensors(newSensors(90, 'ugv'), u4.pos, 'ugv', { slam: true });
    expect(r.satellites).toBe(0);
    expect(r.accuracyM).toBeLessThanOrEqual(0.6);
  });
});

describe('indoor vehicle on the platform', () => {
  let srv: TestServer;
  let alex: Client;
  let nida: Client;
  beforeAll(async () => {
    srv = await startServer();
    [alex, nida] = await Promise.all([Client.login(srv.url, 'alex'), Client.login(srv.url, 'nida')]);
  }, 30_000);
  afterAll(() => srv?.close());

  it('route planning explains why UGV-04 cannot reach an outdoor alert', async () => {
    const r = await alex.post('/routes/plan', { deviceId: 'UGV-04', incidentId: 'INC-024' });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(false);
    expect(r.body.reason).toMatch(/Indoor only/);
    const sug = (await alex.get('/incidents/INC-024/suggest')).body as any[];
    expect(sug.find((x) => x.deviceId === 'UGV-04')?.reason).toMatch(/Indoor only/);
  });

  it('patrols for UGV-04 must stay on its floor', async () => {
    const outdoor = await nida.post('/patrols', {
      name: 'Bad',
      deviceId: 'UGV-04',
      operatorId: 'u-somchai',
      route: [
        { x: 300, y: 200 },
        { x: 330, y: 230 },
      ],
      days: [1],
      times: ['22:00'],
    });
    expect(outdoor.status).toBe(400);
    expect(JSON.stringify(outdoor.body)).toMatch(/indoor vehicle/);
    const ok = await nida.post('/patrols', {
      name: 'B2 night round',
      deviceId: 'UGV-04',
      operatorId: 'u-somchai',
      route: floorPlan('B2', 1)!.patrolRoute,
      days: [1],
      times: ['22:00'],
    });
    expect(ok.status).toBe(200);
  });
});
