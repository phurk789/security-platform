// Unified UGV & UAV Command Center: one screen to watch and run every ground and air unit.
// Left: searchable unit roster. Centre: one stage, map first or the cockpit (camera in front
// with a driving HUD), the other view inset. Right: original mission, driving, readiness and
// camera controls. Command authorization and lifecycle remain in the original components.
import { useMemo, useState } from 'react';
import { Activity, ArrowRight, Battery, Camera, ChevronRight, Crosshair, Drone, Gauge, History, ListChecks, MapPinned, Navigation, PanelLeftClose, PanelLeftOpen, Search, ShieldCheck, Signal, Gamepad2, Truck } from 'lucide-react';
import { PAYLOAD_CATALOG, VEHICLE_CATALOG, routeSpeedOf, runtimeLeftMin, type Device, type Mission } from '@13store/shared';
import { can, currentUser, fmtTime, freshness, userName } from '../domain/policy';
import { isTerminal } from '../domain/reducer';
import { useT, type T } from '../i18n';
import { useStore } from '../store';
import { CommandBadge, FreshBadge, IntegrationBadge, MissionBadge, ModeBadge } from '../components/Badges';
import { CameraControls } from '../components/CameraControls';
import { DrivePanel } from '../components/DrivePanel';
import { useVehicleThumb } from '../components/Hud';
import { LiveMission } from '../components/IncidentPanel';
import { UgvHardwareReadiness } from '../components/UgvHardwareReadiness';
import { showsReadiness } from '../domain/readiness';
import { CockpitStage, fmtDuration, remaining, type StageFocus } from './CockpitStage';
import { displayNumber, matchesUnit } from '../domain/liquidPresentation';

import './command-center.css';

const OPEN_MISSION = ['draft', 'pending_approval', 'approved', 'assigned', 'executing', 'paused'];
/** Folded or open unit list, per browser. */
const RAIL_KEY = 'ps.cc.rail';
/** Map first or the cockpit, per browser. */
const VIEW_KEY = 'ps.cc.view';

/** Liquid Glass workspace. Business actions below continue to use the original components.
 * Map and camera stay mounted while the stage swaps which one is in front.
 * DrivePanel is NEVER put inside a tab, details element or a keyed focus layout.
 */
