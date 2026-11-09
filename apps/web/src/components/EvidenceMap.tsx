// The Evidence page's map: the site's real imagery with its zones, the incident, the devices that
// saw it, and a numbered pin where each image was taken. The selected image's pin is ringed at the
// distance the detected person stood from the camera (the direction is not known, so a ring).
// Read-only: nothing is drawn or edited here. Server-connected consoles only, like the main map.
import 'maplibre-gl/dist/maplibre-gl.css';
import './realmap.css';
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { LocateFixed } from 'lucide-react';
import { SITE, fmtTime, type Incident, type Point } from '@13store/shared';
import { createStandardMap, SITE_ZOOM, type StandardMap } from '../lib/standardMap';
import { SEVERITY_COLOR, buildOverlayData, ensureOperationalLayers, lngLat, updateOverlayData } from '../lib/overlays';
import { addLayerTo } from '../lib/layerOrder';
import { addMapImages } from '../lib/mapImages';
import { registerBasemaps, type Basemap } from '../lib/basemaps';
import { framePoints, shotPaths, type Shot } from '../domain/evidence';
import { freshness } from '../domain/policy';
import { useStore } from '../store';
import { useT } from '../i18n';

const PATH_SRC = 'ev-path';
const RING_SRC = 'ev-ring';
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
/** Overlay redraws at most this often (the clock and telemetry change the state many times a second). */
const REDRAW_MS = 250;
/** Every layer on, whatever the Command Centre hides: this map shows only what concerns the incident. */
const LAYERS = { ugv: true, uav: true, cctv: true, routes: true, geofences: true, labels: true, accuracy: false };

export interface EvidenceMapProps {
  inc: Incident;
  /** The incident and the ones merged into it. */
  related: ReadonlySet<string>;
  /** Devices that saw it or were sent to it. */
  deviceIds: readonly string[];
  shots: readonly Shot[];
  selected?: string;
  onSelect: (evidenceId: string) => void;
}

const circle = (c: Point, r: number, n = 64): Point[] => Array.from({ length: n + 1 }, (_, i) => ({ x: c.x + r * Math.cos((2 * Math.PI * i) / n), y: c.y + r * Math.sin((2 * Math.PI * i) / n) }));

