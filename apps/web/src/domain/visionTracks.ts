// Live boxes from the vision pipelines (the AI on a camera), kept outside the app state: they
// arrive several times a second and only the video overlay needs them. Also the maths to place a
// box from the camera's frame onto video shown "cover" (filling the view, edges cropped).
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { VisionBox } from '@13store/shared';

/** Boxes older than this (by when they arrived) are not shown: the AI or the link has stopped. */
export const BOXES_FRESH_MS = 1500;

export interface LiveTracks {
  deviceId: string;
  /** When the frame was taken (source clock). */
  at: number;
  /** When this console received it (local clock), for freshness. */
  receivedAt: number;
  width?: number;
  height?: number;
  boxes: VisionBox[];
}

let latest = new Map<string, LiveTracks>();
const listeners = new Set<() => void>();

export const visionTracks = {
  set(t: Omit<LiveTracks, 'receivedAt'>, receivedAt: number) {
    latest = new Map(latest).set(t.deviceId, { ...t, receivedAt });
    listeners.forEach((fn) => fn());
  },
  clear() {
    latest = new Map();
    listeners.forEach((fn) => fn());
  },
  get: () => latest,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
};

/** The freshest live boxes among these devices (a vehicle and the camera AIs that follow it), if any are fresh. */
export function freshTracks(all: Map<string, LiveTracks>, deviceIds: string[], now: number): LiveTracks | undefined {
  let best: LiveTracks | undefined;
  for (const id of deviceIds) {
    const t = all.get(id);
    if (t && now - t.receivedAt < BOXES_FRESH_MS && (!best || t.receivedAt > best.receivedAt)) best = t;
  }
  return best;
}

/**
 * Live boxes for these devices, re-checked when new ones arrive and when the shown ones would go
 * stale, so boxes disappear on their own when the AI or the link stops.
 */
export function useLiveTracks(deviceIds: string[]): LiveTracks | undefined {
  const all = useSyncExternalStore(visionTracks.subscribe, visionTracks.get, visionTracks.get);
  const [, tick] = useState(0);
  const now = Date.now();
  const t = freshTracks(all, deviceIds, now);
  useEffect(() => {
    if (!t) return;
    const timer = window.setTimeout(() => tick((n) => n + 1), Math.max(50, BOXES_FRESH_MS - (Date.now() - t.receivedAt) + 20));
    return () => window.clearTimeout(timer);
  }, [t]);
  return t;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Where a box from a `frameW`×`frameH` camera frame lands on a `viewW`×`viewH` view that shows the
 * frame scaled to cover it (CSS object-fit: cover, centred). Parts cut off by the crop are trimmed;
 * a box entirely outside the visible part gives null.
 */
export function placeBox(bbox: VisionBox['bbox'], frameW: number, frameH: number, viewW: number, viewH: number): Rect | null {
  if (!(frameW > 0 && frameH > 0 && viewW > 0 && viewH > 0)) return null;
  const scale = Math.max(viewW / frameW, viewH / frameH);
  const dx = (viewW - frameW * scale) / 2;
  const dy = (viewH - frameH * scale) / 2;
  const x0 = Math.max(0, dx + bbox[0] * frameW * scale);
  const y0 = Math.max(0, dy + bbox[1] * frameH * scale);
  const x1 = Math.min(viewW, dx + (bbox[0] + bbox[2]) * frameW * scale);
  const y1 = Math.min(viewH, dy + (bbox[1] + bbox[3]) * frameH * scale);
  if (x1 - x0 < 2 || y1 - y0 < 2) return null;
  return { left: x0, top: y0, width: x1 - x0, height: y1 - y0 };
}
