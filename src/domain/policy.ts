import type { AppState, Device, Freshness, Role } from './types';

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

export type Action =
  | 'incident.triage'
  | 'incident.verify'
  | 'incident.resolve'
  | 'incident.close'
  | 'mission.prepare'
  | 'mission.approve'
  | 'mission.accept'
  | 'device.command'
  | 'control.handover'
  | 'evidence.add'
  | 'evidence.export'
  | 'demo.control';

/** Role → allowed actions (PRD §3). Checked in the UI *and* again in the reducer, which stands in for the server. */
const MATRIX: Record<Role, Action[]> = {
  dispatcher: [
    'incident.triage',
    'incident.verify',
    'incident.resolve',
    'incident.close',
    'mission.prepare',
    'evidence.add',
    'evidence.export',
    'demo.control',
  ],
  supervisor: [
    'incident.triage',
    'incident.verify',
    'incident.resolve',
    'incident.close',
    'mission.prepare',
    'mission.approve',
    'control.handover',
    'evidence.add',
    'evidence.export',
    'demo.control',
  ],
  operator: ['mission.accept', 'device.command', 'evidence.add', 'demo.control'],
  auditor: ['evidence.export'],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

export function currentUser(s: AppState) {
  return s.users.find((u) => u.id === s.userId)!;
}

export function userName(s: AppState, id?: string) {
  if (!id) return '—';
  return s.users.find((u) => u.id === id)?.name ?? id;
}

export function ageMs(s: AppState, d: Device) {
  return Math.max(0, s.now - d.lastSeen);
}

export function freshness(s: AppState, d: Device): Freshness {
  const age = ageMs(s, d);
  const staleAfter = Math.max(STALE_AFTER_MS, d.rateMs * 3);
  if (age > OFFLINE_AFTER_MS && d.kind !== 'cctv') return 'offline';
  if (d.kind === 'cctv' && age > 60_000) return 'offline';
  if (age > staleAfter) return 'stale';
  return 'live';
}

/** Is the device ready to take a new mission? */
export function isReady(s: AppState, d: Device) {
  if (d.kind === 'cctv') return false;
  if (freshness(s, d) !== 'live') return false;
  if ((d.battery ?? 100) < 25) return false;
  const busy = s.missions.some(
    (m) => m.deviceId === d.id && ['approved', 'assigned', 'executing', 'paused', 'pending_approval'].includes(m.status),
  );
  return !busy;
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