export function CommandCenter() {
  const { s, dispatch, mode } = useStore();
  const t = useT();
  const [filter, setFilter] = useState<'all' | 'ugv' | 'uav'>('all');
  const [query, setQuery] = useState('');
  const [focus, setFocusState] = useState<StageFocus>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === 'cockpit' ? 'cockpit' : 'map';
    } catch {
      return 'map';
    }
  });
  const setFocus = (next: StageFocus) => {
    setFocusState(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* this page only */
    }
  };
  // The unit list folds into a slim rail of unit icons, giving the workspace the room (kept per browser).
  const [railOpen, setRailOpen] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) !== 'folded';
    } catch {
      return true;
    }
  });
  const toggleRail = () =>
    setRailOpen((open) => {
      try {
        localStorage.setItem(RAIL_KEY, open ? 'folded' : 'open');
      } catch {
        /* this page only */
      }
      return !open;
    });
  const units = Object.values(s.devices)
    .filter((d) => d.kind === 'ugv' || d.kind === 'uav')
    .sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'ugv' ? -1 : 1));
  const shown = units.filter((d) => (filter === 'all' || d.kind === filter) && matchesUnit(d, query));
  const selId = s.selectedDeviceId && units.some((u) => u.id === s.selectedDeviceId) ? s.selectedDeviceId : units[0]?.id;
  const d = selId ? s.devices[selId] : undefined;
  const m = d ? s.missions.find((x) => x.deviceId === d.id && OPEN_MISSION.includes(x.status)) : undefined;
  const liveCount = units.filter((u) => freshness(s, u) === 'live').length;
  const offlineCount = units.filter((u) => freshness(s, u) === 'offline').length;
  const count = (kind: 'ugv' | 'uav') => units.filter((u) => u.kind === kind).length;
  const canViewMedia = can(currentUser(s).role, 'media.view');
  // Render-time safety: a role change cannot leave an inaccessible video as the primary pane.
  const visibleFocus = canViewMedia ? focus : 'map';

  return (
    <div className={`cc cc-liquid${railOpen ? '' : ' rail-folded'}`}>
      <aside className={`panel cc-rail${railOpen ? '' : ' is-folded'}`} aria-label={t('Units')}>
        <div className="panel-head lg-roster-head">
          {railOpen && (
            <div>
              <span className="lg-eyebrow">OPERATIONS</span>
              <h2>{t('Units')}</h2>
            </div>
          )}
          <button
            type="button"
            className="lg-rail-toggle"
            onClick={toggleRail}
            aria-expanded={railOpen}
            aria-label={railOpen ? t('Fold the unit list') : t('Open the unit list')}
            title={railOpen ? t('Fold the unit list') : t('Open the unit list')}
          >
            {railOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
          </button>
        </div>
        {!railOpen && (
          <div className="lg-rail-mini" role="group" aria-label={t('Units')}>
            {units.map((unit) => (
              <MiniUnit key={unit.id} d={unit} selected={unit.id === selId} />
            ))}
          </div>
        )}
        {railOpen && (
          <>
        <div className="lg-fleet-counts" aria-label={t('Fleet status')}>
          <div><b>{units.length}</b><small>{t('All')}</small></div>
          <div><b>{liveCount}</b><small>{t('Online')}</small></div>
          <div><b>{offlineCount}</b><small>{t('Offline')}</small></div>
        </div>
        <label className="lg-search">
          <Search size={16} aria-hidden="true" />
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search units…')} aria-label={t('Search units…')} />
        </label>
        <div className="cc-filter seg" role="group" aria-label={t('Filter fleet')}>
          <button type="button" aria-pressed={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>{t('All')}</button>
          <button type="button" aria-pressed={filter === 'ugv'} className={filter === 'ugv' ? 'on' : ''} onClick={() => setFilter('ugv')}><Truck size={14} /> UGV {count('ugv')}</button>
          <button type="button" aria-pressed={filter === 'uav'} className={filter === 'uav' ? 'on' : ''} onClick={() => setFilter('uav')}><Drone size={14} /> UAV {count('uav')}</button>
        </div>
        <div className="cc-units">
          {shown.map((unit) => <LiquidUnitCard key={unit.id} d={unit} selected={unit.id === selId} />)}
          {!shown.length && <p className="empty">{t('No vehicles match the filter.')}</p>}
        </div>
        <div className="lg-roster-foot"><ShieldCheck size={18} /><span>{t('Control permissions are checked by the server.')}<small>PUBLIC SECURITY TWIN</small></span></div>
          </>
        )}
      </aside>

      {d ? (
        <>
          <section className="cc-main" aria-label={t('Mission workspace')}>
            <div className="lg-device-header panel">
              <DevicePortrait d={d} />
              <div className="lg-device-title"><span className="lg-eyebrow">MISSION WORKSPACE</span><h1>{d.id}</h1><p>{d.model}</p></div>
              <div className="lg-device-badges">
                {s.replay.active ? <span className="badge badge-grey"><History size={12} /> REPLAY</span> : <FreshBadge f={freshness(s, d)} />}
                <ModeBadge d={d} />
                <IntegrationBadge i={d.integration} />
              </div>
            </div>
            {s.replay.active && (
              <div className="lg-data-notice" role="status"><History size={16} /><b>REPLAY · {fmtTime(s.replay.at, true)}</b><span>{t('You are viewing past data. Device control is off.')}</span></div>
            )}
            <div className="lg-view-switch">
              <span><MapPinned size={15} /> {t('Operational view')}</span>
              <div className="seg" role="group" aria-label={t('Primary view')}>
                <button type="button" aria-pressed={visibleFocus === 'map'} className={visibleFocus === 'map' ? 'on' : ''} onClick={() => setFocus('map')}><MapPinned size={14} /> {t('Map first')}</button>
                <button type="button" disabled={!canViewMedia} aria-pressed={visibleFocus === 'cockpit'} className={visibleFocus === 'cockpit' ? 'on' : ''} onClick={() => setFocus('cockpit')}
                  title={canViewMedia ? t('Camera in front with a driving HUD') : t('Your role cannot view video. Ask a supervisor if you need access.')}><Gamepad2 size={14} /> {t('Cockpit')}</button>
              </div>
            </div>
            <CockpitStage d={d} m={m} focus={visibleFocus} onFocus={setFocus} canViewMedia={canViewMedia} />
          </section>

          <aside className="cc-side" aria-label={t('Mission control')}>
            {/* Keep driving controls mounted and visible. Never key this subtree by focus/theme. */}
            {mode === 'remote' && d.kind === 'ugv' && d.teleop && <DrivePanel d={d} />}
            <section className="panel cc-box lg-mission-box">
              <div className="panel-head"><div><span className="lg-eyebrow">MISSION CONTROL</span><h2><ListChecks size={17} />{t('Mission control')}</h2></div>{m && <MissionBadge status={m.status} />}</div>
              <div className="cc-box-body">{m && <MissionStrip d={d} m={m} />}<MissionControl d={d} m={m} /></div>
            </section>
            {showsReadiness(d) && <UgvHardwareReadiness device={d} />}
            {['gimbal', 'spotlight', 'beacon', 'speaker'].some((c) => d.capabilities.includes(c)) && (
              <section className="panel cc-box">
                <div className="panel-head"><h2><Camera size={17} />{d.payloads?.length ? t('Camera & 4-in-1 module') : t('Camera')}</h2></div>
                <div className="cc-box-body"><CameraControls device={d} aimAt={m ? { incidentId: m.incidentId } : undefined} /></div>
              </section>
            )}
            {d.catalogId && VEHICLE_CATALOG[d.catalogId] && (
              <details className="panel cc-box lg-disclosure"><summary>{t('Vehicle specifications')}<ChevronRight size={16} /></summary><div className="cc-box-body"><VehicleSpecs d={d} /></div></details>
            )}
            <section className="panel cc-box cc-log-box"><div className="panel-head"><h2><History size={17} />{t('Activity')}</h2></div><ActivityLog d={d} /></section>
          </aside>
        </>
      ) : (
        <section className="cc-main cc-empty panel"><Truck size={42} /><h2>{t('No ground or air units registered.')}</h2><button className="btn-primary" onClick={() => dispatch({ type: 'setView', view: 'devices' })}>{t('Open devices')}<ArrowRight size={16} /></button></section>
      )}
    </div>
  );
}

function DevicePortrait({ d }: { d: Device }) {
  const thumb = useVehicleThumb(d);
  const Icon = d.kind === 'uav' ? Drone : Truck;
  return <span className="lg-portrait">{thumb ? <img src={thumb} alt="" /> : <Icon size={32} aria-hidden="true" />}</span>;
}

function LiquidUnitCard({ d, selected }: { d: Device; selected: boolean }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const f = freshness(s, d);
  const usable = s.replay.active || f === 'live';
  return (
    <button type="button" className={`lg-unit${selected ? ' is-selected' : ''}`} aria-pressed={selected}
      aria-label={t('Select unit {id}', { id: d.id })} onClick={() => dispatch({ type: 'selectDevice', id: d.id })}>
      <div className="lg-unit-top"><DevicePortrait d={d} /><div><b>{d.id}</b><small>{d.kind.toUpperCase()}{d.integration === 'simulated' ? ' · SIMULATED' : ''}</small></div><ChevronRight size={16} /></div>
      <div className="lg-unit-status">{s.replay.active ? <span className="badge badge-grey">REPLAY</span> : <FreshBadge f={f} />}<ModeBadge d={d} /></div>
      <span className="lg-unit-model">{d.model}</span>
      <div className="lg-unit-numbers"><span><Battery size={14} />{displayNumber(usable ? d.battery : undefined, 0, 0, 100)} %</span><span><Gauge size={14} />{displayNumber(usable ? d.speed : undefined, 1, 0)} m/s</span><span><Signal size={14} />{displayNumber(usable ? d.signal : undefined, 0, 0, 100)} %</span></div>
    </button>
  );
}

/** A unit in the folded list: its picture, a dot for live / stale / offline, and its id. */
function MiniUnit({ d, selected }: { d: Device; selected: boolean }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const f = s.replay.active ? 'replay' : freshness(s, d);
  const battery = f === 'live' && d.battery !== undefined ? ` · ${Math.round(d.battery)}%` : '';
  return (
    <button
      type="button"
      className={`lg-mini${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      aria-label={t('Select unit {id}', { id: d.id })}
      title={`${d.id} · ${f.toUpperCase()}${battery}`}
      onClick={() => dispatch({ type: 'selectDevice', id: d.id })}
    >
      <span className="lg-mini-pic">
        <DevicePortrait d={d} />
        <i className={`lg-mini-dot f-${f}`} aria-hidden="true" />
      </span>
      <small>{d.id}</small>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Mission strip: unit, mission, incident, checkpoint progress, distance and ETA
// ---------------------------------------------------------------------------

function MissionStrip({ d, m }: { d: Device; m?: Mission }) {
  const { s, dispatch } = useStore();
  const t = useT();
  const inc = m ? s.incidents.find((i) => i.id === m.incidentId) : undefined;
  const Icon = d.kind === 'uav' ? Drone : Truck;
  const left = m ? remaining(d, m) : 0;
  const moving = m?.status === 'executing';
  // Live speed while moving, else the speed the vehicle drives routes at (its autopilot setting).
  const eta = moving ? left / Math.max(d.speed > 0.5 ? d.speed : routeSpeedOf(d), 0.3) : null;
  return (
    <div className="panel cc-strip">
      <span className={`fc-ico k-${d.kind}`}>
        <Icon size={18} />
      </span>
      <div className="cc-strip-id">
        <b>{d.id}</b>
        <small>{d.model}</small>
      </div>
      {m ? (
        <>
          <div className="cc-strip-m">
            <span className="mono">{m.id}</span> <MissionBadge status={m.status} />
            {inc && (
              <button
                className="link"
                onClick={() => {
                  dispatch({ type: 'selectIncident', id: inc.id });
                  dispatch({ type: 'setView', view: 'overview' });
                }}
              >
                {inc.id} · {inc.title} <ArrowRight size={12} />
              </button>
            )}
          </div>
          <ol className="cc-cps" aria-label={t('Checkpoints')}>
            {m.checkpoints.map((_, i) => (
              <li key={i} className={i < m.nextCp ? 'done' : i === m.nextCp && ['executing', 'paused'].includes(m.status) ? 'next' : ''}>
                <span>{i + 1}</span>
              </li>
            ))}
          </ol>
          <div className="cc-strip-num">
            <small>{t('Remaining')}</small>
            <b>{Math.round(left)} m</b>
          </div>
          <div className="cc-strip-num">
            <small>ETA</small>
            <b>{eta === null ? '—' : fmtDuration(eta)}</b>
          </div>
        </>
      ) : (
        <div className="cc-strip-m muted">
          {d.commands.length
            ? t('No active mission. Missions start from an incident and need a supervisor’s approval.')
            : t('Display and video only. This unit takes no commands.')}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mission control: the live-mission controls from the incident flow, or what is needed next
// ---------------------------------------------------------------------------

function MissionControl({ d, m }: { d: Device; m?: Mission }) {
  const { dispatch } = useStore();
  const t = useT();
  if (!d.commands.length) return <p className="muted">{t('{id} is display and video only. It takes no commands.', { id: d.id })}</p>;
  if (!m) {
    return (
      <div className="cc-next">
        <p className="muted">{t('No active mission. Missions start from an incident and need a supervisor’s approval.')}</p>
        <button className="btn-secondary wide" onClick={() => dispatch({ type: 'setView', view: 'missions' })}>
          <ListChecks size={16} /> {t('Open missions')}
        </button>
      </div>
    );
  }
  if (['assigned', 'executing', 'paused'].includes(m.status))
    return (
      <div className="cc-live">
        <LiveMission m={m} />
      </div>
    );
  return (
    <div className="cc-next">
      <p>{nextStep(m, t)}</p>
      <button
        className="btn-secondary wide"
        onClick={() => {
          dispatch({ type: 'selectIncident', id: m.incidentId });
          dispatch({ type: 'setView', view: 'overview' });
        }}
      >
        <Crosshair size={16} /> {t('Open {id}', { id: m.incidentId })}
      </button>
    </div>
  );
}

function nextStep(m: Mission, t: T) {
  switch (m.status) {
    case 'draft':
      return t('Draft route. The dispatcher submits it for approval.');
    case 'pending_approval':
      return t('Waiting for a supervisor to approve the route.');
    case 'approved':
      return t('Approved. The operator accepts the mission and takes control.');
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Activity: commands and events for this unit
// ---------------------------------------------------------------------------

function ActivityLog({ d }: { d: Device }) {
  const { s } = useStore();
  const t = useT();
  const rows = useMemo(() => {
    const cmds = s.commands.filter((c) => c.deviceId === d.id).map((c) => ({ at: c.issuedAt, key: c.id, kind: 'cmd' as const, c }));
    const evs = s.timeline.filter((e) => e.actor === d.id || e.title.includes(d.id)).map((e) => ({ at: e.at, key: e.id, kind: 'ev' as const, e }));
    return [...cmds, ...evs].sort((a, b) => b.at - a.at).slice(0, 12);
  }, [s.commands, s.timeline, d.id]);
  if (!rows.length) return <p className="empty">{t('No activity yet.')}</p>;
  return (
    <ul className="cc-log">
      {rows.map((r) =>
        r.kind === 'cmd' ? (
          <li key={r.key}>
            <span className="cc-log-t">{fmtTime(r.at, true)}</span>
            <span className="cc-log-i">
              <Navigation size={13} />
            </span>
            <span className="cc-log-x">
              <b>{t(r.c.type)}</b> · {s.users.some((u) => u.id === r.c.issuer) ? userName(s, r.c.issuer) : r.c.issuer}
              {!isTerminal(r.c) && <Activity size={12} className="spin-soft" />}
            </span>
            <CommandBadge status={r.c.status} />
          </li>
        ) : (
          <li key={r.key} className={r.e.tone ? `tone-${r.e.tone}` : ''}>
            <span className="cc-log-t">{fmtTime(r.at, true)}</span>
            <span className="cc-log-i">
              <Gauge size={13} />
            </span>
            <span className="cc-log-x">{r.e.title}</span>
          </li>
        ),
      )}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Vehicle specs from the catalogue (manufacturer ratings) and rated runtime left
// ---------------------------------------------------------------------------

export function VehicleSpecs({ d }: { d: Device }) {
  const t = useT();
  const m = VEHICLE_CATALOG[d.catalogId!];
  const left = runtimeLeftMin(d.catalogId, d.battery);
  const role = { patrol: t('Patrol'), recon: t('Reconnaissance'), transport: t('Transport') }[m.role];
  return (
    <div className="cc-specs">
      <div className="cc-spec-head">
        <b>{m.name}</b>
        <span className="cc-role">{role}</span>
      </div>
      <dl>
        <div>
          <dt>{t('Rated runtime left')}</dt>
          <dd>
            {left === null ? '—' : `≈ ${left} min`} <small>/ {m.enduranceMin} min</small>
          </dd>
        </div>
        <div>
          <dt>{t('Max speed')}</dt>
          <dd>{m.maxSpeedKmh} km/h</dd>
        </div>
        <div>
          <dt>{t('Payload')}</dt>
          <dd>{m.payloadKg} kg</dd>
        </div>
        <div>
          <dt>{t('Control range')}</dt>
          <dd>{m.controlRangeM >= 1000 ? `${m.controlRangeM / 1000} km` : `${m.controlRangeM} m`}</dd>
        </div>
        <div>
          <dt>{t('Climb / step / trench')}</dt>
          <dd>
            {m.climbDeg}° · {m.obstacleMm} mm · {m.trenchMm} mm
          </dd>
        </div>
        <div>
          <dt>{t('Size · mass')}</dt>
          <dd>
            {m.dimsMm.join('×')} mm · {m.massKg} kg
          </dd>
        </div>
      </dl>
      {d.payloads?.map((p) => (
        <p key={p} className="cc-payload">
          + {PAYLOAD_CATALOG[p]?.name ?? p}
        </p>
      ))}
      <p className="fine">
        {t('Manufacturer ratings, not measured on site.')} {m.notes}
      </p>
    </div>
  );
}
