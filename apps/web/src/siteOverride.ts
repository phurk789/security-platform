// Which demo site to show, chosen before the store reads the site data:
//  - the site picker in the top bar stores 'amata' (demo plant, real imagery) or 'civic' (the
//    original civic-centre demo) and reloads;
//  - ?site=<lat>,<lon>[,<rotationDeg>] moves the current site to another real place (the site
//    centre), remembered in this browser; ?site=reset goes back to the built-in location.
import { LAYOUT, SITE, applySiteVariant, type SiteVariant } from '@13store/shared';
import { CAMERA_VIEWS } from './twin/layout';

const KEY = 'ps-site';
const VARIANT_KEY = 'ps-site-variant';
const R = 6_378_137;

export function storedVariant(): SiteVariant {
  try {
    return localStorage.getItem(VARIANT_KEY) === 'civic' ? 'civic' : 'amata';
  } catch {
    return 'amata';
  }
}

/** Switch demo site (offline demo): remembered in this browser, applied on reload. */
export function chooseSiteVariant(v: SiteVariant) {
  try {
    localStorage.setItem(VARIANT_KEY, v);
    localStorage.removeItem(KEY); // a moved location belongs to the previous site
  } catch {
    /* storage blocked: nothing to remember */
  }
  location.reload();
}

function parse(v: string | null): [number, number, number] | null {
  if (!v) return null;
  const n = v.split(',').map((x) => Number(x.trim()));
  if (n.length < 2 || n.some((x) => !Number.isFinite(x)) || Math.abs(n[0]) > 85 || Math.abs(n[1]) > 180) return null;
  return [n[0], n[1], n[2] ?? 0];
}

if (__STANDALONE__) applySiteVariant(storedVariant());
CAMERA_VIEWS['CCTV-01'].target = { ...LAYOUT.cctv01Target };
CAMERA_VIEWS['CCTV-03'].target = { ...LAYOUT.cctv03Target };

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
