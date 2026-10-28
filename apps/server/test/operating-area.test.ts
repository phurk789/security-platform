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
const label = 'Route inside demo area';
const breaches = (dev: string) =>
  (srv.db.prepare("SELECT result, detail FROM audit WHERE action = 'geofence.breach' AND object = ? ORDER BY seq").all(dev) as { result: string; detail: string }[]).filter((r) =>
    r.detail.includes('operating area'),
  );

describe('operating area', () => {
  it('lets a route in the yard pass the approval checks once the yard is the operating area', async () => {
    await alex.post('/incidents/INC-024/triage');
    await alex.post('/incidents/INC-024/confirm');
    const m = await alex.post('/missions', { incidentId: 'INC-024', deviceId: 'UGV-01', operatorId: 'u-somchai', checkpoints: IN_YARD });
    expect(m.status).toBe(200);
    const before = (await alex.get(`/missions/${m.body.id}/checks`)).body as any[];
    expect(before.find((c) => c.label === label)).toMatchObject({ ok: false, hard: true });

    const area = await nida.post('/geofences', { name: 'Office yard', kind: 'operating_area', appliesTo: ['ugv', 'uav'], poly: YARD });
    expect(area.status).toBe(200);
    expect(area.body.kind).toBe('operating_area');
    const after = (await alex.get(`/missions/${m.body.id}/checks`)).body as any[];
    expect(after.find((c) => c.label === label)).toMatchObject({ ok: true, hard: true });

    // The demo car park is now outside the site.
    expect((await alex.patch(`/missions/${m.body.id}/route`, { checkpoints: [{ x: 262, y: 218 }] })).status).toBe(200);
    const moved = (await alex.get(`/missions/${m.body.id}/checks`)).body as any[];
    expect(moved.find((c) => c.label === label)?.ok).toBe(false);
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
