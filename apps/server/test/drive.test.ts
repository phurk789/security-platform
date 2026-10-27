// Live driving from the console: who may drive, in which mode, how stick samples reach the gateway,
// and that every way a drive can end (stop, demotion, console gone, gateway gone) tells the gateway.
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GATEWAY_PROTOCOL } from '@13store/shared';
import { sanitizeTeleop } from '../src/platform';
import { SANDBOX_GATEWAY_KEY, SANDBOX_ORG } from '../src/seed';
import { Client, consoleSocket, sleep, startServer, testActor, waitFor, type TestServer } from './helpers';

const ID = 'SBX-ROVER-01';

/** A gateway holding the sandbox rover, offering live driving; records what the server sends it. */
async function gateway(url: string, teleop: object = { maxThrottle: 0.3, maxSteer: 0.6, deadmanMs: 500 }) {
  const ws = new WebSocket(`${url}/api/v1/gateway`, { headers: { authorization: `Bearer ${SANDBOX_GATEWAY_KEY}` } });
  await new Promise((r) => ws.on('open', r));
  const got: any[] = [];
  ws.on('message', (m) => got.push(JSON.parse(String(m))));
  ws.send(
    JSON.stringify({
      t: 'hello',
      protocol: GATEWAY_PROTOCOL,
      gatewayId: 'drive-edge',
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
          teleop,
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
  const drives = () => got.filter((m) => m.t === 'drive');
  return {
    ws,
    drives,
    close: () => {
      clearInterval(timer);
      ws.close();
    },
  };
}

describe('live driving (server rules)', () => {
  let srv: TestServer;
  let op: Client;
  let disp: Client;
  const sup = () => testActor(SANDBOX_ORG, 'supervisor');
  const device = () => srv.built.platform.listDevices(srv.built.platform.systemActor(SANDBOX_ORG)).find((d) => d.id === ID)!;
  const setMode = (to: string) => srv.built.platform.transitionMode(sup(), ID, { to, reason: 'drive test' });
  const audit = (action: string) =>
    (srv.db.prepare('SELECT result, detail FROM audit WHERE action = ? ORDER BY org_id, seq').all(action) as { result: string; detail: string }[]).map((r) => `${r.result}: ${r.detail}`);

  beforeAll(async () => {
    srv = await startServer({ gateway: false });
    op = await Client.login(srv.url, 'devop');
    disp = await Client.login(srv.url, 'dev');
  }, 30_000);
  afterAll(() => srv?.close());

  it('keeps only sensible drive limits from a gateway', () => {
    expect(sanitizeTeleop({ maxThrottle: 0.3, maxSteer: 0.6, deadmanMs: 500 })).toEqual({ maxThrottle: 0.3, maxSteer: 0.6, deadmanMs: 500 });
    expect(sanitizeTeleop({ maxThrottle: 2, maxSteer: 0.6, deadmanMs: 500 })).toBeUndefined();
    expect(sanitizeTeleop({ maxThrottle: 0.3, maxSteer: 0.6, deadmanMs: 10_000 })).toBeUndefined();
    expect(sanitizeTeleop('yes')).toBeUndefined();
    expect(sanitizeTeleop(undefined)).toBeUndefined();
  });

  it('lets an operator drive a LIVE_MANUAL rover, forwards their stick samples in order, and ends the drive on stop', async () => {
    const gw = await gateway(srv.wsUrl);
    const con = await consoleSocket(srv.wsUrl, op.token);
    try {
      await waitFor(() => device().teleop?.maxThrottle === 0.3 && Date.now() - device().lastSeen < 500);
      // SHADOW: nobody drives.
      const shadow = await op.post(`/devices/${ID}/drive`, { action: 'start' });
      expect(shadow.status).toBe(409);
      expect(shadow.body.code).toBe('mode_locked');
      setMode('LIVE_MANUAL');
      // Dispatchers do not command devices.
      expect((await disp.post(`/devices/${ID}/drive`, { action: 'start' })).status).toBe(403);
      expect((await op.post(`/devices/${ID}/drive`, { action: 'bogus' })).status).toBe(400);

      const r = await op.post(`/devices/${ID}/drive`, { action: 'start' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ drivenBy: 'u-devop', controlOwner: 'u-devop' });

      const send = (seq: number, throttle: unknown, steer: unknown) => con.ws.send(JSON.stringify({ type: 'drive', deviceId: ID, seq, throttle, steer }));
      send(1, 2, -0.5);
      await waitFor(() => gw.drives().length === 1);
      expect(gw.drives()[0]).toMatchObject({ t: 'drive', deviceId: ID, seq: 1, throttle: 1, steer: -0.5 }); // clamped
      send(1, 0.2, 0); // repeated number
      await sleep(60);
      send(2, 0.2, 0);
      send(3, 0.9, 0); // too soon after the last one (40 ms)
      await sleep(60);
      send(4, 'fast', 0.1); // not a number → 0
      await waitFor(() => gw.drives().length === 3);
      expect(gw.drives().map((m) => [m.seq, m.throttle, m.steer])).toEqual([
        [1, 1, -0.5],
        [2, 0.2, 0],
        [4, 0, 0.1],
      ]);
      // Someone else's console cannot inject samples.
      const other = await consoleSocket(srv.wsUrl, disp.token);
      other.ws.send(JSON.stringify({ type: 'drive', deviceId: ID, seq: 99, throttle: 1, steer: 0 }));
      await sleep(100);
      other.close();
      expect(gw.drives()).toHaveLength(3);

      expect((await op.post(`/devices/${ID}/drive`, { action: 'stop' })).status).toBe(200);
      await waitFor(() => gw.drives().some((m) => m.release));
      expect(device().drivenBy).toBeUndefined();
      expect(device().controlOwner).toBeUndefined();
      await sleep(60);
      send(5, 1, 0); // after the drive ended: not forwarded
      await sleep(100);
      expect(gw.drives().filter((m) => !m.release)).toHaveLength(3);
      expect(audit('drive.start').at(-1)).toMatch(/^ok: LIVE_MANUAL · limits throttle 30% steer 60%/);
      expect(audit('drive.stop').at(-1)).toMatch(/^ok: Sandbox Operator · driver stopped/);
    } finally {
      con.close();
      gw.close();
      await waitFor(() => !srv.built.platform.listDevices(srv.built.platform.systemActor(SANDBOX_ORG)).find((d) => d.id === ID)?.drivenBy);
    }
  });

  it('ends the drive and releases the vehicle on demotion, when the console goes away, and when the gateway goes away', async () => {
    const gw = await gateway(srv.wsUrl);
    try {
      await waitFor(() => Date.now() - device().lastSeen < 500);
      if (device().mode !== 'LIVE_MANUAL') setMode('LIVE_MANUAL');

      // Demotion.
      let con = await consoleSocket(srv.wsUrl, op.token);
      expect((await op.post(`/devices/${ID}/drive`, { action: 'start' })).status).toBe(200);
      setMode('SHADOW');
      await waitFor(() => gw.drives().filter((m) => m.release).length === 1);
      expect(device().drivenBy).toBeUndefined();
      expect(audit('drive.stop').at(-1)).toMatch(/mode changed to SHADOW/);
      con.close();

      // Console closed (tab shut, network gone).
      setMode('LIVE_MANUAL');
      con = await consoleSocket(srv.wsUrl, op.token);
      expect((await op.post(`/devices/${ID}/drive`, { action: 'start' })).status).toBe(200);
      con.close();
      await waitFor(() => gw.drives().filter((m) => m.release).length === 2);
      expect(device().drivenBy).toBeUndefined();
      expect(audit('drive.stop').at(-1)).toMatch(/console disconnected/);

      // Gateway gone: the session ends (the gateway itself stops on the dead-man).
      con = await consoleSocket(srv.wsUrl, op.token);
      expect((await op.post(`/devices/${ID}/drive`, { action: 'start' })).status).toBe(200);
      gw.close();
      await waitFor(() => !device().drivenBy);
      expect(audit('drive.stop').at(-1)).toMatch(/gateway disconnected/);
      con.close();
    } finally {
      gw.close();
    }
  });

  it('refuses a vehicle whose gateway does not offer driving, or offers nonsense limits', async () => {
    const gw = await gateway(srv.wsUrl, { maxThrottle: 3, maxSteer: 0.6, deadmanMs: 500 });
    try {
      await waitFor(() => Date.now() - device().lastSeen < 500);
      expect(device().teleop).toBeUndefined();
      if (device().mode !== 'LIVE_MANUAL') setMode('LIVE_MANUAL');
      const r = await op.post(`/devices/${ID}/drive`, { action: 'start' });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('not_enabled');
    } finally {
      gw.close();
    }
  });
});

describe('live driving a simulated UGV end to end', () => {
  let srv: TestServer;
  beforeAll(async () => {
    srv = await startServer();
  }, 30_000);
  afterAll(() => srv?.close());

  it('moves the simulator where the operator steers and stops it when they stop', async () => {
    const op = await Client.login(srv.url, 'somchai');
    const snap = (await op.get('/snapshot')).body;
    const busy = new Set(snap.missions.filter((m: any) => ['assigned', 'executing', 'paused'].includes(m.status)).map((m: any) => m.deviceId));
    const ugv = snap.devices.find((d: any) => d.kind === 'ugv' && d.teleop && !busy.has(d.id) && !d.controlOwner && !d.indoor);
    expect(ugv).toBeTruthy();
    const con = await consoleSocket(srv.wsUrl, op.token);
    try {
      const r = await op.post(`/devices/${ugv.id}/drive`, { action: 'start' });
      expect(r.status).toBe(200);
      const live = () => srv.built.platform.listDevices(srv.built.platform.systemActor('org-demo')).find((d) => d.id === ugv.id)!;
      const from = { ...live().pos };
      let seq = 0;
      const send = (throttle: number, steer: number) => con.ws.send(JSON.stringify({ type: 'drive', deviceId: ugv.id, seq: ++seq, throttle, steer }));
      send(0, 0);
      await sleep(100);
      const t = setInterval(() => send(1, 0), 100);
      try {
        await waitFor(() => live().speed > 1, 8000);
      } finally {
        clearInterval(t);
      }
      expect(Math.hypot(live().pos.x - from.x, live().pos.y - from.y)).toBeGreaterThan(0.5);
      expect(live().components?.find((c) => c.id === 'drive')?.detail).toMatch(/Driving from the console/);
      expect((await op.post(`/devices/${ugv.id}/drive`, { action: 'stop' })).status).toBe(200);
      await waitFor(() => live().speed === 0, 8000);
    } finally {
      con.close();
    }
  }, 30_000);
});
