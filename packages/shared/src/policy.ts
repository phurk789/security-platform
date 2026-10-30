// Rules shared by the server (authoritative) and the clients (to hide what a role cannot do).
import { BUILDINGS, atBuilding } from './site';
import { operatingAreas, routeOutsideSite, routeViolations, type Geofence } from './routing';
import { floorPlan, inNoGo, routeCrossesWalls } from './indoor';
import type { Device, Freshness, Mission, OperationalMode, Point, Role } from './types';

/** Telemetry older than this is stale (PRD §9: 5 s default for the demo vehicle). */
export const STALE_AFTER_MS = 5_000;
/** Telemetry older than this is treated as offline. */
export const OFFLINE_AFTER_MS = 15_000;
/** Commands with no acknowledgement by this time are timed out (F07). */
export const COMMAND_ACK_TIMEOUT_MS = 5_000;
/** Commands are only valid for this long; expired commands are never delivered (F09). */
export const COMMAND_TTL_MS = 10_000;
/** Demo vehicle speed in m/s (accelerated for a 3-minute booth run). */
export const UGV_SPEED = 6;
/** Indoor UGVs (corridors, people nearby): walking pace. */
export const INDOOR_UGV_SPEED = 1.5;
/** Route speed assumed for a real vehicle until its autopilot reports one (m/s). */
export const REAL_ROUTE_SPEED = 1;
/** During a route: warn at this battery level, and hold the vehicle at the second. */
export const MISSION_BATTERY_WARN_PCT = 20;
export const MISSION_BATTERY_HOLD_PCT = 15;

/** Speed to plan arrival times with: the autopilot's route speed, else the demo or a cautious default. */
export function routeSpeedOf(d: Pick<Device, 'routeSpeed' | 'integration' | 'indoor'>) {
  if (d.routeSpeed && d.routeSpeed > 0) return d.routeSpeed;
  if (d.indoor) return INDOOR_UGV_SPEED;
  return d.integration === 'simulated' ? UGV_SPEED : REAL_ROUTE_SPEED;
}
/** Sensitive actions need a password check within this window (risk-based auth, PRD §8). */
export const STEP_UP_WINDOW_MS = 15 * 60_000;

export type Action =
  | 'incident.create'
  | 'incident.triage'
  | 'incident.verify'
  | 'incident.edit'
  | 'incident.assign'
  | 'incident.resolve'
  | 'incident.close'
  | 'incident.reopen'
  | 'mission.prepare'
  | 'mission.approve'
  | 'mission.accept'
  | 'device.command'
  | 'control.handover'
  | 'media.view'
  | 'camera.control'
  | 'payload.control'
  | 'evidence.view'
  | 'evidence.add'
  | 'evidence.export'
  | 'report.view'
  | 'audit.view'
  | 'field.update'
  | 'admin.users'
  | 'admin.devices'
  | 'admin.keys'
  | 'admin.backup'
  | 'admin.settings'
  | 'admin.privacy'
  | 'site.geofences'
  | 'site.manage'
  | 'patrol.manage'
  | 'device.service'
  /** SHADOW → LIVE_MANUAL (ADR-006). Supervisor, with step-up and a reason. */
  | 'device.mode.promote'
  /** LIVE_* → SHADOW. Supervisor or device administrator (the system may always demote). */
  | 'device.mode.demote'
  /** Edge media origins that gateway-declared stream URLs must match (SSRF guard). */
  | 'admin.edge_origins'
  | 'demo.control';

const DISPATCH: Action[] = [
  'incident.create',
  'incident.triage',
  'incident.verify',
  'incident.edit',
  'incident.assign',
  'incident.resolve',
  'incident.close',
  'incident.reopen',
  'mission.prepare',
  'media.view',
  'camera.control',
  'payload.control',
  'evidence.view',
  'evidence.add',
  'report.view',
  'demo.control',
];

/** Operators accept missions and command the vehicle they hold. */
const OPERATE: Action[] = ['mission.accept', 'device.command', 'media.view', 'camera.control', 'payload.control', 'evidence.view', 'evidence.add', 'report.view', 'demo.control'];

const uniq = (...lists: Action[][]): Action[] => [...new Set(lists.flat())];

/** Supervisors do everything dispatchers and operators do, plus approvals, live mode, patrols and zones. */
const SUPERVISE: Action[] = uniq(DISPATCH, OPERATE, [
  'mission.approve',
  'control.handover',
  'evidence.export',
  'audit.view',
  'site.geofences',
  'patrol.manage',
  'device.mode.promote',
  'device.mode.demote',
]);

