// Rendering quality of the 3D twin (per browser). High adds bloom, reflections and MSAA on the
// main view; low is the plain render for weak GPUs.
import { useSyncExternalStore } from 'react';

export type Quality = 'high' | 'low';
const KEY = 'ps-quality';
const listeners = new Set<() => void>();
let quality: Quality = (() => {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'high' || v === 'low') return v;
  } catch {
    /* default below */
  }
  // Phones and small laptops start low; the Layers menu lets people change it.
  return typeof navigator !== 'undefined' && (navigator.hardwareConcurrency ?? 8) <= 4 ? 'low' : 'high';
})();

export function getQuality() {
  return quality;
}

export function setQuality(q: Quality) {
  quality = q;
  try {
    localStorage.setItem(KEY, q);
  } catch {
    /* keep for this page */
  }
  listeners.forEach((l) => l());
}

export function useQuality() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => quality,
    () => quality,
  );
}
