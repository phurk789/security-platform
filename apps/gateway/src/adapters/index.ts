import { seedDevices } from '@13store/shared';
import type { Adapter } from '../sdk';
import { SimCctv } from './simCctv';
import { SimUav } from './simUav';
import { SimUgv } from './simUgv';

export { SimCctv, SimUav, SimUgv };
export { SimDevice, declarationFrom, type SimOptions } from './base';
export { snapshotFrame, UGV_FAILSAFE_MS, UGV_ACK_MS, UGV_EXEC_MS, UGV_CONFIRM_MS } from './simUgv';

export interface DefaultAdapterOptions {
  /** Device ids that start with the link cut (offline). Default: CCTV-04 (see INC-022). */
  offline?: string[];
  /** Override every device's telemetry interval (ms) — handy in tests. */
  rateMs?: number;
  /** Simulate radio/backhaul delay on telemetry (default true). */
  latency?: boolean;
}

/** The seed devices of the demo site, all simulated. */
export function defaultAdapters(opts: DefaultAdapterOptions = {}): Adapter[] {
  const offline = new Set(opts.offline ?? ['CCTV-04']);
  return Object.values(seedDevices(Date.now())).map((d) => {
    const o = { offline: offline.has(d.id), rateMs: opts.rateMs, latency: opts.latency ?? true };
    if (d.kind === 'ugv') return new SimUgv(d, o);
    if (d.kind === 'uav') return new SimUav(d, o);
    return new SimCctv(d, o);
  });
}
