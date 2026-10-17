import { useEffect, useMemo, useRef, useState, type JSX, type PointerEvent as RPointerEvent, type WheelEvent as RWheelEvent } from 'react';
import { Bot, Building2, Cctv, Drone, Layers, LocateFixed, Minus, Plus, Search, TriangleAlert, X } from 'lucide-react';
import { BUILDINGS, FENCE_Y, FLOOR_PLANS, GATE, PARKING, PLAZA, ROAD, SITE, ZONES, floorPlan, floorPlansOf, type FloorPlan } from '@13store/shared';
import { freshness, ageMs } from '../domain/policy';
import { missionForIncident } from '../domain/reducer';
import type { AppState, Device, Layers as LayerState, Point } from '@13store/shared';
import { useStore } from '../store';
import { Twin3D, type Twin3DApi, type ViewInfo } from './Twin3D';
import { webglAvailable } from '../twin/world';
import { setQuality, useQuality } from '../twin/quality';
import { ago, tr, useT } from '../i18n';

// --- projection ------------------------------------------------------------
// 2D: top-down site grid. 3D: oblique view from the south-west using the same
// coordinates, so a selection stays put when switching modes (PRD F01).

type Proj = (x: number, y: number, z?: number) => [number, number];
const P2: Proj = (x, y) => [x, y];
const K = 0.74;
const P3: Proj = (x, y, z = 0) => [x + z * 0.35, y * K - z * 0.9];
const VB = { '2d': '-6 -6 440 302', '3d': '-6 -46 476 268' } as const;

