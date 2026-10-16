// Rules shared by the server (authoritative) and the clients (to hide what a role cannot do).
import { insideDemoArea } from './site';
import type { Device, Freshness, Mission, Role } from './types';

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
  'evidence.view',
  'evidence.add',
  'report.view',
  'demo.control',
];

/**
 * Role → allowed actions (PRD §3). Viewing video, exporting evidence and controlling devices
 * are separate permissions (F13). Administrators do not get device control.
 */
export const MATRIX: Record<Role, Action[]> = {
  dispatcher: DISPATCH,
  supervisor: [...DISPATCH, 'mission.approve', 'control.handover', 'evidence.export', 'audit.view'],
  operator: ['mission.accept', 'device.command', 'media.view', 'evidence.view', 'evidence.add', 'report.view', 'demo.control'],
  responder: ['incident.create', 'field.update', 'evidence.view', 'evidence.add'],
  auditor: ['evidence.view', 'evidence.export', 'report.view', 'audit.view'],
  admin: ['admin.users', 'admin.devices', 'admin.keys', 'admin.backup', 'audit.view', 'demo.control'],
};

/** Actions that require a recent password check. */
export const STEP_UP_ACTIONS: Action[] = ['mission.approve', 'evidence.export', 'control.handover', 'admin.users', 'admin.keys', 'admin.backup'];

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

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

/** Pre-approval checks shown to the supervisor and re-run by the server on approve. */
export function constraintChecksAt(now: number, d: Device, m: Mission, nameOf: (id?: string) => string): Check[] {
  const fresh = freshnessAt(now, d);
  const inside = m.checkpoints.length > 0 && m.checkpoints.every(insideDemoArea);
  const battery = d.battery ?? 0;
  return [
    { label: 'Telemetry fresh', ok: fresh === 'live', hard: true, detail: fresh === 'live' ? 'Last seen < 5 s' : `Telemetry ${fresh}` },
    { label: 'Battery ≥ 30%', ok: battery >= 30, hard: true, detail: `${Math.round(battery)}%` },
    { label: 'Route inside demo area', ok: inside, hard: true, detail: `${m.checkpoints.length} checkpoints inside site boundary` },
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
  return new Date(ms)
    .toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: TZ })
    .toUpperCase();
}

export function dist(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
