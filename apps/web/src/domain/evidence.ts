// The Evidence page's picture of one incident: its images oldest first, each matched to the AI
// detection that produced it (where the camera was, how far away the person stood, how sure the
// model was), and the notes and other files beside them. Pure functions; the page and its map use them.
import type { Detection, Evidence, Point } from '@13store/shared';

/** A still from analytics or a checkpoint photo is shown as a picture; everything else is listed as a file. */
export function isImage(e: Pick<Evidence, 'kind' | 'mime'>) {
  return (e.kind === 'snapshot' || e.kind === 'photo') && (!e.mime || e.mime.startsWith('image/'));
}

export interface Shot {
  ev: Evidence;
  /** 1 = the oldest image: the number on its map pin and in the list. */
  n: number;
  /** Where the camera was when the image was taken (its detection's position). */
  pos?: Point;
  /** Estimated distance from the camera to what was detected, metres. */
  distanceM?: number;
  /** 0–1, from the model. */
  confidence?: number;
  /** The device whose camera took it (the vehicle, for an AI box watching a vehicle's video). */
  deviceId?: string;
}

/** The images among these files, oldest first and numbered, with what their detections add. */
export function evidenceShots(files: readonly Evidence[], detections: readonly Detection[]): Shot[] {
  const bySnapshot = new Map<string, Detection>();
  for (const d of detections) if (d.snapshotEvidenceId) bySnapshot.set(d.snapshotEvidenceId, d);
  return files
    .filter(isImage)
    .slice()
    .sort((a, b) => a.capturedAt - b.capturedAt || a.id.localeCompare(b.id))
    .map((ev, i) => {
      const d = bySnapshot.get(ev.id);
      return { ev, n: i + 1, pos: d?.pos, distanceM: d?.attributes?.distanceM, confidence: d?.confidence, deviceId: d?.deviceId };
    });
}

/** "UGV-01 AI · jetson-ai-01" → the vehicle and the AI box that watched its video (the server names AI detections so). */
export function splitSource(source: string): { device: string; box?: string } {
  const m = /^(.+?) AI · (.+)$/.exec(source);
  return m ? { device: m[1], box: m[2] } : { device: source };
}

/**
 * The span to ask the server for the detections behind these images: a detection's snapshot is
 * stored with the detection's own time, so the oldest and newest image bound it. Null without images.
 */
export function detectionWindow(files: readonly Evidence[]): { from: number; to: number } | null {
  const times = files.filter(isImage).map((e) => e.capturedAt);
  if (!times.length) return null;
  return { from: Math.min(...times), to: Math.max(...times) };
}

/** Fetched detections and the ones that arrived live since, once each (the live copy wins). */
export function mergeDetections(fetched: readonly Detection[], live: readonly Detection[]): Detection[] {
  const out = new Map<string, Detection>();
  for (const d of fetched) out.set(d.id, d);
  for (const d of live) out.set(d.id, d);
  return [...out.values()];
}

export interface ShotSummary {
  first?: number;
  last?: number;
  /** The closest the detected person came to the camera, metres (when any image has a distance). */
  nearestM?: number;
  /** Images placed on the map. */
  placed: number;
}

export function summarizeShots(shots: readonly Shot[]): ShotSummary {
  const dist = shots.map((s) => s.distanceM).filter((m): m is number => m !== undefined);
  return {
    first: shots[0]?.ev.capturedAt,
    last: shots[shots.length - 1]?.ev.capturedAt,
    nearestM: dist.length ? Math.min(...dist) : undefined,
    placed: shots.filter((s) => s.pos).length,
  };
}

/**
 * The camera's path between its images: one line per device, through the positions it took them
 * from, oldest first. A device with fewer than two placed images has no line.
 */
export function shotPaths(shots: readonly Shot[]): { deviceId: string; points: Point[] }[] {
  const by = new Map<string, Point[]>();
  for (const s of shots) {
    if (!s.pos) continue;
    const key = s.deviceId ?? '';
    by.set(key, [...(by.get(key) ?? []), s.pos]);
  }
  return [...by.entries()].filter(([, pts]) => pts.length >= 2).map(([deviceId, points]) => ({ deviceId, points }));
}

/** The points the map frames for an incident: where it was raised, and where each image was taken. */
export function framePoints(incidentPos: Point | undefined, shots: readonly Shot[]): Point[] {
  return [...(incidentPos ? [incidentPos] : []), ...shots.flatMap((s) => (s.pos ? [s.pos] : []))];
}