function rng(seed: number) {
  return () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

function inBlocked(x: number, y: number) {
  const pad = 6;
  if (BUILDINGS.some((b) => x > b.x - pad && x < b.x + b.w + pad && y > b.y - pad && y < b.y + b.d + pad)) return true;
  if (x > PARKING.x - 4 && x < PARKING.x + PARKING.w + 4 && y > PARKING.y - 4 && y < PARKING.y + PARKING.d + 4) return true;
  if (Math.hypot(x - PLAZA.cx, y - PLAZA.cy) < PLAZA.r + 8) return true;
  if (y > FENCE_Y - 8 && y < ROAD.y + ROAD.h + 4) return true;
  if (Math.abs(x - 244) < 8 && y < FENCE_Y) return true; // central walkway
  return false;
}

const TREES: Point[] = (() => {
  const r = rng(7);
  const out: Point[] = [];
  while (out.length < 90) {
    const x = 10 + r() * 400;
    const y = 8 + r() * 280;
    if (!inBlocked(x, y)) out.push({ x, y });
  }
  return out.sort((a, b) => a.y - b.y);
})();

// Deterministic lit-window pattern per building.
const LIT = BUILDINGS.map((_b, i) => {
  const r = rng(31 + i * 13);
  return Array.from({ length: 64 }, () => r() > 0.55);
});

export function TwinMap() {
  const { s, dispatch } = useStore();
  const t = useT();
  const mode = s.mapMode;
  const P = mode === '3d' ? P3 : P2;
  const [zoom, setZoom] = useState(1.1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const [layersOpen, setLayersOpen] = useState(false);
  const ivKey = s.indoorView ? `${s.indoorView.buildingId}:${s.indoorView.level}` : '';
  useEffect(() => {
    if (!ivKey) return;
    const b = BUILDINGS.find((x) => x.id === s.indoorView!.buildingId);
    if (!b) return;
    setZoom(2.6);
    setPan([SITE.width / 2 - (b.x + b.w / 2), SITE.height / 2 - (b.y + b.d / 2)]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ivKey]);
  const quality = useQuality();
  const drag = useRef<{ x: number; y: number; pan: [number, number] } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const api3d = useRef<Twin3DApi>(null);
  const [heading, setHeading] = useState(0);
  const [view, setView] = useState<ViewInfo | null>(null);
  const gl = mode === '3d' && webglAvailable();
  const goTo = (p: Point, z = 1.8) => {
    if (gl) return api3d.current?.lookAt(p);
    setZoom(z);
    setPan([SITE.width / 2 - p.x, mode === '3d' ? (SITE.height / 2 - p.y) * K : SITE.height / 2 - p.y]);
  };

  const replay = s.replay.active;
  const at = replay ? s.replay.at : s.now;
  const selInc = s.incidents.find((i) => i.id === s.selectedIncidentId);
  const mission = selInc ? missionForIncident(s, selInc.id) : undefined;

  const positions = useMemo(() => devicePositions(s, at), [s, at]);
  const visibleIncidents = s.incidents.filter((i) => (i.createdAt <= at && !['closed', 'duplicate', 'dismissed'].includes(i.status)) || i.id === s.selectedIncidentId);

  const onWheel = (e: RWheelEvent) => {
    setZoom((z) => Math.min(3, Math.max(0.7, z * (e.deltaY > 0 ? 0.9 : 1.1))));
  };
  const onDown = (e: RPointerEvent) => {
    if ((e.target as Element).closest('[data-hit]')) return;
    drag.current = { x: e.clientX, y: e.clientY, pan };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag.current || !svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const unit = (mode === '3d' ? 476 : 440) / rect.width;
    setPan([drag.current.pan[0] + ((e.clientX - drag.current.x) * unit) / zoom, drag.current.pan[1] + ((e.clientY - drag.current.y) * unit) / zoom]);
  };
  const onUp = () => (drag.current = null);

  const [cx, cy] = P(SITE.width / 2, SITE.height / 2);
  const tf = `translate(${cx} ${cy}) scale(${zoom}) translate(${-cx + pan[0]} ${-cy + pan[1]})`;
  const L = s.layers;

  return (
    <div className={`map map-${mode}${replay ? ' replay' : ''}${gl ? ' map-gl' : ''}${L.labels ? '' : ' no-labels'}`}>
      {gl ? (
        <Twin3D ref={api3d} onHeading={setHeading} onView={setView} />
      ) : (
        <svg
          ref={svgRef}
          viewBox={VB[mode]}
          preserveAspectRatio="xMidYMid meet"
          onWheel={onWheel}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          role="img"
          aria-label={t('{site} digital twin, {mode} view', { site: SITE.name, mode: mode.toUpperCase() })}
        >
          <defs>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="2.2" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g transform={tf} key={mode}>
            <Ground P={P} />
            {L.zones && <ZonesLayer P={P} selZone={selInc?.zone} />}
            {mode === '2d' ? TREES.map((t, i) => <circle key={i} cx={t.x} cy={t.y} r={4} className="tree" />) : null}
            {(mode === '2d' || !L.buildings) &&
              BUILDINGS.map((b) => (
                <rect
                  key={b.id}
                  x={b.x}
                  y={b.y}
                  width={b.w}
                  height={b.d}
                  className={`bld-2d click${s.selectedBuildingId === b.id ? ' sel' : ''}${L.buildings ? '' : ' ghost'}`}
                  rx={1}
                  onClick={() => dispatch({ type: 'selectBuilding', id: b.id })}
                />
              ))}
            {mode === '3d' && L.buildings && <Buildings3D trees />}
            {L.poi && <PoiLayer P={P} />}
            {mode === '2d' && s.indoorView && <FloorPlanLayer P={P} plan={floorPlan(s.indoorView.buildingId, s.indoorView.level)} />}
            {mode === '2d' && BUILDINGS.filter((b) => b.id !== s.indoorView?.buildingId).map((b) => <BuildingLabel key={b.id} P={P} b={b} />)}
            {L.routes && mission && !['cancelled', 'rejected', 'completed'].includes(mission.status) && (
              <Route
                P={P}
                pts={[positions[mission.deviceId] ?? s.devices[mission.deviceId].pos, ...mission.checkpoints.slice(mission.nextCp)]}
                cps={mission.checkpoints}
                next={mission.nextCp}
                draft={mission.approvedVersion !== mission.planVersion}
              />
            )}
            {Object.values(s.devices).map((d) =>
              show(L, d) ? (
                <DeviceMarker
                  key={d.id}
                  d={d}
                  k={1 / Math.max(1, zoom)}
                  pos={positions[d.id] ?? d.pos}
                  P={P}
                  s={s}
                  replay={replay}
                  selected={s.selectedDeviceId === d.id}
                  onClick={() => dispatch({ type: 'selectDevice', id: d.id })}
                />
              ) : null,
            )}
            {visibleIncidents.map((i) => {
              const [x, y] = P(i.pos.x, i.pos.y);
              const sel = i.id === s.selectedIncidentId;
              const tone = i.status === 'new' || i.status === 'triaging' ? 'amber' : i.severity === 'high' ? 'red' : 'cyan';
              return (
                <g
                  key={i.id}
                  data-hit
                  className={`inc inc-${tone}${sel ? ' sel' : ''}`}
                  onClick={() => dispatch({ type: 'selectIncident', id: i.id })}
                  transform={`translate(${x} ${y}) scale(${1 / Math.max(1, zoom)})`}
                >
                  {sel && <circle r={13} className="inc-pulse" />}
                  <circle r={7} className="inc-dot" />
                  <text y={3} textAnchor="middle" className="inc-mark">
                    !
                  </text>
                  {(sel || mode === '2d') && (
                    <g transform={sel ? 'translate(-37 -36)' : 'translate(10 -22)'}>
                      <rect width={sel ? 74 : 40} height={sel ? 22 : 12} rx={3} className="inc-callout" />
                      <text x={5} y={sel ? 9 : 8.5} className="inc-id">
                        {i.id}
                      </text>
                      {sel && (
                        <text x={5} y={18} className="inc-title">
                          {i.title}
                        </text>
                      )}
                    </g>
                  )}
                </g>
              );
            })}
          </g>
        </svg>
      )}

      {s.indoorView && (
        <div className="seg indoor-seg indoor-bar" role="group" aria-label={t('Floor plan')}>
          <span className="indoor-name">{t(BUILDINGS.find((b) => b.id === s.indoorView!.buildingId)?.name ?? s.indoorView.buildingId)}</span>
          {floorPlansOf(s.indoorView.buildingId).map((pl) => (
            <button
              key={pl.level}
              className={pl.level === s.indoorView!.level ? 'on' : ''}
              onClick={() => dispatch({ type: 'setIndoor', view: { buildingId: s.indoorView!.buildingId, level: pl.level } })}
            >
              L{pl.level}
            </button>
          ))}
          <button aria-label={t('Close floor plan')} onClick={() => dispatch({ type: 'setIndoor', view: null })}>
            ×
          </button>
        </div>
      )}
      <div className="map-tools">
        <MapSearch onGo={goTo} />
        <div className="seg" role="group" aria-label={t('Map view')}>
          <button className={mode === '2d' ? 'on' : ''} onClick={() => dispatch({ type: 'setMapMode', mode: '2d' })}>
            2D
          </button>
          <button className={mode === '3d' ? 'on' : ''} onClick={() => dispatch({ type: 'setMapMode', mode: '3d' })}>
            3D
          </button>
        </div>
        <div className="layers">
          <button className="btn-ghost" onClick={() => setLayersOpen((o) => !o)} aria-expanded={layersOpen}>
            <Layers size={16} /> {t('Layers')}
          </button>
          {layersOpen && (
            <div className="pop">
              {(['buildings', 'traffic', 'cctv', 'ugv', 'uav', 'routes', 'poi', 'zones', 'labels', 'accuracy'] as (keyof LayerState)[]).map((k) => (
                <label key={k}>
                  <input type="checkbox" checked={L[k] !== false} onChange={() => dispatch({ type: 'toggleLayer', layer: k })} />
                  {t(
                    {
                      buildings: 'Buildings',
                      traffic: 'Roads & traffic',
                      cctv: 'CCTV',
                      ugv: 'UGV',
                      uav: 'UAV',
                      routes: 'Mission routes',
                      poi: 'POI (entrances, hydrants)',
                      zones: 'Safety zones',
                      labels: 'Labels',
                      accuracy: 'Position accuracy',
                    }[k],
                  )}
                </label>
              ))}
              <hr />
              <label>
                <input type="checkbox" checked={quality === 'high'} onChange={() => setQuality(quality === 'high' ? 'low' : 'high')} />
                {t('High quality 3D (bloom, reflections)')}
              </label>
              <p className="pop-h">{t('Click a building for its BIM data')}</p>
            </div>
          )}
        </div>
      </div>

      <div className="zoom">
        <button aria-label={t('Zoom in')} onClick={() => (gl ? api3d.current?.zoom(0.7) : setZoom((z) => Math.min(3, z * 1.25)))}>
          <Plus size={18} />
        </button>
        <button aria-label={t('Zoom out')} onClick={() => (gl ? api3d.current?.zoom(1.4) : setZoom((z) => Math.max(0.7, z / 1.25)))}>
          <Minus size={18} />
        </button>
        <button
          aria-label={t('Center on selection')}
          onClick={() => {
            if (gl) return api3d.current?.focusSelection();
            const target = selInc?.pos;
            setZoom(target ? 1.6 : 1.1);
            setPan(target ? [SITE.width / 2 - target.x, mode === '3d' ? (SITE.height / 2 - target.y) * K : SITE.height / 2 - target.y] : [0, 0]);
          }}
        >
          <LocateFixed size={18} />
        </button>
      </div>
      <div className="compass" aria-hidden style={gl ? { transform: `rotate(${heading}deg)` } : undefined}>
        <span>N</span>
        <svg viewBox="0 0 20 20" width="18" height="18">
          <path d="M10 2 L15 17 L10 13 L5 17 Z" fill="currentColor" />
        </svg>
      </div>
      <Minimap view={gl ? view : null} zoom={zoom} pan={pan} mode={mode} positions={positions} incidents={visibleIncidents} onGo={goTo} />
      <div className="map-source">
        {t('Site model: placeholder geometry')} · {SITE.crs}
      </div>
    </div>
  );
}

// --- search ------------------------------------------------------------------

interface Hit {
  kind: 'device' | 'building' | 'incident' | 'room';
  id: string;
  title: string;
  sub: string;
  pos: Point;
  go: () => void;
}

function MapSearch({ onGo }: { onGo: (p: Point) => void }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const needle = q.trim().toLowerCase();
  const hits: Hit[] = [];
  if (needle) {
    const match = (...xs: (string | undefined)[]) => xs.some((x) => x && x.toLowerCase().includes(needle));
    for (const d of Object.values(s.devices))
      if (match(d.id, d.model, d.catalogId, d.zone, t(d.kind.toUpperCase())))
        hits.push({
          kind: 'device',
          id: d.id,
          title: d.id,
          sub: `${d.kind.toUpperCase()} · ${d.catalogId ?? d.model}`,
          pos: d.pos,
          go: () => dispatch({ type: 'selectDevice', id: d.id }),
        });
    for (const b of BUILDINGS)
      if (match(b.id, b.name, t(b.name), b.use, t(b.use), ...b.bim.assets))
        hits.push({
          kind: 'building',
          id: b.id,
          title: `${t(b.name)} (${b.id})`,
          sub: t(b.use),
          pos: { x: b.x + b.w / 2, y: b.y + b.d / 2 },
          go: () => dispatch({ type: 'selectBuilding', id: b.id }),
        });
    for (const i of s.incidents)
      if (match(i.id, i.title, i.place, i.zone))
        hits.push({ kind: 'incident', id: i.id, title: i.id, sub: i.title, pos: i.pos, go: () => dispatch({ type: 'selectIncident', id: i.id }) });
    for (const pl of FLOOR_PLANS)
      for (const r of pl.rooms)
        if (match(r.name, t(r.name.replace(/ \d+\.\d+$/, '')))) {
          const c = r.poly.reduce((a, p) => ({ x: a.x + p.x / r.poly.length, y: a.y + p.y / r.poly.length }), { x: 0, y: 0 });
          hits.push({
            kind: 'room',
            id: r.id,
            title: r.name,
            sub: `${t(BUILDINGS.find((b) => b.id === pl.buildingId)?.name ?? pl.buildingId)} · L${pl.level}`,
            pos: c,
            go: () => {
              dispatch({ type: 'selectBuilding', id: pl.buildingId });
              dispatch({ type: 'setIndoor', view: { buildingId: pl.buildingId, level: pl.level } });
            },
          });
        }
  }
  // best matches first: title starts with the query, then title contains it, then other fields
  hits.sort((a, b) => rank(a, needle) - rank(b, needle));
  const pick = (h: Hit) => {
    h.go();
    onGo(h.pos);
    setQ('');
    setOpen(false);
  };
  const Icon = { device: Bot, building: Building2, incident: TriangleAlert, room: Layers } as const;
  return (
    <div className={`map-search${q ? ' has-q' : ''}`}>
      <Search size={15} />
      <input
        type="search"
        value={q}
        placeholder={t('Search devices, buildings, rooms…')}
        aria-label={t('Search the map')}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && hits[0]) pick(hits[0]);
          if (e.key === 'Escape') {
            setQ('');
            setOpen(false);
          }
        }}
      />
      {q && (
        <button className="ms-clear" aria-label={t('Clear')} onMouseDown={(e) => e.preventDefault()} onClick={() => setQ('')}>
          <X size={13} />
        </button>
      )}
      {open && needle && (
        <div className="pop ms-pop">
          {hits.slice(0, 8).map((h) => {
            const I = Icon[h.kind];
            return (
              <button key={`${h.kind}:${h.id}`} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(h)}>
                <I size={14} /> <span className="ms-t">{h.title}</span>
                <small>{h.sub}</small>
              </button>
            );
          })}
          {!hits.length && <p className="pop-h">{t('No matches')}</p>}
        </div>
      )}
    </div>
  );
}

