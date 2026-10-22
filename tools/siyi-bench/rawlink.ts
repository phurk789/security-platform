// Looks at the raw UDP bytes from the SIYI datalink when no MAVLink frame decodes, to tell
// "nothing arrives" apart from "bytes arrive at the wrong baud rate".
// Pure functions only: probe.ts feeds the socket data in, tests feed synthetic serial data.

export interface RawLinkStats {
  datagrams: number;
  bytes: number;
  /** MAVLink frames with a valid CRC (the node-mavlink splitter drops the rest). */
  frames: number;
  /** The first bytes received, kept for the pattern test. */
  sample: number[];
}

export const RAW_SAMPLE_LIMIT = 4096;
/** Below this many non-zero bytes the pattern test is not trusted. */
export const MIN_PATTERN_BYTES = 32;
/** Random bytes match the double-rate pattern 1 time in 16 (6 %); real mismatches match ~100 %. */
export const DOUBLE_RATE_MIN_MATCH = 0.9;

export function createRawStats(): RawLinkStats {
  return { datagrams: 0, bytes: 0, frames: 0, sample: [] };
}

export function recordDatagram(s: RawLinkStats, data: Uint8Array): void {
  s.datagrams++;
  s.bytes += data.length;
  for (let i = 0; i < data.length && s.sample.length < RAW_SAMPLE_LIMIT; i++) s.sample.push(data[i]);
}

export function recordFrame(s: RawLinkStats): void {
  s.frames++;
}

const bit = (b: number, i: number) => (b >> i) & 1;

/**
 * True when a byte looks like serial data read at twice the sender's baud rate. The receiver
 * sees every sent bit twice, so its bit 0 is the tail of the sender's start bit (always 0) and
 * bits 1-2, 3-4 and 5-6 come in equal pairs. Example: 0x66 = 0110 0110.
 */
export function hasDoubleRateSignature(b: number): boolean {
  return bit(b, 0) === 0 && bit(b, 1) === bit(b, 2) && bit(b, 3) === bit(b, 4) && bit(b, 5) === bit(b, 6);
}

export type RawLinkDiagnosis =
  | { kind: 'silent' }
  | { kind: 'mavlink'; frames: number }
  | { kind: 'double-rate'; bytes: number; matchPct: number }
  | { kind: 'not-mavlink'; bytes: number; matchPct?: number };

export function diagnoseRawLink(s: RawLinkStats): RawLinkDiagnosis {
  if (s.frames > 0) return { kind: 'mavlink', frames: s.frames };
  if (s.bytes === 0) return { kind: 'silent' };
  // Zero bytes carry no pattern information (a long low line reads as 0x00 at any rate).
  const nonZero = s.sample.filter((b) => b !== 0);
  if (nonZero.length < MIN_PATTERN_BYTES) return { kind: 'not-mavlink', bytes: s.bytes };
  const match = nonZero.filter(hasDoubleRateSignature).length / nonZero.length;
  const matchPct = Math.round(match * 100);
  return match >= DOUBLE_RATE_MIN_MATCH ? { kind: 'double-rate', bytes: s.bytes, matchPct } : { kind: 'not-mavlink', bytes: s.bytes, matchPct };
}
