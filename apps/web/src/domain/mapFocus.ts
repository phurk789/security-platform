// What a page asks the real map to show besides the live picture: a route that is only being
// looked at (a saved route, a patrol's loop), drawn dashed with its checkpoints, and requests to
// frame some points. The mission planning page sets these; the map reads them.
import { useSyncExternalStore } from 'react';
import type { Point } from '@13store/shared';

let preview: Point[] | null = null;
let fit: { points: Point[]; seq: number } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const mapFocus = {
  /** Show these points as a dashed route on the map (null: none). */
  setPreview(points: Point[] | null) {
    const next = points && points.length ? points.map((p) => ({ x: p.x, y: p.y })) : null;
    if (JSON.stringify(next) === JSON.stringify(preview)) return;
    preview = next;
    emit();
  },
  /** Frame these points on the map (once per call). */
  fit(points: Point[]) {
    if (!points.length) return;
    fit = { points: points.map((p) => ({ x: p.x, y: p.y })), seq: (fit?.seq ?? 0) + 1 };
    emit();
  },
  getPreview: () => preview,
  getFit: () => fit,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

export const useMapPreview = () => useSyncExternalStore(mapFocus.subscribe, mapFocus.getPreview, mapFocus.getPreview);
export const useMapFit = () => useSyncExternalStore(mapFocus.subscribe, mapFocus.getFit, mapFocus.getFit);
