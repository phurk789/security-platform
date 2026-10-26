import { DEFAULT_GEOFENCES, DEFAULT_LAYERS, DEFAULT_PLAYBOOKS, SEED_USERS, SITE, seedDevices, seedEvidence, seedIncidents, seedTimeline } from '@13store/shared';
import type { AppState } from '@13store/shared';
import { attachPlaybook } from './reducer';

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
    // Nothing is selected at start: the queue shows what is new, and the right panel shows the
    // site overview until the operator picks an incident (the booth script selects INC-024).
    selectedIncidentId: null,
    selectedDeviceId: null,
    selectedBuildingId: null,
    indoorView: null,
    incidents: seedIncidents(now).map((inc) => {
      attachPlaybook({ playbooks: DEFAULT_PLAYBOOKS }, inc);
      return inc;
    }),
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
    geofences: DEFAULT_GEOFENCES.map((g) => ({ ...g, poly: g.poly.map((p) => ({ ...p })) })),
    geo: { ...SITE.geo },
    detections: [],
    patrols: [],
    playbooks: DEFAULT_PLAYBOOKS,
    dataLabel: 'OFFLINE DEMO',
    toasts: [],
    presentation: false,
    seq: 1,
  };
}
