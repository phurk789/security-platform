import type { GwTelemetry, SrvCommand } from '@13store/shared';
import { CommandLedger, silentLogger, type AdapterContext, type CommandReport, type EventReport } from '../src/sdk';

export interface Captured {
  telemetry: Omit<GwTelemetry, 't' | 'deviceId'>[];
  updates: CommandReport[];
  events: EventReport[];
  camera: Parameters<AdapterContext['cameraResult']>[0][];
}

/** Context that records everything an adapter sends. Uses Date.now (faked by vi timers). In-memory ledger unless one is given. */
export function fakeCtx(ledger = new CommandLedger({ now: () => Date.now() })): { ctx: AdapterContext; got: Captured } {
  const got: Captured = { telemetry: [], updates: [], events: [], camera: [] };
  const ctx: AdapterContext = {
    now: () => Date.now(),
    ledger,
    log: silentLogger,
    telemetry: (t) => got.telemetry.push(t),
    commandUpdate: (u) => got.updates.push(u),
    event: (e) => got.events.push(e),
    cameraResult: (r) => got.camera.push(r),
  };
  return { ctx, got };
}

let n = 0;
export function cmd(type: SrvCommand['type'], extra: Partial<SrvCommand> = {}): SrvCommand {
  n += 1;
  return {
    t: 'command',
    commandId: `CMD-${n}`,
    idempotencyKey: `key-${n}`,
    deviceId: 'UGV-01',
    type,
    missionId: 'MSN-1',
    expiresAt: Date.now() + 10_000,
    ...extra,
  };
}

export const statuses = (got: Captured, commandId: string) => got.updates.filter((u) => u.commandId === commandId).map((u) => u.status);