function rank(h: Hit, needle: string) {
  const t = h.title.toLowerCase();
  const id = h.id.toLowerCase();
  if (t.startsWith(needle) || id.startsWith(needle)) return 0;
  if (t.includes(needle) || id.includes(needle)) return 1;
  return 2;
}

// --- points of interest (2D) ---------------------------------------------------

function PoiLayer({ P }: { P: Proj }) {
  return (
    <g className="poi">
      {BUILDINGS.map((b) => (
        <g key={b.id}>
          {b.bim.entrances.map((e) => {
            const [x, y] = P(e.x, e.y);
            return (
              <circle key={e.id} cx={x} cy={y} r={2.4} className={`poi-e k-${e.kind}`}>
                <title>{e.name}</title>
              </circle>
            );
          })}
          {b.bim.hydrants.map((h, i) => {
            const [x, y] = P(h.x, h.y);
            return <rect key={i} x={x - 1.6} y={y - 1.6} width={3.2} height={3.2} className="poi-h" />;
          })}
        </g>
      ))}
    </g>
  );
}

// --- minimap -------------------------------------------------------------------

function Minimap({
  view,
  zoom,
  pan,
  mode,
  positions,
  incidents,
  onGo,
}: {
  view: ViewInfo | null;
  zoom: number;
  pan: [number, number];
  mode: '2d' | '3d';
  positions: Record<string, Point>;
  incidents: { id: string; pos: Point }[];
  onGo: (p: Point) => void;
}) {
  const { s } = useStore();
  const t = useT();
  const W = SITE.width;
  const H = SITE.height;
  // visible area: a view wedge from the 3D camera, or the 2D viewport rectangle
  let shape: JSX.Element | null = null;
  if (view) {
    const dx = view.target.x - view.from.x;
    const dy = view.target.y - view.from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const half = Math.tan((36 / 2) * (Math.PI / 180)) * 1.25;
    const reach = Math.max(60, Math.min(len * 2.2, 700));
    const a = { x: view.from.x, y: view.from.y };
    const b = { x: a.x + (ux - uy * half) * reach, y: a.y + (uy + ux * half) * reach };
    const c = { x: a.x + (ux + uy * half) * reach, y: a.y + (uy - ux * half) * reach };
    shape = (
      <>
        <polygon points={`${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y}`} className="mm-wedge" />
        <circle cx={view.target.x} cy={view.target.y} r={5} className="mm-focus" />
      </>
    );
  } else {
    const vw = (mode === '3d' ? 476 : 440) / zoom;
    const vh = (mode === '3d' ? 268 / K : 302) / zoom;
    const cx = W / 2 - pan[0];
    const cy = H / 2 - (mode === '3d' ? pan[1] / K : pan[1]);
    shape = <rect x={cx - vw / 2} y={cy - vh / 2} width={vw} height={vh} className="mm-rect" />;
  }
  const click = (e: React.MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    onGo({ x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H });
  };
  return (
    <div className="minimap" title={t('Click to look there')}>
      <svg viewBox={`0 0 ${W} ${H}`} onClick={click} role="img" aria-label={t('Minimap')}>
        <rect x={0} y={0} width={W} height={H} className="mm-ground" />
        <rect x={0} y={ROAD.y} width={W} height={ROAD.h} className="mm-road" />
        <rect x={PARKING.x} y={PARKING.y} width={PARKING.w} height={PARKING.d} className="mm-lot" />
        {ZONES.map((z) => (
          <polygon key={z.id} points={z.poly.map((p) => p.join(',')).join(' ')} className="mm-zone" />
        ))}
        {BUILDINGS.map((b) => (
          <rect key={b.id} x={b.x} y={b.y} width={b.w} height={b.d} className={`mm-bld${s.selectedBuildingId === b.id ? ' sel' : ''}`} />
        ))}
        {shape}
        {Object.values(s.devices).map((d) => {
          const p = positions[d.id] ?? d.pos;
          return <circle key={d.id} cx={p.x} cy={p.y} r={s.selectedDeviceId === d.id ? 5 : 3.2} className={`mm-dev k-${d.kind}${s.selectedDeviceId === d.id ? ' sel' : ''}`} />;
        })}
        {incidents.map((i) => (
          <circle key={i.id} cx={i.pos.x} cy={i.pos.y} r={s.selectedIncidentId === i.id ? 5 : 3.2} className={`mm-inc${s.selectedIncidentId === i.id ? ' sel' : ''}`} />
        ))}
      </svg>
    </div>
  );
}

