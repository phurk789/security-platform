// The main map: real imagery on the shared standard map (globe, basemaps, orbit), with the site's
// live devices, trails, incidents, geofences and mission routes on top. Server-connected consoles
// only (the offline demo keeps the drawn twin, which needs no internet).
import 'maplibre-gl/dist/maplibre-gl.css';
import './realmap.css';
import { useEffect, useRef, useState } from 'react';
import maplibregl, { type Map as MlMap, type MapLayerMouseEvent } from 'maplibre-gl';
import { Layers as LayersIcon, LocateFixed, SatelliteDish } from 'lucide-react';
import { GEOFENCE_KIND_LABEL, SITE, fmtLatLon, type AppState, type Layers as LayerState } from '@13store/shared';
import { freshness } from '../domain/policy';
import { useStore } from '../store';
import { useT } from '../i18n';
import { createStandardMap, SITE_ZOOM, type StandardMap } from '../lib/standardMap';
import { CLICKABLE, buildOverlayData, devicePositions, ensureOperationalLayers, lngLat, updateOverlayData, type OverlayInput } from '../lib/overlays';
import { addMapImages } from '../lib/mapImages';
import { registerBasemaps, type Basemap } from '../lib/basemaps';

const TRAILS_KEY = 'ps-map-trails';
const PLAN_KEY = 'ps-map-plan';
/** Overlay redraws at most this often (telemetry and the clock change the state many times a second). */
const REDRAW_MS = 250;

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

function overlayInput(s: AppState, showTrails: boolean, showPlan: boolean): OverlayInput {
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
  };
}

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
  const latest = useRef({ s, showTrails, showPlan, dispatch, t, session });
  latest.current = { s, showTrails, showPlan, dispatch, t, session };

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
    for (const id of CLICKABLE.device) on('click', id, (e) => e.features?.[0] && latest.current.dispatch({ type: 'selectDevice', id: String(e.features[0].properties.id) }));
    for (const id of CLICKABLE.incident) on('click', id, (e) => e.features?.[0] && latest.current.dispatch({ type: 'selectIncident', id: String(e.features[0].properties.id) }));
    for (const id of CLICKABLE.geofence)
      on('click', id, (e) => {
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
      const { s: cur, showTrails: tr, showPlan: pl } = latest.current;
      if (map) updateOverlayData(map, buildOverlayData(overlayInput(cur, tr, pl)));
    }, REDRAW_MS);
  }, [ready, s, showTrails, showPlan]);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
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
      <div ref={el} className="map-real-canvas" aria-label={t('Live map of {site}', { site: SITE.name })} role="region" />
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
            <button className="btn-ghost" onClick={fitSite} title={t('Show the whole site')} aria-label={t('Show the whole site')}>
              <LocateFixed size={16} />
            </button>
          </div>
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