/**
 * Role → allowed actions (PRD §3). Roles are levels: a supervisor can do everything a dispatcher
 * and an operator can, an administrator everything a supervisor can plus running the system.
 * Viewing video, exporting evidence and controlling devices stay separate permissions (F13), and
 * the two-person rule (whoever approves a mission does not operate it) is enforced on the
 * mission itself, not by role.
 */
export const MATRIX: Record<Role, Action[]> = {
  dispatcher: DISPATCH,
  supervisor: SUPERVISE,
  operator: OPERATE,
  responder: ['incident.create', 'field.update', 'evidence.view', 'evidence.add'],
  auditor: ['media.view', 'evidence.view', 'evidence.export', 'report.view', 'audit.view'],
  admin: uniq(SUPERVISE, [
    'admin.users',
    'admin.devices',
    'admin.keys',
    'admin.backup',
    'admin.settings',
    'admin.privacy',
    'site.manage',
    'device.service',
    'admin.edge_origins',
  ]),
};

/** Actions that require a recent password check. */
export const STEP_UP_ACTIONS: Action[] = [
  'mission.approve',
  'evidence.export',
  'control.handover',
  'admin.users',
  'admin.keys',
  'admin.backup',
  'admin.privacy',
  'patrol.manage',
  'site.manage',
  'device.mode.promote',
  'admin.edge_origins',
];

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

// ---------------------------------------------------------------------------
// Operational mode (ADR-006, ADR-015 L1 safety gate)
// ---------------------------------------------------------------------------

/**
 * The mode a device is actually in. Simulated adapters are always SIMULATION; a real device
 * without a stored LIVE mode (new, old record, unknown value) is SHADOW. Never raises a mode.
 */
export function modeOf(d: Pick<Device, 'integration' | 'mode'>): OperationalMode {
  if (d.integration === 'simulated') return 'SIMULATION';
  return d.mode === 'LIVE_MANUAL' || d.mode === 'LIVE_ASSISTED' ? d.mode : 'SHADOW';
}

/**
 * May a request that moves or switches on something reach this device? Stop, pause and hold are
 * never asked here: they pass in every mode. SIMULATION only drives a simulator, so it passes.
 * A person needs LIVE_MANUAL (or LIVE_ASSISTED); automation (auto-aim, scheduled starts) needs LIVE_ASSISTED.
 */
export function modeAllowsMotion(mode: OperationalMode, by: 'person' | 'automation'): boolean {
  if (mode === 'SIMULATION') return true;
  if (by === 'automation') return mode === 'LIVE_ASSISTED';
  return mode === 'LIVE_MANUAL' || mode === 'LIVE_ASSISTED';
}

export const MODE_LABEL: Record<OperationalMode, string> = {
  SIMULATION: 'Simulation — commands drive a simulator',
  SHADOW: 'Shadow — real data, no commands to the device',
  LIVE_MANUAL: 'Live manual — a person may command the device',
  LIVE_ASSISTED: 'Live assisted — automation allowed by policy',
};

export const ROLE_LABEL: Record<Role, string> = {
  dispatcher: 'Dispatcher',
  supervisor: 'Supervisor',
  operator: 'Operator',
  responder: 'Field Responder',
  auditor: 'Auditor',
  admin: 'Administrator',
};

export function freshnessAt(now: number, d: Pick<Device, 'kind' | 'lastSeen' | 'rateMs'>): Freshness {
  const age = Math.max(0, now - d.lastSeen);
  const staleAfter = Math.max(STALE_AFTER_MS, d.rateMs * 3);
  if (d.kind === 'cctv') return age > 60_000 ? 'offline' : age > staleAfter ? 'stale' : 'live';
  if (age > OFFLINE_AFTER_MS) return 'offline';
  if (age > staleAfter) return 'stale';
  return 'live';
}

export const BUSY_MISSION: Mission['status'][] = ['pending_approval', 'approved', 'assigned', 'executing', 'paused'];

export function isReadyAt(now: number, d: Device, missions: Pick<Mission, 'deviceId' | 'status'>[]) {
  if (d.kind === 'cctv' || d.commands.length === 0) return false;
  if (freshnessAt(now, d) !== 'live') return false;
  if ((d.battery ?? 100) < 25) return false;
  return !missions.some((m) => m.deviceId === d.id && BUSY_MISSION.includes(m.status));
}

export interface Check {
  label: string;
  ok: boolean;
  hard: boolean;
  detail: string;
}

/**
 * Where a route may go: inside the site's operating area, legs included. A real vehicle needs one
 * drawn; simulated vehicles on a site without one keep the demo site boundary.
 */
