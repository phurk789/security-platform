// GeoJSON (RFC 7946) in and out of the site grid. Export puts buildings, zones, geofences,
// devices and incidents into one FeatureCollection in WGS 84 for any GIS (QGIS, ArcGIS, a city
// platform); import turns polygons drawn in a GIS into geofences.
import { geoToSite, siteToGeo, type GeoAnchor } from './geo';
import type { Geofence } from './routing';
import type { SiteGeometry } from './site';
import type { Device, Incident, Point } from './types';

export type LonLat = [number, number];

export interface GeoJsonFeature {
  type: 'Feature';
  id?: string | number;
  geometry:
    | { type: 'Point'; coordinates: LonLat }
    | { type: 'Polygon'; coordinates: LonLat[][] }
    | { type: 'MultiPolygon'; coordinates: LonLat[][][] }
    | { type: 'LineString'; coordinates: LonLat[] }
    | null;
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: 'FeatureCollection';
  features: GeoJsonFeature[];
  /** Not part of RFC 7946 but harmless: tells a reader where the local grid sits. */
  site?: { id: string; name: string; crs: string; anchor: GeoAnchor; gridExtentM: { width: number; height: number } };
}

export type GeoLayer = 'site' | 'buildings' | 'zones' | 'entrances' | 'hydrants' | 'geofences' | 'devices' | 'incidents';
export const GEO_LAYERS: GeoLayer[] = ['site', 'buildings', 'zones', 'entrances', 'hydrants', 'geofences', 'devices', 'incidents'];

const round7 = (v: number) => Math.round(v * 1e7) / 1e7;

/** Site grid point → [lon, lat]. */
export function toLonLat(anchor: GeoAnchor, p: Point): LonLat {
  const g = siteToGeo(anchor, p);
  return [round7(g.lon), round7(g.lat)];
}

/** A closed outer ring (first point repeated) from a site polygon. */
function ring(anchor: GeoAnchor, poly: Point[]): LonLat[] {
  const r = poly.map((p) => toLonLat(anchor, p));
  if (r.length) r.push(r[0]);
  return r;
}

function rect(x: number, y: number, w: number, d: number): Point[] {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + d },
    { x, y: y + d },
  ];
}

/** Human-readable latitude/longitude: 13.75630° N, 100.50180° E */
export function fmtLatLon(g: { lat: number; lon: number }, digits = 5) {
  return `${Math.abs(g.lat).toFixed(digits)}° ${g.lat >= 0 ? 'N' : 'S'}, ${Math.abs(g.lon).toFixed(digits)}° ${g.lon >= 0 ? 'E' : 'W'}`;
}

/** Lat/lon of a site grid point, formatted. */
export function fmtSitePoint(anchor: GeoAnchor, p: Point, digits = 5) {
  return fmtLatLon(siteToGeo(anchor, p), digits);
}

/** A maps link responders can open on a phone. */
export function mapsUrl(anchor: GeoAnchor, p: Point) {
  const g = siteToGeo(anchor, p);
  return `https://www.google.com/maps?q=${g.lat.toFixed(6)},${g.lon.toFixed(6)}`;
}

export interface GeoJsonInput {
  site: { id: string; name: string; geometry: SiteGeometry };
  anchor: GeoAnchor;
  geofences?: Geofence[];
  devices?: Device[];
  incidents?: Incident[];
  layers?: GeoLayer[];
  /** Marks the export (SIMULATED / LIVE …) so a reader never mistakes demo data for an operational record. */
  dataLabel?: string;
  generatedAt?: number;
}

