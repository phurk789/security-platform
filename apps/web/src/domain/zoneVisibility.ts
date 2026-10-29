// Zones hidden on this console's map ("my map" only). Switching a zone off (inactive) is a server
// change that turns its rules off for everyone; hiding it here only declutters this browser.
import { useSyncExternalStore } from 'react';

const KEY = 'ps.hiddenZones';
const listeners = new Set<() => void>();

function load(): ReadonlySet<string> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

let hidden: ReadonlySet<string> = load();

export const zoneVisibility = {
  get: () => hidden,
  isHidden: (id: string) => hidden.has(id),
  toggle(id: string) {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    hidden = next;
    try {
      localStorage.setItem(KEY, JSON.stringify([...next]));
    } catch {
      /* this page only */
    }
    listeners.forEach((f) => f());
  },
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export function useHiddenZones() {
  return useSyncExternalStore(zoneVisibility.subscribe, zoneVisibility.get, zoneVisibility.get);
}