function show(L: LayerState, d: Device) {
  return L[d.kind];
}

/** Positions at the given time — from recorded telemetry when replaying. */
function devicePositions(s: AppState, at: number): Record<string, Point> {
  if (!s.replay.active) return Object.fromEntries(Object.values(s.devices).map((d) => [d.id, d.pos]));
  const out: Record<string, Point> = {};
  for (const d of Object.values(s.devices)) {
    let p: Point | undefined;
    for (const t of s.telemetry) {
      if (t.deviceId !== d.id) continue;
      if (t.at > at) break;
      p = { x: t.x, y: t.y };
    }
    out[d.id] = p ?? (d.kind === 'ugv' ? { x: 214, y: 218 } : d.pos);
  }
  return out;
}

function poly(P: Proj, pts: [number, number][], z = 0) {
  return pts.map(([x, y]) => P(x, y, z).join(',')).join(' ');
}

function rectPts(x: number, y: number, w: number, d: number): [number, number][] {
  return [
    [x, y],
    [x + w, y],
    [x + w, y + d],
    [x, y + d],
  ];
}

/** Indoor view: walls, rooms, doors, stairs and lifts of one floor, drawn over the building footprint. */
function FloorPlanLayer({ P, plan }: { P: Proj; plan?: FloorPlan }) {
  const t = useT();
  if (!plan) return null;
  const pts = (poly: Point[]) => poly.map((p) => P(p.x, p.y).join(',')).join(' ');
  const centre = (poly: Point[]) => {
    const c = poly.reduce((a, p) => ({ x: a.x + p.x / poly.length, y: a.y + p.y / poly.length }), { x: 0, y: 0 });
    return P(c.x, c.y);
  };
  return (
    <g className="floorplan">
      {plan.rooms.map((r) => {
        const [cx, cy] = centre(r.poly);
        const corridor = r.name === 'Corridor';
        return (
          <g key={r.id}>
            <polygon points={pts(r.poly)} className={corridor ? 'fp-corr' : 'fp-room'} />
            {!corridor && (
              <text x={cx} y={cy} className="fp-label" textAnchor="middle">
                {t(r.name.replace(/ \d+\.\d+$/, ''))}
                {r.name.match(/ (\d+\.\d+)$/)?.[0] ?? ''}
              </text>
            )}
          </g>
        );
      })}
      {plan.noGo.map((r) => {
        const [cx, cy] = centre(r.poly);
        return (
          <g key={r.id}>
            <polygon points={pts(r.poly)} className="fp-nogo" />
            <text x={cx} y={cy} className="fp-label nogo" textAnchor="middle">
              {t(r.name)}
            </text>
          </g>
        );
      })}
      {plan.walls.map((w, i) => {
        const [x1, y1] = P(w.a.x, w.a.y);
        const [x2, y2] = P(w.b.x, w.b.y);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} className={`fp-wall ${w.kind ?? 'interior'}`} />;
      })}
      {plan.doors.map((d) => {
        const [x, y] = P(d.at.x, d.at.y);
        return <circle key={d.id} cx={x} cy={y} r={d.kind === 'door' ? 0.7 : 1} className={`fp-door k-${d.kind}`} />;
      })}
    </g>
  );
}

