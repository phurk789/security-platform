// AI on a device's video, as the console shows it: which AI draws boxes on it, and why AI that is
// switched on is not running yet.
import { RANGING_TYPES, footOf, type Device } from '@13store/shared';

/** What the distance calibration needs: exactly one person in view, feet visible. */
export function calibrationReadiness(boxes: readonly { type: string; bbox: readonly number[] }[] | undefined): 'ready' | 'none' | 'many' | 'cut' {
  const people = (boxes ?? []).filter((b) => (RANGING_TYPES as readonly string[]).includes(b.type));
  if (!people.length) return 'none';
  if (people.length > 1) return 'many';
  return footOf(people[0].bbox) ? 'ready' : 'cut';
}

/**
 * Devices whose live boxes belong on this device's video: the device itself when AI runs on it (an
 * AI box job, or its own adapter's analytics), and camera AIs configured to follow it.
 */
export function aiSources(d: Device | undefined, devices: Record<string, Device>): string[] {
  if (!d) return [];
  const own = d.ai?.on || d.analytics ? [d.id] : [];
  return [...own, ...Object.values(devices).filter((x) => x.follows === d.id).map((x) => x.id)];
}

/** Why AI that is switched on is not analysing yet (English, for the dictionary), or undefined when it is (or is off). */
export function aiWaiting(d: Device | undefined): string | undefined {
  if (!d?.ai?.on) return undefined;
  switch (d.ai.state) {
    case 'no_box':
      return 'No AI box connected';
    case 'full':
      return 'All AI boxes are busy';
    case 'no_video':
      return 'No video for the AI';
    default:
      return undefined;
  }
}
