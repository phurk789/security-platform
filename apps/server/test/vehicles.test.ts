// Vehicles: route planning around buildings and keep-out zones, geofences (routes refused,
// live breach), unit suggestion, scheduled patrols with standing approval, usage counters and
// service records.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BUILDINGS, DEFAULT_GEOFENCES, FENCE_Y, GATE, insidePoly, planRoute, routeViolations, segmentHitsPoly } from '@13store/shared';
import { nextRun } from '../src/platform';
import { Client, sleep, startServer, waitFor, type TestServer } from './helpers';

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

const hitsBuilding = (pts: { x: number; y: number }[]) => {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    for (let t = 0; t <= 1; t += 0.02) {
      const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
      if (BUILDINGS.some((bl) => p.x > bl.x + 0.5 && p.x < bl.x + bl.w - 0.5 && p.y > bl.y + 0.5 && p.y < bl.y + bl.d - 0.5)) return true;
    }
  }
  return false;
};

describe('route planner', () => {
  it('goes around Building 4 instead of through it, and stays inside the site', () => {
    // From the parking row to the far side of Building 4 (x 300–374, y 128–186).
    const plan = planRoute({ x: 262, y: 218 }, { x: 384, y: 150 }, { fences: DEFAULT_GEOFENCES, kind: 'ugv' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.checkpoints.length).toBeGreaterThan(1);
    expect(plan.checkpoints.length).toBeLessThanOrEqual(50);
    expect(hitsBuilding([{ x: 262, y: 218 }, ...plan.checkpoints])).toBe(false);
    expect(plan.checkpoints[plan.checkpoints.length - 1]).toEqual({ x: 384, y: 150 });
    expect(plan.lengthM).toBeGreaterThan(130);
    expect(plan.etaS).toBeGreaterThan(15);
  });

  it('keeps ground vehicles out of keep-out zones and refuses destinations inside them', () => {
    const fuel = DEFAULT_GEOFENCES.find((g) => g.id === 'GF-FUEL')!;
    // Straight line from UGV-03's spot to the north of the fuel store would clip the zone.
    const plan = planRoute({ x: 60, y: 214 }, { x: 40, y: 125 }, { fences: DEFAULT_GEOFENCES, kind: 'ugv' });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      const pts = [{ x: 60, y: 214 }, ...plan.checkpoints];
      for (let i = 1; i < pts.length; i++) expect(segmentHitsPoly(pts[i - 1], pts[i], fuel.poly)).toBe(false);
    }
    const inside = planRoute({ x: 60, y: 214 }, { x: 44, y: 160 }, { fences: DEFAULT_GEOFENCES, kind: 'ugv' });
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.reason).toMatch(/keep-out zone "Fuel store/);
    // Without the fence the same destination is fine.
    expect(planRoute({ x: 60, y: 214 }, { x: 44, y: 160 }, { kind: 'ugv' }).ok).toBe(true);
  });

  it('uses the gate to cross the fence and refuses places outside the site', () => {
    const plan = planRoute({ x: 262, y: 218 }, { x: 335, y: 236 }, { kind: 'ugv' });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      const pts = [{ x: 262, y: 218 }, ...plan.checkpoints];
      // Any crossing of the fence line happens inside the gate span.
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if ((a.y - FENCE_Y) * (b.y - FENCE_Y) < 0) {
          const x = a.x + ((FENCE_Y - a.y) / (b.y - a.y)) * (b.x - a.x);
          expect(x).toBeGreaterThan(GATE.x - 1);
          expect(x).toBeLessThan(GATE.x + GATE.w + 1);
        }
      }
    }
    expect(planRoute({ x: 262, y: 218 }, { x: 500, y: 100 }, { kind: 'ugv' }).ok).toBe(false);
  });

  it('aircraft ignore buildings and keep-out zones for ground vehicles but respect no-fly zones', () => {
    const over = planRoute({ x: 318, y: 146 }, { x: 110, y: 146 }, { fences: DEFAULT_GEOFENCES, kind: 'uav' });
    expect(over.ok).toBe(true);
    if (over.ok) {
      const noFly = DEFAULT_GEOFENCES.find((g) => g.id === 'GF-B2-ROOF')!;
      const pts = [{ x: 318, y: 146 }, ...over.checkpoints];
      for (let i = 1; i < pts.length; i++) expect(segmentHitsPoly(pts[i - 1], pts[i], noFly.poly)).toBe(false);
    }
    expect(routeViolations([{ x: 110, y: 146 }], { x: 318, y: 146 }, DEFAULT_GEOFENCES, 'uav').map((g) => g.id)).toEqual(['GF-B2-ROOF']);
    expect(routeViolations([{ x: 110, y: 146 }], { x: 318, y: 146 }, DEFAULT_GEOFENCES, 'ugv')).toEqual([]);
    expect(insidePoly({ x: 44, y: 160 }, DEFAULT_GEOFENCES[0].poly)).toBe(true);
  });

  it('computes the next patrol time in the organisation time zone, wrapping the week', () => {
    // Thursday 2026-01-01 10:00 Bangkok = 03:00 UTC.
    const thu10 = Date.UTC(2026, 0, 1, 3, 0, 0);
    expect(nextRun(thu10, [4], ['22:00'], 'Asia/Bangkok')).toBe(Date.UTC(2026, 0, 1, 15, 0, 0));
    expect(nextRun(thu10, [4], ['09:00'], 'Asia/Bangkok')).toBe(Date.UTC(2026, 0, 8, 2, 0, 0)); // next Thursday
    expect(nextRun(thu10, [1], ['06:30'], 'Asia/Bangkok')).toBe(Date.UTC(2026, 0, 4, 23, 30, 0)); // Monday 06:30 = Sunday 23:30 UTC
    expect(nextRun(thu10, [0, 1, 2, 3, 4, 5, 6], ['10:00'], 'Asia/Bangkok')).toBe(Date.UTC(2026, 0, 2, 3, 0, 0));
  });
});