/** Everything about the site as one WGS 84 FeatureCollection. */
export function siteGeoJson(input: GeoJsonInput): GeoJsonFeatureCollection {
  const { site, anchor } = input;
  const g = site.geometry;
  const want = new Set(input.layers?.length ? input.layers : GEO_LAYERS);
  const features: GeoJsonFeature[] = [];
  const polygon = (poly: Point[], props: Record<string, unknown>, id?: string): GeoJsonFeature => ({
    type: 'Feature',
    id,
    geometry: { type: 'Polygon', coordinates: [ring(anchor, poly)] },
    properties: props,
  });
  const point = (p: Point, props: Record<string, unknown>, id?: string): GeoJsonFeature => ({
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: toLonLat(anchor, p) },
    properties: { ...props, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 },
  });
  if (want.has('site')) features.push(polygon(rect(0, 0, g.width, g.height), { layer: 'site', id: site.id, name: site.name, crs: g.crs }, site.id));
  if (want.has('buildings'))
    for (const b of g.buildings)
      features.push(polygon(rect(b.x, b.y, b.w, b.d), { layer: 'building', id: b.id, name: b.name, use: b.use, heightM: b.h, levels: b.bim?.levels, zone: b.zone }, b.id));
  if (want.has('zones'))
    for (const z of g.zones)
      features.push(
        polygon(
          z.poly.map(([x, y]) => ({ x, y })),
          { layer: 'zone', id: z.id, name: z.name },
          z.id,
        ),
      );
  if (want.has('entrances'))
    for (const b of g.buildings)
      for (const e of b.bim?.entrances ?? []) features.push(point(e, { layer: 'entrance', id: e.id, name: e.name, kind: e.kind, buildingId: b.id }, e.id));
  if (want.has('hydrants'))
    for (const b of g.buildings)
      (b.bim?.hydrants ?? []).forEach((h: Point, i: number) => features.push(point(h, { layer: 'hydrant', buildingId: b.id, n: i + 1 }, `${b.id}-H${i + 1}`)));
  if (want.has('geofences'))
    for (const f of input.geofences ?? [])
      features.push(polygon(f.poly, { layer: 'geofence', id: f.id, name: f.name, kind: f.kind, active: f.active, appliesTo: f.appliesTo, reason: f.reason ?? null }, f.id));
  if (want.has('devices'))
    for (const d of input.devices ?? [])
      features.push(
        point(
          d.pos,
          {
            layer: 'device',
            id: d.id,
            kind: d.kind,
            model: d.model,
            integration: d.integration,
            lastSeen: new Date(d.lastSeen).toISOString(),
            heading: d.heading,
            altM: d.alt ?? null,
            accuracyM: d.accuracyM,
            indoor: d.indoor ?? null,
          },
          d.id,
        ),
      );
  if (want.has('incidents'))
    for (const i of input.incidents ?? [])
      features.push(
        point(
          i.pos,
          {
            layer: 'incident',
            id: i.id,
            title: i.title,
            type: i.type,
            severity: i.severity,
            status: i.status,
            zone: i.zone,
            place: i.place,
            createdAt: new Date(i.createdAt).toISOString(),
            source: i.source,
          },
          i.id,
        ),
      );
  const fc: GeoJsonFeatureCollection = {
    type: 'FeatureCollection',
    features,
    site: { id: site.id, name: site.name, crs: 'urn:ogc:def:crs:OGC:1.3:CRS84', anchor, gridExtentM: { width: g.width, height: g.height } },
  };
  if (input.dataLabel || input.generatedAt) fc.features.forEach((f) => Object.assign(f.properties, { dataLabel: input.dataLabel }));
  return fc;
}

export interface GeoImport {
  geofences: (Pick<Geofence, 'name' | 'kind' | 'poly' | 'active' | 'appliesTo' | 'reason'> & { sourceId?: string })[];
  errors: string[];
}

const KINDS = new Set(['keep_out', 'caution', 'no_fly']);

/**
 * Polygons from a GIS → geofences in the site grid. Properties understood: name (or id), kind
 * (keep_out | caution | no_fly, default keep_out), appliesTo (["ugv","uav"] or "ugv,uav"),
 * reason, active. Holes are ignored; a MultiPolygon becomes one geofence per part.
 */