function Ground({ P }: { P: Proj }) {
  const stalls = Array.from({ length: 13 }, (_, i) => PARKING.x + 4 + i * 8);
  return (
    <g>
      <polygon points={poly(P, rectPts(0, 0, SITE.width, SITE.height))} className="ground" />
      <polygon points={poly(P, rectPts(0, ROAD.y, SITE.width, ROAD.h))} className="road" />
      <line {...xy(P, 0, ROAD.y + ROAD.h / 2, SITE.width, ROAD.y + ROAD.h / 2)} className="road-line" />
      <polygon points={poly(P, rectPts(GATE.x, FENCE_Y, GATE.w, ROAD.y - FENCE_Y))} className="paving" />
      <polygon points={poly(P, rectPts(240, 16, 8, FENCE_Y - 16))} className="paving" />
      <polygon points={poly(P, rectPts(20, 116, 380, 8))} className="paving" />
      <polygon points={poly(P, rectPts(PARKING.x, PARKING.y, PARKING.w, PARKING.d))} className="parking" />
      {stalls.map((x) => (
        <line key={x} {...xy(P, x, PARKING.y, x, PARKING.y + 12)} className="stall" />
      ))}
      {stalls.map((x) => (
        <line key={`b${x}`} {...xy(P, x, PARKING.y + PARKING.d - 12, x, PARKING.y + PARKING.d)} className="stall" />
      ))}
      <ellipse cx={P(PLAZA.cx, PLAZA.cy)[0]} cy={P(PLAZA.cx, PLAZA.cy)[1]} rx={PLAZA.r} ry={P === P3 ? PLAZA.r * K : PLAZA.r} className="plaza" />
      <ellipse cx={P(PLAZA.cx, PLAZA.cy)[0]} cy={P(PLAZA.cx, PLAZA.cy)[1]} rx={8} ry={P === P3 ? 8 * K : 8} className="plaza-core" />
      {/* perimeter fence with the service gate gap */}
      <line {...xy(P, 6, FENCE_Y, GATE.x, FENCE_Y)} className="fence" />
      <line {...xy(P, GATE.x + GATE.w, FENCE_Y, SITE.width - 6, FENCE_Y)} className="fence" />
      <line {...xy(P, GATE.x, FENCE_Y, GATE.x + GATE.w, FENCE_Y)} className="gate-bar" />
      <polygon points={poly(P, rectPts(GATE.x + GATE.w + 2, FENCE_Y - 10, 8, 8))} className="booth" />
    </g>
  );
}

