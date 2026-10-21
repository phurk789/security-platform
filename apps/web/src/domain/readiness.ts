// Hardware readiness of a real UGV, worked out from what the adapter reports. Read-only: it never
// unlocks driving. A part counts as passed only when the adapter says the part answered (`ok`);
// parts with nothing to report on (E-stop, engine failsafe) pass only after site sign-off, which is
// recorded by setting the device's integration status to `verified`.
import type { ComponentKind, ComponentStatus, Device, DeviceComponent } from '@13store/shared';

export type ReadinessKey = 'telemetry' | 'controller' | 'camera' | 'depth' | 'estop';

export interface ReadinessRow {
  key: ReadinessKey;
  status: ComponentStatus;
  /** English source text; translated where it is shown. */
  detail: string;
}

const WORST: ComponentStatus[] = ['fault', 'offline', 'pending', 'warn', 'ok'];

/** Worst status among the parts of these kinds, or null when none is fitted. */
function partsStatus(d: Device, kinds: ComponentKind[], match?: (c: DeviceComponent) => boolean): ComponentStatus | null {
  const parts = (d.components ?? []).filter((c) => kinds.includes(c.kind) && (!match || match(c)));
  if (!parts.length) return null;
  return WORST.find((s) => parts.some((p) => p.status === s)) ?? 'ok';
}

/** Only real vehicles get the panel: simulated ones have no hardware to verify. */
export function showsReadiness(d: Device) {
  return d.kind === 'ugv' && d.integration !== 'simulated';
}

export function readinessRows(d: Device, live: boolean): ReadinessRow[] {
  // A lidar, or a camera named as a depth / stereo / time-of-flight camera.
  const isDepth = (c: DeviceComponent) => c.kind === 'lidar' || /depth|stereo|tof|lidar/i.test(c.name);
  const ctl = partsStatus(d, ['flight_controller', 'computer', 'remote', 'radio']);
  const cam = partsStatus(d, ['camera', 'gimbal'], (c) => !isDepth(c));
  const depth = partsStatus(d, ['lidar', 'camera'], isDepth);
  const signedOff = d.integration === 'verified';
  return [
    {
      key: 'telemetry',
      status: live ? 'ok' : 'offline',
      detail: live ? 'Telemetry is fresh. This is a link check, not a hardware sign-off.' : 'No fresh telemetry from the vehicle.',
    },
    {
      key: 'controller',
      status: ctl ?? 'pending',
      detail: ctl === 'ok' ? 'Controller and radio answered.' : 'Check firmware, steering, throttle and that the local RC overrides remote commands.',
    },
    {
      key: 'camera',
      status: cam ?? 'pending',
      detail: cam === null ? 'No camera fitted.' : cam === 'ok' ? 'Camera answered.' : 'Check video and pan/tilt on site.',
    },
    {
      key: 'depth',
      status: depth ?? 'pending',
      detail:
        depth === null
          ? 'No depth sensor fitted: there is no automatic obstacle stop.'
          : depth === 'ok'
            ? 'Depth sensor answered. It must not be the only emergency-stop layer.'
            : 'Calibrate the depth sensor and test obstacle stops on site.',
    },
    {
      key: 'estop',
      status: signedOff ? 'ok' : 'pending',
      detail: signedOff ? 'Signed off on site.' : 'Test the hardwired stop, brakes and loss-of-link behaviour on site, then mark the device verified.',
    },
  ];
}

export const READINESS_LABEL: Record<ReadinessKey, string> = {
  telemetry: 'Vehicle telemetry',
  controller: 'Controller (SIYI / MAVLink)',
  camera: 'Onboard / PTZ camera',
  depth: 'Depth vision / obstacle stop',
  estop: 'Physical E-stop / engine failsafe',
};