export function geofencesFromGeoJson(anchor: GeoAnchor, extent: { width: number; height: number }, input: unknown, opts: { max?: number; maxVertices?: number } = {}): GeoImport {
  const max = opts.max ?? 200;
  const maxV = opts.maxVertices ?? 30;
  const out: GeoImport = { geofences: [], errors: [] };
  const fc = input as Partial<GeoJsonFeatureCollection> & Partial<GeoJsonFeature>;
  const features: GeoJsonFeature[] = fc?.type === 'FeatureCollection' && Array.isArray(fc.features) ? fc.features : fc?.type === 'Feature' ? [fc as GeoJsonFeature] : [];
  if (!features.length) {
    out.errors.push('Expected a GeoJSON FeatureCollection (or one Feature) with Polygon geometries.');
    return out;
  }
  const margin = 50; // metres outside the drawn site still count as "touching" it
  features.forEach((f, i) => {
    const where = `Feature ${i + 1}${f?.id !== undefined ? ` (${f.id})` : ''}`;
    if (out.geofences.length >= max) return out.errors.push(`${where}: skipped, at most ${max} zones per import.`);
    const geom = f?.geometry;
    if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) return out.errors.push(`${where}: only Polygon and MultiPolygon geometries become geofences.`);
    const props = (f.properties ?? {}) as Record<string, unknown>;
    const coords = (geom as { coordinates: unknown }).coordinates;
    const partsRaw: unknown[] =
      geom.type === 'Polygon' ? [Array.isArray(coords) ? coords[0] : undefined] : Array.isArray(coords) ? coords.map((p: unknown) => (Array.isArray(p) ? p[0] : undefined)) : [];
    const okPoint = (pt: unknown) => Array.isArray(pt) && pt.length >= 2 && Number.isFinite(Number(pt[0])) && Number.isFinite(Number(pt[1]));
    if (!partsRaw.length || partsRaw.some((r) => !Array.isArray(r) || !r.every(okPoint)))
      return out.errors.push(`${where}: coordinates must be rings of [longitude, latitude] number pairs.`);
    const parts = partsRaw as LonLat[][];
    const kind = String(props.kind ?? props.type ?? 'keep_out')
      .toLowerCase()
      .replace(/[\s-]/g, '_');
    if (!KINDS.has(kind)) return out.errors.push(`${where}: kind must be keep_out, caution or no_fly (got ${kind}).`);
    const applies = Array.isArray(props.appliesTo)
      ? props.appliesTo.map(String)
      : typeof props.appliesTo === 'string'
        ? props.appliesTo.split(/[,\s]+/)
        : kind === 'no_fly'
          ? ['uav']
          : ['ugv', 'uav'];
    const appliesTo = [...new Set(applies.filter((k) => k === 'ugv' || k === 'uav'))] as Geofence['appliesTo'];
    if (!appliesTo.length) return out.errors.push(`${where}: appliesTo must include ugv and/or uav.`);
    parts.forEach((ringIn, pi) => {
      if (!Array.isArray(ringIn) || ringIn.length < 4) return out.errors.push(`${where}: a polygon ring needs at least 3 distinct points.`);
      let pts = ringIn.map(([lon, lat]) => geoToSite(anchor, { lat: Number(lat), lon: Number(lon) }));
      if (pts.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return out.errors.push(`${where}: coordinates must be [longitude, latitude] numbers.`);
      // drop the closing point and near-duplicates
      const first = pts[0];
      const last = pts[pts.length - 1];
      if (Math.hypot(first.x - last.x, first.y - last.y) < 0.05) pts = pts.slice(0, -1);
      pts = pts.filter((p, j) => j === 0 || Math.hypot(p.x - pts[j - 1].x, p.y - pts[j - 1].y) >= 0.05);
      if (pts.length < 3) return out.errors.push(`${where}: a polygon ring needs at least 3 distinct points.`);
      if (pts.length > maxV) return out.errors.push(`${where}: at most ${maxV} vertices per zone (got ${pts.length}); simplify it in the GIS.`);
      if (!pts.some((p) => p.x >= -margin && p.x <= extent.width + margin && p.y >= -margin && p.y <= extent.height + margin))
        return out.errors.push(`${where}: the polygon is not on this site (check the site anchor and that coordinates are [lon, lat]).`);
      const base =
        String(props.name ?? props.Name ?? props.title ?? f.id ?? `Imported zone ${i + 1}`)
          .trim()
          .slice(0, 80) || `Imported zone ${i + 1}`;
      out.geofences.push({
        name: parts.length > 1 ? `${base} (${pi + 1})` : base,
        kind: kind as Geofence['kind'],
        poly: pts.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 })),
        active: props.active === undefined ? true : props.active !== false && props.active !== 'false' && props.active !== 0,
        appliesTo,
        reason: typeof props.reason === 'string' ? props.reason.trim().slice(0, 160) || undefined : undefined,
        sourceId: f.id !== undefined ? String(f.id) : undefined,
      });
    });
  });
  return out;
}
