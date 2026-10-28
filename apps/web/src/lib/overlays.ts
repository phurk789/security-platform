// Operational overlays on the standard map: site boundary, geofences, sample site plan, mission
// routes, live trails, incidents and devices. Everything is GeoJSON sources updated in place
// (setData), never one DOM marker per object. The platform works in site metres; positions are
// turned into WGS 84 with the site's anchor (the same one gateways use to go the other way).
import type { Feature, FeatureCollection, Geometry, Position } from 'geojson';
import type { GeoJSONSource, LayerSpecification } from 'maplibre-gl';
import { BUILDINGS, BUSY_MISSION, SITE, siteToGeo, type Device, type GeoAnchor, type Geofence, type Incident, type Layers, type Mission, type Point, type TelemetrySample } from '@13store/shared';
import { addLayerTo, type LayerGroup, type LayerHost } from './layerOrder';

export const SRC = {
  boundary: 'ops-boundary',
  geofences: 'ops-geofences',
  plan: 'ops-plan',
  trails: 'ops-trails',
  routes: 'ops-routes',
  checkpoints: 'ops-checkpoints',
  accuracy: 'ops-accuracy',
  incidents: 'ops-incidents',
  devices: 'ops-devices',
} as const;
export type OverlayKey = keyof typeof SRC;
export type OverlayData = Record<OverlayKey, FeatureCollection>;

export type Freshness = 'live' | 'stale' | 'offline';

export interface OverlayInput {
  anchor: GeoAnchor;
  devices: Device[];
  incidents: Incident[];
  geofences: Geofence[];
  missions: Mission[];
  telemetry: TelemetrySample[];
  /** Time shown: now, or the replay time. */
  at: number;
  replay: boolean;
  selectedDeviceId: string | null;
  selectedIncidentId: string | null;
  layers: Partial<Layers>;
  showTrails: boolean;
  showPlan: boolean;
  freshness: (d: Device) => Freshness;
  /** How far back a trail reaches (ms). */
  trailMs?: number;
}

export const KIND_COLOR: Record<string, string> = { ugv: '#38bdf8', uav: '#c084fc', cctv: '#cbd5e1' };
export const SEVERITY_COLOR: Record<string, string> = { high: '#ef4444', medium: '#f59e0b', low: '#22c55e' };
export const GEOFENCE_COLOR: Record<string, string> = { keep_out: '#ef4444', caution: '#f59e0b', no_fly: '#a855f7', operating_area: '#22c55e' };
const OFFLINE_COLOR = '#64748b';
const STALE_COLOR = '#f59e0b';
/** A trail breaks where samples are further apart than this (link outage, no fix). */
const TRAIL_GAP_MS = 30_000;
const CLOSED: Incident['status'][] = ['closed', 'duplicate', 'dismissed'];

const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const feature = (geometry: Geometry, properties: Record<string, unknown>): Feature => ({ type: 'Feature', geometry, properties });

/** Site metres → [lon, lat]. */
export function lngLat(a: GeoAnchor, p: Point): Position {
  const g = siteToGeo(a, p);
  return [g.lon, g.lat];
}
const ring = (a: GeoAnchor, pts: Point[]): Position[] => {
  const r = pts.map((p) => lngLat(a, p));
  return [...r, r[0]];
};
const rect = (x: number, y: number, w: number, d: number): Point[] => [
  { x, y },
  { x: x + w, y },
  { x: x + w, y: y + d },
  { x, y: y + d },
];
function circle(c: Point, r: number, n = 24): Point[] {
  return Array.from({ length: n }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));
}

/** Label image id: the map draws the text into an image the first time it is needed. */
export const labelId = (text: string, bg: string) => `lbl|${text}|${bg}`;

/** Where a device was at `at` during a replay: its last sample at or before then (undefined = unknown). */
export function positionAt(telemetry: TelemetrySample[], deviceId: string, at: number): Point | undefined {
  let p: Point | undefined;
  for (const t of telemetry) {
    if (t.deviceId !== deviceId) continue;
    if (t.at > at) break;
    p = { x: t.x, y: t.y };
  }
  return p;
}

