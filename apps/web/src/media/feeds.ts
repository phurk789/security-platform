// Where a camera feed's picture comes from when the device is not streaming for real:
//   sim      – rendered from the 3D twin (always available, labelled SIMULATED)
//   recorded – a real clip recorded earlier, from public/media/samples.json (labelled RECORDED)
//   local    – this computer's camera (webcam / USB camera), one device at a time (labelled LIVE · LOCAL)
// A real device stream (WHEP from the site media server) always wins over these.
import { useSyncExternalStore } from 'react';
import type { DeviceKind } from '@13store/shared';

export type FeedSource = 'sim' | 'recorded';

export interface SampleClip {
  /** Relative to the app root, e.g. "media/ugv-onboard.mp4". */
  src: string;
  /** Where the footage came from (shown on the feed), e.g. "D100 field test, 12 Oct". */
  credit?: string;
  /** True if the clip was shot by one of our devices (shown as RECORDED · OWN DEVICE). */
  ownDevice?: boolean;
  /** Show this clip by default (until the viewer picks a source in the feed menu). */
  preferred?: boolean;
}

export interface SampleManifest {
  /** Keys: a device id ("UGV-01") or a kind default ("kind:ugv", "kind:cctv", "kind:uav"). */
  clips: Record<string, SampleClip>;
}

// ---------------------------------------------------------------------------
// preferences (per browser)
// ---------------------------------------------------------------------------

const KEY = 'ps-feed-source';
const listeners = new Set<() => void>();
/** null until the viewer picks a source: then clips marked `preferred` show, everything else is 3D. */
let source: FeedSource | null = (() => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'recorded' || v === 'sim' ? v : null;
  } catch {
    return null;
  }
})();
/** Device whose feed shows this computer's camera (not persisted: permission is per page load). */
let webcamDevice: string | null = null;
let snapshot: { source: FeedSource | null; webcamDevice: string | null } = { source, webcamDevice };
const notify = () => {
  snapshot = { source, webcamDevice };
  listeners.forEach((l) => l());
};

export function setFeedSource(s: FeedSource) {
  source = s;
  try {
    localStorage.setItem(KEY, s);
  } catch {
    /* keep for this page */
  }
  notify();
}

export function setWebcamDevice(id: string | null) {
  webcamDevice = id;
  notify();
}

export function useFeedPrefs() {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => snapshot,
    () => snapshot,
  );
}

// ---------------------------------------------------------------------------
// recorded clips: manifest + per-clip load failures
// ---------------------------------------------------------------------------

const mListeners = new Set<() => void>();
let manifest: SampleManifest | null = null;
let manifestLoading: Promise<void> | null = null;
const missing = new Set<string>();
let mSnap: { manifest: SampleManifest | null; missing: string[] } = { manifest, missing: [] };
const mNotify = () => {
  mSnap = { manifest, missing: [...missing] };
  mListeners.forEach((l) => l());
};

/** Used when samples.json cannot be fetched (e.g. the single-file build opened from disk, where fetch() is not allowed but <video> still loads files next to it). */
const DEFAULT_MANIFEST: SampleManifest = {
  clips: {
    'kind:ugv': { src: 'media/ugv-onboard.mp4', credit: 'Onboard camera, recorded on a field test', ownDevice: true },
    'kind:cctv': { src: 'media/cctv-gate.mp4', credit: 'Gate camera, recorded on site', ownDevice: true },
    'kind:uav': { src: 'media/uav-aerial.mp4', credit: 'Drone camera, recorded on a flight test', ownDevice: true },
  },
};

export function loadManifest() {
  if (manifest || manifestLoading) return manifestLoading ?? Promise.resolve();
  if (typeof location !== 'undefined' && location.protocol === 'file:') {
    manifest = DEFAULT_MANIFEST;
    mNotify();
    return Promise.resolve();
  }
  manifestLoading = fetch('media/samples.json', { cache: 'no-cache' })
    .then(async (r) => {
      if (!r.ok) throw new Error(String(r.status));
      const j = (await r.json()) as Partial<SampleManifest>;
      manifest = { clips: j && typeof j.clips === 'object' && j.clips ? j.clips : {} };
    })
    .catch(() => {
      manifest = DEFAULT_MANIFEST;
    })
    .then(mNotify);
  return manifestLoading;
}

export function markClipMissing(src: string) {
  if (missing.has(src)) return;
  missing.add(src);
  mNotify();
}

/** The recorded clip for a device, if the manifest has one and it loaded. */
export function useSampleClip(deviceId: string | undefined, kind: DeviceKind | undefined): { clip?: SampleClip; wanted?: string; missing: boolean; loaded: boolean } {
  const m = useSyncExternalStore(
    (cb) => (mListeners.add(cb), () => mListeners.delete(cb)),
    () => mSnap,
    () => mSnap,
  );
  if (!m.manifest) {
    void loadManifest();
    return { missing: false, loaded: false };
  }
  const clip = (deviceId && m.manifest.clips[deviceId]) || (kind && m.manifest.clips[`kind:${kind}`]) || undefined;
  if (!clip) return { missing: true, loaded: true, wanted: deviceId ? `media/${deviceId.toLowerCase()}.mp4` : undefined };
  return { clip, wanted: clip.src, missing: m.missing.includes(clip.src), loaded: true };
}

// ---------------------------------------------------------------------------
// this computer's camera, shared by every feed that shows it
// ---------------------------------------------------------------------------

let stream: MediaStream | null = null;
let acquiring: Promise<MediaStream> | null = null;
let users = 0;

export const localCameraAvailable = () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && (window.isSecureContext ?? true);

export async function acquireLocalCamera(): Promise<MediaStream> {
  users++;
  if (stream) return stream;
  acquiring ??= navigator.mediaDevices
    .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' }, audio: false })
    .then((s) => {
      stream = s;
      acquiring = null;
      s.getVideoTracks()[0]?.addEventListener('ended', () => {
        stream = null;
      });
      return s;
    })
    .catch((e) => {
      acquiring = null;
      users = Math.max(0, users - 1);
      throw e;
    });
  return acquiring;
}

export function releaseLocalCamera() {
  users = Math.max(0, users - 1);
  if (users === 0 && stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}
