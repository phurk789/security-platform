// What each device's live video player is doing right now, for views outside the player.
// The cockpit shows the vehicle being offline and its video being lost in one card, so it needs
// the player's message, its reconnect attempt and its "try again" without owning the player.
// The player (WhepVideo) reports here; it stays the only place that decides what the video is.
import { useSyncExternalStore } from 'react';
import type { VideoPhase } from './videoState';

export interface LiveVideoStatus {
  phase: VideoPhase;
  /** Failed attempts since the last LIVE, and how many the player makes before giving up. */
  attempt: number;
  maxRetries: number;
  /** The player's own words for its state, already translated; null while the picture is live. */
  message: { main: string; sub?: string } | null;
  /** Start a new connection now. Only set when that is possible (lost, refused, waiting to retry). */
  retry?: () => void;
}

interface Entry {
  owner: object;
  status: LiveVideoStatus;
}

const byDevice = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/**
 * The player for `deviceId` says what it is doing. `owner` is the player instance: when a new
 * player for the same device starts before the old one is gone (SD/HD switch), the old one's
 * clear-up does not wipe the new one's report.
 */
export function reportLiveVideo(deviceId: string, owner: object, status: LiveVideoStatus | null) {
  const cur = byDevice.get(deviceId);
  if (status) byDevice.set(deviceId, { owner, status });
  else if (cur?.owner === owner) byDevice.delete(deviceId);
  else return;
  notify();
}

export function liveVideoOf(deviceId: string | undefined): LiveVideoStatus | undefined {
  return deviceId ? byDevice.get(deviceId)?.status : undefined;
}

/** The live video status of a device, or undefined when it has no live player on screen. */
export function useLiveVideo(deviceId: string | undefined) {
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => listeners.delete(cb)),
    () => liveVideoOf(deviceId),
    () => liveVideoOf(deviceId),
  );
}
