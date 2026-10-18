// Move the demo site to another real place without a rebuild: open the app with
// ?site=<lat>,<lon>[,<rotationDeg>] (the site centre). It is remembered in this browser;
// ?site=reset goes back to the built-in location. Runs before the store reads SITE.geo.
import { SITE } from '@13store/shared';

const KEY = 'ps-site';
const R = 6_378_137;

function parse(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const n = v.split(',').map((x) => Number(x.trim()));
  if (n.length < 2 || n.some((x) => !Number.isFinite(x)) || Math.abs(n[0]) > 85 || Math.abs(n[1]) > 180) return null;
  return [n[0], n[1], n[2] ?? 0];
}

try {
  const q = new URLSearchParams(location.search).get('site');
  if (q === 'reset') localStorage.removeItem(KEY);
  else if (parse(q)) localStorage.setItem(KEY, q!);
  const c = parse(localStorage.getItem(KEY));
  if (c) {
    const [lat, lon, rot] = c;
    // centre → grid origin (north-west corner); rotation is ignored for the offset (small sites)
    SITE.geo.originLat = lat + (SITE.height / 2 / R) * (180 / Math.PI);
    SITE.geo.originLon = lon - (SITE.width / 2 / (R * Math.cos((lat * Math.PI) / 180))) * (180 / Math.PI);
    SITE.geo.rotationDeg = rot;
  }
} catch {
  /* storage blocked: keep the built-in site */
}
