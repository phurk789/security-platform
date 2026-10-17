// Latitude/longitude of a site grid point, from the site's WGS 84 anchor, with a maps link for
// responders on a phone.
import { ExternalLink } from 'lucide-react';
import { fmtSitePoint, mapsUrl, type Point } from '@13store/shared';
import { useStore } from '../store';

export function LatLon({ p, link = true, digits = 5 }: { p: Point; link?: boolean; digits?: number }) {
  const geo = useStore().s.geo;
  const text = fmtSitePoint(geo, p, digits);
  if (!link) return <span className="latlon mono">{text}</span>;
  return (
    <a className="latlon mono" href={mapsUrl(geo, p)} target="_blank" rel="noreferrer" title="Open in maps">
      {text} <ExternalLink size={11} />
    </a>
  );
}