function xy(P: Proj, x1: number, y1: number, x2: number, y2: number) {
  const [a, b] = P(x1, y1);
  const [c, d] = P(x2, y2);
  return { x1: a, y1: b, x2: c, y2: d };
}

function ZonesLayer({ P, selZone }: { P: Proj; selZone?: string }) {
  return (
    <g>
      {ZONES.map((z) => {
        const [lx, ly] = P(z.label[0], z.label[1], P === P3 ? 30 : 0);
        const sel = selZone === z.name;
        return (
          <g key={z.id} className={`zone${sel ? ' sel' : ''}`}>
            <polygon points={poly(P, z.poly)} />
            <g transform={`translate(${lx} ${ly})`}>
              <rect x={-20} y={-8} width={40} height={14} rx={3} className="chip" />
              <text textAnchor="middle" y={2.5} className="chip-t">
                {z.name}
              </text>
            </g>
          </g>
        );
      })}
    </g>
  );
}

function BuildingLabel({ P, b }: { P: Proj; b: (typeof BUILDINGS)[number] }) {
  const [x, y] = P(b.x + b.w / 2, b.y + b.d / 2, P === P3 ? b.h + 6 : 0);
  return (
    <g transform={`translate(${x} ${y})`} className="bld-label">
      <rect x={-27} y={-10} width={54} height={20} rx={3} />
      <text textAnchor="middle" y={-1.5} className="t1">
        {b.name}
      </text>
      <text textAnchor="middle" y={6.5} className="t2">
        {b.use}
      </text>
    </g>
  );
}

