// Arm, disarm, MANUAL/HOLD and gear from the console: who may send which, in which mode, to which vehicle, and that
// the vehicle's own answer comes back and is audited. A vehicle without a hand-held remote (noRemote) can be armed;
// one with a remote can only be made safer (disarm, HOLD).
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { sanitizeVehicleAction, sanitizeVehicleControl } from '../src/platform';
import { SANDBOX_GATEWAY_KEY, SANDBOX_ORG } from '../src/seed';
import { Client, startServer, testActor, waitFor, type TestServer } from './helpers';

const ID = 'SBX-ROVER-01';

/** A gateway holding the sandbox rover; answers every vehicle control with `answer` and records the requests. */
async function gateway(url: string, vehicleControl: object | undefined, answer = { ok: true, detail: 'Done by the vehicle.' }) {
  const ws = new WebSocket(`${url}/api/v1/gateway`, { headers: { authorization: `Bearer ${SANDBOX_GATEWAY_KEY}` } });
  await new Promise((r) => ws.on('open', r));
  const got: any[] = [];
  ws.on('message', (m) => {
    const msg = JSON.parse(String(m));
    got.push(msg);
    if (msg.t === 'vehicle_control') ws.send(JSON.stringify({ t: 'vehicle_control_result', requestId: msg.requestId, deviceId: msg.deviceId, ...answer }));
  });
  ws.send(
    JSON.stringify({
      t: 'hello',
      protocol: GATEWAY_PROTOCOL,
      gatewayId: 'pi-edge',
      adapters: [
        {
          deviceId: ID,
          kind: 'ugv',
          model: 'Test rover',
          integration: 'testing',
          capabilities: ['ground_patrol'],
          commands: ['start', 'pause', 'resume', 'stop'],
          rateMs: 1000,
          limitations: '',
          linkLossBehavior: '',
          teleop: { maxThrottle: 0.3, maxSteer: 0.6, deadmanMs: 500 },
          vehicleControl,
        },
      ],
    }),
  );
  await waitFor(() => got.some((m) => m.t === 'welcome'));
  let seq = 0;
  const tel = () =>
    ws.readyState === ws.OPEN &&
    ws.send(JSON.stringify({ t: 'telemetry', deviceId: ID, seq: ++seq, sourceTime: Date.now(), pos: { x: 120, y: 220 }, accuracyM: 1, speed: 0, quality: 'good' }));
  tel();
  const timer = setInterval(tel, 200);
  return {
    requests: () => got.filter((m) => m.t === 'vehicle_control').map((m) => m.action),
    close: () => {
      clearInterval(timer);
      ws.close();
    },
  };
}

