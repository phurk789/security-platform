// Google Maps key for photorealistic site tiles (build-time env), and the viewer's choice between
// the drawn twin and the real-imagery view. Kept apart from realTiles.ts so builds without a key
// (or viewers who keep the drawn view) never load the tiles library.
import { useSyncExternalStore } from 'react';
import { siteVariant } from '@13store/shared';

export const GOOGLE_KEY: string = ((import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) ?? '').trim();

/** Real imagery needs a key and a site on a real place (the civic demo is drawn only). */
export function realTilesAvailable() {
  return !!GOOGLE_KEY && siteVariant === 'amata';
}

/** 'drawn' = the original stylised twin; 'real' = Google photorealistic tiles of the site. */
export type TwinLook = 'drawn' | 'real';
const KEY = 'ps-twin-look';
const listeners = new Set<() => void>();
let look: TwinLook = (() => {
  try {
    return localStorage.getItem(KEY) === 'drawn' ? 'drawn' : 'real';
  } catch {
    return 'real';
  }
})();

/** The view in effect: always 'drawn' when the build has no key. */
export function getTwinLook(): TwinLook {
  return realTilesAvailable() ? look : 'drawn';
}

export function setTwinLook(l: TwinLook) {
  look = l;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* keep for this page */
  }
  listeners.forEach((f) => f());
}

export function useTwinLook(): TwinLook {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), getTwinLook, getTwinLook);
}
