// A real site's operating area on the server: saved like any zone, it replaces the demo boundary in
// the approval checks, other zones must touch it, and a vehicle leaving it is reported.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GwTelemetry } from '@13store/shared';
import { Client, startServer, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client; // dispatcher
let nida: Client; // supervisor
let ploy: Client; // admin

beforeAll(async () => {
  srv = await startServer();
  [alex, nida, ploy] = await Promise.all(['alex', 'nida', 'ploy'].map((u) => Client.login(srv.url, u)));
}, 30_000);
afterAll(() => srv?.close());

// North-west of the demo grid, where a real office yard sits when the site anchor is at the gate.
const YARD = [
  { x: 0, y: -40 },
  { x: 40, y: -40 },
  { x: 40, y: 0 },
  { x: 0, y: 0 },
];
const IN_YARD = [
  { x: 10, y: -10 },
  { x: 30, y: -30 },
];
const label = 'Route inside the operating area';
const breaches = (dev: string) =>
  (srv.db.prepare("SELECT result, detail FROM audit WHERE action = 'geofence.breach' AND object = ? ORDER BY seq").all(dev) as { result: string; detail: string }[]).filter((r) =>
    r.detail.includes('operating area'),
  );

describe('operating area', () => {
  it('refuses a route in the yard until the yard is the operating area, then passes the approval checks', async () => {
    await alex.post('/incidents/INC-024/triage');
    await alex.post('/incidents/INC-024/confirm');
    const mission = { incidentId: 'INC-024', deviceId: 'UGV-01', operatorId: 'u-somchai', checkpoints: IN_YARD };
    // Without an operating area the demo boundary rules, and the yard lies outside it.
    const outside = await alex.post('/missions', mission);
    expect(outside.status).toBe(409);
    expect(outside.body.error).toMatch(/Checkpoints 1, 2 are outside the site/);

    const area = await nida.post('/geofences', { name: 'Office yard', kind: 'operating_area', appliesTo: ['ugv', 'uav'], poly: YARD });
    expect(area.status).toBe(200);
    expect(area.body.kind).toBe('operating_area');
    const m = await alex.post('/missions', mission);
    expect(m.status).toBe(200);
    const checks = (await alex.get(`/missions/${m.body.id}/checks`)).body as any[];
    expect(checks.find((c) => c.label === label)).toMatchObject({ ok: true, hard: true });

    // The demo car park is now outside the site: the route cannot be moved there.
    const moved = await alex.patch(`/missions/${m.body.id}/route`, { checkpoints: [{ x: 262, y: 218 }] });
    expect(moved.status).toBe(409);
    expect(moved.body.error).toMatch(/Checkpoints 1 are outside the operating area/);
    await alex.post(`/missions/${m.body.id}/cancel`);
  });

  it('wants other zones to touch the operating area, and refuses an unknown kind', async () => {
    const square = (x: number, y: number) => [
      { x, y },
      { x: x + 5, y },
      { x: x + 5, y: y + 5 },
      { x, y: y + 5 },
    ];
    expect((await nida.post('/geofences', { name: 'Ramp', kind: 'keep_out', poly: square(10, -20) })).status).toBe(200);
    const far = await nida.post('/geofences', { name: 'Old plaza', kind: 'keep_out', poly: square(200, 120) });
    expect(far.status).toBe(400);
    expect(far.body.error).toMatch(/touch the site/);
    expect((await nida.post('/geofences', { name: 'x', kind: 'parking', poly: square(10, -20) })).status).toBe(400);
    // A bow-tie outline (two edges cross) is refused: inside tests and its area would be wrong.
    const [a, b, c, d] = square(10, -20);
    const bow = await nida.post('/geofences', { name: 'Bow tie', kind: 'keep_out', poly: [a, c, b, d] });
    expect(bow.status).toBe(400);
    expect(bow.body.error).toMatch(/crosses itself/);
  });

  it('keeps patrols inside the area: refused when saved outside it, skipped when the area moved away', async () => {
    const base = { deviceId: 'UGV-01', operatorId: 'u-somchai', days: [1, 2, 3, 4, 5], times: ['22:00'] };
    const out = await nida.post('/patrols', { ...base, name: 'Car park loop', route: [{ x: 262, y: 218 }] });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/Checkpoints 1 are outside the site/);
    const p = await nida.post('/patrols', { ...base, name: 'Yard loop', route: [{ x: 30, y: -30 }, { x: 30, y: -5 }] });
    expect(p.status).toBe(200);
    // The yard is redrawn smaller: the next run is skipped instead of driving outside it.
    const area = ((await alex.get('/geofences')).body as any[]).find((g) => g.kind === 'operating_area');
    const small = [
      { x: 0, y: -40 },
      { x: 20, y: -40 },
      { x: 20, y: 0 },
      { x: 0, y: 0 },
    ];
    expect((await nida.patch(`/geofences/${area.id}`, { poly: small })).status).toBe(200);
    const run = await nida.post(`/patrols/${p.body.id}/run`);
    expect(run.status).toBe(409);
    expect(run.body.error).toMatch(/checkpoints 1, 2 are outside the site/);
    expect((await nida.patch(`/geofences/${area.id}`, { poly: YARD })).status).toBe(200);
    await nida.req('DELETE', `/patrols/${p.body.id}`);
  });

  it('reports a vehicle leaving the area, once, and when it is back', async () => {
    expect((await ploy.post('/devices', { id: 'UGV-88', kind: 'ugv', model: 'Yard rover' })).status).toBe(200);
    const orgId = (srv.db.prepare('SELECT org_id FROM devices WHERE id = ?').get('UGV-88') as { org_id: string }).org_id;
    let seq = 0;
    const at = (pos: { x: number; y: number }): GwTelemetry => ({ t: 'telemetry', deviceId: 'UGV-88', seq: ++seq, sourceTime: Date.now(), pos, accuracyM: 1, speed: 0, quality: 'good', battery: 90 });
    const p = srv.built.platform;
    p.telemetry(orgId, at({ x: 20, y: -20 }));
    expect(breaches('UGV-88')).toEqual([]);
    p.telemetry(orgId, at({ x: 60, y: -20 }));
    p.telemetry(orgId, at({ x: 61, y: -20 }));
    const out = breaches('UGV-88');
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe('ok'); // no mission: a warning, not a breach
    expect(out[0].detail).toMatch(/UGV-88 is outside the operating area \(Office yard\)/);
    p.telemetry(orgId, at({ x: 20, y: -20 }));
    p.telemetry(orgId, at({ x: 60, y: -20 }));
    expect(breaches('UGV-88')).toHaveLength(2);
  });
});
