// Shared plumbing for simulated devices: telemetry ticker, link-loss simulation, timers.
import type { AdapterDeclaration, Device, SrvCommand, SrvDemo } from '@13store/shared';
import { CommandLedger, type Adapter, type AdapterContext, type EventReport } from '../sdk';

export interface SimOptions {
  /** Start with the radio link cut (device appears offline). */
  offline?: boolean;
  /** Override the telemetry interval (ms). Defaults to the declaration's rateMs. */
  rateMs?: number;
}

const LINK_LOSS: Record<Device['kind'], string> = {
  ugv: 'Stops in place ~1.5 s after link loss. Does not resume by itself after reconnect.',
  uav: 'Simulated only. A real UAV follows its flight controller failsafe (RTL/hover), configured per site.',
  cctv: 'Stream stops. No state to recover.',
};

export function declarationFrom(d: Device, rateMs = d.rateMs): AdapterDeclaration {
  return {
    deviceId: d.id,
    kind: d.kind,
    model: d.model,
    adapterVersion: d.adapterVersion,
    protocolVersion: 'sim/1',
    firmwareTested: d.firmwareTested,
    integration: 'simulated',
    capabilities: [...d.capabilities],
    commands: [...d.commands],
    units: d.kind === 'uav' ? { position: 'site-m', altitude: 'm-site-datum', speed: 'm/s', battery: 'percent' } : { position: 'site-m', speed: 'm/s', battery: 'percent' },
    rateMs,
    limitations: d.limitations,
    linkLossBehavior: LINK_LOSS[d.kind],
    view: d.view,
  };
}

export abstract class SimDevice implements Adapter {
  readonly declaration: AdapterDeclaration;
  protected ctx!: AdapterContext;
  protected ledger = new CommandLedger();
  protected linkCut: boolean;
  protected seq = 0;
  private ticker?: ReturnType<typeof setInterval>;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  /** Events raised while the radio link is down; delivered in order once it is back. */
  private heldEvents: EventReport[] = [];
  protected lastTick = 0;

  constructor(
    protected seed: Device,
    protected opts: SimOptions = {},
  ) {
    this.declaration = declarationFrom(seed, opts.rateMs ?? seed.rateMs);
    this.linkCut = !!opts.offline;
  }

  start(ctx: AdapterContext) {
    this.ctx = ctx;
    this.lastTick = ctx.now();
    this.ticker = setInterval(() => this.tick(), this.declaration.rateMs);
  }

  stop() {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  private tick() {
    const now = this.ctx.now();
    const dt = Math.max(0, now - this.lastTick) / 1000;
    this.lastTick = now;
    this.step(dt, now);
    if (!this.linkCut) this.sendTelemetry(now);
  }

  /** Advance the simulated device by dt seconds. */
  protected abstract step(dt: number, now: number): void;
  protected abstract sendTelemetry(now: number): void;
  protected abstract resetState(): void;

  onCommand(cmd: SrvCommand) {
    if (this.linkCut) {
      // The radio never delivered it: the device knows nothing about this command.
      this.ctx.log.warn(`${this.declaration.deviceId}: link down, ${cmd.type} ${cmd.commandId} lost`);
      return;
    }
    this.handleCommand(cmd);
  }

  protected handleCommand(cmd: SrvCommand) {
    const detail = `${this.declaration.deviceId} does not accept commands.`;
    this.ledger.record(cmd, 'rejected', detail);
    this.ctx.commandUpdate({ commandId: cmd.commandId, status: 'rejected', detail });
  }

  onDemo(action: SrvDemo['action']) {
    if (action === 'cut_link') {
      if (this.linkCut) return;
      this.linkCut = true;
      this.onLinkLost(this.ctx.now());
    } else if (action === 'restore_link') {
      if (!this.linkCut) return;
      // Hook runs while the link still counts as down, so anything it emits is queued
      // and delivered in time order with the other held events.
      this.onLinkRestored();
      this.linkCut = false;
      const held = this.heldEvents.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      this.heldEvents = [];
      for (const e of held) this.ctx.event(e);
    } else if (action === 'reset') {
      for (const t of this.timers) clearTimeout(t);
      this.timers.clear();
      this.heldEvents = [];
      this.ledger.clear();
      this.linkCut = !!this.opts.offline;
      this.resetState();
    }
  }

  protected onLinkLost(_at: number) {}
  protected onLinkRestored() {}

  /** Raise a device event; held until the link is back if the radio is down. */
  protected emit(e: EventReport) {
    const ev = { ...e, at: e.at ?? this.ctx.now() };
    if (this.linkCut) this.heldEvents.push(ev);
    else this.ctx.event(ev);
  }

  /** Command status updates are live radio traffic: lost while the link is down. */
  protected report(commandId: string, status: 'acknowledged' | 'executing' | 'succeeded' | 'rejected' | 'failed', cmd: SrvCommand, detail?: string) {
    this.ledger.record(cmd, status, detail);
    if (!this.linkCut) this.ctx.commandUpdate({ commandId, status, detail });
  }

  protected later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }
}
