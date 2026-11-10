// When a device was last heard from, in words for the Devices page.
import { ago, type T } from '../i18n';

/**
 * A device registered but never connected has no time yet (lastSeen 0): say so, instead of the age
 * since 1970 ("498413 h ago"). Within the last 10 s it is "just now", so live rows do not tick.
 */
export function lastSeenText(t: T, lastSeen: number, now: number) {
  if (!(lastSeen > 0)) return t('Never connected');
  const ms = Math.max(0, now - lastSeen);
  return ms < 10_000 ? t('Just now') : ago(ms);
}
