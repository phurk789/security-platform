// SIYI bench probe — read-only. Connects to the UniRC 7 Pro datalink (or listens for the
// flight controller), records what the UniFC 6 Pico reports, reads every parameter, compares
// them with deploy/vehicle/tracked-ugv-rover.param and writes a JSON report.
//
//   npx tsx tools/siyi-bench/probe.ts                       # UniRC 7 Pro at 192.168.144.20:19856
//   npx tsx tools/siyi-bench/probe.ts --listen 14550        # FC Ethernet / UDP output to this PC
//   npx tsx tools/siyi-bench/probe.ts --duration 40 --no-params
//
// It never arms, changes mode, uploads a mission, overrides RC or writes a parameter:
// every outgoing message passes guard.ts.

import dgram from 'node:dgram';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { MavLinkPacketParser, MavLinkPacketSplitter, MavLinkProtocolV2, ardupilotmega, common, minimal, type MavLinkData, type MavLinkPacket } from 'node-mavlink';
import { assertGcsHeartbeat, assertSendAllowed } from './guard';
import { diffParams, parseParamFile, type ParamDiff } from './params';
import { createRawStats, diagnoseRawLink, recordDatagram, recordFrame } from './rawlink';
import { applyMessage, createState, evaluate, MSG } from './telemetry';

const REGISTRY: Record<number, new () => MavLinkData> = { ...minimal.REGISTRY, ...common.REGISTRY, ...ardupilotmega.REGISTRY } as never;
const here = dirname(fileURLToPath(import.meta.url));

