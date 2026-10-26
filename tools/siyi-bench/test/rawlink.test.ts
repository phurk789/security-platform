import { describe, expect, it } from 'vitest';
import { MavLinkProtocolV2, common, minimal } from 'node-mavlink';
import { createRawStats, diagnoseRawLink, hasDoubleRateSignature, recordDatagram, recordFrame } from '../rawlink';
import { createState, evaluate } from '../telemetry';

/** Drive an 8N1 serial line: `ticksPerBit` samples per sent bit, idle high between bytes. */
function uartLine(bytes: Uint8Array, ticksPerBit: number): number[] {
  const line: number[] = [];
  const put = (v: number, bits = 1) => {
    for (let i = 0; i < bits * ticksPerBit; i++) line.push(v);
  };
  put(1, 4);
  for (const b of bytes) {
    put(0); // start bit
    for (let i = 0; i < 8; i++) put((b >> i) & 1);
    put(1, 2); // stop bit + one idle bit
  }
  put(1, 12);
  return line;
}

/** Read the line as an 8N1 UART with `ticksPerBit` samples per received bit. Framing errors are kept. */
function uartRead(line: number[], ticksPerBit: number): Uint8Array {
  const out: number[] = [];
  let i = 1;
  while (i < line.length) {
    if (!(line[i - 1] === 1 && line[i] === 0)) {
      i++;
      continue;
    }
    const at = (k: number) => line[Math.min(line.length - 1, i + Math.floor((k + 0.5) * ticksPerBit))];
    let b = 0;
    for (let k = 0; k < 8; k++) b |= at(k + 1) << k;
    out.push(b);
    i += Math.floor(9.5 * ticksPerBit);
  }
  return Uint8Array.from(out);
}

/** What a flight controller sends: a few seconds of heartbeats and SYS_STATUS. */
function autopilotBytes(): Uint8Array {
  const proto = new MavLinkProtocolV2(1, 1);
  const frames: Buffer[] = [];
  for (let i = 0; i < 20; i++) {
    const hb = new minimal.Heartbeat();
    hb.type = 2 as never;
    hb.autopilot = 3 as never;
    hb.baseMode = 81 as never;
    hb.customMode = i % 3;
    hb.systemStatus = 3 as never;
    hb.mavlinkVersion = 3;
    const sys = new common.SysStatus();
    sys.voltageBattery = 12_000 + i;
    sys.batteryRemaining = 72;
    frames.push(proto.serialize(hb, 2 * i), proto.serialize(sys, 2 * i + 1));
  }
  return new Uint8Array(Buffer.concat(frames));
}

/** Byte counts captured on 2026-10-22 from the UniRC 7 Pro: remote at 115200, UniFC 6 Pico at 57600. */
const CAPTURED_57600_AT_115200: [number, number][] = [
  [0x00, 180], [0x06, 35], [0x1e, 32], [0xe6, 24], [0x80, 22], [0x86, 21], [0x66, 21], [0x18, 19],
  [0x9e, 17], [0xe0, 8], [0xfe, 7], [0xf8, 7], [0x98, 6], [0x60, 4], [0x78, 3], [0x7e, 2],
];

describe('raw datalink diagnosis', () => {
  it('reads correctly when both sides use the same baud (checks the simulator)', () => {
    const sent = autopilotBytes();
    expect(uartRead(uartLine(sent, 8), 8)).toEqual(sent);
  });

  it('recognizes the bytes captured from the real board as a 2x baud mismatch', () => {
    const s = createRawStats();
    recordDatagram(s, Uint8Array.from(CAPTURED_57600_AT_115200.flatMap(([b, n]) => Array<number>(n).fill(b))));
    expect(CAPTURED_57600_AT_115200.every(([b]) => b === 0 || hasDoubleRateSignature(b))).toBe(true);
    expect(diagnoseRawLink(s)).toEqual({ kind: 'double-rate', bytes: 408, matchPct: 100 });
  });

  it('flags MAVLink sent at 57600 and read at 115200', () => {
    const s = createRawStats();
    recordDatagram(s, uartRead(uartLine(autopilotBytes(), 8), 4));
    expect(diagnoseRawLink(s).kind).toBe('double-rate');
  });

  it('does not blame the 2x pattern when the receiver is the slower side', () => {
    const s = createRawStats();
    recordDatagram(s, uartRead(uartLine(autopilotBytes(), 8), 16));
    const d = diagnoseRawLink(s);
    expect(d.kind).toBe('not-mavlink');
  });

  it('separates silence, too little data and a working link', () => {
    expect(diagnoseRawLink(createRawStats())).toEqual({ kind: 'silent' });

    const few = createRawStats();
    recordDatagram(few, Uint8Array.from([0x66, 0x06, 0x86]));
    expect(diagnoseRawLink(few)).toEqual({ kind: 'not-mavlink', bytes: 3 });

    const ok = createRawStats();
    recordDatagram(ok, uartRead(uartLine(autopilotBytes(), 8), 4));
    recordFrame(ok);
    expect(diagnoseRawLink(ok)).toEqual({ kind: 'mavlink', frames: 1 });
  });

  it('MAVLink start bytes never match the pattern', () => {
    expect(hasDoubleRateSignature(0xfd)).toBe(false);
    expect(hasDoubleRateSignature(0x55)).toBe(false);
  });

  it('puts the cause in the heartbeat check', () => {
    const checks = evaluate(createState(0), { nowMs: 1000, paramsRequested: true, raw: { kind: 'double-rate', bytes: 408, matchPct: 100 } });
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ id: 'link', status: 'fail' });
    expect(checks[0].detail).toMatch(/twice its baud rate/);
    expect(evaluate(createState(0), { nowMs: 1000, paramsRequested: true, raw: { kind: 'silent' } })[0].detail).toMatch(/connection mode is UDP/);
  });
});