export default function EvidenceMap({ inc, related, deviceIds, shots, selected, onSelect }: EvidenceMapProps) {
  const { s, session } = useStore();
  const t = useT();
  const el = useRef<HTMLDivElement>(null);
  const sm = useRef<StandardMap | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef({ s, t, session, inc, related, deviceIds, onSelect });
  latest.current = { s, t, session, inc, related, deviceIds, onSelect };

  // One map per mounted page; everything it added goes with it.
  useEffect(() => {
    const host = el.current;
    if (!host) return;
    let m: StandardMap | undefined;
    let gone = false;
    const off: (() => void)[] = [];
    const api = latest.current.session?.api;
    const start = () => {
      if (gone) return;
      try {
        const cur = latest.current;
        m = createStandardMap(host, {
          center: lngLat(cur.s.geo, cur.inc.pos ?? { x: SITE.width / 2, y: SITE.height / 2 }) as [number, number],
          zoom: SITE_ZOOM + 1,
          t: (k) => latest.current.t(k),
          token: () => latest.current.session?.api.token,
          apiGet: api ? (path) => api.get(path) : undefined,
          onReady: (map) => {
            ensureOperationalLayers(map);
            if (!map.getSource(PATH_SRC)) map.addSource(PATH_SRC, { type: 'geojson', data: EMPTY_FC });
            if (!map.getSource(RING_SRC)) map.addSource(RING_SRC, { type: 'geojson', data: EMPTY_FC });
            // Under the live markers: the camera's path between its images (dark-edged, so it reads on
            // bright roofs and concrete), and the distance ring.
            addLayerTo(map, 'routes', {
              id: 'ev-path-edge',
              type: 'line',
              source: PATH_SRC,
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: { 'line-color': '#0b1220', 'line-width': 5, 'line-opacity': 0.55 },
            });
            addLayerTo(map, 'routes', {
              id: 'ev-path-line',
              type: 'line',
              source: PATH_SRC,
              layout: { 'line-cap': 'round', 'line-join': 'round' },
              paint: { 'line-color': '#f8fafc', 'line-width': 2.5, 'line-opacity': 0.95, 'line-dasharray': [1.5, 1.5] },
            });
            addLayerTo(map, 'routes', { id: 'ev-ring-fill', type: 'fill', source: RING_SRC, paint: { 'fill-color': '#fbbf24', 'fill-opacity': 0.1 } });
            addLayerTo(map, 'routes', { id: 'ev-ring-line', type: 'line', source: RING_SRC, paint: { 'line-color': '#fbbf24', 'line-width': 2, 'line-dasharray': [2, 1.5] } });
            off.push(addMapImages(map));
            setReady(true);
          },
        });
      } catch (e) {
        console.error('[evidence map] cannot start', e);
        setError(latest.current.t('The map needs WebGL 2. Use a current Chrome, Edge or Firefox with graphics acceleration on.'));
        return;
      }
      sm.current = m;
      m.map.on('webglcontextlost', () => setError(latest.current.t('The map lost its graphics context. Reload the page.')));
      let logged = 0;
      m.map.on('error', (ev) => {
        if (logged++ < 5) console.warn('[evidence map]', ev.error?.message ?? ev);
      });
    };
    // Basemaps the server offers (Google, with the key on the server) join the list before the map exists.
    if (api)
      api
        .get<Basemap[]>('/basemaps')
        .then((list) => registerBasemaps(list.map((b) => ({ ...b, tiles: b.tiles.map((u) => (u.startsWith('/') ? `${location.origin}${u}` : u)) }))))
        .catch((e) => console.warn('[evidence map] server basemaps unavailable', e))
        .finally(start);
    else start();
    return () => {
      gone = true;
      for (const f of off.splice(0)) f();
      m?.destroy();
      sm.current = null;
      setReady(false);
    };
  }, []);

  // Zones, the incident and the devices involved, from the latest state at most every REDRAW_MS.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const map = sm.current?.map;
      const { s: cur, inc: i, related: rel, deviceIds: ids } = latest.current;
      if (!map) return;
      const devices = new Set(ids);
      updateOverlayData(
        map,
        buildOverlayData({
          anchor: cur.geo,
          devices: Object.values(cur.devices).filter((d) => devices.has(d.id)),
          incidents: cur.incidents.filter((x) => rel.has(x.id)),
          geofences: cur.geofences,
          missions: cur.missions.filter((x) => rel.has(x.incidentId)),
          telemetry: cur.telemetry,
          at: cur.replay.active ? cur.replay.at : cur.now,
          replay: cur.replay.active,
          selectedDeviceId: null,
          selectedIncidentId: i.id,
          layers: LAYERS,
          showTrails: false,
          showPlan: false,
          freshness: (d) => freshness(cur, d),
        }),
      );
    }, REDRAW_MS);
  }, [ready, s, inc.id, related, deviceIds]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // The camera's path, the selected image's distance ring, and one numbered pin per placed image.
  const pins = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    const map = sm.current?.map;
    if (!ready || !map) return;
    const g = s.geo;
    const tt = latest.current.t;
    (map.getSource(PATH_SRC) as GeoJSONSource | undefined)?.setData({
      type: 'FeatureCollection',
      features: shotPaths(shots).map((p) => ({ type: 'Feature', properties: { deviceId: p.deviceId }, geometry: { type: 'LineString', coordinates: p.points.map((q) => lngLat(g, q)) } })),
    });
    const sel = shots.find((x) => x.ev.id === selected);
    (map.getSource(RING_SRC) as GeoJSONSource | undefined)?.setData(
      sel?.pos && sel.distanceM
        ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [circle(sel.pos, sel.distanceM).map((q) => lngLat(g, q))] } }] }
        : EMPTY_FC,
    );
    for (const mk of pins.current) mk.remove();
    pins.current = [];
    // The selected pin last, so it sits on top of its neighbours.
    const placed = shots.filter((x) => x.pos).sort((a, b) => Number(a.ev.id === selected) - Number(b.ev.id === selected));
    for (const shot of placed) {
      const on = shot.ev.id === selected;
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = on ? 'evd-pin sel' : 'evd-pin';
      pin.textContent = String(shot.n);
      const time = fmtTime(shot.ev.capturedAt, true);
      const far = shot.distanceM !== undefined ? tt('about {m} m away', { m: shot.distanceM }) : '';
      pin.title = [`${shot.n} · ${time}`, far].filter(Boolean).join(' · ');
      pin.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) {
        const tag = document.createElement('span');
        tag.className = 'evd-pin-tag';
        tag.textContent = far ? `${time} · ${far}` : time;
        pin.append(tag);
      }
      pin.addEventListener('click', (ev) => {
        ev.stopPropagation();
        latest.current.onSelect(shot.ev.id);
      });
      pins.current.push(new maplibregl.Marker({ element: pin }).setLngLat(lngLat(g, shot.pos!) as [number, number]).addTo(map));
    }
  }, [ready, shots, selected, s.geo]);
  useEffect(
    () => () => {
      for (const mk of pins.current) mk.remove();
      pins.current = [];
    },
    [],
  );

  /** Frame the incident and where its images were taken. */
  const frame = (duration = 700) => {
    const map = sm.current?.map;
    if (!map) return;
    const cur = latest.current;
    const pts = framePoints(cur.inc.pos, shots).map((p) => lngLat(cur.s.geo, p));
    if (!pts.length) return;
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      // Close enough to tell the pins apart, far enough to see the buildings and zones around them.
      { padding: { top: 70, bottom: 50, left: 60, right: 60 }, maxZoom: 18.5, duration, pitch: 0, bearing: 0 },
    );
  };

  // A new incident, or its images placed once their detections arrive: frame them.
  const placedCount = shots.filter((x) => x.pos).length;
  useEffect(() => {
    if (ready) frame(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, inc.id, placedCount]);

  // A selected image whose pin is off screen is brought into view (without changing the zoom).
  useEffect(() => {
    const map = sm.current?.map;
    const p = shots.find((x) => x.ev.id === selected)?.pos;
    if (!ready || !map || !p) return;
    const ll = lngLat(s.geo, p) as [number, number];
    if (!map.getBounds().contains(ll)) map.easeTo({ center: ll, duration: 500 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selected]);

  return (
    <div className={`map map-real evd-map-real${s.replay.active ? ' replay' : ''}`}>
      <div ref={el} className="map-real-canvas" aria-label={t('Evidence map of {id}', { id: inc.id })} role="region" />
      {error ? (
        <div className="map-error" role="alert">
          {error}
        </div>
      ) : (
        <div className="evd-map-key">
          <button className="evd-map-fit" onClick={() => frame()} title={t('Show all evidence on the map')} aria-label={t('Show all evidence on the map')}>
            <LocateFixed size={16} />
          </button>
          <ul aria-label={t('Map key')}>
            <li>
              <i className="evd-key-inc" style={{ background: SEVERITY_COLOR[inc.severity] ?? '#f59e0b' }} />
              {t('Where it happened')}
            </li>
            {placedCount > 0 && (
              <li>
                <i className="evd-key-pin">1</i>
                {t('Where each image was taken')}
              </li>
            )}
            {shots.some((x) => x.pos && x.distanceM) && (
              <li>
                <i className="evd-key-ring" />
                {t('Distance to what was detected')}
              </li>
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