function Buildings3D({ trees }: { trees?: boolean }) {
  type Item = { key: string; depth: number; el: JSX.Element };
  const items: Item[] = [];
  const P = P3;
  BUILDINGS.forEach((b, bi) => {
    const { x, y, w, d, h } = b;
    const top = poly(P, rectPts(x, y, w, d), h);
    const south = [P(x, y + d), P(x + w, y + d), P(x + w, y + d, h), P(x, y + d, h)].map((p) => p.join(',')).join(' ');
    const west = [P(x, y), P(x, y + d), P(x, y + d, h), P(x, y, h)].map((p) => p.join(',')).join(' ');
    const floors = Math.max(2, Math.round(h / 4.5));
    const cols = Math.round(w / 7);
    const lit = LIT[bi];
    const windows: JSX.Element[] = [];
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        const wx = x + 3 + c * ((w - 6) / cols);
        const z = 2.5 + f * ((h - 4) / floors);
        const [px, py] = P(wx, y + d, z + 2);
        windows.push(<rect key={`${f}-${c}`} x={px} y={py} width={(w - 6) / cols - 2} height={1.8} className={lit[(f * cols + c) % 64] ? 'win lit' : 'win'} />);
      }
    }
    // roof details
    const [rx, ry] = P(x + w * 0.3, y + d * 0.35, h);
    items.push({
      key: b.id,
      depth: y + d - x * 0.15,
      el: (
        <g key={b.id} className="bld">
          <polygon points={west} className="bld-w" />
          <polygon points={south} className="bld-s" />
          {windows}
          <polygon points={top} className="bld-t" />
          <rect x={rx} y={ry} width={w * 0.25} height={d * 0.2 * K} className="roof-unit" />
          <BuildingLabel P={P} b={b} />
        </g>
      ),
    });
  });
  if (trees) {
    TREES.forEach((t, i) => {
      const [gx, gy] = P(t.x, t.y);
      const [cx, cy] = P(t.x, t.y, 5);
      items.push({
        key: `t${i}`,
        depth: t.y - t.x * 0.15,
        el: (
          <g key={`t${i}`}>
            <ellipse cx={gx + 2} cy={gy} rx={4} ry={2} className="tree-shadow" />
            <circle cx={cx} cy={cy} r={4.2} className="tree" />
          </g>
        ),
      });
    });
  }
  items.sort((a, b) => a.depth - b.depth);
  return <g>{items.map((i) => i.el)}</g>;
}

