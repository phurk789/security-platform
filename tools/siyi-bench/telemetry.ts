// Folds decoded MAVLink messages into a bench state and turns it into pass/warn/fail checks.
// Pure functions only: the socket and parser live in probe.ts so this file is unit-testable.

import type { ParamDiff } from './params';
import type { RawLinkDiagnosis } from './rawlink';

export const MSG = {
  HEARTBEAT: 0,
  SYS_STATUS: 1,
  PARAM_VALUE: 22,
  GPS_RAW_INT: 24,
  GLOBAL_POSITION_INT: 33,
  RADIO_STATUS: 109,
  STATUSTEXT: 253,
} as const;

const MAV_TYPE_GCS = 6;
const MAV_TYPE_GROUND_ROVER = 10;
const MAV_AUTOPILOT_ARDUPILOT = 3;
const MAV_AUTOPILOT_INVALID = 8;
const MAV_AUTOPILOT_PX4 = 12;
const MAV_MODE_FLAG_SAFETY_ARMED = 128;

const ROVER_MODES: Record<number, string> = {
  0: 'MANUAL', 1: 'ACRO', 3: 'STEERING', 4: 'HOLD', 5: 'LOITER', 6: 'FOLLOW', 7: 'SIMPLE',
  10: 'AUTO', 11: 'RTL', 12: 'SMART_RTL', 15: 'GUIDED', 16: 'INITIALISING',
};
const GPS_FIX = ['NO_GPS', 'NO_FIX', '2D_FIX', '3D_FIX', 'DGPS', 'RTK_FLOAT', 'RTK_FIXED', 'STATIC', 'PPP'];

export interface DecodedMessage {
  msgId: number;
  sysId: number;
  compId: number;
  data: Record<string, unknown>;
}

export interface BenchState {
  startedMs: number;
  autopilot?: { sysId: number; compId: number; name: string; vehicleType: number };
  heartbeats: number;
  firstHeartbeatMs?: number;
  lastHeartbeatMs?: number;
  armed?: boolean;
  customMode?: number;
  mode?: string;
  seen: Set<number>;
  battery?: { voltageV?: number; currentA?: number; remainingPct?: number };
  gps?: { fixType: number; fix: string; satellites?: number; ephM?: number; hAccM?: number };
  position?: { lat: number; lon: number; relAltM: number; headingDeg?: number };
  radio?: { rssi: number; remrssi: number };
  statusText: { severity: number; text: string; atMs: number }[];
  otherGcsHeartbeats: number;
  params: Map<string, number>;
  paramCount?: number;
}

export function createState(nowMs: number): BenchState {
  return { startedMs: nowMs, heartbeats: 0, seen: new Set(), statusText: [], otherGcsHeartbeats: 0, params: new Map() };
}

const num = (v: unknown): number => Number(v);
const text = (v: unknown): string => String(v ?? '').replace(/\0/g, '').trim();

function autopilotName(id: number): string {
  if (id === MAV_AUTOPILOT_ARDUPILOT) return 'ArduPilot';
  if (id === MAV_AUTOPILOT_PX4) return 'PX4';
  return `autopilot ${id}`;
}

export function modeName(state: BenchState, customMode: number): string {
  const ap = state.autopilot;
  if (ap?.name === 'ArduPilot' && ap.vehicleType === MAV_TYPE_GROUND_ROVER) return ROVER_MODES[customMode] ?? `mode ${customMode}`;
  return `mode ${customMode}`;
}

