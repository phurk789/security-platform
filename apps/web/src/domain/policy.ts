// Web helpers over AppState. Rules themselves live in @13store/shared.
import { constraintChecksAt, freshnessAt, isReadyAt } from '@13store/shared';
import type { AppState, Device, Mission } from '@13store/shared';

export * from '@13store/shared';

export function currentUser(s: AppState) {
  return s.users.find((u) => u.id === s.userId) ?? s.users[0];
}

export function userName(s: AppState, id?: string) {
  if (!id) return '—';
  return s.users.find((u) => u.id === id)?.name ?? id;
}

export function ageMs(s: AppState, d: Device) {
  return Math.max(0, s.now - d.lastSeen);
}

export function freshness(s: AppState, d: Device) {
  return freshnessAt(s.now, d);
}

export function isReady(s: AppState, d: Device) {
  return isReadyAt(s.now, d, s.missions);
}

export function constraintChecks(s: AppState, m: Mission) {
  return constraintChecksAt(s.now, s.devices[m.deviceId], m, (id) => userName(s, id));
}