/** Map bearing (degrees clockwise from true north) of a site-grid heading. */
export const trueBearing = (a: GeoAnchor, siteHeading: number) => (((siteHeading + (a.rotationDeg ?? 0)) % 360) + 360) % 360;

/** Where each device is drawn now; devices without a known position are left out. */
export function devicePositions(i: Pick<OverlayInput, 'devices' | 'telemetry' | 'at' | 'replay'>): Map<string, Point> {
  const out = new Map<string, Point>();
  for (const d of i.devices) {
    const p = i.replay ? positionAt(i.telemetry, d.id, i.at) : d.noFix ? undefined : d.pos;
    if (p) out.set(d.id, p);
  }
  return out;
}

export function buildOverlayData(i: OverlayInput): OverlayData {
  const a = i.anchor;
  const L = i.layers;
  const on = (k: keyof Layers) => L[k] !== false;
  const out: OverlayData = { boundary: empty(), geofences: empty(), plan: empty(), trails: empty(), routes: empty(), checkpoints: empty(), accuracy: empty(), incidents: empty(), devices: empty() };

  out.boundary = fc([feature({ type: 'Polygon', coordinates: [ring(a, rect(0, 0, SITE.width, SITE.height))] }, { name: SITE.name })]);

  if (on('geofences'))
    out.geofences = fc(
      i.geofences
        .filter((g) => g.active && g.poly.length >= 3)
        .map((g) => feature({ type: 'Polygon', coordinates: [ring(a, g.poly)] }, { id: g.id, name: g.name, kind: g.kind, color: GEOFENCE_COLOR[g.kind] ?? '#f59e0b' })),
    );

  if (i.showPlan) out.plan = fc(BUILDINGS.map((b) => feature({ type: 'Polygon', coordinates: [ring(a, rect(b.x, b.y, b.w, b.d))] }, { id: b.id, name: b.name, height: b.h })));

  const kindOn = (d: Device) => (d.kind === 'cctv' ? on('cctv') : d.kind === 'uav' ? on('uav') : on('ugv'));
  const pos = devicePositions(i);

  // Trails: where each vehicle went recently (or up to the replay time), split at gaps.
  if (i.showTrails) {
    const from = i.at - (i.trailMs ?? 10 * 60_000);
    const vehicles = new Map(i.devices.filter((d) => d.kind !== 'cctv' && kindOn(d)).map((d) => [d.id, d]));
    const segs: Feature[] = [];
    const cur = new Map<string, { last: number; pts: Position[] }>();
    const flush = (id: string) => {
      const s = cur.get(id);
      if (s && s.pts.length >= 2) segs.push(feature({ type: 'LineString', coordinates: s.pts }, { deviceId: id, color: KIND_COLOR[vehicles.get(id)!.kind] }));
      cur.delete(id);
    };
    for (const t of i.telemetry) {
      if (t.at < from || t.at > i.at || !vehicles.has(t.deviceId)) continue;
      const s = cur.get(t.deviceId);
      if (s && t.at - s.last > TRAIL_GAP_MS) flush(t.deviceId);
      const c = cur.get(t.deviceId) ?? { last: t.at, pts: [] };
      c.pts.push(lngLat(a, t));
      c.last = t.at;
      cur.set(t.deviceId, c);
    }
    for (const id of [...cur.keys()]) flush(id);
    out.trails = fc(segs);
  }

  if (on('routes')) {
    const selMission = i.selectedIncidentId ? i.missions.find((m) => m.incidentId === i.selectedIncidentId) : undefined;
    const lines: Feature[] = [];
    const cps: Feature[] = [];
    for (const m of i.missions) {
      if (!BUSY_MISSION.includes(m.status) && m !== selMission) continue;
      if (m.checkpoints.length === 0) continue;
      const start = m.status === 'executing' || m.status === 'paused' ? pos.get(m.deviceId) : undefined;
      const pts = [...(start ? [start] : []), ...m.checkpoints.slice(start ? m.nextCp : 0)];
      const draft = m.approvedVersion !== m.planVersion ? 1 : 0;
      const selected = m === selMission ? 1 : 0;
      if (pts.length >= 2) lines.push(feature({ type: 'LineString', coordinates: pts.map((p) => lngLat(a, p)) }, { missionId: m.id, draft, selected }));
      m.checkpoints.forEach((p, n) => cps.push(feature({ type: 'Point', coordinates: lngLat(a, p) }, { missionId: m.id, n: n + 1, state: n < m.nextCp ? 'done' : n === m.nextCp ? 'next' : 'todo', selected })));
    }
    out.routes = fc(lines);
    out.checkpoints = fc(cps);
  }

  const incidents = i.incidents.filter((x) => (x.createdAt <= i.at && !CLOSED.includes(x.status)) || x.id === i.selectedIncidentId);
  out.incidents = fc(
    incidents.map((x) => {
      const color = SEVERITY_COLOR[x.severity] ?? '#f59e0b';
      return feature({ type: 'Point', coordinates: lngLat(a, x.pos) }, { id: x.id, severity: x.severity, color, label: labelId(x.id, color), selected: x.id === i.selectedIncidentId ? 1 : 0 });
    }),
  );

  const devs: Feature[] = [];
  const acc: Feature[] = [];
  for (const d of i.devices) {
    const p = pos.get(d.id);
    if (!p || !kindOn(d)) continue;
    const state = i.replay ? 'live' : i.freshness(d);
    const color = state === 'offline' ? OFFLINE_COLOR : KIND_COLOR[d.kind] ?? '#e2e8f0';
    const hasBearing = d.kind !== 'cctv' && d.heading !== undefined && state !== 'offline';
    devs.push(
      feature(
        { type: 'Point', coordinates: lngLat(a, p) },
        {
          id: d.id,
          kind: d.kind,
          state,
          color,
          ring: state === 'stale' ? STALE_COLOR : '#0b1220',
          bearing: hasBearing ? trueBearing(a, d.heading!) : 0,
          hasBearing: hasBearing ? 1 : 0,
          label: labelId(d.id, state === 'live' ? '#0f172a' : state === 'stale' ? '#92400e' : '#334155'),
          showLabel: on('labels') ? 1 : 0,
          selected: d.id === i.selectedDeviceId ? 1 : 0,
          real: d.integration === 'simulated' ? 0 : 1,
        },
      ),
    );
    if (on('accuracy') && d.kind !== 'cctv' && d.accuracyM > 0.5 && !i.replay)
      acc.push(feature({ type: 'Polygon', coordinates: [ring(a, circle(p, d.accuracyM))] }, { id: d.id, color }));
  }
  out.devices = fc(devs);
  out.accuracy = fc(acc);
  return out;
}

