import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, common, minimal, type MavLinkData, type MavLinkPacket } from 'node-mavlink';
import { applyMessage, createState, evaluate, type BenchState, type DecodedMessage } from '../telemetry';

const REGISTRY = { ...minimal.REGISTRY, ...common.REGISTRY } as Record<number, new () => MavLinkData>;

/** Serialize real MAVLink 2 frames as the autopilot would and decode them like probe.ts does. */
async function roundTrip(sysId: number, msgs: MavLinkData[]): Promise<DecodedMessage[]> {
  const proto = new MavLinkProtocolV2(sysId, 1);
  const input = new PassThrough();
  const out: DecodedMessage[] = [];
  const done = new Promise<void>((res) => {
    const parser = input.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser());
    parser.on('data', (p: MavLinkPacket) => {
      const data = p.protocol.data(p.payload, REGISTRY[p.header.msgid] as never) as unknown as Record<string, unknown>;
      out.push({ msgId: p.header.msgid, sysId: p.header.sysid, compId: p.header.compid, data });
      if (out.length === msgs.length) res();
    });
  });
  msgs.forEach((m, i) => input.write(proto.serialize(m, i)));
  await done;
  return out;
}

function roverHeartbeat(customMode = 4, armed = false) {
  const hb = new minimal.Heartbeat();
  hb.type = 10 as never; // GROUND_ROVER
  hb.autopilot = 3 as never; // ArduPilot
  hb.baseMode = (armed ? 128 + 1 : 1) as never;
  hb.customMode = customMode;
  hb.systemStatus = 4 as never;
  hb.mavlinkVersion = 3;
  return hb;
}

function feed(state: BenchState, msgs: DecodedMessage[], startMs: number, stepMs = 1000) {
  msgs.forEach((m, i) => applyMessage(state, m, startMs + i * stepMs));
}

describe('bench telemetry', () => {
  it('decodes heartbeat, battery, GPS and parameters from real frames', async () => {
    const sys = new common.SysStatus();
    sys.voltageBattery = 12_480;
    sys.currentBattery = 150;
    sys.batteryRemaining = 87;
    const gps = new common.GpsRawInt();
    gps.fixType = 1 as never;
    gps.satellitesVisible = 0;
    gps.eph = 65535;
    const pv = new common.ParamValue();
    pv.paramId = 'FS_ACTION';
    pv.paramValue = 2;
    pv.paramType = 9 as never;
    pv.paramCount = 900;
    pv.paramIndex = 3;
    const decoded = await roundTrip(1, [roverHeartbeat(), sys, gps, pv, roverHeartbeat()]);

    const state = createState(0);
    feed(state, decoded, 0);
    expect(state.autopilot).toMatchObject({ sysId: 1, name: 'ArduPilot', vehicleType: 10 });
    expect(state.armed).toBe(false);
    expect(state.mode).toBe('HOLD');
    expect(state.battery).toEqual({ voltageV: 12.48, currentA: 1.5, remainingPct: 87 });
    expect(state.gps).toMatchObject({ fix: 'NO_FIX', satellites: 0, ephM: undefined });
    expect(state.params.get('FS_ACTION')).toBe(2);
    expect(state.paramCount).toBe(900);
  });

  it('ignores other ground stations and non-autopilot components', async () => {
    const gcs = new minimal.Heartbeat();
    gcs.type = 6 as never;
    gcs.autopilot = 8 as never;
    const radio = new minimal.Heartbeat();
    radio.type = 18 as never;
    radio.autopilot = 8 as never;
    const state = createState(0);
    feed(state, [...(await roundTrip(255, [gcs])), ...(await roundTrip(51, [radio]))], 0);
    expect(state.autopilot).toBeUndefined();
    expect(state.otherGcsHeartbeats).toBe(1);
    expect(evaluate(state, { nowMs: 1000, paramsRequested: true })[0]).toMatchObject({ id: 'link', status: 'fail' });
  });

  it('fails when the vehicle is armed on the bench', async () => {
    const state = createState(0);
    feed(state, await roundTrip(1, [roverHeartbeat(0, true), roverHeartbeat(0, true)]), 0);
    const checks = evaluate(state, { nowMs: 1500, paramsRequested: false });
    expect(checks.find((c) => c.id === 'disarmed')?.status).toBe('fail');
    expect(checks.find((c) => c.id === 'mode')).toMatchObject({ status: 'warn', detail: 'MANUAL' });
  });

  it('warns without a GNSS fix and fails when the link goes quiet', async () => {
    const state = createState(0);
    feed(state, await roundTrip(1, [roverHeartbeat(), roverHeartbeat(), roverHeartbeat()]), 0);
    const fresh = evaluate(state, { nowMs: 2500, paramsRequested: false });
    expect(fresh.find((c) => c.id === 'gps')?.status).toBe('warn');
    expect(fresh.find((c) => c.id === 'link-fresh')?.status).toBe('pass');
    expect(fresh.find((c) => c.id === 'heartbeat-rate')?.status).toBe('pass');
    const quiet = evaluate(state, { nowMs: 9000, paramsRequested: false });
    expect(quiet.find((c) => c.id === 'link-fresh')?.status).toBe('fail');
  });
});