describe('geofences on the platform', () => {
  it('ships defaults, lets a supervisor add a zone, and refuses a route through it', async () => {
    const list = (await alex.get('/geofences')).body as any[];
    expect(list.map((g) => g.id.replace(/^.*GF-/, 'GF-'))).toEqual(['GF-FUEL', 'GF-B2-ROOF', 'GF-PLAZA']);
    expect(
      (
        await alex.post('/geofences', {
          name: 'x',
          kind: 'keep_out',
          poly: [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
            { x: 2, y: 2 },
          ],
        })
      ).status,
    ).toBe(403);
    // A crane lift in the car park, right on the default route to the gate.
    const g = await nida.post('/geofences', {
      name: 'Crane lift',
      kind: 'keep_out',
      appliesTo: ['ugv'],
      reason: 'Crane working',
      poly: [
        { x: 300, y: 212 },
        { x: 324, y: 212 },
        { x: 324, y: 232 },
        { x: 300, y: 232 },
      ],
    });
    expect(g.status).toBe(200);
    expect(g.body.id).toMatch(/^GF-\d{3}$/);
    expect(((await alex.get('/geofences')).body as any[]).some((x) => x.id === g.body.id)).toBe(true);

    await alex.post('/incidents/INC-024/triage');
    await alex.post('/incidents/INC-024/confirm');
    const bad = await alex.post('/missions', {
      incidentId: 'INC-024',
      deviceId: 'UGV-01',
      operatorId: 'u-somchai',
      checkpoints: [
        { x: 262, y: 218 },
        { x: 312, y: 222 },
        { x: 334, y: 228 },
      ],
    });
    expect(bad.status).toBe(409);
    expect(bad.body.error).toMatch(/keep-out zone "Crane lift"/);
    // Planned around it, the route is accepted and the checks pass the zone test.
    const plan = await alex.post('/routes/plan', { deviceId: 'UGV-01', incidentId: 'INC-024' });
    expect(plan.status).toBe(200);
    expect(plan.body.ok).toBe(true);
    const m = await alex.post('/missions', { incidentId: 'INC-024', deviceId: 'UGV-01', operatorId: 'u-somchai', checkpoints: plan.body.checkpoints });
    expect(m.status).toBe(200);
    const checks = (await alex.get(`/missions/${m.body.id}/checks`)).body as any[];
    expect(checks.find((c) => c.label === 'Route clear of keep-out zones')).toMatchObject({ ok: true, hard: true });
    // Deactivating the zone makes the direct route valid again.
    expect((await nida.patch(`/geofences/${g.body.id}`, { active: false })).body.active).toBe(false);
    expect(
      (
        await alex.patch(`/missions/${m.body.id}/route`, {
          checkpoints: [
            { x: 262, y: 218 },
            { x: 312, y: 222 },
            { x: 334, y: 228 },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await nida.req('DELETE', `/geofences/${g.body.id}`)).status).toBe(200);
    await alex.post(`/missions/${m.body.id}/cancel`);
  });

  it('ranks vehicles for an incident by planned arrival', async () => {
    const s = (await alex.get('/incidents/INC-024/suggest')).body as any[];
    expect(s.length).toBeGreaterThan(2);
    expect(s[0].ready).toBe(true);
    expect(s[0].etaS).toBeGreaterThan(0);
    expect(s[0].checkpoints.length).toBeGreaterThan(0);
    const readyEtas = s.filter((x) => x.ready).map((x) => x.etaS);
    expect([...readyEtas].sort((a, b) => a - b)).toEqual(readyEtas);
    expect(s.map((x) => x.deviceId)).toContain('UGV-02'); // parked closest to the service gate
    expect(s[0].deviceId).toBe('UGV-02');
  });
});

describe('scheduled patrols', () => {
  let patrolId: string;

  it('a supervisor creates a schedule with a standing approval; a dispatcher cannot', async () => {
    const body = {
      name: 'Lot sweep',
      deviceId: 'UGV-02',
      operatorId: 'u-somchai',
      route: [
        { x: 296, y: 206 },
        { x: 320, y: 206 },
        { x: 296, y: 206 },
      ],
      days: [0, 1, 2, 3, 4, 5, 6],
      times: ['22:00', '02:00'],
      autoStart: true,
    };
    expect((await alex.post('/patrols', body)).status).toBe(403);
    const r = await nida.post('/patrols', body);
    expect(r.status).toBe(200);
    patrolId = r.body.id;
    expect(r.body).toMatchObject({ enabled: true, autoStart: true, createdBy: 'u-nida', route: body.route });
    expect(r.body.nextRunAt).toBeGreaterThan(Date.now());
    expect((await nida.post('/patrols', { ...body, route: [{ x: 44, y: 160 }] })).status).toBe(409); // inside the fuel keep-out
    expect((await nida.post('/patrols', { ...body, times: ['25:00'] })).status).toBe(400);
    expect(((await alex.get('/patrols')).body as any[]).map((p) => p.id)).toContain(patrolId);
  });

  it('runs now: a patrol incident and an approved mission, started automatically, closed when the vehicle finishes', async () => {
    const run = await nida.post(`/patrols/${patrolId}/run`);
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ ok: true, started: true });
    const inc = (await alex.get(`/incidents/${run.body.incidentId}`)).body;
    expect(inc).toMatchObject({ type: 'Scheduled patrol', title: 'Patrol: Lot sweep', patrolId });
    expect(['confirmed', 'responding']).toContain(inc.status);
    const m = (await alex.get(`/missions/${run.body.missionId}`)).body;
    expect(m).toMatchObject({ approvedBy: 'u-nida', approvedVersion: 1, operatorId: 'u-somchai', patrolId });
    expect(['assigned', 'executing']).toContain(m.status);
    expect((await somchai.get('/devices/UGV-02')).body.controlOwner).toBe('u-somchai');
    // The operator still holds the controls: a pause from them is accepted while it drives.
    await waitFor(async () => (await alex.get(`/missions/${run.body.missionId}`)).body.status === 'executing', 10_000);
    await waitFor(async () => (await alex.get(`/missions/${run.body.missionId}`)).body.status === 'completed', 30_000);
    await waitFor(async () => (await alex.get(`/incidents/${run.body.incidentId}`)).body.status === 'closed', 5000);
    const closed = (await alex.get(`/incidents/${run.body.incidentId}`)).body;
    expect(closed.outcome).toMatch(/Patrol completed/);
    expect((await somchai.get('/devices/UGV-02')).body.controlOwner).toBeUndefined();
    const p = ((await nida.get('/patrols')).body as any[]).find((x) => x.id === patrolId);
    expect(p).toMatchObject({ lastOutcome: 'started', lastMissionId: run.body.missionId });
    // A second run while the first incident is closed works; a busy vehicle is skipped with a reason.
    const tl = (await alex.get(`/incidents/${run.body.incidentId}/timeline`)).body as any[];
    expect(tl.some((e) => e.title === 'Mission approved (standing approval)')).toBe(true);
    expect(tl.some((e) => e.title === 'Patrol completed')).toBe(true);
  }, 60_000);

  it('skips a run when the vehicle is not ready and says why; disabled schedules never fire', async () => {
    // Put UGV-02 on another mission first.
    const other = await nida.post('/patrols', {
      name: 'Blocker',
      deviceId: 'UGV-02',
      operatorId: 'u-somchai',
      route: [
        { x: 296, y: 206 },
        { x: 330, y: 206 },
        { x: 296, y: 206 },
      ],
      days: [0, 1, 2, 3, 4, 5, 6],
      times: ['23:00'],
      autoStart: true,
    });
    const run = await nida.post(`/patrols/${other.body.id}/run`);
    expect(run.body.started).toBe(true);
    await sleep(500);
    const again = await nida.post(`/patrols/${patrolId}/run`);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatch(/on another mission/);
    expect(((await nida.get('/patrols')).body as any[]).find((x) => x.id === patrolId).lastOutcome).toBe('skipped');
    const off = await nida.patch(`/patrols/${patrolId}`, { enabled: false });
    expect(off.body.enabled).toBe(false);
    expect(off.body.nextRunAt).toBeUndefined();
    // The scheduler tick does nothing for a disabled or not-yet-due schedule.
    expect(srv.built.platform.runPatrols(Date.now())).toEqual([]);
    await waitFor(async () => (await alex.get(`/missions/${run.body.missionId}`)).body.status === 'completed', 30_000);
    expect((await nida.req('DELETE', `/patrols/${other.body.id}`)).status).toBe(200);
  }, 60_000);

  it('the scheduler fires a due schedule from the timer path', async () => {
    const p = await nida.post('/patrols', {
      name: 'Due now',
      deviceId: 'UGV-01',
      operatorId: 'u-somchai',
      route: [
        { x: 214, y: 218 },
        { x: 240, y: 218 },
        { x: 214, y: 218 },
      ],
      days: [0, 1, 2, 3, 4, 5, 6],
      times: ['00:00'],
      autoStart: false,
    });
    // Pretend the next run was a minute ago.
    srv.db.prepare("UPDATE patrols SET data = json_set(data, '$.nextRunAt', ?) WHERE id = ?").run(Date.now() - 60_000, p.body.id);
    const out = srv.built.platform.runPatrols(Date.now());
    expect(out).toEqual([{ id: p.body.id, ok: true, incidentId: expect.any(String), missionId: expect.any(String), started: false }]);
    const m = (await alex.get(`/missions/${(out[0] as any).missionId}`)).body;
    expect(m.status).toBe('approved'); // waits for the operator to accept
    const after = ((await nida.get('/patrols')).body as any[]).find((x) => x.id === p.body.id);
    expect(after.nextRunAt).toBeGreaterThan(Date.now());
    expect(after.lastOutcome).toBe('approved');
    await alex.post(`/missions/${m.id}/cancel`);
    await nida.req('DELETE', `/patrols/${p.body.id}`);
  });
});

describe('usage counters and service', () => {
  it('counts odometer, runtime and missions from telemetry; administrators record a service', async () => {
    await waitFor(async () => ((await alex.get('/devices/UGV-02')).body.stats?.odometerM ?? 0) > 20, 10_000);
    const d = (await alex.get('/devices/UGV-02')).body;
    expect(d.stats.runtimeS).toBeGreaterThan(5);
    expect(d.stats.missions).toBeGreaterThanOrEqual(1);
    expect(Math.abs(d.stats.dock.x - 296)).toBeLessThanOrEqual(1);
    expect(Math.abs(d.stats.dock.y - 206)).toBeLessThanOrEqual(1);
    expect((await alex.post('/devices/UGV-02/service', { note: 'x' })).status).toBe(403);
    const sv = await ploy.post('/devices/UGV-02/service', { note: 'Tracks tensioned' });
    expect(sv.status).toBe(200);
    expect(sv.body.serviceOdometerM).toBeCloseTo(d.stats.odometerM, -1);
    expect(sv.body.lastServiceAt).toBeGreaterThan(0);
    const upd = await ploy.patch('/devices/UGV-02/stats', { serviceIntervalM: 1000, dock: { x: 300, y: 206 } });
    expect(upd.body).toMatchObject({ serviceIntervalM: 1000, dock: { x: 300, y: 206 } });
    expect((await ploy.patch('/devices/UGV-02/stats', { dock: { x: 999, y: 1 } })).status).toBe(400);
    const audit = (await Client.login(srv.url, 'priya')).get('/audit?action=device.service');
    expect(((await audit).body as any[]).some((a) => /Tracks tensioned/.test(a.detail))).toBe(true);
  }, 20_000);
});