export function routeAreaCheck(d: Pick<Device, 'kind' | 'integration'>, route: Point[], fences: Geofence[]): Check {
  const kind = d.kind === 'uav' ? 'uav' : 'ugv';
  const hasArea = operatingAreas(fences, kind).length > 0;
  if (!hasArea && d.integration !== 'simulated') return { label: 'Route inside the operating area', ok: false, hard: true, detail: 'No operating area drawn for this site' };
  const out = route.length ? routeOutsideSite(route, fences, kind) : [];
  return {
    label: hasArea ? 'Route inside the operating area' : 'Route inside the site boundary',
    ok: route.length > 0 && out.length === 0,
    hard: true,
    detail: out.length ? `Checkpoints ${out.join(', ')} outside` : `${route.length} checkpoints inside`,
  };
}

/** Pre-approval checks shown to the supervisor and re-run by the server on approve. */
export function constraintChecksAt(now: number, d: Device, m: Mission, nameOf: (id?: string) => string, fences: Geofence[] = []): Check[] {
  const fresh = freshnessAt(now, d);
  const area = routeAreaCheck(d, m.checkpoints, fences);
  const battery = d.battery ?? 0;
  const hits = d.kind === 'ugv' || d.kind === 'uav' ? routeViolations(m.checkpoints, d.pos, fences, d.kind) : [];
  const routeChecks: Check[] = d.indoor
    ? indoorRouteChecks(d, m)
    : [
        area,
        ...(fences.length
          ? [
              {
                label: 'Route clear of keep-out zones',
                ok: hits.length === 0,
                hard: true,
                detail: hits.length ? `Enters ${hits.map((f) => f.name).join(', ')}` : `${fences.filter((f) => f.active).length} active zones checked`,
              },
            ]
          : []),
      ];
  return [
    { label: 'Telemetry fresh', ok: fresh === 'live', hard: true, detail: fresh === 'live' ? 'Last seen < 5 s' : `Telemetry ${fresh}` },
    { label: 'Battery ≥ 30%', ok: battery >= 30, hard: true, detail: `${Math.round(battery)}%` },
    ...routeChecks,
    { label: 'Operator assigned', ok: !!m.operatorId, hard: true, detail: nameOf(m.operatorId) },
    {
      label: 'Control available',
      ok: !d.controlOwner || d.controlOwner === m.operatorId,
      hard: true,
      detail: d.controlOwner ? `Held by ${nameOf(d.controlOwner)}` : 'No current holder',
    },
    {
      label: 'Integration status',
      ok: d.integration === 'verified',
      hard: false,
      detail: d.integration === 'simulated' ? 'SIMULATED device — demo only' : d.integration,
    },
  ];
}

/** Indoor vehicle: the route must stay in the building, on its floor, off stairs and lifts, and not cross a wall. */
export function indoorRouteChecks(d: Device, m: Mission): Check[] {
  const b = BUILDINGS.find((x) => x.id === d.indoor?.buildingId);
  const plan = floorPlan(d.indoor?.buildingId, d.indoor?.level);
  const cps = m.checkpoints;
  const insideBuilding = !!b && cps.length > 0 && cps.every((p) => atBuilding(b, p, 0));
  const out: Check[] = [
    { label: 'Route inside building', ok: insideBuilding, hard: true, detail: b ? `${cps.length} checkpoints inside ${b.name}, level ${d.indoor?.level}` : 'Unknown building' },
  ];
  if (!plan) {
    out.push({ label: 'Floor plan available', ok: false, hard: true, detail: 'No floor plan for this level — import one from the BIM model.' });
    return out;
  }
  const leg = routeCrossesWalls([d.pos, ...cps], plan);
  out.push({
    label: 'Route clear of walls',
    ok: leg < 0,
    hard: true,
    detail:
      leg < 0
        ? 'No leg crosses a wall'
        : leg === 0
          ? 'The leg from the vehicle to checkpoint 1 crosses a wall or rack'
          : `The leg between checkpoints ${leg} and ${leg + 1} crosses a wall or rack`,
  });
  const bad = cps.findIndex((p) => inNoGo(plan, p));
  out.push({
    label: 'Avoids no-go areas',
    ok: bad < 0,
    hard: true,
    detail: bad < 0 ? 'No checkpoint in a no-go area (stairs, lifts, fuel store, charging bay)' : `Checkpoint ${bad + 1} is in ${inNoGo(plan, cps[bad])?.name}`,
  });
  return out;
}

export function fmtAge(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const TZ = 'Asia/Bangkok';

export function fmtTime(ms: number, withSeconds = false) {
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: withSeconds ? '2-digit' : undefined,
    hour12: false,
    timeZone: TZ,
  });
}

export function fmtDate(ms: number) {
  return new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ }).toUpperCase();
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