function Route({ P, pts, cps, next, draft }: { P: Proj; pts: Point[]; cps: Point[]; next: number; draft: boolean }) {
  return (
    <g className={`route${draft ? ' draft' : ''}`}>
      <polyline points={pts.map((p) => P(p.x, p.y).join(',')).join(' ')} />
      {cps.map((p, i) => {
        const [x, y] = P(p.x, p.y);
        return (
          <g key={i} transform={`translate(${x} ${y})`} className={i < next ? 'cp done' : 'cp'}>
            <circle r={3.6} />
            <text y={1.6} textAnchor="middle">
              {i + 1}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function DeviceMarker({
  d,
  pos,
  P,
  s,
  selected,
  onClick,
  replay,
  k = 1,
}: {
  d: Device;
  pos: Point;
  P: Proj;
  s: AppState;
  selected: boolean;
  onClick: () => void;
  replay: boolean;
  /** Counter-scale so markers keep their screen size when the map is zoomed in. */ k?: number;
}) {
  const f = replay ? 'live' : freshness(s, d);
  const z = d.kind === 'uav' ? (P === P3 ? (d.alt ?? 0) : 0) : 0;
  const [gx, gy] = P(pos.x, pos.y);
  const [x, y] = P(pos.x, pos.y, z);
  const Icon = d.kind === 'cctv' ? Cctv : d.kind === 'ugv' ? Bot : Drone;
  const age = ageMs(s, d);
  const acc = d.accuracyM * (f === 'stale' ? 1 + age / 2000 : 1);
  const sim = d.integration === 'simulated';
  return (
    <g data-hit className={`dev dev-${d.kind} f-${f}${selected ? ' sel' : ''}`} onClick={onClick}>
      {s.layers.accuracy && d.kind !== 'cctv' && <ellipse cx={gx} cy={gy} rx={Math.max(3, acc * 2)} ry={Math.max(3, acc * 2) * (P === P3 ? K : 1)} className="acc" />}
      {z > 0 && <line x1={gx} y1={gy} x2={x} y2={y} className="tether" />}
      {z > 0 && <ellipse cx={gx} cy={gy} rx={4} ry={2} className="tree-shadow" />}
      <g className="dev-pos" style={{ transform: `translate(${x}px, ${y}px) scale(${k})` }}>
        <circle r={7.5} className="dev-ring" />
        <Icon x={-5} y={-5} width={10} height={10} className="dev-icon" strokeWidth={2} />
        <g transform="translate(10 -6)">
          <rect width={d.id.length * 4.6 + (sim ? 22 : 6)} height={12} rx={3} className="dev-chip" />
          <text x={3} y={8.6} className="dev-t">
            {d.id}
          </text>
          {sim && (
            <g transform={`translate(${d.id.length * 4.6 + 3} 2)`}>
              <rect width={17} height={8} rx={2} className="sim-chip" />
              <text x={8.5} y={6.1} textAnchor="middle" className="sim-t">
                SIM
              </text>
            </g>
          )}
        </g>
        {f !== 'live' && (
          <g transform="translate(-14 -16)">
            <TriangleAlert x={0} y={0} width={9} height={9} className={f === 'offline' ? 'warn-red' : 'warn-amber'} />
            <title>{tr('{id} telemetry {f}, last seen {ago}', { id: d.id, f: f.toUpperCase(), ago: ago(age) })}</title>
          </g>
        )}
      </g>
    </g>
  );
}
