import { DEFAULT_LAYERS, SEED_USERS, seedDevices, seedEvidence, seedIncidents, seedTimeline } from '@13store/shared';
import type { AppState } from '@13store/shared';

export { DEFAULT_ROUTE } from '@13store/shared';

/** 17 Oct 2026 05:27:00 Asia/Bangkok — the scenario start time from the concept mockup. */
export const SCENARIO_START = Date.UTC(2026, 9, 16, 22, 27, 0);

export function initialState(): AppState {
  const now = SCENARIO_START;
  return {
    now,
    userId: 'u-alex',
    users: SEED_USERS.filter((u) => ['dispatcher', 'supervisor', 'operator', 'auditor'].includes(u.role)),
    view: 'overview',
    mapMode: '3d',
    layers: { ...DEFAULT_LAYERS },
    selectedIncidentId: 'INC-024',
    selectedDeviceId: null,
    selectedBuildingId: null,
    indoorView: null,
    incidents: seedIncidents(now),
    devices: seedDevices(now),
    missions: [],
    commands: [],
    timeline: seedTimeline(now),
    evidence: seedEvidence(now),
    audit: [],
    telemetry: [],
    linkCut: {},
    failsafeAt: {},
    replay: { active: false, at: now },
    assignments: [],
    dataLabel: 'OFFLINE DEMO',
    toasts: [],
    presentation: false,
    seq: 1,
  };
}
