import { describe, expect, it } from 'vitest';
import { applyComponentUpdates, cameraComponents, componentSummary, verificationPending } from '../src/components';
import { seedDevices } from '../src/seed';
import type { DeviceComponent } from '../src/types';

const parts: DeviceComponent[] = [
  { id: 'fc', name: 'FC', kind: 'flight_controller', status: 'pending' },
  { id: 'cam-rear', name: 'Rear', kind: 'camera', status: 'ok', facing: 'rear' },
  { id: 'cam', name: 'Front', kind: 'camera', status: 'ok', facing: 'front' },
];

describe('device equipment', () => {
  it('merges status updates by id and ignores unknown parts', () => {
    const next = applyComponentUpdates(parts, [
      { id: 'fc', status: 'ok', version: 'ArduPilot' },
      { id: 'nope', status: 'ok' },
    ])!;
    expect(next.find((c) => c.id === 'fc')).toMatchObject({ status: 'ok', version: 'ArduPilot' });
    expect(next).toHaveLength(3);
    expect(applyComponentUpdates(parts, [{ id: 'cam' }])).toBe(parts); // nothing changed → same array
  });

  it('orders cameras front first and reports verification pending for testing devices', () => {
    expect(cameraComponents({ components: parts }).map((c) => c.id)).toEqual(['cam', 'cam-rear']);
    expect(verificationPending({ integration: 'testing', components: parts })).toBe(true);
    expect(verificationPending({ integration: 'verified', components: parts })).toBe(false);
    expect(componentSummary(parts)).toMatchObject({ total: 3, ok: 2, pending: 1 });
  });

  it('gives every seed device an equipment list with a camera where it has video', () => {
    for (const d of Object.values(seedDevices(Date.now()))) {
      expect(d.components?.length, d.id).toBeGreaterThan(0);
      if (d.kind === 'cctv' || d.capabilities.includes('camera')) expect(cameraComponents(d).length, d.id).toBeGreaterThan(0);
    }
    expect(cameraComponents(seedDevices(Date.now())['UGV-02']).map((c) => c.facing)).toEqual(['front', 'rear']);
  });
});
