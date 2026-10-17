// Simulated UAV overwatch: verifying an incident sends the simulated UAV to orbit over it (a demo
// message to the gateway, never a command to a real aircraft); resolving it releases the UAV.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client, startServer, waitFor, type TestServer } from './helpers';

let srv: TestServer;
let alex: Client;
const sent: { deviceId: string; target: unknown }[] = [];

beforeAll(async () => {
  srv = await startServer();
  alex = await Client.login(srv.url, 'alex');
  const hub = srv.built.platform.gateways;
  const orig = hub.send.bind(hub);
  hub.send = (orgId, deviceId, msg) => {
    if (msg.t === 'demo' && msg.action === 'overwatch') sent.push({ deviceId, target: msg.target });
    return orig(orgId, deviceId, msg);
  };
});
afterAll(() => srv?.close());

const sys = () => srv.built.platform.systemActor('org-demo');
const PATROL = { x: 318, y: 52 };

describe('UAV overwatch (simulated)', () => {
  it('tasks the simulated UAV when an incident is verified, and the aircraft heads there', async () => {
    const before = sent.length;
    expect((await alex.post('/incidents/INC-024/confirm')).status).toBe(200);
    expect(sent.slice(before).at(-1)).toEqual({ deviceId: 'UAV-02', target: { x: 335, y: 236 } });
    // the orbit centre moves at ~9 m/s: within a few seconds the aircraft has clearly left the patrol loop
    await waitFor(() => {
      const d = srv.built.platform.getDevice(sys(), 'UAV-02');
      return Math.hypot(d.pos.x - PATROL.x, d.pos.y - PATROL.y) > 60;
    }, 15_000);
  }, 20_000);

  it('moves on to the next verified incident when one is resolved, and does not repeat an unchanged target', async () => {
    const before = sent.length;
    expect((await alex.post('/incidents/INC-024/resolve', { outcome: 'False alarm: contractor at the gate.' })).status).toBe(200);
    // INC-023 (seeded as confirmed) is the remaining verified incident
    expect(sent.slice(before).at(-1)).toEqual({ deviceId: 'UAV-02', target: { x: 170, y: 120 } });
    const n = sent.length;
    await alex.post('/incidents/INC-024/close');
    expect(sent.length).toBe(n); // same target as before: nothing new to send
    // resolving the last verified incident releases the UAV to its patrol loop
    expect((await alex.post('/incidents/INC-023/resolve', { outcome: 'Cleared by field team.' })).status).toBe(200);
    expect(sent.at(-1)).toEqual({ deviceId: 'UAV-02', target: null });
  });
});
