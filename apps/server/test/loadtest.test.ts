// Load-test harness (TOR §9): a small profile against a server in this process must deliver
// telemetry and incident events to every console well inside the 2 s p95 target.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportMarkdown, runLoadTest } from '../src/loadtest';
import { startServer, type TestServer } from './helpers';

let srv: TestServer;

beforeAll(async () => {
  srv = await startServer({ gateway: false });
}, 30_000);
afterAll(() => srv?.close());

describe('load-test harness', () => {
  it('2 gateways × 20 devices, 4 consoles, 500 ms telemetry, 6 incidents/min for 8 s: no errors, ≥ 80 % delivered, p95 < 2 s', async () => {
    const r = await runLoadTest({ url: srv.url, gateways: 2, devices: 40, ugvs: 6, consoles: 4, rateMs: 500, durationS: 8, incidentsPerMin: 6, drainS: 2 });

    expect(r.errors.samples).toEqual([]);
    expect(r.errors.count).toBe(0);
    expect(r.setup.gatewaysConnected).toBe(2);
    expect(r.setup.consolesConnected).toBe(4);
    expect(r.setup.devicesRegistered).toBe(40);

    // Roughly 40 devices × 2 samples/s × 8 s; each sample reaches all four consoles.
    expect(r.telemetry.sent).toBeGreaterThan(40 * 2 * 5);
    expect(r.telemetry.expected).toBe(r.telemetry.sent * 4);
    expect(r.telemetry.received).toBeGreaterThanOrEqual(r.telemetry.expected * 0.8);
    expect(r.telemetry.latencyMs.p95).toBeLessThan(2000);
    expect(r.telemetry.skipped).toBe(0);

    expect(r.incidents.created).toBeGreaterThanOrEqual(1);
    expect(r.incidents.received).toBe(r.incidents.created * 4);
    expect(r.incidents.latencyMs.p95).toBeLessThan(2000);

    expect(r.http.getIncidents.count).toBeGreaterThan(3);
    expect(r.http.getSnapshot.errors + r.http.getIncidents.errors + r.http.postIncident.errors).toBe(0);
    expect(r.serverMetrics?.some((l) => l.startsWith('ps_http_requests_total'))).toBe(true);
    expect(r.serverMetrics?.some((l) => l.startsWith('ps_devices'))).toBe(true);
    expect(r.targets.pass).toBe(true);

    const md = reportMarkdown(r);
    expect(md).toContain('# Load test report');
    expect(md).toContain('Telemetry: gateway send → console shown');
    expect(md).toContain('PASS');
  }, 24_000);

  it('a second run reuses the registered load devices', async () => {
    const r = await runLoadTest({ url: srv.url, gateways: 1, devices: 10, ugvs: 2, consoles: 1, rateMs: 500, durationS: 1, incidentsPerMin: 0, drainS: 1 });
    expect(r.setup.devicesRegistered).toBe(0);
    expect(r.setup.devicesReused).toBe(10);
    expect(r.errors.count).toBe(0);
    expect(r.incidents.created).toBe(0);
    expect(r.telemetry.received).toBeGreaterThan(0);
  }, 15_000);
});
