// Equipment status tracking for real adapters: parts start `pending` and become `ok` the first
// time the adapter actually talks to them; changes ride along in the next telemetry sample.
import type { ComponentStatus, ComponentUpdate, DeviceComponent } from '@13store/shared';

export class ComponentTracker {
  private parts = new Map<string, DeviceComponent>();
  private dirty = new Map<string, ComponentUpdate>();

  constructor(initial: DeviceComponent[]) {
    for (const c of initial) this.parts.set(c.id, { ...c });
  }

  /** The declared list (for the adapter's declaration). */
  list(): DeviceComponent[] {
    return [...this.parts.values()].map((c) => ({ ...c }));
  }

  get(id: string) {
    return this.parts.get(id);
  }

  /** Record a status/version/detail change; a no-op when nothing changed. */
  set(id: string, patch: { status?: ComponentStatus; version?: string; detail?: string }) {
    const c = this.parts.get(id);
    if (!c) return;
    const u: ComponentUpdate = { id };
    if (patch.status && patch.status !== c.status) u.status = c.status = patch.status;
    if (patch.version !== undefined && patch.version !== c.version) u.version = c.version = patch.version;
    if (patch.detail !== undefined && patch.detail !== c.detail) u.detail = c.detail = patch.detail;
    if (u.status === undefined && u.version === undefined && u.detail === undefined) return;
    this.dirty.set(id, { ...this.dirty.get(id), ...u });
  }

  /** Updates since the last flush, or undefined when there are none. */
  flush(): ComponentUpdate[] | undefined {
    if (!this.dirty.size) return undefined;
    const out = [...this.dirty.values()];
    this.dirty.clear();
    return out;
  }
}