/** Apply one decoded message. Messages from other systems than the first autopilot are ignored. */
export function applyMessage(state: BenchState, m: DecodedMessage, nowMs: number): void {
  const d = m.data;
  if (m.msgId === MSG.HEARTBEAT) {
    if (num(d.type) === MAV_TYPE_GCS) {
      state.otherGcsHeartbeats++;
      return;
    }
    if (num(d.autopilot) === MAV_AUTOPILOT_INVALID) return; // radio, camera, other non-autopilot
    state.autopilot ??= { sysId: m.sysId, compId: m.compId, name: autopilotName(num(d.autopilot)), vehicleType: num(d.type) };
    if (m.sysId !== state.autopilot.sysId) return;
    state.heartbeats++;
    state.firstHeartbeatMs ??= nowMs;
    state.lastHeartbeatMs = nowMs;
    state.armed = (num(d.baseMode) & MAV_MODE_FLAG_SAFETY_ARMED) !== 0;
    state.customMode = num(d.customMode);
    state.mode = modeName(state, state.customMode);
    state.seen.add(m.msgId);
    return;
  }
  if (!state.autopilot || m.sysId !== state.autopilot.sysId) return;
  state.seen.add(m.msgId);
  switch (m.msgId) {
    case MSG.SYS_STATUS: {
      const mv = num(d.voltageBattery);
      const ca = num(d.currentBattery);
      const pct = num(d.batteryRemaining);
      state.battery = {
        voltageV: mv === 65535 ? undefined : mv / 1000,
        currentA: ca === -1 ? undefined : ca / 100,
        remainingPct: pct === -1 ? undefined : pct,
      };
      break;
    }
    case MSG.GPS_RAW_INT: {
      const fixType = num(d.fixType);
      const sats = num(d.satellitesVisible);
      const eph = num(d.eph);
      const hAcc = num(d.hAcc);
      state.gps = {
        fixType,
        fix: GPS_FIX[fixType] ?? `fix ${fixType}`,
        satellites: sats === 255 ? undefined : sats,
        ephM: eph === 65535 ? undefined : eph / 100,
        hAccM: hAcc > 0 ? hAcc / 1000 : undefined,
      };
      break;
    }
    case MSG.GLOBAL_POSITION_INT: {
      const hdg = num(d.hdg);
      state.position = {
        lat: num(d.lat) / 1e7,
        lon: num(d.lon) / 1e7,
        relAltM: num(d.relativeAlt) / 1000,
        headingDeg: hdg === 65535 ? undefined : hdg / 100,
      };
      break;
    }
    case MSG.RADIO_STATUS:
      state.radio = { rssi: num(d.rssi), remrssi: num(d.remrssi) };
      break;
    case MSG.STATUSTEXT:
      state.statusText.push({ severity: num(d.severity), text: text(d.text), atMs: nowMs });
      break;
    case MSG.PARAM_VALUE:
      state.params.set(text(d.paramId).toUpperCase(), num(d.paramValue));
      state.paramCount = num(d.paramCount);
      break;
  }
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip';
export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
}

export interface EvaluateOptions {
  nowMs: number;
  paramDiffs?: ParamDiff[];
  paramsRequested: boolean;
  /** What the raw bytes looked like; turns "no heartbeat" into a specific cause. */
  raw?: RawLinkDiagnosis;
}

/** Explain a missing heartbeat from what actually arrived on the socket. */
function noHeartbeatDetail(raw: RawLinkDiagnosis | undefined): string {
  switch (raw?.kind) {
    case 'silent':
      return 'No data at all from the datalink. Check that the SIYI app datalink connection mode is UDP, the air unit is linked (ping 192.168.144.11), the UART cable from the air unit to TELEM1, and that the flight controller is powered.';
    case 'double-rate':
      return `Bytes arrive (${raw.bytes} B) but none are MAVLink, and ${raw.matchPct}% of them look like serial data read at twice its baud rate: the SIYI datalink baud is double the flight controller's SERIALn_BAUD (for example 115200 on the remote, 57600 on the board). Set both to the same value.`;
    case 'not-mavlink':
      return `Bytes arrive (${raw.bytes} B) but none decode as MAVLink. Most likely the SIYI datalink baud and SERIALn_BAUD differ (the UniFC 6 Pico ships with 57600 on TELEM1), or SERIALn_PROTOCOL is not 2.`;
    case 'mavlink':
      return `MAVLink arrives (${raw.frames} frames) but no autopilot heartbeat: only ground stations or other components are on the link.`;
    default:
      return 'No heartbeat from an autopilot. Check the LAN cable to the UniRC 7 Pro, the PC address (192.168.144.x), the datalink connection mode (UDP) and baud in the SIYI app, and SERIALn_PROTOCOL/BAUD on the flight controller.';
  }
}

