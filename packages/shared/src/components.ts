// Equipment on a device: what the adapter declared, what it has verified, and helpers for the
// Equipment tab. Status is per part, separate from the device being online and from the
// adapter's integration status (an adapter can be TESTING with every part answering).
import type { ComponentKind, ComponentStatus, ComponentUpdate, Device, DeviceComponent } from './types';

export const COMPONENT_KIND_LABEL: Record<ComponentKind, string> = {
  flight_controller: 'Flight controller',
  computer: 'Edge computer',
  camera: 'Camera',
  gimbal: 'Gimbal',
  radio: 'Radio link',
  remote: 'Remote controller',
  gnss: 'GNSS',
  lidar: 'LiDAR',
  battery: 'Battery',
  payload: 'Payload',
  network: 'Network',
  other: 'Other',
};

export const COMPONENT_STATUS_LABEL: Record<ComponentStatus, string> = { ok: 'OK', warn: 'Warning', fault: 'Fault', offline: 'Offline', pending: 'Interface verification pending' };

export const COMPONENT_STATUSES: ComponentStatus[] = ['ok', 'warn', 'fault', 'offline', 'pending'];
export const COMPONENT_KINDS: ComponentKind[] = Object.keys(COMPONENT_KIND_LABEL) as ComponentKind[];

export function componentSummary(cs: DeviceComponent[] | undefined) {
  const out = { total: 0, ok: 0, warn: 0, fault: 0, offline: 0, pending: 0 };
  for (const c of cs ?? []) {
    out.total++;
    out[c.status]++;
  }
  return out;
}

/** Merge status updates (from telemetry) into the component list by id; unknown ids are ignored. */
export function applyComponentUpdates(cs: DeviceComponent[] | undefined, ups: ComponentUpdate[]): DeviceComponent[] | undefined {
  if (!cs?.length || !ups.length) return cs;
  let changed = false;
  const next = cs.map((c) => {
    const u = ups.find((x) => x.id === c.id);
    if (!u) return c;
    const n = { ...c };
    if (u.status && u.status !== c.status) n.status = u.status;
    if (u.version !== undefined && u.version !== c.version) n.version = u.version;
    if (u.detail !== undefined && u.detail !== c.detail) n.detail = u.detail;
    if (n.status !== c.status || n.version !== c.version || n.detail !== c.detail) changed = true;
    return n;
  });
  return changed ? next : cs;
}

/** Cameras on a device, front camera first (each becomes a feed tab). */
export function cameraComponents(d: Pick<Device, 'components'>) {
  const order = { front: 0, down: 1, left: 2, right: 3, rear: 4 };
  return (d.components ?? []).filter((c) => c.kind === 'camera').sort((a, b) => (order[a.facing ?? 'front'] ?? 9) - (order[b.facing ?? 'front'] ?? 9));
}

/** True while any interface on a TESTING device is still unverified. */
export function verificationPending(d: Pick<Device, 'integration' | 'components'>) {
  return d.integration !== 'verified' && (d.components ?? []).some((c) => c.status === 'pending');
}
