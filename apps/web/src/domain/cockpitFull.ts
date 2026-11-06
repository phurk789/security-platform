// Full-screen cockpit: the app's top bar, side menu and footer step aside so the Command Centre's
// cockpit fills the window. Only the cockpit turns it on, and leaving the cockpit (the map view,
// another page) turns it off. It is never kept across reloads, so nobody lands on a page without
// its menu. Not the browser's own full screen: that would take the Esc key, which stops a drive.
import { useSyncExternalStore } from 'react';

let full = false;
const listeners = new Set<() => void>();

export function setCockpitFull(on: boolean) {
  if (full === on) return;
  full = on;
  listeners.forEach((l) => l());
}

export function isCockpitFull() {
  return full;
}

export function useCockpitFull() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => full,
    () => full,
  );
}
