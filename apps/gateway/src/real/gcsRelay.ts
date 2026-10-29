// Relay for a ground station on the same machine as the gateway (CLEANUP_PLAN E-5): UniGCS on the SIYI remote.
// The remote's datalink (192.168.144.20:19856) serves one client well; with two, commands from the second are lost
// and the platform loses telemetry while UniGCS loads parameters (tested 27 Oct). So the gateway stays the only
// client of the datalink and listens on a local port (default 127.0.0.1:19857) for UniGCS, which connects there
// (UDPCL 127.0.0.1:19857) instead. Every datagram from the vehicle also goes to UniGCS, and every frame from
// UniGCS goes to the vehicle unchanged (its own system and component id), with one rule:
//   while the console drives, UniGCS's stick input (RC_CHANNELS_OVERRIDE, MANUAL_CONTROL) is held back, so two
//   drivers never fight over the sticks. Anything else, a mode change to HOLD or a disarm included, goes through:
//   the person at the remote can always stop the vehicle (and a mode change ends console driving).
import dgram from 'node:dgram';
import type { Logger } from '../sdk';

export const GCS_RELAY_DEFAULT = { host: '127.0.0.1', port: 19857 };
/** A local ground station that sent nothing for this long counts as gone (it sends a heartbeat every second). */
export const GCS_RELAY_STALE_MS = 5_000;

const MSG_HEARTBEAT = 0;
const MSG_SET_MODE = 11;
const MSG_MISSION_COUNT = 44;
const MSG_MANUAL_CONTROL = 69;
const MSG_RC_CHANNELS_OVERRIDE = 70;
const MSG_COMMAND_LONG = 76;
const MAV_TYPE_GCS = 6;
const CMD_DO_SET_MODE = 176;
const CMD_ARM_DISARM = 400;

export interface Frame {
  bytes: Buffer;
  sysid: number;
  compid: number;
  msgid: number;
  /** Payload as sent (MAVLink 2 trims trailing zero bytes: read it through `padded`). */
  payload: Buffer;
}

/**
 * Split a UDP datagram into MAVLink 1/2 frames. Bytes that are not a whole frame (noise, a cut-off frame) come back
 * in `rest` so a relay can pass them on untouched.
 */
export function splitFrames(buf: Buffer): { frames: Frame[]; rest: Buffer[] } {
  const frames: Frame[] = [];
  const rest: Buffer[] = [];
  let i = 0;
  while (i < buf.length) {
    const magic = buf[i];
    if (magic !== 0xfd && magic !== 0xfe) {
      let j = i + 1;
      while (j < buf.length && buf[j] !== 0xfd && buf[j] !== 0xfe) j++;
      rest.push(buf.subarray(i, j));
      i = j;
      continue;
    }
    const v2 = magic === 0xfd;
    const head = v2 ? 10 : 6;
    if (i + head > buf.length) break;
    const len = buf[i + 1];
    const total = head + len + 2 + (v2 && buf[i + 2] & 0x01 ? 13 : 0);
    if (i + total > buf.length) break;
    const bytes = buf.subarray(i, i + total);
    frames.push({
      bytes,
      sysid: v2 ? buf[i + 5] : buf[i + 3],
      compid: v2 ? buf[i + 6] : buf[i + 4],
      msgid: v2 ? buf[i + 7] | (buf[i + 8] << 8) | (buf[i + 9] << 16) : buf[i + 5],
      payload: buf.subarray(i + head, i + head + len),
    });
    i += total;
  }
  if (i < buf.length) rest.push(buf.subarray(i));
  return { frames, rest };
}

/** Payload padded with zeros to `size` (MAVLink 2 drops trailing zero bytes). */
const padded = (p: Buffer, size: number) => (p.length >= size ? p : Buffer.concat([p, Buffer.alloc(size - p.length)]));

/** What a frame from the local ground station asks for, in words for the log; undefined for routine traffic. */
export function describeGcsFrame(f: Frame, modeName: (m: number) => string): string | undefined {
  if (f.msgid === MSG_SET_MODE) return `mode change to ${modeName(padded(f.payload, 6).readUInt32LE(0))}`;
  if (f.msgid === MSG_MISSION_COUNT) return 'mission upload';
  if (f.msgid !== MSG_COMMAND_LONG) return undefined;
  const p = padded(f.payload, 33);
  const command = p.readUInt16LE(28);
  if (command === CMD_DO_SET_MODE) return `mode change to ${modeName(Math.round(p.readFloatLE(4)))}`;
  if (command === CMD_ARM_DISARM) return p.readFloatLE(0) >= 0.5 ? 'arm' : 'disarm';
  return undefined;
}

