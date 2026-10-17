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
  if (q === 'high') resetGuard();
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

// ---------------------------------------------------------------------------
// Performance guard: an unknown booth PC must never stutter through the demo. If the twin
// cannot hold ~22 fps for a few seconds in high quality, drop to low and say so once.
// ---------------------------------------------------------------------------

let fps = 0;
const fpsListeners = new Set<() => void>();

export function useFps() {
  return useSyncExternalStore(
    (cb) => (fpsListeners.add(cb), () => fpsListeners.delete(cb)),
    () => fps,
    () => fps,
  );
}

/** Feed one frame interval (seconds). Returns true when the guard just downgraded. */
let acc = 0;
let n = 0;
let slowSince = 0;
let downgraded = false;
export function feedFrame(dt: number, nowMs: number): boolean {
  acc += dt;
  n++;
  if (acc >= 0.5) {
    const next = Math.round(n / acc);
    acc = 0;
    n = 0;
    if (next !== fps) {
      fps = next;
      fpsListeners.forEach((l) => l());
    }
    if (quality === 'high' && fps > 0 && fps < 22 && document.visibilityState === 'visible') {
      slowSince ||= nowMs;
      if (nowMs - slowSince > 4000 && !downgraded) {
        downgraded = true;
        setQuality('low');
        return true;
      }
    } else slowSince = 0;
  }
  return false;
}

/** Re-arm the guard (e.g. after the presenter turns high quality back on). */
export function resetGuard() {
  downgraded = false;
  slowSince = 0;
}