describe('vehicle control from the console', () => {
  let srv: TestServer;
  let op: Client;
  let disp: Client;
  const sup = () => testActor(SANDBOX_ORG, 'supervisor');
  const p = () => srv.built.platform;
  const device = () => p().listDevices(p().systemActor(SANDBOX_ORG)).find((d) => d.id === ID)!;
  const setMode = (to: string) => device().mode !== to && p().transitionMode(sup(), ID, { to, reason: 'vehicle control test' });
  const audit = (action: string) =>
    (srv.db.prepare('SELECT result, detail FROM audit WHERE action = ? ORDER BY org_id, seq').all(action) as { result: string; detail: string }[]).map((r) => `${r.result}: ${r.detail}`);
  const arm = (confirmClear?: boolean) => p().vehicleControl(sup(), ID, { action: { kind: 'arm' }, confirmClear });
  const code = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      return 'ok';
    } catch (e) {
      return (e as { code?: string }).code ?? String(e);
    }
  };

  beforeAll(async () => {
    srv = await startServer({ gateway: false });
    op = await Client.login(srv.url, 'devop');
    disp = await Client.login(srv.url, 'dev');
  }, 30_000);
  afterAll(() => srv?.close());

  it('keeps only sensible declarations and actions', () => {
    expect(sanitizeVehicleControl({ noRemote: true, gears: 3 })).toEqual({ noRemote: true, gears: 3 });
    expect(sanitizeVehicleControl({ noRemote: false, gears: 3 })).toEqual({ noRemote: false, gears: 0 });
    expect(sanitizeVehicleControl({ noRemote: true, gears: 99 })).toEqual({ noRemote: true, gears: 0 });
    expect(sanitizeVehicleControl({ gears: 3 })).toBeUndefined();
    expect(sanitizeVehicleAction({ kind: 'mode', mode: 'manual' })).toEqual({ kind: 'mode', mode: 'manual' });
    expect(sanitizeVehicleAction({ kind: 'mode', mode: 'auto' })).toBeUndefined();
    expect(sanitizeVehicleAction({ kind: 'gear', gear: 0 })).toBeUndefined();
    expect(sanitizeVehicleAction({ kind: 'launch' })).toBeUndefined();
  });

  it('no hand-held remote: a supervisor arms a LIVE_MANUAL vehicle after confirming the area; the operator switches and picks gears', async () => {
    const gw = await gateway(srv.wsUrl, { noRemote: true, gears: 3 });
    try {
      await waitFor(() => device().vehicleControl?.gears === 3 && Date.now() - device().lastSeen < 500);
      setMode('SHADOW');
      expect(await code(() => arm(true))).toBe('mode_locked');
      setMode('LIVE_MANUAL');
      expect(await code(() => arm())).toBe('confirm_required');
      // Operators and dispatchers do not arm.
      expect((await op.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'arm' }, confirmClear: true })).status).toBe(403);
      expect((await disp.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'arm' }, confirmClear: true })).status).toBe(403);

      expect(await arm(true)).toEqual({ ok: true, detail: 'Done by the vehicle.' });
      const manual = await op.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'mode', mode: 'manual' } });
      expect(manual.status).toBe(200);
      expect((await op.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'gear', gear: 2 } })).body).toEqual({ ok: true, detail: 'Done by the vehicle.' });
      expect((await op.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'gear', gear: 4 } })).body.code).toBe('invalid');
      expect((await op.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'fly' } })).status).toBe(400);
      expect(gw.requests()).toEqual([{ kind: 'arm' }, { kind: 'mode', mode: 'manual' }, { kind: 'gear', gear: 2 }]);
      expect(audit('vehicle.arm')).toEqual([
        'denied: arm: SBX-ROVER-01 is in SHADOW. A supervisor must promote it to LIVE_MANUAL first.',
        'denied: arm: Confirm that the area around the vehicle is clear of people before arming.',
        'ok: arm — Done by the vehicle.',
      ]);
      expect(audit('vehicle.gear').at(-1)).toBe('denied: gear 4: SBX-ROVER-01 has gears 1–3.');
    } finally {
      gw.close();
    }
  });

  it('with a hand-held remote: anyone working with vehicles can disarm or HOLD it in any mode, nobody arms or switches it to MANUAL', async () => {
    await waitFor(() => !p().listDevices(p().systemActor(SANDBOX_ORG)).find((d) => d.id === ID)?.drivenBy);
    const gw = await gateway(srv.wsUrl, { noRemote: false, gears: 0 });
    try {
      await waitFor(() => device().vehicleControl?.noRemote === false && Date.now() - device().lastSeen < 500);
      setMode('SHADOW');
      expect(await code(() => arm(true))).toBe('has_remote');
      expect((await op.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'mode', mode: 'manual' } })).body.code).toBe('has_remote');
      expect((await op.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'disarm' } })).body).toEqual({ ok: true, detail: 'Done by the vehicle.' });
      expect((await disp.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'mode', mode: 'hold' } })).status).toBe(200);
      expect(gw.requests()).toEqual([{ kind: 'disarm' }, { kind: 'mode', mode: 'hold' }]);
      expect(audit('vehicle.disarm').at(-1)).toBe('ok: disarm — Done by the vehicle.');
    } finally {
      gw.close();
    }
  });

  it("reports the vehicle's refusal, and says so when the gateway is not connected", async () => {
    const gw = await gateway(srv.wsUrl, { noRemote: true, gears: 3 }, { ok: false, detail: 'Arming refused: PreArm: Radio failsafe on' });
    try {
      await waitFor(() => device().vehicleControl?.noRemote === true && Date.now() - device().lastSeen < 500);
      setMode('LIVE_MANUAL');
      expect(await arm(true)).toEqual({ ok: false, detail: 'Arming refused: PreArm: Radio failsafe on' });
      expect(audit('vehicle.arm').at(-1)).toBe('error: arm — Arming refused: PreArm: Radio failsafe on');
    } finally {
      gw.close();
    }
    await waitFor(() => !srv.built.platform.listDevices(p().systemActor(SANDBOX_ORG)).find((d) => d.id === ID)?.drivenBy);
    await new Promise((r) => setTimeout(r, 200));
    const r = await op.post(`/devices/${ID}/vehicle-control`, { action: { kind: 'disarm' } });
    expect(r.body).toEqual({ ok: false, detail: 'SBX-ROVER-01 gateway is not connected. Not sent.' });
  });
});
