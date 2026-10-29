// The main map: real imagery on the shared standard map (globe, basemaps, orbit), with the site's
// live devices, trails, incidents, geofences and mission routes on top. Server-connected consoles
// only (the offline demo keeps the drawn twin, which needs no internet).
import 'maplibre-gl/dist/maplibre-gl.css';
import './realmap.css';
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type GeoJSONSource, type Map as MlMap, type MapLayerMouseEvent, type MapMouseEvent } from 'maplibre-gl';
import { Layers as LayersIcon, LocateFixed, SatelliteDish } from 'lucide-react';
import { GEOFENCE_KIND_LABEL, SITE, fmtLatLon, geoToSite, type AppState, type Layers as LayerState } from '@13store/shared';
import { MAX_ZONE_POINTS, addPoint, insertPoint, isZonePurpose, maxPoints, movePoint, northUpRect, removePoint, routeDraft, useRouteDraft, type ZoneMeta } from '../domain/routeDraft';
import { useHiddenZones } from '../domain/zoneVisibility';
import { ZonesPanel } from './ZonesPanel';
import { RouteDraftPanel } from './RouteDraftPanel';
import { freshness } from '../domain/policy';
import { useStore } from '../store';
import { useT } from '../i18n';
import { createStandardMap, SITE_ZOOM, type StandardMap } from '../lib/standardMap';
import { CLICKABLE, GEOFENCE_COLOR, buildOverlayData, devicePositions, ensureOperationalLayers, lngLat, updateOverlayData, type OverlayInput } from '../lib/overlays';
import { addMapImages } from '../lib/mapImages';
import { registerBasemaps, type Basemap } from '../lib/basemaps';

const TRAILS_KEY = 'ps-map-trails';
const PLAN_KEY = 'ps-map-plan';
/** Overlay redraws at most this often (telemetry and the clock change the state many times a second). */
const REDRAW_MS = 250;
/** The route being drawn (dashed line; its checkpoints are draggable DOM markers). */
const DRAFT_SRC = 'route-draft';
/** The line from the last point to the mouse while drawing (a rectangle preview for the rectangle tool). */
const CURSOR_SRC = 'route-draft-cursor';
const EMPTY_FC: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
const drawing = () => routeDraft.get()?.state === 'drawing';

function useLocalFlag(key: string, def: boolean): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      const s = localStorage.getItem(key);
      return s === null ? def : s === '1';
    } catch {
      return def;
    }
  });
  const set = (nv: boolean) => {
    setV(nv);
    try {
      localStorage.setItem(key, nv ? '1' : '0');
    } catch {
      /* this page only */
    }
  };
  return [v, set];
}

function overlayInput(s: AppState, showTrails: boolean, showPlan: boolean, hiddenGeofenceIds?: ReadonlySet<string>): OverlayInput {
  return {
    anchor: s.geo,
    devices: Object.values(s.devices),
    incidents: s.incidents,
    geofences: s.geofences,
    missions: s.missions,
    telemetry: s.telemetry,
    at: s.replay.active ? s.replay.at : s.now,
    replay: s.replay.active,
    selectedDeviceId: s.selectedDeviceId,
    selectedIncidentId: s.selectedIncidentId,
    layers: s.layers,
    showTrails,
    showPlan,
    freshness: (d) => freshness(s, d),
    hiddenGeofenceIds,
  };
}

/** A zone being drawn or reshaped in the editor on the map. */
const zoneMeta = () => {
  const d = routeDraft.get();
  return d?.state === 'drawing' && d.purpose === 'geofence' ? (d.meta as ZoneMeta) : undefined;
};

/** Pixels hidden behind the floating HUD panels (CSS variables on the overview), used as camera padding. */
function hudPadding(el: HTMLElement) {
  const cs = getComputedStyle(el);
  const px = (name: string) => {
    const v = parseFloat(cs.getPropertyValue(name));
    return Number.isFinite(v) ? v : 0;
  };
  return { left: px('--view-l'), right: px('--view-r'), bottom: px('--view-b'), top: 0 };
}

