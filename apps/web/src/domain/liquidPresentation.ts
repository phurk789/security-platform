// Display-only helpers. These must not authorize or send a command.
import type { Device } from '@13store/shared';

export function matchesUnit(device: Pick<Device, 'id' | 'model' | 'kind'>, query: string): boolean {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${device.id} ${device.model} ${device.kind}`.toLocaleLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** Unknown / non-finite is not zero. Optional ranges only affect presentation. */
export function displayNumber(value: number | undefined, digits = 0, min = -Infinity, max = Infinity): string {
  if (value === undefined || !Number.isFinite(value) || value < min || value > max) return '—';
  return value.toFixed(Math.max(0, Math.min(6, digits)));
}
