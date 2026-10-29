// Small rules behind the site screens: reading a pasted map position, and ticking site access.

/** "13.95055, 100.46209" (as Google Maps copies it) → lat, lon. */
export function parseLatLon(text: string): { lat: number; lon: number } | null {
  const m = text.trim().match(/^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/**
 * Which sites a user may see after one tick. [] = every site, including sites added later.
 * Unticking one site of "every site" leaves the others; the last ticked site stays ticked
 * (a user who sees no site would see everything: an empty list means all).
 */
export function nextSiteAccess(value: string[], all: string[], toggle: string | 'all'): string[] {
  if (toggle === 'all') return value.length === 0 ? all : [];
  const now = value.length === 0 ? all : value;
  const next = now.includes(toggle) ? now.filter((x) => x !== toggle) : [...now, toggle];
  return next.length === 0 ? now : all.filter((x) => next.includes(x));
}