/** Bench checks that can be judged without sending any command. */
export function evaluate(state: BenchState, o: EvaluateOptions): CheckResult[] {
  const r: CheckResult[] = [];
  const add = (id: string, title: string, status: CheckStatus, detail: string) => r.push({ id, title, status, detail });

  if (!state.autopilot || state.heartbeats === 0) {
    add('link', 'Autopilot heartbeat', 'fail', noHeartbeatDetail(o.raw));
    return r;
  }
  const spanS = Math.max(1, ((state.lastHeartbeatMs ?? o.nowMs) - (state.firstHeartbeatMs ?? o.nowMs)) / 1000);
  const rate = state.heartbeats > 1 ? (state.heartbeats - 1) / spanS : 0;
  add('link', 'Autopilot heartbeat', 'pass', `${state.autopilot.name}, system ${state.autopilot.sysId}, vehicle type ${state.autopilot.vehicleType}, ${state.heartbeats} heartbeats`);
  add('heartbeat-rate', 'Heartbeat rate ≈ 1 Hz', rate >= 0.8 ? 'pass' : 'warn', `${rate.toFixed(2)} Hz`);
  const silentS = (o.nowMs - (state.lastHeartbeatMs ?? o.nowMs)) / 1000;
  add('link-fresh', 'Link fresh at end of run', silentS <= 3 ? 'pass' : 'fail', `last heartbeat ${silentS.toFixed(1)} s ago (platform marks STALE after 5 s)`);
  add('rover', 'Autopilot is ArduPilot Rover', state.autopilot.name === 'ArduPilot' && state.autopilot.vehicleType === MAV_TYPE_GROUND_ROVER ? 'pass' : 'warn',
    `${state.autopilot.name}, MAV_TYPE ${state.autopilot.vehicleType} (Rover = ${MAV_TYPE_GROUND_ROVER})`);
  add('disarmed', 'Disarmed on the bench', state.armed === false ? 'pass' : 'fail', state.armed ? 'ARMED — disarm on the remote before continuing' : 'disarmed');
  add('mode', 'Boot mode is HOLD (INITIAL_MODE 4)', state.mode === 'HOLD' ? 'pass' : 'warn', state.mode ?? 'unknown');

  const streams = [MSG.SYS_STATUS, MSG.GPS_RAW_INT, MSG.GLOBAL_POSITION_INT].filter((id) => state.seen.has(id));
  add('streams', 'Telemetry streams arriving', streams.length === 3 ? 'pass' : 'warn',
    streams.length === 3 ? 'SYS_STATUS, GPS_RAW_INT, GLOBAL_POSITION_INT' : `only ${streams.length}/3 stream types seen — check MAV2_* stream rates (SR1_* before ArduPilot 4.7)`);

  if (!state.battery?.voltageV) add('battery', 'Battery voltage reported', 'warn', 'no voltage — check the power module and BATT_MONITOR');
  else add('battery', 'Battery voltage reported', 'pass', `${state.battery.voltageV.toFixed(2)} V` + (state.battery.remainingPct !== undefined ? `, ${state.battery.remainingPct}%` : ''));

  if (!state.gps || state.gps.fixType === 0) add('gps', 'GNSS fix (needed for position on the map)', 'warn', 'no GPS detected — position on the map needs a GNSS module');
  else if (state.gps.fixType < 3) add('gps', 'GNSS fix (needed for position on the map)', 'warn', `${state.gps.fix}, ${state.gps.satellites ?? '?'} satellites — needs open sky`);
  else add('gps', 'GNSS fix (needed for position on the map)', 'pass', `${state.gps.fix}, ${state.gps.satellites ?? '?'} satellites` + (state.gps.hAccM ? `, ±${state.gps.hAccM.toFixed(1)} m` : ''));

  add('other-gcs', 'No other ground station on the link', state.otherGcsHeartbeats === 0 ? 'pass' : 'warn',
    state.otherGcsHeartbeats === 0 ? 'none heard' : `${state.otherGcsHeartbeats} heartbeats from another GCS (UniGCS/QGroundControl?) — close it before running the gateway`);

  const errors = state.statusText.filter((s) => s.severity <= 3);
  add('statustext', 'No error messages from the autopilot', errors.length === 0 ? 'pass' : 'warn',
    errors.length === 0 ? `${state.statusText.length} status messages, none at error level` : errors.slice(0, 5).map((e) => e.text).join(' | '));

  if (!o.paramsRequested) add('params', 'Parameters match the vehicle file', 'skip', 'parameter read disabled');
  else if (!state.paramCount) add('params', 'Parameters match the vehicle file', 'warn', 'no PARAM_VALUE received');
  else {
    const got = state.params.size;
    const diffs = o.paramDiffs ?? [];
    const critical = diffs.filter((d) => d.severity === 'critical');
    const warnings = diffs.filter((d) => d.severity === 'warning');
    const status: CheckStatus = critical.length ? 'fail' : got < state.paramCount || warnings.length ? 'warn' : 'pass';
    add('params', 'Parameters match the vehicle file', status,
      `read ${got}/${state.paramCount}; ${critical.length} critical, ${warnings.length} warnings` +
        (critical.length ? ` (${critical.map((d) => d.name).join(', ')})` : ''));
  }
  return r;
}