export default function RealMap() {
  const { s, dispatch, session } = useStore();
  const t = useT();
  const el = useRef<HTMLDivElement>(null);
  const sm = useRef<StandardMap | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layersOpen, setLayersOpen] = useState(false);
  const [showTrails, setShowTrails] = useLocalFlag(TRAILS_KEY, true);
  const [showPlan, setShowPlan] = useLocalFlag(PLAN_KEY, false);
  const draft = useRouteDraft();
  const hiddenZones = useHiddenZones();
  // The zone open in the editor is drawn by the editor, not as a normal zone.
  const editingId = draft?.state === 'drawing' && draft.purpose === 'geofence' ? (draft.meta as ZoneMeta).id : undefined;
  const hiddenIds = editingId ? new Set([...hiddenZones, editingId]) : hiddenZones;
  const latest = useRef({ s, showTrails, showPlan, dispatch, t, session, hiddenIds });
  latest.current = { s, showTrails, showPlan, dispatch, t, session, hiddenIds };

  // One map per mounted component; everything it added goes with it.
  useEffect(() => {
    const host = el.current;
    if (!host) return;
    let m: StandardMap | undefined;
    let gone = false;
    let ro: ResizeObserver | undefined;
    const off: (() => void)[] = [];
    const api = latest.current.session?.api;
    const start = () => {
      if (gone) return;
      try {
        m = createStandardMap(host, {
          center: lngLat(latest.current.s.geo, { x: SITE.width / 2, y: SITE.height / 2 }) as [number, number],
          zoom: SITE_ZOOM,
          t: (k) => latest.current.t(k),
          token: () => latest.current.session?.api.token,
          apiGet: api ? (path) => api.get(path) : undefined,
          onReady: (map) => {
            ensureOperationalLayers(map);
            if (!map.getSource(DRAFT_SRC)) map.addSource(DRAFT_SRC, { type: 'geojson', data: EMPTY_FC });
            if (!map.getSource(CURSOR_SRC)) map.addSource(CURSOR_SRC, { type: 'geojson', data: EMPTY_FC });
            if (!map.getLayer('route-draft-fill'))
              map.addLayer({
                id: 'route-draft-fill',
                type: 'fill',
                source: DRAFT_SRC,
                filter: ['==', ['geometry-type'], 'Polygon'],
                paint: { 'fill-color': ['coalesce', ['get', 'color'], '#fbbf24'], 'fill-opacity': 0.2 },
              });
            if (!map.getLayer('route-draft-line'))
              map.addLayer({
                id: 'route-draft-line',
                type: 'line',
                source: DRAFT_SRC,
                filter: ['==', ['geometry-type'], 'LineString'],
                layout: { 'line-cap': 'round', 'line-join': 'round' },
                paint: { 'line-color': ['coalesce', ['get', 'color'], '#fbbf24'], 'line-width': 3, 'line-dasharray': [2, 1.5] },
              });
            if (!map.getLayer('route-draft-cursor'))
              map.addLayer({
                id: 'route-draft-cursor',
                type: 'line',
                source: CURSOR_SRC,
                paint: { 'line-color': ['coalesce', ['get', 'color'], '#fbbf24'], 'line-width': 1.5, 'line-opacity': 0.8, 'line-dasharray': [1, 1.5] },
              });
            off.push(addMapImages(map));
            bindInteractions(map, off);
            map.setPadding(hudPadding(host));
            setReady(true);
          },
        });
      } catch (e) {
        console.error('[map] cannot start', e);
        setError(latest.current.t('The map needs WebGL 2. Use a current Chrome, Edge or Firefox with graphics acceleration on.'));
        return;
      }
      sm.current = m;
      m.map.on('webglcontextlost', () => setError(latest.current.t('The map lost its graphics context. Reload the page.')));
      let logged = 0;
      m.map.on('error', (ev) => {
        // Tile servers fail now and then; log a few for diagnosis (tile URLs carry no credentials).
        if (logged++ < 5) console.warn('[map]', ev.error?.message ?? ev);
      });
      ro = new ResizeObserver(() => sm.current?.map.setPadding(hudPadding(host)));
      ro.observe(host);
    };
    // Basemaps the server offers (Google, with the key on the server) join the list before the map exists.
    if (api)
      api
        .get<Basemap[]>('/basemaps')
        // Absolute URLs (tiles load in a web worker); plain concatenation keeps the {z}/{x}/{y} placeholders as they are.
        .then((list) => registerBasemaps(list.map((b) => ({ ...b, tiles: b.tiles.map((u) => (u.startsWith('/') ? `${location.origin}${u}` : u)) }))))
        .catch((e) => console.warn('[map] server basemaps unavailable', e))
        .finally(start);
    else start();
    return () => {
      gone = true;
      ro?.disconnect();
      for (const f of off.splice(0)) f();
      m?.destroy();
      sm.current = null;
      setReady(false);
    };
  }, []);

  /** The dashed line from the last point to the mouse; a rectangle preview for the rectangle tool. */
  function drawCursor(map: MlMap, at: { lng: number; lat: number } | null) {
    const src = map.getSource(CURSOR_SRC) as GeoJSONSource | undefined;
    if (!src) return;
    const d = routeDraft.get();
    const meta = zoneMeta();
    if (!at || !d || d.state !== 'drawing' || meta?.mode === 'edit' || d.points.length >= maxPoints(d.purpose)) return src.setData(EMPTY_FC);
    const g = latest.current.s.geo;
    const cur: [number, number] = [at.lng, at.lat];
    const ll = (p: { x: number; y: number }) => lngLat(g, p) as [number, number];
    let coords: [number, number][];
    if (meta?.shape === 'rect') {
      if (d.points.length !== 1) return src.setData(EMPTY_FC);
      const rect = northUpRect(d.points[0], geoToSite(g, { lat: at.lat, lon: at.lng }), g);
      coords = [...rect, rect[0]].map(ll);
    } else if (isZonePurpose(d.purpose)) {
      if (!d.points.length) return src.setData(EMPTY_FC);
      const last = ll(d.points[d.points.length - 1]);
      coords = d.points.length >= 2 ? [last, cur, ll(d.points[0])] : [last, cur];
    } else {
      // A route continues from its last checkpoint, or from the vehicle before the first one.
      const dev = latest.current.s.devices[d.deviceId];
      const start = d.points.length ? d.points[d.points.length - 1] : dev && !dev.noFix ? dev.pos : undefined;
      if (!start) return src.setData(EMPTY_FC);
      coords = [ll(start), cur];
    }
    const color = meta ? GEOFENCE_COLOR[meta.kind] : undefined;
    src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: color ? { color } : {}, geometry: { type: 'LineString', coordinates: coords } }] });
  }

  function bindInteractions(map: MlMap, off: (() => void)[]) {
    const on = (type: 'click' | 'mouseenter' | 'mouseleave', layer: string, fn: (e: MapLayerMouseEvent) => void) => {
      map.on(type, layer, fn);
      off.push(() => map.off(type, layer, fn));
    };
    const pointer = (v: string) => () => (map.getCanvas().style.cursor = v);
    for (const id of [...CLICKABLE.device, ...CLICKABLE.incident, ...CLICKABLE.geofence]) {
      on('mouseenter', id, pointer('pointer'));
      on('mouseleave', id, pointer(''));
    }
    // While a route is drawn, every click on the map is a checkpoint (selection waits).
    const onMapClick = (e: MapMouseEvent) => {
      const d = routeDraft.get();
      if (!d || d.state !== 'drawing') return;
      if ((e.originalEvent.target as HTMLElement | null)?.closest?.('.route-pt, .route-mid')) return;
      const geo = latest.current.s.geo;
      const p = geoToSite(geo, { lat: e.lngLat.lat, lon: e.lngLat.lng });
      const meta = zoneMeta();
      if (meta) {
        // Reshaping: corners are added from the midpoint handles, not by clicking the map.
        if (meta.mode === 'edit') return;
        if (meta.shape === 'rect') {
          if (!d.points.length) return routeDraft.setPoints(addPoint([], p));
          routeDraft.setPoints(northUpRect(d.points[0], p, geo));
          routeDraft.setMeta({ ...meta, mode: 'edit', shape: 'polygon' });
          return;
        }
      }
      routeDraft.setPoints(addPoint(d.points, p, maxPoints(d.purpose)));
    };
    map.on('click', onMapClick);
    off.push(() => map.off('click', onMapClick));
    // Rubber band from the last point to the mouse (one redraw per frame).
    let raf = 0;
    let at: { lng: number; lat: number } | null = null;
    const onMove = (e: MapMouseEvent) => {
      at = e.lngLat;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        drawCursor(map, at);
      });
    };
    map.on('mousemove', onMove);
    off.push(() => {
      map.off('mousemove', onMove);
      cancelAnimationFrame(raf);
    });
    for (const id of CLICKABLE.device) on('click', id, (e) => !drawing() && e.features?.[0] && latest.current.dispatch({ type: 'selectDevice', id: String(e.features[0].properties.id) }));
    for (const id of CLICKABLE.incident) on('click', id, (e) => !drawing() && e.features?.[0] && latest.current.dispatch({ type: 'selectIncident', id: String(e.features[0].properties.id) }));
    for (const id of CLICKABLE.geofence)
      on('click', id, (e) => {
        if (drawing()) return;
        const p = e.features?.[0]?.properties;
        if (!p || map.queryRenderedFeatures(e.point, { layers: [...CLICKABLE.device, ...CLICKABLE.incident] }).length) return;
        const tt = latest.current.t;
        const box = document.createElement('div');
        const b = document.createElement('b');
        b.textContent = String(p.name);
        const small = document.createElement('div');
        small.textContent = tt(GEOFENCE_KIND_LABEL[p.kind as keyof typeof GEOFENCE_KIND_LABEL] ?? String(p.kind));
        box.append(b, small);
        const popup = new maplibregl.Popup({ closeButton: true, className: 'ps-popup' }).setLngLat(e.lngLat).setDOMContent(box).addTo(map);
        off.push(() => popup.remove());
      });
  }

  // Redraw overlays from the latest state, at most every REDRAW_MS.
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (!ready || timer.current !== null) return;
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const map = sm.current?.map;
      const { s: cur, showTrails: tr, showPlan: pl, hiddenIds: hid } = latest.current;
      if (map) updateOverlayData(map, buildOverlayData(overlayInput(cur, tr, pl, hid)));
    }, REDRAW_MS);
  }, [ready, s, showTrails, showPlan, hiddenZones, editingId]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // The route or zone being drawn: a dashed line (a route starts at the vehicle; a zone closes on its
  // first corner, filled in its kind's colour), and one draggable marker per point (right-click
  // removes it). Reshaping a zone adds a handle on each edge: click or drag it to add a corner.
  const markers = useRef<maplibregl.Marker[]>([]);
  useEffect(() => {
    const map = sm.current?.map;
    if (!ready || !map) return;
    for (const mk of markers.current) mk.remove();
    markers.current = [];
    const src = map.getSource(DRAFT_SRC) as GeoJSONSource | undefined;
    const cursor = map.getSource(CURSOR_SRC) as GeoJSONSource | undefined;
    const on = draft?.state === 'drawing';
    map.getCanvas().style.cursor = on ? 'crosshair' : '';
    // A double-click while drawing would zoom away from the shape.
    if (on) map.doubleClickZoom.disable();
    else map.doubleClickZoom.enable();
    if (!on || !draft) {
      src?.setData(EMPTY_FC);
      cursor?.setData(EMPTY_FC);
      return;
    }
    const cur = latest.current.s;
    const g = cur.geo;
    const zone = isZonePurpose(draft.purpose);
    const meta = draft.purpose === 'geofence' ? (draft.meta as ZoneMeta) : undefined;
    if (meta?.mode === 'edit') cursor?.setData(EMPTY_FC);
    const color = meta ? GEOFENCE_COLOR[meta.kind] : undefined;
    const props = color ? { color } : {};
    const dev = zone ? undefined : cur.devices[draft.deviceId];
    const from = dev && !dev.noFix ? dev.pos : undefined;
    const ring = draft.points.length > 2 ? [...draft.points, draft.points[0]] : draft.points;
    const line = (zone ? ring : [...(from ? [from] : []), ...draft.points]).map((p) => lngLat(g, p));
    const features: GeoJSON.Feature[] = [];
    if (zone && draft.points.length > 2) features.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [ring.map((p) => lngLat(g, p))] } });
    if (line.length > 1) features.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: line } });
    src?.setData({ type: 'FeatureCollection', features });
    const tt = latest.current.t;
    draft.points.forEach((p, i) => {
      const el = document.createElement('div');
      el.className = zone ? 'route-pt zone-pt' : 'route-pt';
      if (color) el.style.setProperty('--pt-color', color);
      if (!zone) el.textContent = String(i + 1);
      const closes = meta?.mode === 'draw' && i === 0 && draft.points.length >= 3;
      el.title = closes ? tt('Click to close the outline') : tt('Drag to move · right-click to remove');
      if (closes) el.classList.add('closes');
      el.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const d = routeDraft.get();
        if (d) routeDraft.setPoints(removePoint(d.points, i));
      });
      const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lngLat(g, p) as [number, number]).addTo(map);
      let dragged = false;
      mk.on('dragstart', () => (dragged = true));
      mk.on('dragend', () => {
        const ll = mk.getLngLat();
        const d = routeDraft.get();
        if (d) routeDraft.setPoints(movePoint(d.points, i, geoToSite(g, { lat: ll.lat, lon: ll.lng })));
      });
      // Clicking the first corner closes a new outline: the shape is then reshaped, not extended.
      if (closes)
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (dragged) return;
          const m = zoneMeta();
          if (m) routeDraft.setMeta({ ...m, mode: 'edit' });
        });
      markers.current.push(mk);
    });
    if (meta?.mode === 'edit' && draft.points.length >= 2 && draft.points.length < MAX_ZONE_POINTS) {
      const n = draft.points.length;
      for (let i = 0; i < (n === 2 ? 1 : n); i++) {
        const a = draft.points[i];
        const b = draft.points[(i + 1) % n];
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const el = document.createElement('div');
        el.className = 'route-mid';
        if (color) el.style.setProperty('--pt-color', color);
        el.title = tt('Click or drag to add a corner');
        const mk = new maplibregl.Marker({ element: el, draggable: true }).setLngLat(lngLat(g, mid) as [number, number]).addTo(map);
        let dragged = false;
        mk.on('dragstart', () => (dragged = true));
        mk.on('dragend', () => {
          const ll = mk.getLngLat();
          const d = routeDraft.get();
          if (d) routeDraft.setPoints(insertPoint(d.points, i + 1, geoToSite(g, { lat: ll.lat, lon: ll.lng })));
        });
        el.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (dragged) return;
          const d = routeDraft.get();
          if (d) routeDraft.setPoints(insertPoint(d.points, i + 1, mid));
        });
        markers.current.push(mk);
      }
    }
  }, [ready, draft]);
  useEffect(
    () => () => {
      for (const mk of markers.current) mk.remove();
      markers.current = [];
    },
    [],
  );

  // Bring a newly selected device or incident into view (without changing the zoom).
  const focus = s.selectedDeviceId ?? s.selectedIncidentId;
  useEffect(() => {
    const map = sm.current?.map;
    if (!ready || !map || !focus) return;
    const cur = latest.current.s;
    const p = cur.devices[focus] ? devicePositions(overlayInput(cur, false, false)).get(focus) : cur.incidents.find((i) => i.id === focus)?.pos;
    if (!p) return;
    const ll = lngLat(cur.geo, p) as [number, number];
    if (!map.getBounds().contains(ll)) map.easeTo({ center: ll, duration: 600 });
  }, [ready, focus]);

  const fitSite = () => {
    const map = sm.current?.map;
    if (!map) return;
    // A real site is its operating area; the demo site is its drawn grid.
    const area = s.geofences.filter((z) => z.active && z.kind === 'operating_area').flatMap((z) => z.poly);
    if (area.length) return zoomTo(area);
    const g = s.geo;
    const pts = [lngLat(g, { x: 0, y: 0 }), lngLat(g, { x: SITE.width, y: 0 }), lngLat(g, { x: SITE.width, y: SITE.height }), lngLat(g, { x: 0, y: SITE.height })];
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 40, duration: 800, pitch: 0, bearing: 0 },
    );
  };

  // Each site opens on its operating area once its zones have loaded (the demo site keeps its view).
  const fitted = useRef<string | undefined>(undefined);
  const siteKey = s.site?.id;
  const hasArea = s.geofences.some((z) => z.active && z.kind === 'operating_area');
  useEffect(() => {
    if (!ready || !siteKey || fitted.current === siteKey) return;
    fitted.current = siteKey;
    // The site and its zones come in the same snapshot, so this runs once the zones are known.
    if (hasArea) fitSite();
    else if (!s.site?.demo) sm.current?.map.jumpTo({ center: lngLat(s.geo, { x: 0, y: 0 }) as [number, number], zoom: 17 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, siteKey, hasArea]);

  /** Fit a zone (site metres) into view, clear of the HUD panels. */
  const zoomTo = (poly: { x: number; y: number }[]) => {
    const map = sm.current?.map;
    if (!map || !poly.length) return;
    const pts = poly.map((p) => lngLat(s.geo, p));
    const lons = pts.map((p) => p[0]);
    const lats = pts.map((p) => p[1]);
    map.fitBounds(
      [
        [Math.min(...lons), Math.min(...lats)],
        [Math.max(...lons), Math.max(...lats)],
      ],
      { padding: 80, maxZoom: 19, duration: 700 },
    );
  };

  const L = s.layers;
  const storeLayers: [keyof LayerState, string][] = [
    ['ugv', 'UGV'],
    ['uav', 'UAV'],
    ['cctv', 'CCTV'],
    ['routes', 'Mission routes'],
    ['geofences', 'Geofences'],
    ['labels', 'Labels'],
    ['accuracy', 'Position accuracy'],
  ];
  const noFix = Object.values(s.devices).filter((d) => d.noFix && d.kind !== 'cctv' && d.integration !== 'simulated' && freshness(s, d) === 'live');

  return (
    <div className={`map map-real${s.replay.active ? ' replay' : ''}`}>
      <div ref={el} className="map-real-canvas" aria-label={t('Live map of {site}', { site: s.site?.name ?? SITE.name })} role="region" />
      {error ? (
        <div className="map-error" role="alert">
          {error}
        </div>
      ) : (
        <>
          <div className="map-tools">
            <div className="layers">
              <button className="btn-ghost" onClick={() => setLayersOpen((o) => !o)} aria-expanded={layersOpen}>
                <LayersIcon size={16} /> {t('Layers')}
              </button>
              {layersOpen && (
                <div className="pop">
                  {storeLayers.map(([k, label]) => (
                    <label key={k}>
                      <input type="checkbox" checked={L[k] !== false} onChange={() => dispatch({ type: 'toggleLayer', layer: k })} />
                      {t(label)}
                    </label>
                  ))}
                  <label>
                    <input type="checkbox" checked={showTrails} onChange={() => setShowTrails(!showTrails)} />
                    {t('Vehicle trails (10 min)')}
                  </label>
                  <hr />
                  <label>
                    <input type="checkbox" checked={showPlan} onChange={() => setShowPlan(!showPlan)} />
                    {t('Sample site plan (placeholder buildings)')}
                  </label>
                  <p className="pop-h">
                    {t('WGS 84 anchor')} {fmtLatLon({ lat: s.geo.originLat, lon: s.geo.originLon })}
                    {s.geo.rotationDeg ? ` · ${s.geo.rotationDeg}°` : ''}
                  </p>
                </div>
              )}
            </div>
            <ZonesPanel onZoom={zoomTo} />
            <button className="btn-ghost" onClick={fitSite} title={t('Show the whole site')} aria-label={t('Show the whole site')}>
              <LocateFixed size={16} />
            </button>
          </div>
          <RouteDraftPanel />
          {noFix.length > 0 && (
            <div className="map-nofix" role="status">
              <SatelliteDish size={14} />
              {noFix.map((d) => d.id).join(', ')} · {t('no GNSS fix: not shown on the map')}
            </div>
          )}
        </>
      )}
    </div>
  );
}