export interface RelayState {
  /** host:port the gateway listens on for the local ground station. */
  listen: string;
  connected: boolean;
  /** Address the local ground station sends from. */
  peer?: string;
  lastSeenAt?: number;
  /** System id the local ground station uses (its heartbeats). */
  sysid?: number;
}

export interface GcsRelayOptions {
  deviceId: string;
  host: string;
  port: number;
  log: Logger;
  now: () => number;
  /** Send bytes to the vehicle (over the datalink socket). */
  toVehicle: (b: Buffer) => void;
  /** True while the console drives: the local ground station's stick input is held back. */
  driving: () => boolean;
  modeName: (m: number) => string;
  onChange: (s: RelayState, note?: string) => void;
  staleMs?: number;
}

export class GcsRelay {
  private sock?: dgram.Socket;
  private peer?: { address: string; port: number };
  private lastSeenAt = 0;
  private sysid?: number;
  private connected = false;
  private heldBack = 0;
  private wasDriving = false;

  constructor(private o: GcsRelayOptions) {}

  /** The port actually bound (differs from the configured one only when that is 0, in tests). */
  private bound = 0;

  get state(): RelayState {
    return {
      listen: `${this.o.host}:${this.bound || this.o.port}`,
      connected: this.connected,
      ...(this.peer ? { peer: `${this.peer.address}:${this.peer.port}` } : {}),
      ...(this.lastSeenAt ? { lastSeenAt: this.lastSeenAt } : {}),
      ...(this.sysid !== undefined ? { sysid: this.sysid } : {}),
    };
  }

  start() {
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('message', (msg, r) => this.fromGcs(msg, { address: r.address, port: r.port }));
    sock.on('error', (e) => this.o.log.warn(`${this.o.deviceId}: ground station relay on ${this.o.host}:${this.o.port}: ${e.message}`));
    sock.bind(this.o.port, this.o.host, () => {
      this.bound = (sock.address() as { port: number }).port;
      this.o.log.info(`${this.o.deviceId}: ground station relay listening on ${this.o.host}:${this.bound} (UniGCS: UDPCL ${this.o.host} port ${this.bound})`);
    });
  }

  stop() {
    this.sock?.close();
    this.sock = undefined;
  }

  /** A datagram from the vehicle: also for the local ground station while it is there. */
  fromVehicle(buf: Buffer) {
    if (this.connected && this.peer && this.sock) this.sock.send(buf, this.peer.port, this.peer.address);
  }

  /** Called a few times a second: notice a ground station that went away, and the end of console driving. */
  tick() {
    const now = this.o.now();
    if (this.connected && now - this.lastSeenAt > (this.o.staleMs ?? GCS_RELAY_STALE_MS)) {
      this.connected = false;
      this.o.log.info(`${this.o.deviceId}: ground station on the remote disconnected`);
      this.o.onChange(this.state);
    }
    const driving = this.o.driving();
    if (this.wasDriving && !driving && this.heldBack) {
      this.o.log.info(`${this.o.deviceId}: held back ${this.heldBack} stick message(s) from the ground station while the console drove`);
      this.heldBack = 0;
    }
    this.wasDriving = driving;
  }

  private fromGcs(buf: Buffer, from: { address: string; port: number }) {
    this.peer = from;
    this.lastSeenAt = this.o.now();
    const { frames, rest } = splitFrames(buf);
    const driving = this.o.driving();
    const pass: Buffer[] = [...rest];
    let note: string | undefined;
    for (const f of frames) {
      if (f.msgid === MSG_HEARTBEAT && padded(f.payload, 9)[4] === MAV_TYPE_GCS) this.sysid = f.sysid;
      if (driving && (f.msgid === MSG_RC_CHANNELS_OVERRIDE || f.msgid === MSG_MANUAL_CONTROL)) {
        if (!this.heldBack) this.o.log.warn(`${this.o.deviceId}: the console is driving: stick input from the ground station on the remote is held back`);
        this.heldBack++;
        continue;
      }
      const what = describeGcsFrame(f, this.o.modeName);
      if (what) {
        note = `UniGCS on the remote: ${what}`;
        this.o.log.info(`${this.o.deviceId}: ${note}`);
      }
      pass.push(f.bytes);
    }
    if (pass.length) this.o.toVehicle(pass.length === 1 ? pass[0] : Buffer.concat(pass));
    if (!this.connected) {
      this.connected = true;
      this.o.log.info(`${this.o.deviceId}: ground station on the remote connected from ${from.address}:${from.port}`);
      this.o.onChange(this.state, note);
    } else if (note) this.o.onChange(this.state, note);
  }
}
