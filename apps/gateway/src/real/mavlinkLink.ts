// How the gateway reaches a flight controller:
//  • UDP: a SIYI UniRC 7 / 7 Pro datalink ("client") or the board's own Ethernet port ("listen").
//  • Serial: a computer on the vehicle (e.g. a Raspberry Pi wired to TELEM1, or a USB cable). Linux only.
// A link only moves bytes: the adapter parses and builds the MAVLink frames.
import { execFileSync } from 'node:child_process';
import dgram from 'node:dgram';
import { closeSync, constants, openSync } from 'node:fs';
import type { Duplex } from 'node:stream';
import tty from 'node:tty';
import type { Logger } from '../sdk';

export type LinkConfig =
  | { mode: 'client'; host: string; port: number }
  | { mode: 'listen'; port: number }
  /** baud: the board's SERIALn_BAUD (115 → 115200). A USB cable ignores it. */
  | { mode: 'serial'; path: string; baud?: number };

export const SERIAL_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 500000, 921600, 1500000];
export const DEFAULT_BAUD = 115200;
/** A device node, e.g. /dev/ttyAMA0, /dev/ttyACM0 or /dev/serial/by-id/usb-ArduPilot_…-if00. */
const SERIAL_PATH = /^\/dev\/[A-Za-z0-9._:+/-]+$/;

export interface VehicleLink {
  /** For logs and the device's limitations, e.g. "192.168.144.20:19856" or "serial /dev/ttyAMA0 at 115200 baud". */
  readonly describe: string;
  start(onData: (bytes: Buffer) => void): void;
  /** Dropped while the link is down (no peer yet, port unplugged): the adapter repeats what matters. */
  send(bytes: Buffer): void;
  stop(): void;
}

/** What is wrong with a site.json `link`, or null. Omitted is fine (the UniRC datalink). */
export function linkProblem(link: unknown): string | null {
  if (link === undefined) return null;
  const l = link as Record<string, unknown>;
  if (!l || typeof l !== 'object') return 'link must be an object';
  const udpPort = (p: unknown) => Number.isInteger(p) && (p as number) >= 1 && (p as number) <= 65535;
  switch (l.mode) {
    case 'client':
      if (typeof l.host !== 'string' || !l.host.trim()) return 'link.host is required for mode "client"';
      return udpPort(l.port) ? null : 'link.port must be a UDP port (1–65535)';
    case 'listen':
      return udpPort(l.port) ? null : 'link.port must be a UDP port (1–65535)';
    case 'serial':
      if (typeof l.path !== 'string' || !SERIAL_PATH.test(l.path) || l.path.includes('..'))
        return 'link.path must be a serial device such as /dev/ttyAMA0 or /dev/ttyACM0';
      if (l.baud !== undefined && !SERIAL_BAUDS.includes(l.baud as number)) return `link.baud must be one of ${SERIAL_BAUDS.join(', ')}`;
      return null;
    default:
      return 'link.mode must be "client", "listen" or "serial"';
  }
}

export function describeLink(link: LinkConfig): string {
  if (link.mode === 'client') return `${link.host}:${link.port}`;
  if (link.mode === 'listen') return `UDP :${link.port}`;
  return `serial ${link.path} at ${link.baud ?? DEFAULT_BAUD} baud`;
}

export function createLink(link: LinkConfig, log: Logger, deviceId: string, serial: SerialDeps = linuxSerial): VehicleLink {
  return link.mode === 'serial' ? new SerialLink(link, log, deviceId, serial) : new UdpLink(link, log, deviceId);
}

class UdpLink implements VehicleLink {
  readonly describe: string;
  private sock?: dgram.Socket;
  private peer?: { host: string; port: number };

  constructor(
    private cfg: Exclude<LinkConfig, { mode: 'serial' }>,
    private log: Logger,
    private deviceId: string,
  ) {
    this.describe = describeLink(cfg);
  }

  start(onData: (bytes: Buffer) => void) {
    const sock = dgram.createSocket('udp4');
    this.sock = sock;
    sock.on('message', (msg, rinfo) => {
      // listen: answer whoever the vehicle sends from (its address is learned, not configured).
      if (this.cfg.mode === 'listen') this.peer = { host: rinfo.address, port: rinfo.port };
      onData(msg);
    });
    sock.on('error', (e) => this.log.warn(`${this.deviceId}: UDP error ${e.message}`));
    if (this.cfg.mode === 'client') {
      this.peer = { host: this.cfg.host, port: this.cfg.port };
      sock.bind(0);
    } else sock.bind(this.cfg.port);
  }

