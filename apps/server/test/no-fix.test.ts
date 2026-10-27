// A real vehicle without a GNSS fix: alive (fresh telemetry) but its position unknown. Maps must not
// draw it at a guessed place, and replay history must not contain guessed positions.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GwTelemetry } from '@13store/shared';
import { Client, startServer, type TestServer } from './helpers';

let srv: TestServer;
let admin: Client;
const DEV = 'UGV-77';

beforeAll(async () => {
  process.env.ADMIN_PASSWORD = 'pilot-admin-pass';
  srv = await startServer({ env: 'pilot', gateway: false });
  delete process.env.ADMIN_PASSWORD;
  admin = await Client.login(srv.url, 'admin', 'pilot-admin-pass');
}, 30_000);
afterAll(() => srv?.close());

const rows = () => (srv.db.prepare('SELECT COUNT(*) AS n FROM telemetry WHERE device_id = ?').get(DEV) as { n: number }).n;
const device = () => srv.built.platform.listDevices({ orgId: 'org-demo', role: 'admin', siteIds: [], userId: 'u-admin', name: 'Administrator' } as never).find((d) => d.id === DEV)!;
let seq = 0;
const sample = (pos?: { x: number; y: number }): GwTelemetry => ({ t: 'telemetry', deviceId: DEV, seq: ++seq, sourceTime: Date.now(), ...(pos ? { pos } : {}), accuracyM: 2, speed: 0, quality: pos ? 'good' : 'degraded', battery: 80 });

describe('telemetry without a position fix', () => {
  it('starts a newly registered device with no position, then follows the fix as it comes and goes', async () => {
    expect((await admin.post('/devices', { id: DEV, kind: 'ugv', model: 'GNSS rover' })).status).toBe(200);
    const orgId = (srv.db.prepare('SELECT org_id FROM devices WHERE id = ?').get(DEV) as { org_id: string }).org_id;
    expect(device().noFix).toBe(true); // registered, never reported: no position yet

    srv.built.platform.telemetry(orgId, sample()); // alive, no fix
    expect(device().noFix).toBe(true);
    expect(device().lastSeen).toBeGreaterThan(0);
    expect(device().battery).toBe(80);
    expect(rows()).toBe(0); // nothing to replay

    srv.built.platform.telemetry(orgId, sample({ x: 120, y: 80 }));
    expect(device().noFix).toBeUndefined();
    expect(device().pos).toEqual({ x: 120, y: 80 });
    expect(rows()).toBe(1);

    srv.built.platform.telemetry(orgId, sample()); // fix lost
    expect(device().noFix).toBe(true);
    expect(device().pos).toEqual({ x: 120, y: 80 }); // last known kept, flagged
    expect(rows()).toBe(1);
  });
});