const { values: args } = parseArgs({
  options: {
    host: { type: 'string', default: '192.168.144.20' },
    port: { type: 'string', default: '19856' },
    listen: { type: 'string' },
    duration: { type: 'string', default: '30' },
    params: { type: 'string', default: resolve(here, '../../deploy/vehicle/tracked-ugv-rover.param') },
    'no-params': { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const durationMs = Number(args.duration) * 1000;
const readParams = !args['no-params'];
const expected = readParams ? parseParamFile(readFileSync(args.params!, 'utf8')) : [];
const state = createState(Date.now());
const raw = createRawStats();
const proto = new MavLinkProtocolV2(255, 190);
const sock = dgram.createSocket('udp4');
const input = new PassThrough();
let peer: { host: string; port: number } | undefined = args.listen ? undefined : { host: args.host!, port: Number(args.port) };
let seq = 0;
let paramsRequestedAt: number | undefined;
let missingRequested = false;

function send(msg: MavLinkData) {
  const ctor = msg.constructor as unknown as { MSG_ID: number; MSG_NAME: string };
  assertSendAllowed(ctor.MSG_ID, ctor.MSG_NAME);
  if (!peer) return;
  sock.send(proto.serialize(msg, seq++ & 0xff), peer.port, peer.host);
}

function gcsHeartbeat() {
  const hb = new minimal.Heartbeat();
  hb.type = 6 as never;
  hb.autopilot = 8 as never;
  hb.baseMode = 0 as never;
  hb.customMode = 0;
  hb.systemStatus = 4 as never;
  hb.mavlinkVersion = 3;
  assertGcsHeartbeat({ type: 6, autopilot: 8, baseMode: 0, customMode: 0 });
  send(hb);
}

function requestParamList() {
  if (!state.autopilot) return;
  const m = new common.ParamRequestList();
  m.targetSystem = state.autopilot.sysId;
  m.targetComponent = state.autopilot.compId;
  send(m);
  paramsRequestedAt = Date.now();
}

/** Ask once, by index, for parameters the list stream dropped. */
function requestMissingParams() {
  if (!state.autopilot || !state.paramCount || missingRequested) return;
  missingRequested = true;
  const have = state.params.size;
  if (have >= state.paramCount) return;
  for (const p of expected) {
    if (state.params.has(p.name)) continue;
    const m = new common.ParamRequestRead();
    m.targetSystem = state.autopilot.sysId;
    m.targetComponent = state.autopilot.compId;
    m.paramId = p.name;
    m.paramIndex = -1;
    send(m);
  }
}

input.pipe(new MavLinkPacketSplitter()).pipe(new MavLinkPacketParser()).on('data', (p: MavLinkPacket) => {
  recordFrame(raw);
  const clazz = REGISTRY[p.header.msgid];
  if (!clazz) return;
  const data = p.protocol.data(p.payload, clazz as never) as unknown as Record<string, unknown>;
  applyMessage(state, { msgId: p.header.msgid, sysId: p.header.sysid, compId: p.header.compid, data }, Date.now());
  if (p.header.msgid === MSG.HEARTBEAT && readParams && paramsRequestedAt === undefined && state.autopilot) requestParamList();
});

sock.on('message', (msg, rinfo) => {
  if (args.listen && !peer) peer = { host: rinfo.address, port: rinfo.port };
  recordDatagram(raw, msg);
  input.write(msg);
});
sock.on('error', (e) => console.error(`UDP error: ${e.message}`));
if (args.listen) sock.bind(Number(args.listen));
else sock.bind(0);

console.log(args.listen ? `Listening on UDP ${args.listen} for ${args.duration} s…` : `Probing ${args.host}:${args.port} for ${args.duration} s… (read-only)`);
const hbTimer = setInterval(gcsHeartbeat, 1000);
gcsHeartbeat();
const missingTimer = setTimeout(requestMissingParams, Math.max(5000, durationMs * 0.7));
const endTimer = setTimeout(finish, durationMs);
process.on('SIGINT', finish);

let finished = false;
function finish() {
  if (finished) return;
  finished = true;
  clearInterval(hbTimer);
  clearTimeout(missingTimer);
  clearTimeout(endTimer);
  sock.close();
  const now = Date.now();
  const paramDiffs: ParamDiff[] | undefined = readParams && state.paramCount ? diffParams(expected, state.params) : undefined;
  const rawDiagnosis = diagnoseRawLink(raw);
  const checks = evaluate(state, { nowMs: now, paramDiffs, paramsRequested: readParams, raw: rawDiagnosis });
  const report = {
    tool: 'siyi-bench-probe',
    readOnly: true,
    generatedAt: new Date(now).toISOString(),
    link: args.listen ? { mode: 'listen', port: Number(args.listen) } : { mode: 'client', host: args.host, port: Number(args.port) },
    durationS: (now - state.startedMs) / 1000,
    rawLink: { datagrams: raw.datagrams, bytes: raw.bytes, frames: raw.frames, diagnosis: rawDiagnosis },
    autopilot: state.autopilot,
    armed: state.armed,
    mode: state.mode,
    battery: state.battery,
    gps: state.gps,
    position: state.position,
    radio: state.radio,
    statusText: state.statusText,
    paramsRead: state.params.size,
    paramCount: state.paramCount,
    checks,
    paramDiffs: paramDiffs?.filter((d) => d.kind !== 'match'),
    params: Object.fromEntries([...state.params].sort(([a], [b]) => a.localeCompare(b))),
  };
  const out = args.out ?? `siyi-bench-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`;
  writeFileSync(out, JSON.stringify(report, null, 2));
  const mark = { pass: 'PASS', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' } as const;
  for (const c of checks) console.log(`${mark[c.status].padEnd(4)}  ${c.title} — ${c.detail}`);
  for (const d of paramDiffs?.filter((x) => x.kind !== 'match') ?? []) {
    console.log(`  ${d.severity.toUpperCase().padEnd(8)} ${d.name}: expected ${d.expected}, got ${d.actual ?? 'missing'}${d.confirm ? ' (CONFIRM)' : ''}`);
  }
  console.log(`\nReport written to ${out}`);
  process.exitCode = checks.some((c) => c.status === 'fail') ? 1 : 0;
}