  send(bytes: Buffer) {
    if (this.sock && this.peer) this.sock.send(bytes, this.peer.port, this.peer.host);
  }

  stop() {
    this.sock?.close();
    this.sock = undefined;
  }
}

/** Opening a serial port. Replaced in tests; the real one needs Linux (stty and a tty device). */
export interface SerialDeps {
  /** Raw 8N1 at this speed, no echo, no flow control (only TX, RX and GND are wired). */
  configure(path: string, baud: number): void;
  open(path: string): Duplex;
  /** Wait before trying an unplugged or missing port again. Default 2 s. */
  retryMs?: number;
}

export const linuxSerial: SerialDeps = {
  configure(path, baud) {
    // "raw" alone leaves echo on: the board would get its own bytes back.
    execFileSync('stty', ['-F', path, String(baud), 'raw', '-echo', '-echonl', 'cs8', '-parenb', '-cstopb', 'clocal', 'cread', '-crtscts'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 5000,
    });
  },
  open(path) {
    // O_NOCTTY: the service has no terminal, so without it the port would become its controlling terminal, and a
    // hang-up (USB cable pulled) would send SIGHUP to the whole gateway.
    const fd = openSync(path, constants.O_RDWR | constants.O_NOCTTY);
    try {
      // A tty stream reads without blocking a thread, and writes on the same handle.
      return new tty.ReadStream(fd);
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  },
};

class SerialLink implements VehicleLink {
  readonly describe: string;
  private port?: Duplex;
  private retry?: ReturnType<typeof setTimeout>;
  private stopped = true;
  /** Down since the last report: log the first failure, then once when it works again. */
  private down = false;
  private onData?: (bytes: Buffer) => void;

  constructor(
    private cfg: Extract<LinkConfig, { mode: 'serial' }>,
    private log: Logger,
    private deviceId: string,
    private deps: SerialDeps,
  ) {
    this.describe = describeLink(cfg);
  }

  start(onData: (bytes: Buffer) => void) {
    this.onData = onData;
    this.stopped = false;
    this.open();
  }

  send(bytes: Buffer) {
    const p = this.port;
    if (p && !p.destroyed && p.writable) p.write(bytes);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    const p = this.port;
    this.port = undefined;
    p?.destroy();
  }

  private open() {
    this.retry = undefined;
    if (this.stopped) return;
    const { path } = this.cfg;
    let port: Duplex;
    try {
      this.deps.configure(path, this.cfg.baud ?? DEFAULT_BAUD);
      port = this.deps.open(path);
    } catch (e) {
      if (!this.down) this.log.warn(`${this.deviceId}: cannot open ${path} (${firstLine(e)}); trying again every ${this.retryMs / 1000} s`);
      this.down = true;
      this.later();
      return;
    }
    this.log.info(`${this.deviceId}: ${this.down ? 'serial port back' : 'serial port open'}: ${this.describe}`);
    this.down = false;
    this.port = port;
    port.on('data', (b: Buffer) => this.onData?.(b));
    port.on('error', (e) => {
      this.log.warn(`${this.deviceId}: ${path}: ${e.message}`);
      port.destroy();
    });
    port.on('close', () => {
      if (this.port !== port) return;
      this.port = undefined;
      if (this.stopped) return;
      this.log.warn(`${this.deviceId}: ${path} closed (cable unplugged or board restarting); trying again every ${this.retryMs / 1000} s`);
      this.down = true;
      this.later();
    });
  }

  private get retryMs() {
    return this.deps.retryMs ?? 2000;
  }

  private later() {
    if (!this.stopped && !this.retry) this.retry = setTimeout(() => this.open(), this.retryMs);
  }
}

/** stty's own message is on stderr; Node's error text starts with "Command failed: …". */
function firstLine(e: unknown) {
  const err = e as { stderr?: Buffer | string; message?: string };
  const text = (err.stderr ? String(err.stderr) : '') || err.message || String(e);
  return text.trim().split('\n')[0];
}
