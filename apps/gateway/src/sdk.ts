// Adapter SDK — the interface a device adapter implements to plug into the Edge Gateway.
//
// An adapter owns one device. It declares what the device can do (AdapterDeclaration),
// streams telemetry, and executes commands the server sends. The gateway handles the
// network to the server; the adapter only talks to its device (SDK, serial, radio, sim…).
//
// Rules every adapter must follow (see docs/ADAPTER_CONTRACT.md):
//  - Only declare commands the device really executes. The server never sends others.
//  - Report `succeeded` only when the device confirms the effect, never when you just sent it.
//  - Reject commands whose `expiresAt` has passed. Never execute the same `idempotencyKey` twice.
//  - On link loss the device must reach a safe state on its own. Nothing received or queued
//    during the outage may run after the link comes back.

import type { AdapterDeclaration, CameraAction, GwCameraResult, GwCommandUpdate, GwDeviceEvent, GwTelemetry, SrvCommand, SrvDemo } from '@13store/shared';

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (m, e) => console.log(`[gw] ${m}`, e ?? ''),
  warn: (m, e) => console.warn(`[gw] ${m}`, e ?? ''),
  error: (m, e) => console.error(`[gw] ${m}`, e ?? ''),
};

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** Telemetry as an adapter reports it. The gateway fills in `t` and `deviceId`. */
export type TelemetryReport = Omit<GwTelemetry, 't' | 'deviceId'>;
/** Command status update. `at` defaults to now. */
export type CommandReport = Omit<GwCommandUpdate, 't' | 'at'> & { at?: number };
/** Device event. `at` defaults to now. */
export type EventReport = Omit<GwDeviceEvent, 't' | 'deviceId' | 'at'> & { at?: number };

/** What the gateway gives an adapter. All sends are fire-and-forget; while the gateway is
 *  disconnected from the server they are dropped, not buffered. */
export interface AdapterContext {
  /** Current time in ms (use this, not Date.now(), so tests can control the clock). */
  now(): number;
  telemetry(t: TelemetryReport): void;
  commandUpdate(u: CommandReport): void;
  event(e: EventReport): void;
  /** Result of a camera control request (gimbal, zoom, photo, record). */
  cameraResult(r: Omit<GwCameraResult, 't' | 'deviceId'>): void;
  log: Logger;
}

export interface Adapter {
  readonly declaration: AdapterDeclaration;
  /** Called once when the gateway starts. Begin talking to the device and streaming telemetry. */
  start(ctx: AdapterContext): void;
  /** Release timers and device connections. */
  stop(): void;
  /** A command from the server for this device. */
  onCommand(cmd: SrvCommand): void;
  /** Demo/presenter control (simulators only; real adapters may ignore it). */
  onDemo(action: SrvDemo['action']): void;
  /** Camera control, for adapters that declare the 'gimbal' / 'zoom' / 'photo' capabilities. */
  onCamera?(requestId: string, action: CameraAction): void;
}

/** Outcome of checking an incoming command against the ledger. */
export type LedgerCheck =
  | { kind: 'new' }
  | { kind: 'duplicate'; status: GwCommandUpdate['status'] | 'received'; detail?: string }
  | { kind: 'expired' };

/**
 * Tracks commands by idempotency key so a retried request never executes twice,
 * and rejects commands that arrive after their expiry.
 */
export class CommandLedger {
  private byKey = new Map<string, { commandId: string; status: GwCommandUpdate['status'] | 'received'; detail?: string }>();

  check(cmd: SrvCommand, now: number): LedgerCheck {
    const seen = this.byKey.get(cmd.idempotencyKey);
    if (seen) return { kind: 'duplicate', status: seen.status, detail: seen.detail };
    if (now > cmd.expiresAt) return { kind: 'expired' };
    return { kind: 'new' };
  }

  record(cmd: SrvCommand, status: GwCommandUpdate['status'] | 'received', detail?: string) {
    this.byKey.set(cmd.idempotencyKey, { commandId: cmd.commandId, status, detail });
  }

  commandIdFor(key: string) {
    return this.byKey.get(key)?.commandId;
  }

  clear() {
    this.byKey.clear();
  }
}

/**
 * Standard handling for the parts of a command every adapter must do the same way:
 * dedupe, expiry, and "not supported". Returns true if the adapter should go on and execute it.
 */
export function admitCommand(ctx: AdapterContext, decl: AdapterDeclaration, ledger: CommandLedger, cmd: SrvCommand): boolean {
  const res = ledger.check(cmd, ctx.now());
  if (res.kind === 'duplicate') {
    // Re-report what we already know; never execute again.
    if (res.status !== 'received') ctx.commandUpdate({ commandId: ledger.commandIdFor(cmd.idempotencyKey) ?? cmd.commandId, status: res.status, detail: res.detail });
    ctx.log.info(`duplicate idempotency key ${cmd.idempotencyKey} ignored`);
    return false;
  }
  if (res.kind === 'expired') {
    const detail = 'Command expired before it reached the device. Not executed.';
    ledger.record(cmd, 'rejected', detail);
    ctx.commandUpdate({ commandId: cmd.commandId, status: 'rejected', detail });
    return false;
  }
  if (!decl.commands.includes(cmd.type)) {
    const detail = `${decl.deviceId} does not support ${cmd.type}.`;
    ledger.record(cmd, 'rejected', detail);
    ctx.commandUpdate({ commandId: cmd.commandId, status: 'rejected', detail });
    return false;
  }
  ledger.record(cmd, 'received');
  return true;
}