// ---------------------------------------------------------------------------
// Sources and layers
// ---------------------------------------------------------------------------

export const ARROW_IMAGE = 'ps-arrow';

/** Layers in drawing order within each group. Ids starting with these are clickable. */
export const CLICKABLE = { device: ['ops-device-dot', 'ops-device-arrow'], incident: ['ops-incident-dot'], geofence: ['ops-geofence-fill'] } as const;

const OPERATIONAL_LAYERS: [LayerGroup, LayerSpecification][] = [
  ['vector', { id: 'ops-plan-fill', type: 'fill', source: SRC.plan, paint: { 'fill-color': '#0f172a', 'fill-opacity': 0.45 } }],
  ['vector', { id: 'ops-plan-line', type: 'line', source: SRC.plan, paint: { 'line-color': '#94a3b8', 'line-width': 1 } }],
  ['boundaries', { id: 'ops-boundary-line', type: 'line', source: SRC.boundary, paint: { 'line-color': '#e2e8f0', 'line-width': 1.5, 'line-opacity': 0.75, 'line-dasharray': [3, 2] } }],
  ['boundaries', { id: 'ops-geofence-fill', type: 'fill', source: SRC.geofences, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['case', ['==', ['get', 'kind'], 'operating_area'], 0.05, 0.16] } }],
  ['boundaries', { id: 'ops-geofence-line', type: 'line', source: SRC.geofences, paint: { 'line-color': ['get', 'color'], 'line-width': 2 } }],
  ['routes', { id: 'ops-trail-line', type: 'line', source: SRC.trails, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.7 } }],
  [
    'routes',
    {
      id: 'ops-route-line',
      type: 'line',
      source: SRC.routes,
      filter: ['==', ['get', 'draft'], 0],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#22d3ee', 'line-width': ['case', ['==', ['get', 'selected'], 1], 4, 2.5] },
    },
  ],
  [
    'routes',
    {
      id: 'ops-route-draft',
      type: 'line',
      source: SRC.routes,
      filter: ['==', ['get', 'draft'], 1],
      paint: { 'line-color': '#fbbf24', 'line-width': ['case', ['==', ['get', 'selected'], 1], 4, 2.5], 'line-dasharray': [2, 1.5] },
    },
  ],
  [
    'routes',
    {
      id: 'ops-checkpoint',
      type: 'circle',
      source: SRC.checkpoints,
      paint: {
        'circle-radius': ['case', ['==', ['get', 'state'], 'next'], 6, 4.5],
        'circle-color': ['match', ['get', 'state'], 'done', '#64748b', 'next', '#22d3ee', '#f8fafc'],
        'circle-stroke-color': '#0b1220',
        'circle-stroke-width': 1.5,
      },
    },
  ],
  ['live', { id: 'ops-accuracy-fill', type: 'fill', source: SRC.accuracy, paint: { 'fill-color': ['get', 'color'], 'fill-opacity': 0.12, 'fill-outline-color': ['get', 'color'] } }],
  [
    'live',
    {
      id: 'ops-incident-halo',
      type: 'circle',
      source: SRC.incidents,
      paint: { 'circle-radius': ['case', ['==', ['get', 'selected'], 1], 18, 13], 'circle-color': ['get', 'color'], 'circle-opacity': 0.25 },
    },
  ],
  [
    'live',
    {
      id: 'ops-incident-dot',
      type: 'circle',
      source: SRC.incidents,
      paint: { 'circle-radius': 7, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
    },
  ],
  [
    'live',
    {
      id: 'ops-incident-label',
      type: 'symbol',
      source: SRC.incidents,
      layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'left', 'icon-offset': [12, 0], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    },
  ],
  [
    'live',
    {
      id: 'ops-device-select',
      type: 'circle',
      source: SRC.devices,
      filter: ['==', ['get', 'selected'], 1],
      paint: { 'circle-radius': 15, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#fde047', 'circle-stroke-width': 3 },
    },
  ],
  [
    'live',
    {
      id: 'ops-device-arrow',
      type: 'symbol',
      source: SRC.devices,
      filter: ['==', ['get', 'hasBearing'], 1],
      layout: {
        'icon-image': ARROW_IMAGE,
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-pitch-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
    },
  ],
  [
    'live',
    {
      id: 'ops-device-dot',
      type: 'circle',
      source: SRC.devices,
      paint: {
        'circle-radius': ['match', ['get', 'kind'], 'cctv', 5, 7],
        'circle-color': ['get', 'color'],
        'circle-stroke-color': ['get', 'ring'],
        'circle-stroke-width': 2.5,
      },
    },
  ],
  [
    'live',
    {
      id: 'ops-device-label',
      type: 'symbol',
      source: SRC.devices,
      filter: ['==', ['get', 'showLabel'], 1],
      layout: { 'icon-image': ['get', 'label'], 'icon-anchor': 'top', 'icon-offset': [0, 12], 'icon-allow-overlap': true, 'icon-ignore-placement': true },
    },
  ],
];

/** Adds the overlay sources and layers once (nothing twice, whatever the call count). */
export function ensureOperationalLayers(map: LayerHost) {
  for (const id of Object.values(SRC)) if (!map.getSource(id)) map.addSource(id, { type: 'geojson', data: empty() });
  for (const [group, layer] of OPERATIONAL_LAYERS) addLayerTo(map, group, layer);
}

/** Replaces the data of every overlay source (sources that are not there yet are skipped). */
export function updateOverlayData(map: Pick<LayerHost, 'getSource'>, data: OverlayData) {
  for (const k of Object.keys(SRC) as OverlayKey[]) (map.getSource(SRC[k]) as GeoJSONSource | undefined)?.setData(data[k]);
}

export const OPERATIONAL_LAYER_IDS = OPERATIONAL_LAYERS.map(([, l]) => l.id);
