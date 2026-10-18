// Which demo site the app shows: 'amata' (demo plant on real roofs, real imagery available) or
// 'civic' (the original civic-centre demo, drawn twin). Switch before the app builds its state.
import { SITE_GEOMETRY, SITE, setSiteData, type SiteVariant } from './site';
import { rebuildFloorPlans } from './indoor';
import { setGeofenceData } from './routing';

export function applySiteVariant(v: SiteVariant) {
  setSiteData(v);
  setGeofenceData(v);
  rebuildFloorPlans();
  Object.assign(SITE_GEOMETRY, { name: SITE.name, geo: SITE.geo });
}
